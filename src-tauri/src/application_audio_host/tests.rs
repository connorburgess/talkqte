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
    /// A session for the source alone waits before it begins.
    session_waits: AtomicBool,
    /// The microphone does not read off, as with an activity check.
    microphone_open: AtomicBool,
    /// No local recognizer could be loaded.
    recognizer_missing: AtomicBool,
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
    fn begin_session(&mut self, control: &Control) -> Result<Box<dyn FnOnce()>, Failure> {
        while self.script.session_waits.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(2));
        }
        // The app's own check, under the runtime lock as the app makes it.
        let session = {
            let mut runtime = self.runtime.lock().unwrap();
            let microphone = if self.script.microphone_open.load(Ordering::SeqCst) {
                crate::microphone::Status::Listening
            } else {
                crate::microphone::Status::Off
            };
            session_preflight(
                Some(crate::microphone::not_capturing(microphone, true)),
                !self.script.recognizer_missing.load(Ordering::SeqCst),
            )?;
            runtime.begin_source_session(control)?
        };
        let runtime = self.runtime.clone();
        Ok(Box::new(move || {
            // A poisoned lock here would mean a test already failed.
            if let Ok(mut runtime) = runtime.lock() {
                runtime.end_source_session(session);
            }
        }))
    }

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
        self.script.session_waits.store(false, Ordering::SeqCst);
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

impl Fixture {
    /// List, review the first application and start it in a session of its
    /// own.
    fn start_session(&self) -> String {
        self.host.list(true).unwrap();
        let listed = self.wait("choices", |view| !view.choices.is_empty());
        self.host.review(&listed.choices[0].id).unwrap();
        let operation = self.view().operation.unwrap();
        self.host.start_session(&operation).unwrap();
        operation
    }

