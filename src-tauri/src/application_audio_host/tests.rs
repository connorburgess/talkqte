//! The host against a scripted owner and a memory-only clock feed. No stream,
//! device, permission prompt or real application list is involved.

use super::*;
use crate::{
    application_audio::{
        handoff::{Format, Input},
        native::{Feed, NativeBlock, Status},
        Capture, Phase as GatePhase,
    },
    native_session_clock::tests::measure_fictional,
    native_source::{self, Source},
    transcription::{AudioChunk, Recognized, Transcriber},
    Runtime,
};
use std::sync::atomic::AtomicU64;

const WAIT: Duration = Duration::from_secs(5);

/// What the fictional OS does. Tests flip these while the worker runs.
#[derive(Default)]
struct Script {
    /// The start completion has not arrived.
    start_pending: AtomicBool,
    /// How many more Stop requests the OS will report as failed.
    stop_failures: AtomicU64,
    /// The Stop completion never arrives.
    stop_hangs: AtomicBool,
    /// The worker's loop faults on its next pass.
    panics: AtomicBool,
    /// Listing waits, as it would behind an OS prompt.
    list_waits: AtomicBool,
    /// Listing does not notice a cancellation while it waits.
    list_deaf: AtomicBool,
    list_denied: AtomicBool,
    list_panics: AtomicBool,
    /// The worker has taken the run request but not begun it.
    run_waits: AtomicBool,
    runs: AtomicU64,
    lists: AtomicU64,
    begins: AtomicU64,
    captures: AtomicU64,
    polls: AtomicU64,
    retries: AtomicU64,
}

struct Scripted {
    script: Arc<Script>,
    control: Control,
    start: Option<Start>,
    capture: Option<Capture<()>>,
    feed: Feed,
    _input: Input,
    stage: Stage,
    /// Kept once set, through a retry and release, as the real owner does.
    problem: Option<NativeProblem>,
}

impl Source for Scripted {
    fn poll(&mut self) -> Status {
        self.script.polls.fetch_add(1, Ordering::SeqCst);
        if self.script.panics.load(Ordering::SeqCst) {
            panic!("fictional fault in the source worker");
        }
        let cancelled = self.control.is_cancelled();
        self.stage = match self.stage {
            Stage::Starting | Stage::CancellingStart => {
                if self.script.start_pending.load(Ordering::SeqCst) {
                    if cancelled {
                        Stage::CancellingStart
                    } else {
                        Stage::Starting
                    }
                } else {
                    // The start completed. A cancelled start is never
                    // accepted as capture; it is stopped like any other.
                    match self.start.take().expect("one start").run(|_, _| Ok(())) {
                        Ok(capture) => {
                            self.script.captures.fetch_add(1, Ordering::SeqCst);
                            self.capture = Some(capture);
                            Stage::Running
                        }
                        Err(_) => Stage::Stopping,
                    }
                }
            }
            Stage::Running if cancelled => Stage::Stopping,
            Stage::Stopping if self.script.stop_hangs.load(Ordering::SeqCst) => Stage::Stopping,
            Stage::Stopping
                if self
                    .script
                    .stop_failures
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                        left.checked_sub(1)
                    })
                    .is_ok() =>
            {
                Stage::StopFailed
            }
            Stage::Stopping => Stage::Draining,
            Stage::Draining => {
                self.capture = None;
                Stage::Released
            }
            unchanged => unchanged,
        };
        if self.stage == Stage::StopFailed {
            self.problem = Some(NativeProblem::StopFailed);
        }
        Status {
            stage: self.stage,
            problem: self.problem,
        }
    }

    fn retry_cleanup(&mut self) -> bool {
        self.script.retries.fetch_add(1, Ordering::SeqCst);
        if self.stage != Stage::StopFailed {
            return false;
        }
        self.stage = Stage::Stopping;
        true
    }

    fn try_next(&mut self, session: u64) -> Result<Option<NativeBlock>, TimingError> {
        self.feed.next(session)
    }
}

struct Silent;
impl Transcriber for Silent {
    fn transcribe(&mut self, _: &AudioChunk) -> Result<Vec<Recognized>, String> {
        Ok(Vec::new())
    }
}

struct Fake {
    runtime: Arc<Mutex<Runtime>>,
    script: Arc<Script>,
}

fn applications() -> Vec<Application> {
    ["Fictional player", "Fictional browser"]
        .into_iter()
        .enumerate()
        .map(|(index, name)| Application::new(format!("fictional-{index}"), name.into()).unwrap())
        .collect()
}

