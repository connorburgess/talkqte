//! Development-only ScreenCaptureKit ownership. No app command, enumeration,
//! permission request or processing path enables this module.
//! Native filtering, callback safety and actual release still need device tests.

use super::{Application, Control, Failure, Lease, Phase, Start};
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};

mod output;
pub mod pcm;
mod stream;
pub use stream::{ClockBinding, NativeOwner, Selection};

const PENDING: u8 = 0;
const SUCCEEDED: u8 = 1;
const FAILED: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Starting,
    CancellingStart,
    Running,
    Stopping,
    StopFailed,
    RemoveFailed,
    Draining,
    Released,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    StreamFailed,
    StartFailed,
    StopFailed,
    RemoveFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub stage: Stage,
    pub problem: Option<Problem>,
}

// A private seam for completion-order tests of this native owner, not a public
// capture abstraction. Methods run only on the owning thread, never a callback.
trait Driver {
    fn stream_failed(&self) -> bool;
    fn start(&mut self, completion: Arc<AtomicU8>);
    fn stop(&mut self, completion: Arc<AtomicU8>);
    fn remove_output(&mut self) -> bool;
    fn drain(&self, completion: Arc<AtomicBool>);
}

// Shared with the native delegate. No native references, locks, allocation or
// error text cross into this callback signal. Cancellation is operation-scoped.
struct StreamFault {
    control: Control,
    failed: AtomicBool,
}

impl StreamFault {
    fn new(control: Control) -> Self {
        Self {
            control,
            failed: AtomicBool::new(false),
        }
    }

    fn record(&self) {
        self.control.0.cancelled.store(true, Ordering::Release);
        self.failed.store(true, Ordering::Release);
    }
}

struct Owner<D: Driver> {
    // Explicit release drops the driver before the lease. Abandonment preserves
    // both: a destructor/timeout is not evidence of native release.
    resources: Option<(D, Lease)>,
    completion: Arc<AtomicU8>,
    drained: Arc<AtomicBool>,
    status: Status,
}

impl<D: Driver> Owner<D> {
    fn begin(start: Start, driver: D) -> Result<Self, Failure> {
        if start.lease.control.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        let mut owner = Self {
            resources: Some((driver, start.lease)),
            completion: Arc::new(AtomicU8::new(PENDING)),
            drained: Arc::new(AtomicBool::new(false)),
            status: Status {
                stage: Stage::Starting,
                problem: None,
            },
        };
        // Install the fail-closed guard before sending the first native request.
        owner
            .resources
            .as_mut()
            .unwrap()
            .0
            .start(owner.completion.clone());
        Ok(owner)
    }

    fn stop(&mut self) {
        let (driver, lease) = self.resources.as_mut().unwrap();
        let _ = lease.gate.stop(&lease.control);
        self.status.stage = Stage::Stopping;
        // A fresh slot prevents an old/duplicate completion from completing a retry.
        self.completion = Arc::new(AtomicU8::new(PENDING));
        driver.stop(self.completion.clone());
    }

    fn remove_and_drain(&mut self) {
        let (driver, _) = self.resources.as_mut().unwrap();
        if !driver.remove_output() {
            self.status = Status {
                stage: Stage::RemoveFailed,
                problem: Some(Problem::RemoveFailed),
            };
            return;
        }
        self.status.stage = Stage::Draining;
        driver.drain(self.drained.clone());
    }

