//! Development-only ScreenCaptureKit ownership. Only this feature's
//! `application_audio_host` command reaches it; a default build has neither.
//! Native filtering, callback safety and actual release still need device tests.

use super::{Application, Control, Failure, Lease, Phase, Start};
use objc2_screen_capture_kit::SCStreamErrorCode;
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};

mod chunks;
mod clock;
mod output;
pub mod pcm;
mod position;
mod select;
mod stream;
mod task;
pub use chunks::{NativeChunk, NativeChunker, MAX_SEGMENTS};
#[cfg(test)]
pub(crate) use clock::tests::Feed;
pub use clock::{ClockBinding, NativeBlock, NativeReader};
pub use select::shareable_applications;
pub use stream::{NativeOwner, NativeTask, Selection};
pub use task::{TaskControl, TaskSnapshot};

const PENDING: u8 = 0;
const SUCCEEDED: u8 = 1;
const FAILED: u8 = 2;
// Only a Stop completion may report the framework's specific not-running error.
const ALREADY_STOPPED: u8 = 3;

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
    /// macOS refused capture to this process. Just after the Screen
    /// Recording grant, that means TalkQTE must be quit and reopened.
    PermissionNeeded,
    /// The selected application quit or can no longer be captured.
    SourceGone,
    /// The stream began but macOS could not capture the application's audio.
    AudioFailed,
    /// Capture was stopped outside TalkQTE, by the person or the system.
    StoppedByMacOS,
    /// Audio arrived in a form TalkQTE could not read.
    AudioUnreadable,
}

/// No error was reported.
pub(crate) const NO_CODE: i64 = 0;
/// An error from outside ScreenCaptureKit's domain; its code is not kept.
pub(crate) const OTHER_DOMAIN: i64 = 1;
/// TalkQTE's own reading of the audio failed; not a macOS code.
pub(crate) const AUDIO_UNREADABLE: i64 = 2;

/// The problem a ScreenCaptureKit error `code` means, or `fallback`.
fn classify(code: i64, fallback: Problem) -> Problem {
    let is = |known: SCStreamErrorCode| code == known.0 as i64;
    if code == AUDIO_UNREADABLE {
        Problem::AudioUnreadable
    } else if is(SCStreamErrorCode::UserDeclined) {
        Problem::PermissionNeeded
    } else if is(SCStreamErrorCode::NoCaptureSource)
        || is(SCStreamErrorCode::FailedNoMatchingApplicationContext)
        || is(SCStreamErrorCode::FailedApplicationConnectionInvalid)
        || is(SCStreamErrorCode::FailedApplicationConnectionInterrupted)
    {
        Problem::SourceGone
    } else if is(SCStreamErrorCode::FailedToStartAudioCapture) {
        Problem::AudioFailed
    } else if is(SCStreamErrorCode::UserStopped) || is(SCStreamErrorCode::SystemStoppedStream) {
        Problem::StoppedByMacOS
    } else {
        fallback
    }
}