impl Backend for Fake {
    fn list(&mut self, cancelled: &AtomicBool) -> Result<Vec<Application>, Failure> {
        self.script.lists.fetch_add(1, Ordering::SeqCst);
        while self.script.list_waits.load(Ordering::SeqCst) {
            if cancelled.load(Ordering::Acquire) && !self.script.list_deaf.load(Ordering::SeqCst) {
                return Err(Failure::Cancelled);
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(
            !self.script.list_panics.load(Ordering::SeqCst),
            "fictional fault while listing"
        );
        if self.script.list_denied.load(Ordering::SeqCst) {
            return Err(Failure::PermissionDenied);
        }
        Ok(applications())
    }

    fn run(&mut self, source: &str, start: Start, monitor: Monitor) -> Result<Report, Refused> {
        assert_eq!(source, "fictional-0", "only the reviewed application");
        self.script.runs.fetch_add(1, Ordering::SeqCst);
        while self.script.run_waits.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(2));
        }
        let script = self.script.clone();
        // The real ordering of the source worker, with a fictional clock read
        // and this scripted owner in place of the two native steps.
        native_source::run_with(
            self.runtime.clone(),
            start,
            measure_fictional,
            move |mut start, binding| {
                script.begins.fetch_add(1, Ordering::SeqCst);
                let (input, reader) = start
                    .handoff(Format::new(16_000, 1).unwrap(), 4)
                    .map_err(|_| Failure::StartFailed)?;
                Ok(Scripted {
                    control: start.control(),
                    start: Some(start),
                    capture: None,
                    feed: Feed::new(reader, binding, 1.0),
                    _input: input,
                    stage: Stage::Starting,
                    problem: None,
                    script,
                })
            },
            Silent,
            monitor,
        )
    }
}

struct Fixture {
    host: Host,
    script: Arc<Script>,
    runtime: Arc<Mutex<Runtime>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Let a deliberately stuck fictional OS finish, so no worker outlives
        // its test waiting on it.
        self.script.stop_hangs.store(false, Ordering::SeqCst);
        self.script.start_pending.store(false, Ordering::SeqCst);
        self.script.list_waits.store(false, Ordering::SeqCst);
        self.script.run_waits.store(false, Ordering::SeqCst);
        // A host that locked itself up has already failed its test; do not
        // hang the teardown on it as well.
        if self.host.0.state.try_lock().is_ok() {
            self.host.exit();
        }
    }
}

fn fixture(live: bool) -> Fixture {
    let mut runtime = Runtime::default();
    if live {
        let ticket = runtime.begin_live_start().unwrap();
        runtime.install_live_start(&ticket).unwrap();
    }
    let runtime = Arc::new(Mutex::new(runtime));
    let script = Arc::new(Script::default());
    let (backend_runtime, backend_script) = (runtime.clone(), script.clone());
    let host = Host::new(move || {
        Box::new(Fake {
            runtime: backend_runtime,
            script: backend_script,
        })
    });
    Fixture {
        host,
        script,
        runtime,
    }
}

impl Fixture {
    fn view(&self) -> View {
        self.host.snapshot().view
    }