    fn poll(&mut self) -> Status {
        let Some((driver, lease)) = &self.resources else {
            return self.status;
        };
        if driver.stream_failed() && self.status.problem.is_none() {
            self.status.problem = Some(Problem::StreamFailed);
        }
        match self.status.stage {
            Stage::Starting | Stage::CancellingStart => {
                match self.completion.load(Ordering::Acquire) {
                    PENDING => {
                        if lease.control.is_cancelled() {
                            self.status.stage = Stage::CancellingStart;
                        }
                    } // Cancellation cannot guess the outcome of a pending start.
                    SUCCEEDED if !lease.control.is_cancelled() => {
                        let accepted = {
                            let mut state = lease.gate.0.lock().unwrap_or_else(|e| e.into_inner());
                            if state.owns(&lease.control)
                                && state.phase == Phase::Starting
                                && !lease.control.is_cancelled()
                            {
                                state.phase = Phase::Capturing;
                                lease.control.0.capturing.store(true, Ordering::Release);
                                true
                            } else {
                                false
                            }
                        };
                        if accepted {
                            self.status.stage = Stage::Running;
                        } else {
                            self.stop();
                        }
                    }
                    outcome => {
                        if outcome != SUCCEEDED && self.status.problem.is_none() {
                            self.status.problem = Some(Problem::StartFailed);
                        }
                        // Even start failure is conservatively stopped. Until the OS
                        // confirms cleanup this operation remains reserved.
                        self.stop();
                    }
                }
            }
            Stage::Running if lease.control.is_cancelled() => self.stop(),
            Stage::Stopping => match self.completion.load(Ordering::Acquire) {
                SUCCEEDED => self.remove_and_drain(),
                FAILED => {
                    self.status = Status {
                        stage: Stage::StopFailed,
                        problem: Some(Problem::StopFailed),
                    }
                }
                _ => {}
            },
            Stage::Draining if self.drained.load(Ordering::Acquire) => {
                let (driver, lease) = self.resources.take().unwrap();
                drop(driver);
                drop(lease);
                self.status.stage = Stage::Released;
            }
            _ => {}
        }
        self.status
    }

    fn retry_cleanup(&mut self) -> bool {
        match self.status.stage {
            Stage::StopFailed => self.stop(),
            Stage::RemoveFailed => self.remove_and_drain(),
            _ => return false,
        }
        true
    }
}