/// Note a start or stream problem and macOS's code in the timing log. Runs
/// on the owning worker, never in a callback.
fn record(problem: Problem, code: i64, detail: Option<String>) {
    let label = match problem {
        Problem::StreamFailed => "stream_failed",
        Problem::StartFailed => "start_failed",
        Problem::StopFailed => "stop_failed",
        Problem::RemoveFailed => "remove_failed",
        Problem::PermissionNeeded => "permission_needed",
        Problem::SourceGone => "source_gone",
        Problem::AudioFailed => "audio_failed",
        Problem::StoppedByMacOS => "stopped_by_macos",
        Problem::AudioUnreadable => "audio_unreadable",
    };
    crate::timing_log::record(crate::timing_log::Event::SourceProblem {
        problem: label,
        os_code: (code < 0).then_some(code),
        detail,
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub stage: Stage,
    pub problem: Option<Problem>,
}

// A private seam for completion-order tests of this native owner, not a public
// capture abstraction. Methods run only on the owning thread, never a callback.
trait Driver {
    fn consumer_closed(&self) -> bool;
    fn stream_failed(&self) -> bool;
    /// macOS's code for the failed start, if any; see `NO_CODE`.
    fn start_code(&self) -> i64 {
        NO_CODE
    }
    /// macOS's code for the stream stopping on its own, if any.
    fn stream_code(&self) -> i64 {
        NO_CODE
    }
    /// What TalkQTE refused in the audio, if that stopped the stream.
    fn stream_detail(&self) -> Option<String> {
        None
    }
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
    /// The first reason given, as a number only; see `NO_CODE`.
    code: std::sync::atomic::AtomicI64,
    /// For a buffer TalkQTE could not read: which check refused it and its
    /// metadata. Set once, with a non-waiting lock, in the callback.
    refused: std::sync::Mutex<Option<(&'static str, pcm::Seen)>>,
}

impl StreamFault {
    fn new(control: Control) -> Self {
        Self {
            control,
            failed: AtomicBool::new(false),
            code: std::sync::atomic::AtomicI64::new(NO_CODE),
            refused: std::sync::Mutex::new(None),
        }
    }

    /// A buffer could not be read or handed over: keep why, then fail.
    fn record_refused(&self, why: &'static str, seen: pcm::Seen) {
        if let Ok(mut refused) = self.refused.try_lock() {
            refused.get_or_insert((why, seen));
        }
        self.record_code(AUDIO_UNREADABLE);
    }

    /// The refused buffer, as text, for the timing log. Off the callback.
    fn refused_detail(&self) -> Option<String> {
        let refused = *self.refused.lock().unwrap_or_else(|e| e.into_inner());
        refused.map(|(why, seen)| {
            format!(
                "{why}: rate {} Hz, {} channels, flags {:#x}, {} bits, {} bytes per frame, {} frames, {} bytes, duration {}/{}, pts {}/{}",
                seen.rate,
                seen.channels,
                seen.flags,
                seen.bits,
                seen.bytes_per_frame,
                seen.frames,
                seen.total_size,
                seen.duration.0,
                seen.duration.1,
                seen.pts.0,
                seen.pts.1
            )
        })
    }

    /// As `record`, keeping the first reason's code.
    fn record_code(&self, code: i64) {
        let _ = self
            .code
            .compare_exchange(NO_CODE, code, Ordering::Release, Ordering::Relaxed);
        self.record();
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
        // Consumer retirement must initiate cleanup even if a silent source
        // never calls the sample handler again. This is cancellation, not an OS fault.
        if driver.consumer_closed() {
            lease.control.0.cancelled.store(true, Ordering::Release);
        }
        if driver.stream_failed() && self.status.problem.is_none() {
            let code = driver.stream_code();
            let problem = classify(code, Problem::StreamFailed);
            let detail = driver.stream_detail();
            if let Some(detail) = &detail {
                eprintln!("TalkQTE application audio: stopped, {detail}.");
            }
            record(problem, code, detail);
            self.status.problem = Some(problem);
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
                            let code = driver.start_code();
                            let problem = classify(code, Problem::StartFailed);
                            if code != NO_CODE {
                                eprintln!("TalkQTE application audio: start refused, code {code}.");
                            }
                            record(problem, code, None);
                            self.status.problem = Some(problem);
                        }
                        // Even start failure is conservatively stopped. Until the OS
                        // confirms cleanup this operation remains reserved.
                        self.stop();
                    }
                }
            }
            Stage::Running if lease.control.is_cancelled() => self.stop(),
            Stage::Stopping => match self.completion.load(Ordering::Acquire) {
                SUCCEEDED | ALREADY_STOPPED => self.remove_and_drain(),
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
        consumer_closed: Arc<AtomicBool>,
        panic_on_stop: bool,
        dropped_on: Option<std::thread::ThreadId>,
        pause_stop: Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>,
        /// macOS's code for a failed start.
        start_code: i64,
    }
    struct Fake(Arc<Mutex<Script>>, StreamFault);
    impl Driver for Fake {
        fn consumer_closed(&self) -> bool {
            self.0
                .lock()
                .unwrap()
                .consumer_closed
                .load(Ordering::Acquire)
        }
        fn stream_failed(&self) -> bool {
            self.1.failed.load(Ordering::Acquire)
        }
        fn start_code(&self) -> i64 {
            self.0.lock().unwrap().start_code
        }
        fn stream_code(&self) -> i64 {
            self.1.code.load(Ordering::Acquire)
        }
        fn start(&mut self, slot: Arc<AtomicU8>) {
            self.0.lock().unwrap().starts.push(slot);
        }
        fn stop(&mut self, slot: Arc<AtomicU8>) {
            let mut script = self.0.lock().unwrap();
            assert!(!script.panic_on_stop, "scripted owner failure");
            script.stops.push(slot);
            let pause = script.pause_stop.take();
            drop(script);
            if let Some((entered, release)) = pause {
                entered.send(()).unwrap();
                release
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
            }
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
            let mut script = self.0.lock().unwrap();
            script.drops += 1;
            script.dropped_on = Some(std::thread::current().id());
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

    fn wait_for(mut condition: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !condition() {
            assert!(
                std::time::Instant::now() < deadline,
                "worker did not advance"
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    #[test]
    fn dropping_host_control_keeps_worker_until_late_start_stop_and_drain() {
        use std::sync::mpsc::{channel, TryRecvError};
        for during_start in [true, false] {
            let (ready_tx, ready_rx) = channel();
            let (done_tx, done_rx) = channel();
            let worker = std::thread::spawn(move || {
                let (gate, control, owner, script) = setup();
                let (task, host) = task::Task::new(owner);
                ready_tx.send((gate, control, script, host)).unwrap();
                done_tx.send(task.run()).unwrap();
            });
            let worker_id = worker.thread().id();
            let (gate, control, script, host) = ready_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            if !during_start {
                complete(&script.lock().unwrap().starts[0], SUCCEEDED);
                wait_for(|| host.snapshot().status.stage == Stage::Running);
            }
            drop(host);
            assert!(control.is_cancelled());
            busy(&gate);
            if during_start {
                assert!(script.lock().unwrap().stops.is_empty());
                assert_eq!(done_rx.try_recv(), Err(TryRecvError::Empty));
                complete(&script.lock().unwrap().starts[0], SUCCEEDED);
            }
            wait_for(|| script.lock().unwrap().stops.len() == 1);
            assert_eq!(done_rx.try_recv(), Err(TryRecvError::Empty));
            busy(&gate);
            complete(&script.lock().unwrap().stops[0], SUCCEEDED);
            wait_for(|| script.lock().unwrap().fence.is_some());
            assert_eq!(script.lock().unwrap().drops, 0);
            busy(&gate);
            script
                .lock()
                .unwrap()
                .fence
                .as_ref()
                .unwrap()
                .store(true, Ordering::Release);
            let status = done_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert_eq!(
                status,
                Status {
                    stage: Stage::Released,
                    problem: None
                }
            );
            worker.join().unwrap();
            let script = script.lock().unwrap();
            assert_eq!(script.stops.len(), 1);
            assert_eq!(script.drops, 1);
            assert_eq!(script.dropped_on, Some(worker_id));
            assert!(gate.review(source()).is_ok());
        }
    }

    #[test]
    fn task_retries_only_observed_cleanup_failures_and_never_a_later_operation() {
        let (gate, _, owner, script) = setup();
        let (mut task, host) = task::Task::new(owner);
        assert!(!host.retry_cleanup());
        complete(&script.lock().unwrap().starts[0], SUCCEEDED);
        assert_eq!(task.step().stage, Stage::Running);
        host.stop();
        assert!(host.snapshot().stop_requested);
        assert_eq!(task.step().stage, Stage::Stopping);
        assert!(!host.retry_cleanup());
        complete(&script.lock().unwrap().stops[0], FAILED);
        assert_eq!(task.step().stage, Stage::StopFailed);
        for _ in 0..3 {
            assert_eq!(task.step().stage, Stage::StopFailed);
        }
        assert_eq!(script.lock().unwrap().stops.len(), 1);
        assert!(host.retry_cleanup());
        assert!(!host.retry_cleanup());
        assert_eq!(task.step().stage, Stage::Stopping);
        assert!(!host.retry_cleanup());
        complete(&script.lock().unwrap().stops[0], SUCCEEDED);
        assert_eq!(task.step().stage, Stage::Stopping); // old completion
        script.lock().unwrap().remove_fails = true;
        complete(&script.lock().unwrap().stops[1], SUCCEEDED);
        assert_eq!(task.step().stage, Stage::RemoveFailed);
        busy(&gate);
        assert!(host.retry_cleanup());
        script.lock().unwrap().remove_fails = false;
        assert_eq!(task.step().stage, Stage::Draining);
        assert!(!host.retry_cleanup());
        script
            .lock()
            .unwrap()
            .fence
            .as_ref()
            .unwrap()
            .store(true, Ordering::Release);
        assert_eq!(task.run().stage, Stage::Released);
        assert!(!host.snapshot().abandoned);
        assert_eq!(host.snapshot().status.stage, Stage::Released);
        let mut review = gate.review(source()).unwrap();
        let next_control = review.control();
        let next_start = gate.approve(&mut review).unwrap();
        host.stop();
        assert!(!host.retry_cleanup());
        drop(host);
        assert!(!next_control.is_cancelled());
        drop(next_start);
    }

    #[test]
    fn blocked_native_stop_does_not_hold_host_status_or_command_lock() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let (ready_tx, ready_rx) = channel();
        let worker = std::thread::spawn(move || {
            let (_, _, owner, script) = setup();
            let (task, host) = task::Task::new(owner);
            ready_tx.send((script, Arc::new(host))).unwrap();
            task.run()
        });
        let (script, host) = ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (entered_tx, entered_rx) = channel();
        let (release_tx, release_rx) = channel();
        script.lock().unwrap().pause_stop = Some((entered_tx, release_rx));
        complete(&script.lock().unwrap().starts[0], SUCCEEDED);
        wait_for(|| host.snapshot().status.stage == Stage::Running);
        host.stop();
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (probe_tx, probe_rx) = channel();
        let probe_host = host.clone();
        let probe = std::thread::spawn(move || {
            probe_host.stop();
            probe_tx
                .send((probe_host.snapshot(), probe_host.retry_cleanup()))
                .unwrap();
        });
        let response = probe_rx.recv_timeout(Duration::from_secs(1));
        // Always release the scripted native call, even if the probe timed out.
        release_tx.send(()).unwrap();
        probe.join().unwrap();
        complete(&script.lock().unwrap().stops[0], SUCCEEDED);
        wait_for(|| script.lock().unwrap().fence.is_some());
        script
            .lock()
            .unwrap()
            .fence
            .as_ref()
            .unwrap()
            .store(true, Ordering::Release);
        assert_eq!(worker.join().unwrap().stage, Stage::Released);
        let (snapshot, retried) = response.expect("native call blocked host control");
        assert!(snapshot.stop_requested);
        assert!(!snapshot.abandoned && !retried);
        assert_eq!(script.lock().unwrap().stops.len(), 1);
    }

    #[test]
    fn dropping_unrun_task_reports_abandonment_without_releasing_its_grant() {
        let (gate, _, owner, script) = setup();
        let (task, host) = task::Task::new(owner);
        drop(task);
        let snapshot = host.snapshot();
        assert!(snapshot.stop_requested && snapshot.abandoned);
        assert_eq!(snapshot.status.stage, Stage::Starting);
        assert!(!host.retry_cleanup());
        assert_eq!(script.lock().unwrap().drops, 0);
        busy(&gate);
    }

    #[test]
    fn worker_unwind_reports_abandonment_instead_of_successful_stop() {
        let (gate, _, owner, script) = setup();
        let (task, host) = task::Task::new(owner);
        script.lock().unwrap().panic_on_stop = true;
        complete(&script.lock().unwrap().starts[0], SUCCEEDED);
        host.stop();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task.run()));
        assert!(outcome.is_err());
        let snapshot = host.snapshot();
        assert!(snapshot.stop_requested && snapshot.abandoned);
        assert_eq!(snapshot.status.stage, Stage::Stopping);
        assert!(!host.retry_cleanup());
        assert_eq!(script.lock().unwrap_or_else(|e| e.into_inner()).drops, 0);
        busy(&gate);
    }

    #[test]
    fn retiring_a_silent_consumer_stops_pending_or_running_capture() {
        use crate::application_audio::handoff::Format;
        for during_start in [true, false] {
            let gate = Gate::default();
            let mut review = gate.review(source()).unwrap();
            let control = review.control();
            let mut start = gate.approve(&mut review).unwrap();
            let (input, reader) = start.handoff(Format::new(16_000, 1).unwrap(), 1).unwrap();
            let script = Arc::new(Mutex::new(Script {
                consumer_closed: input.consumer_closed_signal(),
                ..Script::default()
            }));
            let mut owner = Owner::begin(
                start,
                Fake(script.clone(), StreamFault::new(control.clone())),
            )
            .unwrap();
            if !during_start {
                complete(&script.lock().unwrap().starts[0], SUCCEEDED);
                assert_eq!(owner.poll().stage, Stage::Running);
            }
            // The real session reader retires on session replacement. No audio
            // callback or native object is needed to publish consumer closure.
            let mut session = reader.bind_session(7, 0);
            assert!(session.try_next(8).is_err());
            assert_eq!(
                owner.poll().stage,
                if during_start {
                    Stage::CancellingStart
                } else {
                    Stage::Stopping
                }
            );
            assert!(control.is_cancelled());
            assert_eq!(owner.poll().problem, None);
            busy(&gate);
            if during_start {
                assert!(script.lock().unwrap().stops.is_empty());
                complete(&script.lock().unwrap().starts[0], SUCCEEDED);
                assert_eq!(owner.poll().stage, Stage::Stopping);
            }
            owner.poll();
            assert_eq!(script.lock().unwrap().stops.len(), 1);
            finish(&mut owner, &script);
            assert!(gate.review(source()).is_ok());
            drop(input);
        }
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
    fn a_failed_start_or_stopped_stream_is_named_by_the_code_macos_gave() {
        let code = |known: SCStreamErrorCode| known.0 as i64;
        for (given, expected) in [
            (
                code(SCStreamErrorCode::UserDeclined),
                Problem::PermissionNeeded,
            ),
            (
                code(SCStreamErrorCode::NoCaptureSource),
                Problem::SourceGone,
            ),
            (
                code(SCStreamErrorCode::FailedToStartAudioCapture),
                Problem::AudioFailed,
            ),
            (code(SCStreamErrorCode::InternalError), Problem::StartFailed),
            (OTHER_DOMAIN, Problem::StartFailed),
            (NO_CODE, Problem::StartFailed),
        ] {
            let (_, _, mut owner, script) = setup();
            script.lock().unwrap().start_code = given;
            complete(&script.lock().unwrap().starts[0], FAILED);
            assert_eq!(owner.poll().problem, Some(expected), "{given}");
            finish(&mut owner, &script);
        }
        for (given, expected) in [
            (
                code(SCStreamErrorCode::UserStopped),
                Problem::StoppedByMacOS,
            ),
            (
                code(SCStreamErrorCode::FailedApplicationConnectionInterrupted),
                Problem::SourceGone,
            ),
            (AUDIO_UNREADABLE, Problem::AudioUnreadable),
            (OTHER_DOMAIN, Problem::StreamFailed),
        ] {
            let (_, _, mut owner, script) = setup();
            complete(&script.lock().unwrap().starts[0], SUCCEEDED);
            assert_eq!(owner.poll().stage, Stage::Running);
            owner.resources.as_ref().unwrap().0 .1.record_code(given);
            // A later fault does not replace the first reason.
            owner
                .resources
                .as_ref()
                .unwrap()
                .0
                 .1
                .record_code(NO_CODE - 1);
            assert_eq!(owner.poll().problem, Some(expected), "{given}");
            finish(&mut owner, &script);
        }
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
    fn not_running_stop_after_start_failure_or_stream_fault_still_removes_and_drains() {
        for failed_start in [true, false] {
            let (gate, control, mut owner, script) = setup();
            complete(
                &script.lock().unwrap().starts[0],
                if failed_start { FAILED } else { SUCCEEDED },
            );
            owner.poll();
            if !failed_start {
                owner.resources.as_ref().unwrap().0 .1.record();
                owner.poll();
            }
            assert!(control.is_cancelled());
            assert_eq!(owner.status.stage, Stage::Stopping);
            busy(&gate);
            let stop = script.lock().unwrap().stops[0].clone();
            complete(&stop, ALREADY_STOPPED);
            script.lock().unwrap().remove_fails = true;
            assert_eq!(owner.poll().stage, Stage::RemoveFailed);
            busy(&gate);
            assert!(script.lock().unwrap().fence.is_none());
            script.lock().unwrap().remove_fails = false;
            assert!(owner.retry_cleanup());
            assert_eq!(owner.poll().stage, Stage::Draining);
            busy(&gate);
            {
                let script = script.lock().unwrap();
                assert_eq!(script.starts.len(), 1);
                assert_eq!(script.stops.len(), 1);
                assert_eq!(script.drops, 0);
                script
                    .fence
                    .as_ref()
                    .unwrap()
                    .store(true, Ordering::Release);
            }
            assert_eq!(owner.poll().stage, Stage::Released);
            assert_eq!(script.lock().unwrap().drops, 1);
            assert!(gate.review(control.0.application.clone()).is_ok());
        }
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