    /// The live session's state: whether one runs, whether it is a source
    /// session, whether it has a microphone, and the engine's status.
    fn session(&self) -> (bool, bool, bool, crate::engine::Status) {
        let runtime = self.runtime.lock().unwrap();
        let session = runtime.engine.session();
        (
            runtime.live.is_some(),
            runtime.is_source_session(session),
            runtime
                .live
                .as_ref()
                .is_some_and(|live| live.microphone.is_some()),
            runtime.engine.state.status,
        )
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

#[test]
fn a_source_session_starts_without_a_microphone_and_ends_with_its_own_stop_or_the_session_stop() {
    use crate::engine::Status;
    for by_session in [false, true] {
        let fixture = fixture(false);
        assert!(!fixture.session().0, "no live session to begin with");
        let operation = fixture.start_session();
        let listening = fixture.wait_phase(Phase::Listening);
        assert!(listening.source_session && listening.may_be_capturing);
        let published = fixture.host.published();
        assert!(published.source_session);
        assert_eq!(published.operation.as_deref(), Some(operation.as_str()));
        // A live session of its own, with no microphone and no model loaded
        // by the session itself.
        assert_eq!(
            fixture.session(),
            (true, true, false, Status::Running),
            "by session {by_session}"
        );
        fixture.script.stop_hangs.store(true, Ordering::SeqCst);
        if by_session {
            // Stop live session, as the notebook does it.
            let mut runtime = fixture.runtime.lock().unwrap();
            let session = runtime.engine.session();
            drop(runtime.take_live_for_stop().unwrap());
            assert!(runtime.engine.finish_live_stop(session));
        } else {
            // The source's own Stop.
            assert_eq!(fixture.host.stop(&operation), Ok(true));
        }
        let stopping = fixture.view();
        assert_eq!(stopping.phase, Phase::Stopping, "by session {by_session}");
        assert!(stopping.may_be_capturing);
        fixture.script.stop_hangs.store(false, Ordering::SeqCst);
        let off = fixture.wait_phase(Phase::Off);
        assert_eq!(off.problem, None);
        let (live, source_session, microphone, status) = fixture.session();
        assert!(
            !live && !source_session && !microphone,
            "by session {by_session}"
        );
        assert_eq!(status, Status::Ended);
        assert_eq!(fixture.script.captures.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn a_source_session_ends_when_cleanup_fails_or_the_worker_faults_but_capture_stays_reported() {
    use crate::engine::Status;
    // Cleanup fails: nothing can be delivered any more, so the session ends,
    // while the source keeps reading as possibly capturing.
    let fixture = fixture(false);
    fixture.script.stop_failures.store(1, Ordering::SeqCst);
    let operation = fixture.start_session();
    fixture.wait_phase(Phase::Listening);
    fixture.host.stop(&operation).unwrap();
    let failed = fixture.wait_phase(Phase::CleanupFailed);
    // Its source is stopped, so nothing calls this the source's own
    // session any more; a later session may well have a microphone.
    assert!(failed.may_be_capturing && !failed.source_session);
    fixture.runtime.lock().unwrap().sync();
    let (live, _, _, status) = fixture.session();
    assert!(!live, "the source's session ended");
    assert_eq!(status, Status::Ended);
    assert_eq!(fixture.view().phase, Phase::CleanupFailed);
    assert_eq!(fixture.host.retry_cleanup(&operation), Ok(true));
    fixture.wait_phase(Phase::Off);

    // The worker faults: the session ends as it unwinds, and the source reads
    // abandoned rather than off.
    let fixture = self::fixture(false);
    fixture.start_session();
    fixture.wait_phase(Phase::Listening);
    fixture.script.panics.store(true, Ordering::SeqCst);
    let abandoned = fixture.wait_phase(Phase::Abandoned);
    assert!(abandoned.may_be_capturing);
    let deadline = Instant::now() + WAIT;
    while fixture.session().0 {
        assert!(Instant::now() < deadline, "the session outlived its worker");
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(fixture.session().3, Status::Ended);
    assert_eq!(fixture.view().phase, Phase::Abandoned);
}

#[test]
fn a_source_session_stopped_before_its_source_begins_ends_off_and_asks_nothing() {
    use crate::engine::Status;
    for by_session in [false, true] {
        let fixture = fixture(false);
        fixture.script.run_waits.store(true, Ordering::SeqCst);
        let operation = fixture.start_session();
        let deadline = Instant::now() + WAIT;
        while fixture.script.runs.load(Ordering::SeqCst) == 0 {
            assert!(
                Instant::now() < deadline,
                "the worker never took the request"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(fixture.session().0, "the session was started first");
        assert_eq!(fixture.view().phase, Phase::Starting);
        if by_session {
            let mut runtime = fixture.runtime.lock().unwrap();
            let session = runtime.engine.session();
            drop(runtime.take_live_for_stop().unwrap());
            runtime.engine.finish_live_stop(session);
        } else {
            fixture.host.stop(&operation).unwrap();
        }
        assert_eq!(
            fixture.view().phase,
            Phase::Stopping,
            "by session {by_session}"
        );
        fixture.script.run_waits.store(false, Ordering::SeqCst);
        let off = fixture.wait_phase(Phase::Off);
        assert_eq!(off.problem, None, "by session {by_session}");
        assert_eq!(fixture.script.begins.load(Ordering::SeqCst), 0);
        let (live, _, _, status) = fixture.session();
        assert!(!live);
        assert_eq!(status, Status::Ended);
    }
}

#[test]
fn a_source_session_is_refused_while_another_session_runs_and_leaves_it_alone() {
    use crate::engine::Status;
    let fixture = fixture(true);
    let session = fixture.runtime.lock().unwrap().engine.session();
    fixture.start_session();
    // Approval publishes a start, but not yet a session of the source's own:
    // the session it would claim has no microphone is the microphone's.
    assert!(!fixture.host.published().source_session);
    let off = fixture.wait("refusal", |view| view.problem.is_some());
    assert!(!off.source_session && !fixture.host.published().source_session);
    assert_eq!(
        (off.phase, off.problem),
        (Phase::Off, Some(Problem::SessionBusy))
    );
    assert!(!off.may_be_capturing);
    assert_eq!(fixture.script.runs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.script.begins.load(Ordering::SeqCst), 0);
    let runtime = fixture.runtime.lock().unwrap();
    assert_eq!(
        runtime.engine.session(),
        session,
        "the running session is untouched"
    );
    assert_eq!(runtime.engine.state.status, Status::Running);
    assert!(!runtime.is_source_session(session));
}

#[test]
fn a_source_session_is_refused_with_the_microphone_open_or_no_recognizer_and_clears_nothing() {
    use crate::engine::Status;
    for (microphone_open, recognizer_missing, problem) in [
        (true, false, Problem::SessionBusy),
        (false, true, Problem::Unavailable),
    ] {
        let fixture = fixture(false);
        // An earlier session that has ended, with what it heard.
        let before = {
            let mut runtime = fixture.runtime.lock().unwrap();
            runtime.engine.end();
            (runtime.engine.session(), runtime.engine.state.status)
        };
        fixture
            .script
            .microphone_open
            .store(microphone_open, Ordering::SeqCst);
        fixture
            .script
            .recognizer_missing
            .store(recognizer_missing, Ordering::SeqCst);
        fixture.start_session();
        let off = fixture.wait("refusal", |view| view.problem.is_some());
        assert_eq!((off.phase, off.problem), (Phase::Off, Some(problem)));
        assert!(!off.source_session);
        assert_eq!(fixture.script.runs.load(Ordering::SeqCst), 0);
        let runtime = fixture.runtime.lock().unwrap();
        assert!(runtime.live.is_none(), "no session was installed");
        assert_eq!(
            (runtime.engine.session(), runtime.engine.state.status),
            before,
            "the earlier session was left as it was"
        );
        assert_eq!(before.1, Status::Ended);
    }
}

#[test]
fn the_source_session_flag_holds_only_from_its_start_until_its_source_is_stopped() {
    let fixture = fixture(false);
    fixture.script.session_waits.store(true, Ordering::SeqCst);
    let operation = fixture.start_session();
    std::thread::sleep(Duration::from_millis(50));
    // Approved, but the session has not begun.
    let early = fixture.view();
    assert_eq!(early.phase, Phase::Starting);
    assert!(!early.source_session && !fixture.host.published().source_session);
    fixture.script.session_waits.store(false, Ordering::SeqCst);
    let listening = fixture.wait_phase(Phase::Listening);
    assert!(listening.source_session && fixture.host.published().source_session);
    // From Stop on, it no longer describes anything.
    fixture.script.stop_hangs.store(true, Ordering::SeqCst);
    fixture.host.stop(&operation).unwrap();
    let stopping = fixture.view();
    assert_eq!(stopping.phase, Phase::Stopping);
    assert!(!stopping.source_session && !fixture.host.published().source_session);
    fixture.script.stop_hangs.store(false, Ordering::SeqCst);
    fixture.wait_phase(Phase::Off);
}

#[test]
fn a_failed_microphone_blocks_a_source_session_only_while_it_may_still_capture() {
    use crate::microphone::{not_capturing, Status};
    // Failed and released, for example after a denied permission: nothing is
    // captured and a start may follow, so the session may begin.
    assert_eq!(
        session_preflight(Some(not_capturing(Status::Error, true)), true),
        Ok(())
    );
    assert_eq!(
        session_preflight(Some(not_capturing(Status::Off, true)), true),
        Ok(())
    );
    // Failed with its cleanup pending, or open in any way: possibly capturing.
    for status in [
        Status::Error,
        Status::Starting,
        Status::Listening,
        Status::Stopping,
    ] {
        assert_eq!(
            session_preflight(Some(not_capturing(status, false)), true),
            Err(Failure::Busy),
            "{status:?}"
        );
    }
    for status in [Status::Starting, Status::Listening, Status::Stopping] {
        assert!(!not_capturing(status, true), "{status:?}");
    }
    // A controller that cannot be read is not taken as idle.
    assert_eq!(session_preflight(None, true), Err(Failure::Busy));
    assert_eq!(
        session_preflight(Some(true), false),
        Err(Failure::Unavailable)
    );
}

mod by_setting {
    use super::*;
    use dev_start::{Outcome, Settings, SOURCE_ENV, STOP_AFTER_ENV};

    fn waits() -> DevWaits {
        DevWaits {
            list: WAIT,
            start: WAIT,
            poll: Duration::from_millis(2),
        }
    }

    fn named(application: &str) -> Settings {
        Settings {
            application: application.into(),
            stop_after: Ok(None),
        }
    }

    #[test]
    fn the_settings_are_read_only_when_an_application_is_named() {
        let read = |source: Option<&str>, stop: Option<&str>| {
            Settings::read(|name| match name {
                SOURCE_ENV => source.map(str::to_owned),
                STOP_AFTER_ENV => stop.map(str::to_owned),
                _ => None,
            })
        };
        assert_eq!(read(None, Some("30")), None);
        assert_eq!(read(Some("  "), None), None);
        assert_eq!(
            read(Some("Fictional player"), None),
            Some(named("Fictional player"))
        );
        assert_eq!(
            read(Some("Fictional player"), Some("30"))
                .unwrap()
                .stop_after,
            Ok(Some(Duration::from_secs(30)))
        );
        for invalid in ["0", "-5", "soon", "1.5"] {
            assert_eq!(
                read(Some("Fictional player"), Some(invalid))
                    .unwrap()
                    .stop_after,
                Err(()),
                "{invalid}"
            );
        }
    }

    #[test]
    fn the_setting_lists_once_and_starts_only_the_exactly_named_application_alone() {
        let f = fixture(false);
        let outcome = f.host.start_by_setting(&named("Fictional player"), waits());
        assert_eq!(outcome, Outcome::Started { stopped: false });
        let view = f.view();
        assert_eq!(view.phase, Phase::Listening);
        assert_eq!(view.application.as_deref(), Some("Fictional player"));
        assert!(view.source_session, "a session for the source alone");
        assert!(view.by_setting, "the setting stands for the notice");
        assert!(f.host.published().by_setting);
        assert_eq!(f.script.lists.load(Ordering::SeqCst), 1);
        assert_eq!(f.script.runs.load(Ordering::SeqCst), 1);
        // The panel's next step is its own again.
        f.host
            .apply(Action::Stop {
                operation: view.operation.unwrap(),
            })
            .unwrap();
        f.wait_phase(Phase::Off);
        f.host.apply(Action::List { acknowledged: true }).unwrap();
        assert!(!f.view().by_setting);
    }

    #[test]
    fn the_stop_setting_asks_the_ordinary_stop_after_capture_and_release_follows() {
        let f = fixture(false);
        let settings = Settings {
            application: "Fictional player".into(),
            stop_after: Ok(Some(Duration::from_millis(30))),
        };
        let outcome = f.host.start_by_setting(&settings, waits());
        assert_eq!(outcome, Outcome::Started { stopped: true });
        let view = f.wait_phase(Phase::Off);
        assert_eq!(view.problem, None, "an ordinary, confirmed release");
        assert!(view.last_run.is_some());
    }

    #[test]
    fn no_exact_match_starts_nothing_says_why_and_does_not_list_again() {
        let f = fixture(false);
        for name in ["Fictional Player", "Fictional", "Other application"] {
            let outcome = f.host.start_by_setting(&named(name), waits());
            assert_eq!(
                outcome,
                Outcome::Refused("no_matching_application"),
                "{name}"
            );
            let view = f.view();
            assert_eq!(view.phase, Phase::Off);
            assert_eq!(view.problem, Some(Problem::NoMatchingApplication));
        }
        // One listing per attempt, and no attempt of its own after that.
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(f.script.lists.load(Ordering::SeqCst), 3);
        assert_eq!(f.script.runs.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_refused_permission_ends_the_attempt_after_one_request() {
        let f = fixture(false);
        f.script.list_denied.store(true, Ordering::SeqCst);
        let outcome = f.host.start_by_setting(&named("Fictional player"), waits());
        assert_eq!(outcome, Outcome::Refused("permission_denied"));
        assert_eq!(f.view().problem, Some(Problem::PermissionDenied));
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(f.script.lists.load(Ordering::SeqCst), 1);
        assert_eq!(f.script.runs.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_listing_that_never_answers_is_cancelled_once_its_wait_ends() {
        let f = fixture(false);
        f.script.list_waits.store(true, Ordering::SeqCst);
        let short = DevWaits {
            list: Duration::from_millis(30),
            ..waits()
        };
        let outcome = f.host.start_by_setting(&named("Fictional player"), short);
        assert_eq!(outcome, Outcome::Refused("list_timed_out"));
        let view = f.view();
        assert_eq!(view.phase, Phase::Off);
        assert_eq!(view.problem, Some(Problem::ListFailed));
        assert_eq!(f.script.runs.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_setting_never_starts_with_the_microphone_open_or_an_invalid_stop() {
        let f = fixture(false);
        f.script.microphone_open.store(true, Ordering::SeqCst);
        let outcome = f.host.start_by_setting(&named("Fictional player"), waits());
        assert_eq!(outcome, Outcome::Refused("start_refused"));
        let view = f.wait_phase(Phase::Off);
        assert_eq!(view.problem, Some(Problem::SessionBusy));
        assert_eq!(f.script.captures.load(Ordering::SeqCst), 0);

        let g = fixture(false);
        let invalid = Settings {
            application: "Fictional player".into(),
            stop_after: Err(()),
        };
        let outcome = g.host.start_by_setting(&invalid, waits());
        assert_eq!(outcome, Outcome::Refused("stop_after_invalid"));
        assert_eq!(g.view().problem, Some(Problem::DevSettingInvalid));
        assert_eq!(g.script.lists.load(Ordering::SeqCst), 0, "nothing is asked");
    }
}