impl<D: Driver> Drop for Owner<D> {
    fn drop(&mut self) {
        if let Some((driver, lease)) = self.resources.take() {
            let _ = lease.gate.stop(&lease.control);
            // Deliberately quarantine a single abandoned operation until process
            // exit. Never free callbacks or allow overlap without stop/drain proof.
            // The eventual host must keep polling this owner through cleanup.
            std::mem::forget((driver, lease));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application_audio::{Control, Gate};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Script {
        starts: Vec<Arc<AtomicU8>>,
        stops: Vec<Arc<AtomicU8>>,
        fence: Option<Arc<AtomicBool>>,
        remove_fails: bool,
        removes: usize,
        drops: usize,
    }
    struct Fake(Arc<Mutex<Script>>, StreamFault);
    impl Driver for Fake {
        fn stream_failed(&self) -> bool {
            self.1.failed.load(Ordering::Acquire)
        }
        fn start(&mut self, slot: Arc<AtomicU8>) {
            self.0.lock().unwrap().starts.push(slot);
        }
        fn stop(&mut self, slot: Arc<AtomicU8>) {
            self.0.lock().unwrap().stops.push(slot);
        }
        fn remove_output(&mut self) -> bool {
            let mut s = self.0.lock().unwrap();
            s.removes += 1;
            !s.remove_fails
        }
        fn drain(&self, slot: Arc<AtomicBool>) {
            self.0.lock().unwrap().fence = Some(slot);
        }
    }
    impl Drop for Fake {
        fn drop(&mut self) {
            self.0.lock().unwrap().drops += 1;
        }
    }
    fn source() -> Application {
        Application::new("fictional-source".into(), "Fictional player".into()).unwrap()
    }
    fn setup() -> (Gate, Control, Owner<Fake>, Arc<Mutex<Script>>) {
        let gate = Gate::default();
        let mut review = gate.review(source()).unwrap();
        let control = review.control();
        let start = gate.approve(&mut review).unwrap();
        let script = Arc::new(Mutex::new(Script::default()));
        let owner = Owner::begin(
            start,
            Fake(script.clone(), StreamFault::new(control.clone())),
        )
        .unwrap();
        (gate, control, owner, script)
    }
    fn busy(gate: &Gate) {
        assert!(matches!(gate.review(source()), Err(Failure::Busy)));
    }
    fn complete(slot: &AtomicU8, outcome: u8) {
        slot.store(outcome, Ordering::Release);
    }
    fn finish(owner: &mut Owner<Fake>, script: &Mutex<Script>) {
        complete(script.lock().unwrap().stops.last().unwrap(), SUCCEEDED);
        assert_eq!(owner.poll().stage, Stage::Draining);
        script
            .lock()
            .unwrap()
            .fence
            .as_ref()
            .unwrap()
            .store(true, Ordering::Release);
        assert_eq!(owner.poll().stage, Stage::Released);
        assert_eq!(script.lock().unwrap().drops, 1);
    }

    #[test]
    fn early_cancel_never_sends_native_start() {
        let gate = Gate::default();
        let mut review = gate.review(source()).unwrap();
        let control = review.control();
        let start = gate.approve(&mut review).unwrap();
        gate.stop(&control).unwrap();
        let script = Arc::new(Mutex::new(Script::default()));
        assert!(matches!(
            Owner::begin(
                start,
                Fake(script.clone(), StreamFault::new(control.clone()))
            ),
            Err(Failure::Cancelled)
        ));
        assert!(script.lock().unwrap().starts.is_empty());
        assert_eq!(script.lock().unwrap().drops, 1);
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
    }

    #[test]
    fn cancelled_late_start_is_stopped_and_reserved_through_drain() {
        let (gate, control, mut owner, script) = setup();
        gate.stop(&control).unwrap();
        for _ in 0..100 {
            assert_eq!(owner.poll().stage, Stage::CancellingStart);
        }
        assert!(script.lock().unwrap().stops.is_empty());
        busy(&gate);
        complete(&script.lock().unwrap().starts[0], SUCCEEDED);
        assert_eq!(owner.poll().stage, Stage::Stopping);
        assert!(!control.0.capturing.load(Ordering::Acquire));
        assert!(!owner.retry_cleanup());
        complete(&script.lock().unwrap().stops[0], SUCCEEDED);
        assert_eq!(owner.poll().stage, Stage::Draining);
        busy(&gate);
        assert_eq!(script.lock().unwrap().drops, 0);
        script
            .lock()
            .unwrap()
            .fence
            .as_ref()
            .unwrap()
            .store(true, Ordering::Release);
        assert_eq!(owner.poll().stage, Stage::Released);
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
        assert!(gate.review(source()).is_ok());
    }

    #[test]
    fn successful_start_requires_actual_stop_completion_not_repeated_polling() {
        let (gate, control, mut owner, script) = setup();
        complete(&script.lock().unwrap().starts[0], SUCCEEDED);
        assert_eq!(owner.poll().stage, Stage::Running);
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Capturing);
        gate.stop(&control).unwrap();
        assert_eq!(owner.poll().stage, Stage::Stopping);
        for _ in 0..100 {
            owner.poll();
            assert!(!owner.retry_cleanup());
        }
        assert_eq!(script.lock().unwrap().stops.len(), 1);
        busy(&gate);
        finish(&mut owner, &script);
        assert!(!owner.retry_cleanup());
        assert_eq!(owner.poll().stage, Stage::Released);
    }

    #[test]
    fn completed_stop_failure_needs_explicit_retry_with_a_fresh_completion() {
        let (gate, control, mut owner, script) = setup();
        complete(&script.lock().unwrap().starts[0], SUCCEEDED);
        owner.poll();
        gate.stop(&control).unwrap();
        owner.poll();
        let old = script.lock().unwrap().stops[0].clone();
        complete(&old, FAILED);
        assert_eq!(owner.poll().stage, Stage::StopFailed);
        busy(&gate);
        // Repeated stream errors cannot hide the actionable cleanup failure.
        owner.resources.as_ref().unwrap().0 .1.record();
        for _ in 0..5 {
            assert_eq!(owner.poll().problem, Some(Problem::StopFailed));
        }
        assert_eq!(script.lock().unwrap().stops.len(), 1);
        assert!(owner.retry_cleanup());
        complete(&old, SUCCEEDED); // A delayed old completion cannot release this retry.
        assert_eq!(owner.poll().stage, Stage::Stopping);
        busy(&gate);
        finish(&mut owner, &script);
    }

    #[test]
    fn removal_failure_retries_removal_without_restarting_stop_or_capture() {
        let (gate, control, mut owner, script) = setup();
        complete(&script.lock().unwrap().starts[0], SUCCEEDED);
        owner.poll();
        gate.stop(&control).unwrap();
        owner.poll();
        script.lock().unwrap().remove_fails = true;
        complete(&script.lock().unwrap().stops[0], SUCCEEDED);
        assert_eq!(owner.poll().stage, Stage::RemoveFailed);
        busy(&gate);
        assert!(script.lock().unwrap().fence.is_none());
        script.lock().unwrap().remove_fails = false;
        assert!(owner.retry_cleanup());
        assert_eq!(owner.poll().stage, Stage::Draining);
        assert_eq!(script.lock().unwrap().starts.len(), 1);
        assert_eq!(script.lock().unwrap().stops.len(), 1);
        script
            .lock()
            .unwrap()
            .fence
            .as_ref()
            .unwrap()
            .store(true, Ordering::Release);
        assert_eq!(owner.poll().stage, Stage::Released);
    }

    #[test]
    fn failed_start_is_not_treated_as_proven_native_cleanup() {
        let (gate, _, mut owner, script) = setup();
        complete(&script.lock().unwrap().starts[0], FAILED);
        assert_eq!(
            owner.poll(),
            Status {
                stage: Stage::Stopping,
                problem: Some(Problem::StartFailed)
            }
        );
        busy(&gate);
        finish(&mut owner, &script);
        assert_eq!(owner.poll().problem, Some(Problem::StartFailed));
    }

    #[test]
    fn stream_fault_cancels_delivery_before_owner_poll_and_waits_for_pending_start() {
        let (gate, control, mut owner, script) = setup();
        owner.resources.as_ref().unwrap().0 .1.record();
        assert!(control.is_cancelled());
        assert_eq!(
            owner.poll(),
            Status {
                stage: Stage::CancellingStart,
                problem: Some(Problem::StreamFailed)
            }
        );
        assert!(script.lock().unwrap().stops.is_empty());
        busy(&gate);
        complete(&script.lock().unwrap().starts[0], SUCCEEDED);
        assert_eq!(owner.poll().stage, Stage::Stopping);
        assert!(!control.0.capturing.load(Ordering::Acquire));
        finish(&mut owner, &script);
        assert_eq!(owner.poll().problem, Some(Problem::StreamFailed));
    }

    #[test]
    fn stream_fault_during_capture_or_stop_never_restarts_or_releases_early() {
        for fault_before_stop in [true, false] {
            let (gate, control, mut owner, script) = setup();
            complete(&script.lock().unwrap().starts[0], SUCCEEDED);
            assert_eq!(owner.poll().stage, Stage::Running);
            if !fault_before_stop {
                gate.stop(&control).unwrap();
                assert_eq!(owner.poll().stage, Stage::Stopping);
            }
            owner.resources.as_ref().unwrap().0 .1.record();
            assert!(control.is_cancelled());
            for _ in 0..3 {
                owner.resources.as_ref().unwrap().0 .1.record();
                assert_eq!(
                    owner.poll(),
                    Status {
                        stage: Stage::Stopping,
                        problem: Some(Problem::StreamFailed)
                    }
                );
                busy(&gate);
            }
            assert_eq!(script.lock().unwrap().starts.len(), 1);
            assert_eq!(script.lock().unwrap().stops.len(), 1);
            finish(&mut owner, &script);
            // A late signal still belongs to the old operation, never a new review.
            let mut next = gate.review(source()).unwrap();
            let next_control = next.control();
            let _next_start = gate.approve(&mut next).unwrap();
            StreamFault::new(control).record();
            assert!(!next_control.is_cancelled());
        }
    }

    #[test]
    fn abandoned_owner_closes_delivery_without_claiming_release() {
        let (gate, control, owner, script) = setup();
        drop(owner);
        assert!(control.is_cancelled());
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Stopping);
        busy(&gate);
        assert_eq!(script.lock().unwrap().drops, 0);
    }
}