    fn wait(&self, what: &str, done: impl Fn(&View) -> bool) -> View {
        let deadline = Instant::now() + WAIT;
        loop {
            let view = self.view();
            if done(&view) {
                return view;
            }
            assert!(Instant::now() < deadline, "{what}: still {view:?}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn wait_phase(&self, phase: Phase) -> View {
        self.wait("phase", |view| view.phase == phase)
    }

    /// List, review the first application and approve it.
    fn start(&self) -> String {
        self.host.list(true).unwrap();
        let listed = self.wait("choices", |view| !view.choices.is_empty());
        self.host.review(&listed.choices[0].id).unwrap();
        let operation = self.view().operation.unwrap();
        self.host.start(&operation).unwrap();
        operation
    }

    fn listening(&self) -> String {
        let operation = self.start();
        self.wait_phase(Phase::Listening);
        operation
    }
}

/// What the rest of the app would show with the microphone already off.
fn shown(view: &View) -> CaptureState {
    overall_capture(CaptureState::Off, view.phase)
}

#[test]
fn nothing_is_listed_before_acknowledgement_and_only_the_reviewed_application_starts() {
    let fixture = fixture(true);
    let host = &fixture.host;
    assert_eq!(fixture.view().phase, Phase::Off);
    assert!(fixture.view().scope_notice.contains("all windows"));
    assert_eq!(host.list(false), Err(Error::NotAcknowledged));
    assert_eq!(
        host.apply(serde_json::from_str(r#"{"kind":"list","acknowledged":false}"#).unwrap()),
        Err(Error::NotAcknowledged)
    );
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(fixture.script.lists.load(Ordering::SeqCst), 0);

    host.apply(serde_json::from_str(r#"{"kind":"list","acknowledged":true}"#).unwrap())
        .unwrap();
    let listed = fixture.wait("choices", |view| view.choices.len() == 2);
    assert_eq!(listed.phase, Phase::Off);
    assert_eq!(listed.choices[0].name, "Fictional player");
    assert_eq!(host.review("someone-else"), Err(Error::UnknownSource));

    host.review(&listed.choices[1].id).unwrap();
    let first = fixture.view();
    assert_eq!(
        (first.phase, first.application.as_deref()),
        (Phase::Reviewing, Some("Fictional browser"))
    );
    assert!(!first.may_be_capturing);
    // Choosing again replaces the review; the old approval is worthless.
    host.review(&listed.choices[0].id).unwrap();
    let second = fixture.view();
    assert_eq!(second.application.as_deref(), Some("Fictional player"));
    assert_ne!(first.operation, second.operation);
    assert_eq!(
        host.start(first.operation.as_deref().unwrap()),
        Err(Error::Changed)
    );
    assert_eq!(fixture.view().phase, Phase::Reviewing);

    // Cancelling the review starts nothing.
    assert_eq!(host.stop(second.operation.as_deref().unwrap()), Ok(true));
    assert_eq!(fixture.view().phase, Phase::Off);
    assert_eq!(
        host.start(second.operation.as_deref().unwrap()),
        Err(Error::Changed)
    );
    assert_eq!(fixture.script.begins.load(Ordering::SeqCst), 0);

    // Approving the current review starts exactly that application.
    host.review(&listed.choices[0].id).unwrap();
    let operation = fixture.view().operation.unwrap();
    host.start(&operation).unwrap();
    let listening = fixture.wait_phase(Phase::Listening);
    assert_eq!(listening.application.as_deref(), Some("Fictional player"));
    assert!(listening.choices.is_empty(), "the list is spent");
    assert_eq!(host.review("fictional-1"), Err(Error::Busy));
    assert_eq!(host.list(true), Err(Error::Busy));
}

#[test]
fn stop_reads_stopping_until_cleanup_is_confirmed_whoever_asked() {
    for by_session in [false, true] {
        let fixture = fixture(true);
        let operation = fixture.listening();
        let listening = fixture.view();
        assert!(listening.may_be_capturing && !listening.can_retry);
        assert_eq!(shown(&listening), CaptureState::Running);
        assert_eq!(fixture.host.stop("not-this-operation"), Ok(false));
        let other = Action::Stop {
            operation: "not-this-operation".into(),
        };
        assert_eq!(fixture.host.apply(other), Err(Error::Changed));
        assert_eq!(fixture.view().phase, Phase::Listening);

        // Hold the fictional Stop completion so the reading in between does
        // not depend on scheduling.
        fixture.script.stop_hangs.store(true, Ordering::SeqCst);
        if by_session {
            // The live session's own Stop, which the host did not issue.
            drop(fixture.runtime.lock().unwrap().take_live_for_stop());
        } else {
            assert_eq!(fixture.host.stop(&operation), Ok(true));
        }
        // Immediately afterwards it is stopping, not off.
        let stopping = fixture.view();
        assert_eq!(stopping.phase, Phase::Stopping, "by session {by_session}");
        assert_eq!(shown(&stopping), CaptureState::Stopping);
        fixture.script.stop_hangs.store(false, Ordering::SeqCst);

        let off = fixture.wait_phase(Phase::Off);
        assert!(!off.may_be_capturing && off.problem.is_none());
        assert_eq!(off.operation, None);
        // The released run's counts are kept; this one heard nothing.
        let json = serde_json::to_value(&off).unwrap();
        assert_eq!(json["lastRun"]["acceptedLines"], 0);
        assert_eq!(json["lastRun"]["workerDetached"], false);
        assert_eq!(shown(&off), CaptureState::Off);
        assert_eq!(
            fixture.host.0.gate.snapshot().unwrap().phase,
            GatePhase::Idle
        );
        // Released: another explicit selection is possible.
        assert_eq!(fixture.host.list(true), Ok(()));
    }
}

#[test]
fn a_failed_stop_reads_cleanup_failed_until_one_explicit_retry_releases_it() {
    let fixture = fixture(true);
    fixture.script.stop_failures.store(1, Ordering::SeqCst);
    let operation = fixture.listening();
    assert_eq!(fixture.host.retry_cleanup(&operation), Ok(false));
    fixture.host.stop(&operation).unwrap();

    let failed = fixture.wait_phase(Phase::CleanupFailed);
    assert!(failed.may_be_capturing && failed.can_retry && !failed.stalled);
    assert_eq!(failed.problem, Some(Problem::StopFailed));
    assert_eq!(shown(&failed), CaptureState::Stopping);
    let json = serde_json::to_value(fixture.host.snapshot()).unwrap();
    assert_eq!(json["phase"], "cleanupFailed");
    assert_eq!(json["mayBeCapturing"], true);
    assert_eq!(json["problem"], "stopFailed");

    // It stays failed: no automatic retry, no new selection, still reserved.
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(fixture.view().phase, Phase::CleanupFailed);
    assert_eq!(fixture.script.retries.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.host.list(true), Err(Error::Busy));
    assert_eq!(
        fixture.host.stop(&operation),
        Ok(true),
        "Stop again is harmless"
    );
    assert_eq!(fixture.view().phase, Phase::CleanupFailed);

    assert_eq!(fixture.host.retry_cleanup("not-this-operation"), Ok(false));
    let retry = || Action::RetryCleanup {
        operation: operation.clone(),
    };
    assert_eq!(fixture.host.apply(retry()), Ok(()));
    assert_eq!(fixture.host.apply(retry()), Err(Error::NothingToRetry));
    let off = fixture.wait_phase(Phase::Off);
    assert_eq!(fixture.script.retries.load(Ordering::SeqCst), 1);
    assert!(!off.may_be_capturing);
    assert_eq!(fixture.host.retry_cleanup(&operation), Ok(false));
}

#[test]
fn a_stop_failure_is_reported_until_a_retry_confirms_release_and_then_cleared() {
    // The retry succeeds: release is confirmed, so Stop failed no longer
    // describes anything, even though the owner still carries it.
    let fixture = fixture(true);
    fixture.script.stop_failures.store(1, Ordering::SeqCst);
    let operation = fixture.listening();
    fixture.host.stop(&operation).unwrap();
    let failed = fixture.wait_phase(Phase::CleanupFailed);
    assert_eq!(failed.problem, Some(Problem::StopFailed));
    assert_eq!(fixture.host.retry_cleanup(&operation), Ok(true));
    let off = fixture.wait_phase(Phase::Off);
    assert_eq!(off.problem, None, "release was confirmed");
    assert!(!off.may_be_capturing);

    // The retry fails again: cleanup is still unconfirmed, so the failure
    // stays reported with the application still possibly captured.
    let fixture = self::fixture(true);
    fixture.script.stop_failures.store(2, Ordering::SeqCst);
    let operation = fixture.listening();
    fixture.host.stop(&operation).unwrap();
    fixture.wait_phase(Phase::CleanupFailed);
    assert_eq!(fixture.host.retry_cleanup(&operation), Ok(true));
    let deadline = Instant::now() + WAIT;
    while fixture.script.retries.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline, "the retry was not performed");
        std::thread::sleep(Duration::from_millis(1));
    }
    let again = fixture.wait("the second failure", |view| view.can_retry);
    assert_eq!(
        (again.phase, again.problem),
        (Phase::CleanupFailed, Some(Problem::StopFailed))
    );
    assert!(again.may_be_capturing);
}

#[test]
fn a_retry_that_fails_again_can_be_retried_and_one_that_hangs_cannot() {
    let retried = |fixture: &Fixture, count: u64| {
        let deadline = Instant::now() + WAIT;
        while fixture.script.retries.load(Ordering::SeqCst) < count {
            assert!(Instant::now() < deadline, "retry {count} was not performed");
            std::thread::sleep(Duration::from_millis(1));
        }
    };

    // The OS reports failure twice. Each reported failure allows one retry.
    let fixture = fixture(true);
    fixture.script.stop_failures.store(2, Ordering::SeqCst);
    let operation = fixture.listening();
    fixture.host.stop(&operation).unwrap();
    fixture.wait_phase(Phase::CleanupFailed);
    assert_eq!(fixture.host.retry_cleanup(&operation), Ok(true));
    retried(&fixture, 1);
    // The second failure has to be reported before a second retry is taken;
    // how long that takes is the worker's business, so wait for the answer.
    let deadline = Instant::now() + WAIT;
    while fixture.host.retry_cleanup(&operation) != Ok(true) {
        assert_ne!(fixture.view().phase, Phase::Off, "it failed twice");
        assert!(
            Instant::now() < deadline,
            "the second failure was never offered"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    retried(&fixture, 2);
    fixture.wait_phase(Phase::Off);
    assert_eq!(fixture.script.retries.load(Ordering::SeqCst), 2);

    // The OS reports failure once, and the retried Stop is never answered.
    let fixture = self::fixture(true);
    fixture.script.stop_failures.store(1, Ordering::SeqCst);
    let operation = fixture.listening();
    fixture.host.stop(&operation).unwrap();
    fixture.wait_phase(Phase::CleanupFailed);
    fixture.script.stop_hangs.store(true, Ordering::SeqCst);
    assert_eq!(fixture.host.retry_cleanup(&operation), Ok(true));
    retried(&fixture, 1);
    // From the performed retry on there is no reported failure to retry,
    // however long the Stop stays unanswered.
    let stopping = fixture.wait_phase(Phase::Stopping);
    assert!(stopping.may_be_capturing && !stopping.can_retry);
    for _ in 0..50 {
        assert_eq!(fixture.host.retry_cleanup(&operation), Ok(false));
        assert_eq!(fixture.view().phase, Phase::Stopping);
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(fixture.script.retries.load(Ordering::SeqCst), 1);
    fixture.script.stop_hangs.store(false, Ordering::SeqCst);
    fixture.wait_phase(Phase::Off);
}

#[test]
fn a_listing_cancelled_before_the_worker_takes_it_never_asks_the_os() {
    for quit in [false, true] {
        let fixture = fixture(true);
        // The worker is held inside one listing that cannot be interrupted.
        fixture.script.list_waits.store(true, Ordering::SeqCst);
        fixture.script.list_deaf.store(true, Ordering::SeqCst);
        fixture.host.list(true).unwrap();
        let deadline = Instant::now() + WAIT;
        while fixture.script.lists.load(Ordering::SeqCst) == 0 {
            assert!(Instant::now() < deadline, "the worker never listed");
            std::thread::sleep(Duration::from_millis(2));
        }
        fixture.host.cancel_list().unwrap();
        // A second request waits behind it and is cancelled, or the app
        // quits, before the worker can take it.
        fixture.host.list(true).unwrap();
        if quit {
            fixture.host.exit();
        } else {
            fixture.host.cancel_list().unwrap();
        }
        assert_eq!(fixture.view().phase, Phase::Off);
        fixture.script.list_waits.store(false, Ordering::SeqCst);
        // Proof the worker is past both requests: it answers a third.
        if !quit {
            fixture.host.list(true).unwrap();
            fixture.wait("choices", |view| !view.choices.is_empty());
        } else {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(
            fixture.script.lists.load(Ordering::SeqCst),
            if quit { 1 } else { 2 },
            "the cancelled request was never put to the OS (quit {quit})"
        );
    }
}

#[test]
fn before_the_native_request_a_start_is_checked_for_stop_selection_and_session() {
    use app::before_native_start;
    let listed = ["fictional-0", "fictional-1"];
    let live = || {
        let mut runtime = Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        runtime.install_live_start(&ticket).unwrap();
        Arc::new(Mutex::new(runtime))
    };
    let control = || {
        let gate = Gate::default();
        let review = gate
            .review(Application::new("fictional-0".into(), "Fictional player".into()).unwrap())
            .unwrap();
        (gate, review.control(), review)
    };
    let never = || -> Result<(), String> { panic!("the recognizer must not be loaded") };

    // Stopped while the request waited.
    let (runtime, (gate, stopped, _review)) = (live(), control());
    gate.stop(&stopped).unwrap();
    assert_eq!(
        before_native_start(&runtime, &stopped, "fictional-0", &listed, never),
        Err(Refused::Start(Failure::Cancelled))
    );
    // Not one of the listed selections.
    let (_gate, current, _review) = control();
    assert_eq!(
        before_native_start(&runtime, &current, "fictional-9", &listed, never),
        Err(Refused::Start(Failure::SourceUnavailable))
    );
    // No live session to feed.
    let idle = Arc::new(Mutex::new(Runtime::default()));
    assert_eq!(
        before_native_start(&idle, &current, "fictional-1", &listed, never),
        Err(Refused::Clock(TimingError::SessionChanged))
    );
    // The recognizer cannot be loaded.
    assert_eq!(
        before_native_start(&runtime, &current, "fictional-1", &listed, || {
            Err::<(), _>("no model".to_string())
        }),
        Err(Refused::Start(Failure::Unavailable))
    );
    // The session is replaced while the recognizer loads.
    let replaced = runtime.clone();
    assert_eq!(
        before_native_start(&runtime, &current, "fictional-1", &listed, move || {
            let mut runtime = replaced.lock().unwrap();
            drop(runtime.take_live_for_stop());
            runtime.engine.end();
            let ticket = runtime.begin_live_start().unwrap();
            runtime.install_live_start(&ticket).unwrap();
            Ok(())
        }),
        Err(Refused::Clock(TimingError::SessionChanged))
    );
    // Otherwise: the chosen selection and the loaded recognizer.
    assert_eq!(
        before_native_start(&runtime, &current, "fictional-1", &listed, || Ok(7)),
        Ok((1, 7))
    );
}

#[test]
fn a_completion_that_never_arrives_reads_stopping_then_stalled_and_never_off() {
    let fixture = fixture(true);
    fixture.script.stop_hangs.store(true, Ordering::SeqCst);
    let operation = fixture.listening();
    fixture.host.stop(&operation).unwrap();
    let asked = Instant::now();
    assert_eq!(fixture.view().phase, Phase::Stopping);

    std::thread::sleep(Duration::from_millis(100));
    for (later, stalled) in [
        (Duration::ZERO, false),
        (STALLED_AFTER * 2, true),
        (Duration::from_secs(3_600), true),
    ] {
        let view = fixture.host.snapshot_at(asked + later).view;
        assert_eq!((view.phase, view.stalled), (Phase::Stopping, stalled));
        assert!(view.may_be_capturing && !view.can_retry);
        assert_eq!(shown(&view), CaptureState::Stopping);
    }
    // Waiting is not a failure the OS reported: there is nothing to retry,
    // and nothing else may start.
    assert_eq!(fixture.host.retry_cleanup(&operation), Ok(false));
    assert_eq!(fixture.host.list(true), Err(Error::Busy));
    assert_eq!(fixture.script.retries.load(Ordering::SeqCst), 0);

    // Quitting does not turn it into Off either.
    fixture.host.exit();
    assert_eq!(fixture.view().phase, Phase::Stopping);
    // Only the completion itself does.
    fixture.script.stop_hangs.store(false, Ordering::SeqCst);
    fixture.wait_phase(Phase::Off);
}

#[test]
fn an_abandoned_worker_reads_abandoned_and_refuses_retry_and_new_work() {
    let fixture = fixture(true);
    let operation = fixture.listening();
    fixture.script.panics.store(true, Ordering::SeqCst);

    let abandoned = fixture.wait_phase(Phase::Abandoned);
    assert!(abandoned.may_be_capturing && !abandoned.can_retry);
    assert_eq!(shown(&abandoned), CaptureState::Stopping);
    assert_eq!(
        abandoned.application.as_deref(),
        Some("Fictional player"),
        "the person can still see which application"
    );
    assert_eq!(fixture.host.retry_cleanup(&operation), Ok(false));
    assert_eq!(fixture.host.stop(&operation), Ok(true));
    assert_eq!(fixture.host.list(true), Err(Error::Busy));
    fixture.host.exit();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(fixture.view().phase, Phase::Abandoned);
    // Delivery was closed even though release was never confirmed: the
    // session no longer has this source, and its own state is untouched.
    let mut runtime = fixture.runtime.lock().unwrap();
    runtime.sync();
    assert!(runtime.live_source.is_none());
    assert!(runtime.live_source_operation().is_some());
    drop(runtime);
    let json = serde_json::to_value(fixture.host.snapshot()).unwrap();
    assert_eq!(json["phase"], "abandoned");
}

#[test]
fn stop_or_exit_during_starting_reads_stopping_until_the_late_start_is_cleaned_up() {
    for exit in [false, true] {
        let fixture = fixture(true);
        fixture.script.start_pending.store(true, Ordering::SeqCst);
        let operation = fixture.start();
        // The start request is out and unanswered.
        let deadline = Instant::now() + WAIT;
        while fixture.script.polls.load(Ordering::SeqCst) < 3 {
            assert!(Instant::now() < deadline, "the worker never started");
            std::thread::sleep(Duration::from_millis(2));
        }
        let starting = fixture.view();
        assert_eq!(starting.phase, Phase::Starting);
        assert!(starting.may_be_capturing);
        assert_eq!(shown(&starting), CaptureState::Starting);

        if exit {
            fixture.host.exit();
        } else {
            assert_eq!(fixture.host.stop(&operation), Ok(true));
        }
        assert_eq!(fixture.view().phase, Phase::Stopping, "exit {exit}");
        std::thread::sleep(Duration::from_millis(100));
        let waiting = fixture.view();
        assert_eq!(waiting.phase, Phase::Stopping);
        assert_eq!(shown(&waiting), CaptureState::Stopping);

        // The start succeeds late. It is stopped, never accepted as capture.
        fixture.script.start_pending.store(false, Ordering::SeqCst);
        let off = fixture.wait_phase(Phase::Off);
        assert_eq!(off.problem, None);
        assert_eq!(fixture.script.captures.load(Ordering::SeqCst), 0);
        assert_eq!(
            fixture.host.list(true),
            if exit { Err(Error::Busy) } else { Ok(()) }
        );
    }
}

#[test]
fn a_start_that_cannot_attach_ends_off_with_its_reason_and_sends_no_native_request() {
    // No live session at all.
    let fixture = fixture(false);
    fixture.start();
    let off = fixture.wait("refusal", |view| view.problem.is_some());
    assert_eq!(
        (off.phase, off.problem),
        (Phase::Off, Some(Problem::NoLiveSession))
    );
    assert!(!off.may_be_capturing);
    assert_eq!(fixture.script.begins.load(Ordering::SeqCst), 0);

    // A live session that already has another source.
    let fixture = self::fixture(true);
    let other_gate = Gate::default();
    let other = other_gate
        .review(Application::new("other".into(), "Fictional player".into()).unwrap())
        .unwrap();
    fixture
        .runtime
        .lock()
        .unwrap()
        .attach_live_source(&other.control())
        .unwrap();
    fixture.start();
    let off = fixture.wait("refusal", |view| view.problem.is_some());
    assert_eq!(
        (off.phase, off.problem),
        (Phase::Off, Some(Problem::SessionHasSource))
    );
    assert_eq!(fixture.script.begins.load(Ordering::SeqCst), 0);
    assert!(
        !other.control().is_cancelled(),
        "the attached source runs on"
    );
}

#[test]
fn stop_before_the_worker_begins_ends_off_without_blaming_the_session() {
    let fixture = fixture(true);
    fixture.script.run_waits.store(true, Ordering::SeqCst);
    let operation = fixture.start();
    // Approved: the shared capture state must not read Off from here on,
    // even before anyone has read the status again.
    assert!(fixture.host.published().phase.may_be_capturing());
    let deadline = Instant::now() + WAIT;
    while fixture.script.runs.load(Ordering::SeqCst) == 0 {
        assert!(
            Instant::now() < deadline,
            "the worker never took the request"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(fixture.view().phase, Phase::Starting);
    assert_eq!(fixture.host.stop(&operation), Ok(true));
    assert_eq!(fixture.view().phase, Phase::Stopping);

    fixture.script.run_waits.store(false, Ordering::SeqCst);
    let off = fixture.wait_phase(Phase::Off);
    // The live session is running; the person stopped the start.
    assert_eq!(off.problem, None);
    assert_eq!(fixture.host.published().phase, Phase::Off);
    assert_eq!(fixture.script.begins.load(Ordering::SeqCst), 0);
    assert!(fixture
        .runtime
        .lock()
        .unwrap()
        .live_source_operation()
        .is_some());
}

#[test]
fn a_worker_that_cannot_be_reached_or_faults_while_listing_never_leaves_the_host_stuck() {
    // Each call runs on its own thread: a host that locked itself up would
    // otherwise hang the test instead of failing it.
    fn within<T: Send + 'static>(action: impl FnOnce() -> T + Send + 'static) -> T {
        let (done, result) = std::sync::mpsc::channel();
        std::thread::spawn(move || done.send(action()));
        result.recv_timeout(WAIT).expect("the host did not answer")
    }

    // No worker can be started.
    let fixture = fixture(true);
    fixture.host.lock().factory = None;
    let host = fixture.host.clone();
    assert_eq!(within(move || host.list(true)), Err(Error::Unavailable));
    let host = fixture.host.clone();
    assert_eq!(within(move || host.snapshot().view.phase), Phase::Off);

    // The worker faults while listing.
    let fixture = self::fixture(true);
    fixture.script.list_panics.store(true, Ordering::SeqCst);
    fixture.host.list(true).unwrap();
    let failed = fixture.wait("a failed listing", |view| view.problem.is_some());
    assert_eq!(
        (failed.phase, failed.problem),
        (Phase::Off, Some(Problem::ListFailed))
    );
    // Its thread is going or gone. Nothing was started, and soon nothing can
    // be: a request that still gets in is answered as failed, not left
    // listing.
    let deadline = Instant::now() + WAIT;
    loop {
        let host = fixture.host.clone();
        match within(move || host.list(true)) {
            Err(Error::Unavailable) => break,
            Ok(()) | Err(Error::Busy) => {
                fixture.wait("the dropped request", |view| view.phase == Phase::Off);
            }
            other => panic!("unexpected answer {other:?}"),
        }
        assert!(Instant::now() < deadline, "the dead worker kept accepting");
    }
    let host = fixture.host.clone();
    assert_eq!(within(move || host.snapshot().view.phase), Phase::Off);
}

#[test]
fn an_unanswered_listing_can_be_cancelled_and_a_refused_one_says_why() {
    let fixture = fixture(true);
    fixture.script.list_waits.store(true, Ordering::SeqCst);
    fixture.host.list(true).unwrap();
    assert_eq!(fixture.view().phase, Phase::Listing);
    assert!(!fixture.view().may_be_capturing);
    assert_eq!(fixture.host.list(true), Err(Error::Busy));
    assert_eq!(fixture.host.review("fictional-0"), Err(Error::Busy));

    fixture.host.cancel_list().unwrap();
    assert_eq!(fixture.view().phase, Phase::Off);
    // The OS answers after all; the answer is not used.
    fixture.script.list_waits.store(false, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(100));
    assert!(fixture.view().choices.is_empty());
    assert_eq!(fixture.view().problem, None);

    fixture.script.list_denied.store(true, Ordering::SeqCst);
    fixture.host.list(true).unwrap();
    let denied = fixture.wait("denial", |view| view.problem.is_some());
    assert_eq!(
        (denied.phase, denied.problem),
        (Phase::Off, Some(Problem::PermissionDenied))
    );
    assert!(denied.choices.is_empty());
}

#[test]
fn the_published_status_follows_the_host_through_failure_retry_and_release() {
    // What the processing snapshot reports for the source is the published
    // copy; it must match what the host itself says at each step.
    let matches = |fixture: &Fixture| {
        let view = fixture.view();
        let published = fixture.host.published();
        assert_eq!(
            (
                published.phase,
                published.may_be_capturing,
                published.can_retry,
                published.stalled,
                published.problem,
                published.application.clone()
            ),
            (
                view.phase,
                view.may_be_capturing,
                view.can_retry,
                view.stalled,
                view.problem,
                view.application.clone()
            )
        );
        published
    };
    let fixture = fixture(true);
    fixture.script.stop_failures.store(1, Ordering::SeqCst);
    fixture.script.start_pending.store(true, Ordering::SeqCst);
    let operation = fixture.start();
    // Before any status read, approval alone has published a start.
    let early = fixture.host.published();
    assert_eq!(early.phase, Phase::Starting);
    assert_eq!(early.application.as_deref(), Some("Fictional player"));
    assert!(early.may_be_capturing);
    fixture.script.start_pending.store(false, Ordering::SeqCst);
    fixture.wait_phase(Phase::Listening);
    matches(&fixture);
    fixture.host.stop(&operation).unwrap();
    fixture.wait_phase(Phase::CleanupFailed);
    let failed = matches(&fixture);
    assert!(failed.can_retry && failed.problem == Some(Problem::StopFailed));
    fixture.host.retry_cleanup(&operation).unwrap();
    fixture.wait_phase(Phase::Off);
    let off = matches(&fixture);
    assert!(!off.may_be_capturing && off.application.is_none());
}

#[test]
fn the_shared_capture_state_is_never_off_while_the_source_may_be_capturing() {
    use CaptureState::{Off, Running, Starting, Stopping, Unknown};
    let phases = [
        Phase::Off,
        Phase::Listing,
        Phase::Reviewing,
        Phase::Starting,
        Phase::Listening,
        Phase::Stopping,
        Phase::CleanupFailed,
        Phase::Abandoned,
    ];
    for microphone in [Unknown, Off, Starting, Running, Stopping] {
        for phase in phases {
            let shown = overall_capture(microphone, phase);
            if phase.may_be_capturing() {
                assert!(
                    !matches!(shown, Off | Unknown),
                    "{microphone:?} with {phase:?} read {shown:?}"
                );
            } else {
                assert_eq!(shown, microphone, "{phase:?} adds nothing");
            }
        }
    }
    // A starting microphone is never shown as stopping, so a reader that
    // disables Stop on stopping cannot lose it for a start it could cancel.
    for phase in phases {
        assert_ne!(overall_capture(Starting, phase), Stopping, "{phase:?}");
        if phase != Phase::Listening {
            assert_eq!(overall_capture(Starting, phase), Starting, "{phase:?}");
        }
    }
    assert_eq!(overall_capture(Off, Phase::Listening), Running);
    assert_eq!(overall_capture(Running, Phase::CleanupFailed), Running);
    assert_eq!(overall_capture(Off, Phase::Abandoned), Stopping);
}

#[test]
fn every_native_stage_maps_to_a_phase_that_does_not_understate_capture() {
    use Stage::*;
    for stage in [
        Starting,
        CancellingStart,
        Running,
        Stopping,
        StopFailed,
        RemoveFailed,
        Draining,
        Released,
    ] {
        for cancelled in [false, true] {
            let phase = active_phase(false, Some(stage), cancelled);
            assert!(phase.may_be_capturing(), "{stage:?} read {phase:?}");
            assert_eq!(
                phase == Phase::Listening,
                stage == Running && !cancelled,
                "{stage:?}"
            );
            assert_eq!(
                phase == Phase::CleanupFailed,
                matches!(stage, StopFailed | RemoveFailed)
            );
            assert_eq!(active_phase(true, Some(stage), cancelled), Phase::Abandoned);
        }
    }
    assert_eq!(active_phase(false, None, false), Phase::Starting);
    assert_eq!(active_phase(false, None, true), Phase::Stopping);
}
