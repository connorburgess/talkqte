//! Development-only app host for one selected application's audio. It owns the
//! explicit steps (list after disclosure, review, approve, Stop, retry) and
//! turns what the source worker reports into a status a UI can show without
//! guessing. The rule for that status: it says Off only when nothing was
//! started or native cleanup was confirmed. A failed, unanswered or abandoned
//! cleanup stays visible as such.
//!
//! Compiled only with `native-audio-spike` on macOS. The app wiring at the end
//! of this file was compiled but never run, and no test creates a stream,
//! lists real applications or asks for permission.

use crate::{
    application_audio::{
        native::{Problem as NativeProblem, Stage},
        timing::TimingError,
        Application, Control, Failure, Gate, Review, Start, SCOPE_NOTICE,
    },
    engine::{CaptureState, SourceCapture},
    native_source::{Monitor, Refused, Report},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{channel, Sender},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};

/// How long Stopping may last before the status also says `stalled`. Host
/// policy for wording only; not a measured release time, and nothing is
/// forced, retried or reported Off when it passes.
pub(crate) const STALLED_AFTER: Duration = Duration::from_secs(5);

/// What the selection and capture steps need from the platform, on the one
/// worker thread that owns the native objects.
pub(crate) trait Backend {
    /// List selectable applications. May show an OS permission prompt, so it
    /// is called only after the scope notice was acknowledged.
    fn list(&mut self, cancelled: &AtomicBool) -> Result<Vec<Application>, Failure>;
    /// Run the approved start for the listed application `source` until its
    /// native cleanup is released. Blocks this worker.
    fn run(&mut self, source: &str, start: Start, monitor: Monitor) -> Result<Report, Refused>;
    /// Start a live session for the source alone, with no microphone. The
    /// returned step ends that session, if it is still the current one.
    /// `control` is the approved start's; the session's Stop cancels it.
    fn begin_session(&mut self, control: &Control) -> Result<Box<dyn FnOnce()>, Failure>;
}

/// Runs its step when dropped, including while unwinding.
struct OnDrop(Option<Box<dyn FnOnce()>>);

impl Drop for OnDrop {
    fn drop(&mut self) {
        if let Some(step) = self.0.take() {
            step();
        }
    }
}

type Factory = Box<dyn FnOnce() -> Box<dyn Backend> + Send>;

/// The phase and problem labels are shared with the processing snapshot.
pub(crate) use crate::engine::{SourcePhase as Phase, SourceProblem as Problem};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Choice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    phase: Phase,
    /// True whenever the selected application might still be captured.
    may_be_capturing: bool,
    /// Stopping has lasted longer than `STALLED_AFTER` with no answer.
    stalled: bool,
    /// An explicit cleanup retry can be requested now.
    can_retry: bool,
    /// The application under review or in use.
    application: Option<String>,
    /// Identifies the review or operation for Start, Stop and retry.
    operation: Option<String>,
    /// The live session was started for this source alone.
    source_session: bool,
    /// The last attempt came from the development launch setting, which
    /// stands for the acknowledged scope notice.
    by_setting: bool,
    choices: Vec<Choice>,
    problem: Option<Problem>,
    /// What the last released operation did, for acceptance records.
    last_run: Option<Evidence>,
    scope_notice: &'static str,
}

/// Counts and one duration from a released operation. No audio or text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Evidence {
    /// Chunks the recognizer processed.
    recognized_chunks: u64,
    accepted_lines: u64,
    /// Lines the sink or the engine refused, for example as out of order.
    refused_lines: u64,
    /// Lines whose time fell outside their audio.
    out_of_range_lines: u64,
    /// Chunks withheld because the source had stopped.
    stale_chunks: u64,
    /// Chunks the transcription queue had no room for.
    refused_chunks: u64,
    recognizer_failures: u64,
    /// The transcription worker did not stop in time; counts are incomplete.
    worker_detached: bool,
    /// Width of the accepted host-clock read.
    clock_read_micros: u64,
}

impl Evidence {
    fn of(report: &Report) -> Self {
        Self {
            recognized_chunks: report.worker.chunks,
            accepted_lines: report.worker.accepted,
            refused_lines: report.worker.rejected,
            out_of_range_lines: report.worker.out_of_range,
            stale_chunks: report.worker.stale,
            refused_chunks: report.refused_chunks,
            recognizer_failures: report.worker.failures,
            worker_detached: report.worker.detached,
            clock_read_micros: u64::try_from(report.bracket_width.as_micros()).unwrap_or(u64::MAX),
        }
    }
}

/// Metadata for the main window. No audio, transcript or native identifier.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub revision: u64,
    #[serde(flatten)]
    view: View,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Error {
    Unavailable,
    /// Listing needs the acknowledged scope notice first.
    NotAcknowledged,
    /// Something is listing, starting, capturing or cleaning up.
    Busy,
    UnknownSource,
    /// The review or operation named is not the current one.
    Changed,
    /// No failed cleanup is waiting for a retry of this operation.
    NothingToRetry,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Action {
    Snapshot,
    List {
        acknowledged: bool,
    },
    CancelList,
    Review {
        source: String,
    },
    Start {
        review: String,
    },
    /// Start a live session fed by this application alone.
    StartSession {
        review: String,
    },
    Stop {
        operation: String,
    },
    RetryCleanup {
        operation: String,
    },
}

enum Ended {
    Released(Report),
    Refused(Refused),
    /// The worker unwound, or the request was never run.
    Unwound,
}

/// Travels with a run request. If it is dropped without an outcome, for
/// example because the worker panicked, the operation reads as abandoned.
struct Finish(Arc<Mutex<Option<Ended>>>);

impl Finish {
    fn set(&self, ended: Ended) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(ended);
    }
}

impl Drop for Finish {
    fn drop(&mut self) {
        let mut ended = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if ended.is_none() {
            *ended = Some(Ended::Unwound);
        }
    }
}

/// Travels with a list request and always answers it, so a failed or
/// unwound listing cannot leave the status at Listing.
struct Listed {
    host: Weak<Inner>,
    cancelled: Arc<AtomicBool>,
    answered: bool,
}

impl Listed {
    fn answer(&mut self, result: Result<Vec<Application>, Failure>) {
        self.answered = true;
        let Some(inner) = self.host.upgrade() else {
            return;
        };
        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state
            .listing
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &self.cancelled))
        {
            return; // Cancelled or superseded: a late answer changes nothing.
        }
        state.listing = None;
        match result {
            Ok(applications) => {
                state.listed = crate::application_audio::listing::shown(applications)
            }
            Err(Failure::Cancelled) => {}
            Err(Failure::PermissionDenied) => state.problem = Some(Problem::PermissionDenied),
            Err(_) => state.problem = Some(Problem::ListFailed),
        }
    }
}

impl Drop for Listed {
    fn drop(&mut self) {
        if !self.answered {
            self.answer(Err(Failure::Unavailable));
        }
    }
}

enum Command {
    /// FIFO fence after every previously admitted list/start has settled.
    #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
    LabStopFence(Sender<()>),
    List(Listed),
    Run {
        source: String,
        start: Start,
        monitor: Monitor,
        finish: Finish,
        /// Start a live session for this source alone first.
        session_only: bool,
        /// Set once that session has begun.
        session_started: Arc<AtomicBool>,
    },
}

struct Active {
    id: String,
    application: Application,
    control: Control,
    monitor: Monitor,
    ended: Arc<Mutex<Option<Ended>>>,
    /// When the current, continuous Stopping began.
    stopping_since: Option<Instant>,
    /// Stop or exit was asked of this host for this operation.
    stop_requested: bool,
    /// The live session was started for this source alone.
    session_only: bool,
    /// The worker has begun that session. Until then nothing says the
    /// session has no microphone, since it may not be this source's.
    session_started: Arc<AtomicBool>,
}

struct State {
    revision: u64,
    last: Option<View>,
    /// The revision last handed to the event publisher.
    published: u64,
    factory: Option<Factory>,
    worker: Option<Sender<Command>>,
    listing: Option<Arc<AtomicBool>>,
    listed: Vec<Application>,
    review: Option<(String, Review)>,
    active: Option<Active>,
    problem: Option<Problem>,
    /// Counts from the last operation that reached release.
    last_run: Option<Evidence>,
    exiting: bool,
    lab_stop_closed: bool,
    /// The last attempt came from the development launch setting, not the
    /// panel. Cleared by the next step the panel asks for.
    by_setting: bool,
}

struct Inner {
    gate: Gate,
    state: Mutex<State>,
    /// The status last computed, readable without the state lock. Written
    /// only under that lock: by a start, before the worker is asked, and by
    /// every status read. It can lag a release, never a start. A leaf lock:
    /// nothing else is taken while it is held, so a reader that holds the
    /// runtime lock cannot wait on the host.
    published: Mutex<SourceCapture>,
}

#[derive(Clone)]
pub(crate) struct Host(Arc<Inner>);

impl Host {
    /// `backend` is called once, on the worker thread, when it is first needed.
    pub(crate) fn new(backend: impl FnOnce() -> Box<dyn Backend> + Send + 'static) -> Self {
        Self(Arc::new(Inner {
            gate: Gate::default(),
            published: Mutex::new(SourceCapture {
                phase: Phase::Off,
                may_be_capturing: false,
                stalled: false,
                can_retry: false,
                application: None,
                problem: None,
                operation: None,
                source_session: false,
                by_setting: false,
            }),
            state: Mutex::new(State {
                revision: 0,
                last: None,
                published: 0,
                factory: Some(Box::new(backend)),
                worker: None,
                listing: None,
                listed: Vec::new(),
                review: None,
                active: None,
                problem: None,
                last_run: None,
                exiting: false,
                lab_stop_closed: false,
                by_setting: false,
            }),
        }))
    }

    /// Nothing panics while holding this lock; if something ever did, the
    /// state is still the best account there is, and Stop must keep working.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// One command surface for the main window. Never waits for the worker,
    /// the OS or the runtime.
    pub(crate) fn apply(&self, action: Action) -> Result<(), Error> {
        if matches!(
            action,
            Action::List { .. }
                | Action::Review { .. }
                | Action::Start { .. }
                | Action::StartSession { .. }
        ) {
            // The panel is choosing now, not the launch setting.
            self.lock().by_setting = false;
        }
        match action {
            Action::Snapshot => Ok(()),
            Action::List { acknowledged } => self.list(acknowledged),
            Action::CancelList => self.cancel_list(),
            Action::Review { source } => self.review(&source),
            Action::Start { review } => self.start(&review),
            Action::StartSession { review } => self.start_session(&review),
            Action::Stop { operation } => match self.stop(&operation)? {
                true => Ok(()),
                false => Err(Error::Changed),
            },
            Action::RetryCleanup { operation } => match self.retry_cleanup(&operation)? {
                true => Ok(()),
                false => Err(Error::NothingToRetry),
            },
        }
    }

    fn idle(&self, state: &mut State) -> Result<(), Error> {
        #[cfg(all(
            debug_assertions,
            target_os = "macos",
            feature = "native-audio-spike",
            feature = "lab-evaluator"
        ))]
        if crate::dev_stop::requested() {
            return Err(Error::Busy);
        }
        self.settle(state);
        if state.exiting
            || state.lab_stop_closed
            || state.active.is_some()
            || state.listing.is_some()
        {
            return Err(Error::Busy);
        }
        Ok(())
    }

    fn worker(&self, state: &mut State) -> Result<Sender<Command>, Error> {
        if let Some(worker) = &state.worker {
            return Ok(worker.clone());
        }
        let factory = state.factory.take().ok_or(Error::Unavailable)?;
        let (sender, commands) = channel::<Command>();
        // Handed to the thread through a slot, so a thread that cannot be
        // started leaves the factory for a later attempt.
        let slot = Arc::new(Mutex::new(Some(factory)));
        let taken = slot.clone();
        let spawned = std::thread::Builder::new()
            .name("talkqte-application-audio".into())
            .spawn(move || {
                let Some(factory) = taken.lock().unwrap_or_else(|e| e.into_inner()).take() else {
                    return;
                };
                // Native selections and the owner live and die on this thread.
                let mut backend = factory();
                while let Ok(command) = commands.recv() {
                    match command {
                        #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
                        Command::LabStopFence(done) => {
                            let _ = done.send(());
                        }
                        Command::List(mut listed) => {
                            // Cancelled or quit while this waited: the OS is
                            // not asked at all, so no prompt can follow.
                            let result = if listed.cancelled.load(Ordering::Acquire) {
                                Err(Failure::Cancelled)
                            } else {
                                backend.list(&listed.cancelled)
                            };
                            listed.answer(result);
                        }
                        Command::Run {
                            source,
                            start,
                            monitor,
                            finish,
                            session_only,
                            session_started,
                        } => {
                            // The session ends however the run ends,
                            // unwinding included, and before the outcome is
                            // reported, so Off never shows beside it.
                            let session = if session_only {
                                match backend.begin_session(&start.control()) {
                                    Ok(end) => {
                                        session_started.store(true, Ordering::Release);
                                        Some(OnDrop(Some(end)))
                                    }
                                    Err(failure) => {
                                        finish.set(Ended::Refused(Refused::Start(failure)));
                                        continue;
                                    }
                                }
                            } else {
                                None
                            };
                            let outcome = backend.run(&source, start, monitor);
                            drop(session);
                            match outcome {
                                Ok(report) => finish.set(Ended::Released(report)),
                                Err(refused) => finish.set(Ended::Refused(refused)),
                            }
                        }
                    }
                }
            });
        if spawned.is_err() {
            state.factory = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
            return Err(Error::Unavailable);
        }
        state.worker = Some(sender.clone());
        Ok(sender)
    }

    /// The person acknowledged the scope notice; ask the OS which applications
    /// can be selected. The OS may show its own permission prompt.
    pub(crate) fn list(&self, acknowledged: bool) -> Result<(), Error> {
        if !acknowledged {
            return Err(Error::NotAcknowledged);
        }
        let mut state = self.lock();
        self.idle(&mut state)?;
        state.review = None;
        state.listed.clear();
        state.problem = None;
        let worker = self.worker(&mut state)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        state.listing = Some(cancelled.clone());
        // Enqueue under the admission lock, so a later Stop fence cannot
        // overtake this admitted listing. Retain a failed send until after
        // unlocking: dropping its self-answering request also takes the lock.
        let listed = Listed {
            host: Arc::downgrade(&self.0),
            cancelled,
            answered: false,
        };
        let sent = worker.send(Command::List(listed));
        drop(state);
        sent.map_err(|_| Error::Unavailable)
    }

    pub(crate) fn cancel_list(&self) -> Result<(), Error> {
        let mut state = self.lock();
        if let Some(cancelled) = state.listing.take() {
            cancelled.store(true, Ordering::Release);
        }
        Ok(())
    }

    /// Put one listed application under review. Nothing is requested of the
    /// OS; a later review replaces this one.
    pub(crate) fn review(&self, source: &str) -> Result<(), Error> {
        let mut state = self.lock();
        self.idle(&mut state)?;
        let application = state
            .listed
            .iter()
            .find(|application| application.selection_id() == source)
            .cloned()
            .ok_or(Error::UnknownSource)?;
        state.review = None;
        let review = self.0.gate.review(application).map_err(|_| Error::Busy)?;
        state.review = Some((new_id()?, review));
        state.problem = None;
        Ok(())
    }

    /// The person approved exactly the application under review.
    pub(crate) fn start(&self, review: &str) -> Result<(), Error> {
        self.start_with(review, false)
    }

    /// As `start`, in a live session started for this source alone: no model
    /// is loaded for it and no microphone is opened. Refused, with nothing
    /// started, while another session runs.
    pub(crate) fn start_session(&self, review: &str) -> Result<(), Error> {
        self.start_with(review, true)
    }

    fn start_with(&self, review: &str, session_only: bool) -> Result<(), Error> {
        let mut state = self.lock();
        self.idle(&mut state)?;
        if !state.review.as_ref().is_some_and(|(id, _)| id == review) {
            return Err(Error::Changed);
        }
        let (id, mut review) = state.review.take().expect("checked above");
        let application = review.application().clone();
        let start = self
            .0
            .gate
            .approve(&mut review)
            .map_err(|_| Error::Changed)?;
        let control = start.control();
        let monitor = Monitor::default();
        let ended = Arc::new(Mutex::new(None));
        let session_started = Arc::new(AtomicBool::new(false));
        let worker = self.worker(&mut state)?;
        // Before the worker can act on it: from here the shared capture
        // state must not read Off.
        self.publish(SourceCapture {
            phase: Phase::Starting,
            may_be_capturing: true,
            stalled: false,
            can_retry: false,
            application: Some(application.name().to_owned()),
            problem: None,
            operation: Some(id.clone()),
            // Not until the worker has begun the session.
            source_session: false,
            by_setting: state.by_setting,
        });
        worker
            .send(Command::Run {
                source: application.selection_id().to_owned(),
                start,
                monitor: monitor.clone(),
                finish: Finish(ended.clone()),
                session_only,
                session_started: session_started.clone(),
            })
            .map_err(|_| Error::Unavailable)?;
        // The retained selections are consumed by this start.
        state.listed.clear();
        state.problem = None;
        state.last_run = None;
        state.active = Some(Active {
            id,
            application,
            control,
            monitor,
            ended,
            stopping_since: None,
            stop_requested: false,
            session_only,
            session_started,
        });
        Ok(())
    }

    /// Stop exactly this review or operation. Closes delivery at once; the
    /// status stays Stopping until native cleanup is confirmed.
    pub(crate) fn stop(&self, operation: &str) -> Result<bool, Error> {
        let mut state = self.lock();
        if state.review.as_ref().is_some_and(|(id, _)| id == operation) {
            state.review = None;
            return Ok(true);
        }
        Ok(stop_active(&self.0.gate, &mut state, Some(operation)))
    }

    /// One explicit retry of a cleanup failure the status has shown.
    pub(crate) fn retry_cleanup(&self, operation: &str) -> Result<bool, Error> {
        let state = self.lock();
        Ok(state
            .active
            .as_ref()
            .is_some_and(|active| active.id == operation && active.monitor.retry_cleanup()))
    }

    /// The app is quitting: refuse new work and request Stop. Does not wait.
    /// Whether the OS ends an unconfirmed capture with the process is a
    /// device question this code does not answer.
    pub(crate) fn exit(&self) {
        let mut state = self.lock();
        state.exiting = true;
        if let Some(cancelled) = state.listing.take() {
            cancelled.store(true, Ordering::Release);
        }
        state.review = None;
        stop_active(&self.0.gate, &mut state, None);
    }

    /// Permanently close admission and request the ordinary source Stop. The
    /// returned FIFO fence is not a release report: it confirms that queued or
    /// in-flight listing/start work can no longer acquire resources later.
    #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
    pub(crate) fn close_for_lab_stop(&self) -> Result<std::sync::mpsc::Receiver<()>, Error> {
        let mut state = self.lock();
        state.lab_stop_closed = true;
        if let Some(cancelled) = state.listing.take() {
            cancelled.store(true, Ordering::Release);
        }
        state.review = None;
        stop_active(&self.0.gate, &mut state, None);
        let (done, settled) = channel();
        if let Some(worker) = &state.worker {
            worker
                .send(Command::LabStopFence(done))
                .map_err(|_| Error::Unavailable)?;
        } else {
            let _ = done.send(());
        }
        Ok(settled)
    }

    #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
    pub(crate) fn lab_stop_released(&self) -> bool {
        let Ok(mut state) = self.0.state.try_lock() else {
            return false;
        };
        self.settle(&mut state);
        state.lab_stop_closed
            && state.active.is_none()
            && state.listing.is_none()
            && !state
                .last_run
                .as_ref()
                .is_some_and(|run| run.worker_detached)
    }

    /// Take a finished operation out, keeping why it ended.
    fn settle(&self, state: &mut State) {
        let Some(active) = &state.active else {
            return;
        };
        let problem = match &*active.ended.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(Ended::Released(report)) => {
                state.last_run = Some(Evidence::of(report));
                // The owner keeps a Stop or removal failure in its status
                // after a retry. Release is confirmed now, so that failure
                // was resolved and is not a problem any more. A start or
                // stream failure still explains why the run ended.
                report
                    .status
                    .problem
                    .filter(|problem| {
                        !matches!(
                            problem,
                            NativeProblem::StopFailed | NativeProblem::RemoveFailed
                        )
                    })
                    .map(native_problem)
            }
            // Stopped here before anything started. The refusal then only
            // reflects that Stop, whatever step noticed it.
            Some(Ended::Refused(_)) if active.stop_requested => None,
            // The source's own session began and was stopped before the
            // source did. Any other changed session is still reported.
            Some(Ended::Refused(Refused::Clock(TimingError::SessionChanged)))
                if active.session_only && active.session_started.load(Ordering::Acquire) =>
            {
                None
            }
            Some(Ended::Refused(refused)) => refusal_problem(*refused),
            Some(Ended::Unwound) | None => return,
        };
        if crate::timing_log::enabled() {
            let recognized_chunks = match &*active.ended.lock().unwrap_or_else(|e| e.into_inner()) {
                Some(Ended::Released(report)) => Some(report.worker.chunks),
                _ => None,
            };
            crate::timing_log::record(crate::timing_log::Event::SourceEnded {
                application: active.application.name().to_owned(),
                problem: problem.and_then(|problem| {
                    serde_json::to_value(problem)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_owned))
                }),
                recognized_chunks,
            });
        }
        state.problem = problem;
        state.active = None;
    }

    fn view(&self, state: &mut State, now: Instant) -> View {
        self.settle(state);
        let (phase, stalled, can_retry) = match &mut state.active {
            None if state.listing.is_some() => (Phase::Listing, false, false),
            None if state.review.is_some() => (Phase::Reviewing, false, false),
            None => (Phase::Off, false, false),
            Some(active) => {
                // Only an unwound worker. An outcome that arrived since the
                // check above is taken on the next read.
                let unwound = matches!(
                    *active.ended.lock().unwrap_or_else(|e| e.into_inner()),
                    Some(Ended::Unwound)
                );
                let phase = active_phase(
                    unwound || active.monitor.abandoned(),
                    active.monitor.status().map(|status| status.stage),
                    active.control.is_cancelled(),
                );
                if phase == Phase::Stopping {
                    active.stopping_since.get_or_insert(now);
                } else {
                    active.stopping_since = None;
                }
                let stalled = phase == Phase::Stopping
                    && active
                        .stopping_since
                        .is_some_and(|since| now.saturating_duration_since(since) >= STALLED_AFTER);
                (phase, stalled, phase == Phase::CleanupFailed)
            }
        };
        let problem = match (&state.active, phase) {
            (Some(active), Phase::CleanupFailed) => active
                .monitor
                .status()
                .and_then(|status| status.problem)
                .map(native_problem),
            (Some(_), _) => None,
            (None, _) => state.problem,
        };
        View {
            phase,
            may_be_capturing: phase.may_be_capturing(),
            stalled,
            can_retry,
            application: state
                .active
                .as_ref()
                .map(|active| &active.application)
                .or(state
                    .review
                    .as_ref()
                    .map(|(_, review)| review.application()))
                .map(|application| application.name().to_owned()),
            operation: state
                .active
                .as_ref()
                .map(|active| active.id.clone())
                .or(state.review.as_ref().map(|(id, _)| id.clone())),
            // Only while that session's source is starting or capturing:
            // once it is stopped the session has ended or is ending, and a
            // later session may well have a microphone.
            source_session: state.active.as_ref().is_some_and(|active| {
                active.session_only
                    && active.session_started.load(Ordering::Acquire)
                    && !active.control.is_cancelled()
                    && matches!(phase, Phase::Starting | Phase::Listening)
            }),
            choices: state
                .listed
                .iter()
                .map(|application| Choice {
                    id: application.selection_id().to_owned(),
                    name: application.name().to_owned(),
                })
                .collect(),
            problem,
            last_run: state.last_run.clone(),
            by_setting: state.by_setting,
            scope_notice: SCOPE_NOTICE,
        }
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        self.snapshot_at(Instant::now())
    }

    pub(crate) fn snapshot_at(&self, now: Instant) -> Snapshot {
        let mut state = self.lock();
        self.read(&mut state, now)
    }

    /// For the one event publisher: the status, if it has a revision that
    /// publisher has not been given. Other readers do not consume it.
    pub(crate) fn unpublished(&self, now: Instant) -> Option<Snapshot> {
        let mut state = self.lock();
        let snapshot = self.read(&mut state, now);
        if snapshot.revision == state.published {
            return None;
        }
        state.published = snapshot.revision;
        Some(snapshot)
    }

    /// The status as of the last start or status read, without taking the
    /// host lock, for callers that already hold another lock.
    pub(crate) fn published(&self) -> SourceCapture {
        self.0
            .published
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn publish(&self, status: SourceCapture) {
        *self.0.published.lock().unwrap_or_else(|e| e.into_inner()) = status;
    }

    fn read(&self, state: &mut State, now: Instant) -> Snapshot {
        let view = self.view(state, now);
        self.publish(SourceCapture {
            phase: view.phase,
            may_be_capturing: view.may_be_capturing,
            stalled: view.stalled,
            can_retry: view.can_retry,
            application: view.application.clone(),
            problem: view.problem,
            operation: view.operation.clone(),
            source_session: view.source_session,
            by_setting: view.by_setting,
        });
        if state.last.as_ref() != Some(&view) {
            state.revision += 1;
            state.last = Some(view.clone());
        }
        Snapshot {
            revision: state.revision,
            view,
        }
    }
}

fn stop_active(gate: &Gate, state: &mut State, operation: Option<&str>) -> bool {
    let Some(active) = state
        .active
        .as_mut()
        .filter(|active| operation.is_none_or(|id| active.id == id))
    else {
        return false;
    };
    // The atomic first: authoritative even if the gate is unavailable.
    active.control.cancel();
    let _ = gate.stop(&active.control);
    active.stop_requested = true;
    true
}

/// The status of a started operation that has not reported an outcome.
/// `stage` is the last native stage the worker saw, if its loop has begun.
fn active_phase(abandoned: bool, stage: Option<Stage>, cancelled: bool) -> Phase {
    if abandoned {
        return Phase::Abandoned;
    }
    match stage {
        Some(Stage::StopFailed | Stage::RemoveFailed) => Phase::CleanupFailed,
        // Native cleanup is confirmed, but the worker has not finished, so
        // nothing new can start yet. Off follows with the outcome.
        Some(Stage::CancellingStart | Stage::Stopping | Stage::Draining | Stage::Released) => {
            Phase::Stopping
        }
        _ if cancelled => Phase::Stopping,
        Some(Stage::Running) => Phase::Listening,
        Some(Stage::Starting) | None => Phase::Starting,
    }
}

/// Before a session for the source alone begins: a recognizer must be
/// available, or the session would end as soon as it began after clearing the
/// previous one; and the microphone must read off, since the session says it
/// is not used. A microphone that cannot be read counts as not off.
/// `microphone_not_capturing` is the controller's reading (off, or failed
/// with its device released); None means it could not be read.
pub(crate) fn session_preflight(
    microphone_not_capturing: Option<bool>,
    recognizer_available: bool,
) -> Result<(), Failure> {
    if !recognizer_available {
        return Err(Failure::Unavailable);
    }
    if microphone_not_capturing != Some(true) {
        return Err(Failure::Busy);
    }
    Ok(())
}

fn native_problem(problem: NativeProblem) -> Problem {
    match problem {
        NativeProblem::StreamFailed => Problem::StreamFailed,
        NativeProblem::StartFailed => Problem::StartFailed,
        NativeProblem::StopFailed => Problem::StopFailed,
        NativeProblem::RemoveFailed => Problem::RemoveFailed,
        NativeProblem::PermissionNeeded => Problem::PermissionNeedsReopen,
        NativeProblem::SourceGone => Problem::ApplicationEnded,
        NativeProblem::AudioFailed => Problem::AudioCaptureFailed,
        NativeProblem::StoppedByMacOS => Problem::StoppedByMacOS,
        NativeProblem::AudioUnreadable => Problem::AudioUnreadable,
    }
}

fn refusal_problem(refused: Refused) -> Option<Problem> {
    Some(match refused {
        Refused::Clock(TimingError::SessionChanged) => Problem::NoLiveSession,
        Refused::Clock(TimingError::Occupied) => Problem::SessionHasSource,
        Refused::Clock(_) => Problem::ClockRefused,
        // The person stopped it before anything started: not a problem.
        Refused::Start(Failure::Cancelled) => return None,
        Refused::Start(Failure::PermissionDenied) => Problem::PermissionDenied,
        Refused::Start(Failure::SourceUnavailable) => Problem::SourceUnavailable,
        Refused::Start(Failure::Unavailable) => Problem::Unavailable,
        Refused::Start(Failure::Busy) => Problem::SessionBusy,
        Refused::Start(_) => Problem::StartFailed,
    })
}

fn new_id() -> Result<String, Error> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Error::Unavailable)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The capture state the rest of the app shows, with this source included:
/// never Off or Unknown while the selected application may be captured. A
/// starting microphone stays Starting whatever the source is doing, so a
/// reader that disables Stop while capture reads Stopping (as the processing
/// panel did before it read the microphone alone) never loses Stop for a
/// microphone that is starting.
pub(crate) fn overall_capture(microphone: CaptureState, source: Phase) -> CaptureState {
    if !source.may_be_capturing() {
        return microphone;
    }
    match (microphone, source) {
        (CaptureState::Running, _) | (_, Phase::Listening) => CaptureState::Running,
        (CaptureState::Starting, _)
        | (CaptureState::Off | CaptureState::Unknown, Phase::Starting) => CaptureState::Starting,
        _ => CaptureState::Stopping,
    }
}

// ---------------------------------------------------------------------------
// App wiring. Compiled with the feature; never run by a test or on a device.
// ---------------------------------------------------------------------------

pub(crate) mod app {
    use super::*;
    use crate::{
        application_audio::native::{shareable_applications, Selection},
        native_source::{self, Access, Limits},
        transcription::Transcriber,
        AppState, Runtime,
    };
    use tauri::{Emitter, Manager};

    /// Host policy for the clock read, not measured budgets: the read bracket
    /// may be at most 2 ms wide and the snapshot at most 250 ms old.
    const LIMITS: Limits = Limits {
        max_width: Duration::from_millis(2),
        max_age: Duration::from_millis(250),
    };
    const REFRESH: Duration = Duration::from_millis(200);

    #[derive(Clone)]
    struct AppAccess(tauri::AppHandle);

    impl Access for AppAccess {
        fn with<R>(&self, action: impl FnOnce(&mut Runtime) -> R) -> Option<R> {
            let state = self.0.state::<AppState>();
            let mut runtime = state.0.lock().ok()?;
            let before = runtime.engine.state.revision;
            let result = action(&mut runtime);
            // Publish under the lock, as the microphone sink does.
            if runtime.engine.state.revision != before {
                crate::publish(&self.0, &mut runtime);
            }
            Some(result)
        }
    }

    struct Native {
        app: tauri::AppHandle,
        selections: Vec<Selection>,
    }

    impl Backend for Native {
        fn begin_session(&mut self, control: &Control) -> Result<Box<dyn FnOnce()>, Failure> {
            // The same check the recognizer load makes first. Whisper builds
            // verify the model again when loading; that can still fail.
            let recognizer_available = cfg!(feature = "local-whisper")
                && crate::model_path(&self.app).is_some_and(|(path, _)| path.is_file());
            let controller = self
                .app
                .state::<crate::microphone::Controller>()
                .inner()
                .clone();
            let access = AppAccess(self.app.clone());
            let session = access
                .with(|runtime| {
                    // Under the runtime lock, which a standalone microphone
                    // start also consults, so the two cannot interleave.
                    session_preflight(controller.try_not_capturing(), recognizer_available)?;
                    runtime.begin_source_session(control)
                })
                .ok_or(Failure::Unavailable)??;
            Ok(Box::new(move || {
                access.with(|runtime| runtime.end_source_session(session));
            }))
        }

        fn list(&mut self, cancelled: &AtomicBool) -> Result<Vec<Application>, Failure> {
            self.selections.clear();
            // SAFETY: reached only through Host::list, which requires the
            // acknowledged scope notice, on the worker that keeps the result.
            self.selections = unsafe { shareable_applications(cancelled) }?;
            if cancelled.load(Ordering::Acquire) {
                // Answered just as it was cancelled: keep nothing.
                self.selections.clear();
                return Err(Failure::Cancelled);
            }
            Ok(self
                .selections
                .iter()
                .map(|selection| selection.application().clone())
                .collect())
        }

        fn run(&mut self, source: &str, start: Start, monitor: Monitor) -> Result<Report, Refused> {
            let access = AppAccess(self.app.clone());
            let listed: Vec<&str> = self
                .selections
                .iter()
                .map(|selection| selection.application().selection_id())
                .collect();
            let ready = before_native_start(&access, &start.control(), source, &listed, || {
                recognizer(&self.app)
            });
            // Whatever the answer, the listed selections are spent.
            let (chosen, transcriber) = match ready {
                Ok(ready) => ready,
                Err(refused) => {
                    self.selections.clear();
                    return Err(refused);
                }
            };
            let selection = self.selections.swap_remove(chosen);
            self.selections.clear();
            // SAFETY: the person reviewed and approved this exact selection
            // through the gate, and this is the worker that constructed it.
            // The remaining obligations of NativeOwner::begin are unverified
            // device gates; see docs/native-audio-owner.md.
            unsafe { native_source::run(access, start, selection, LIMITS, transcriber, monitor) }
        }
    }

    /// Everything decided before the native request, in order: a start that
    /// was stopped while it waited loads nothing; the source must be one of
    /// the listed selections; a live session must be running; the recognizer
    /// is loaded; and the live session must still be the same one, because
    /// the approval was given during it and loading can take seconds.
    /// Returns the position of the selection and the loaded recognizer.
    pub(in crate::application_audio_host) fn before_native_start<A: Access, T>(
        access: &A,
        control: &Control,
        source: &str,
        listed: &[&str],
        load: impl FnOnce() -> Result<T, String>,
    ) -> Result<(usize, T), Refused> {
        if control.is_cancelled() {
            return Err(Refused::Start(Failure::Cancelled));
        }
        let chosen = listed
            .iter()
            .position(|id| *id == source)
            .ok_or(Refused::Start(Failure::SourceUnavailable))?;
        let session = || {
            access
                .with(|runtime| {
                    runtime
                        .live_source_operation()
                        .map(|_| runtime.engine.session())
                })
                .flatten()
                .ok_or(Refused::Clock(TimingError::SessionChanged))
        };
        let approved_in = session()?;
        let loaded = load().map_err(|_| Refused::Start(Failure::Unavailable))?;
        if session()? != approved_in {
            return Err(Refused::Clock(TimingError::SessionChanged));
        }
        Ok((chosen, loaded))
    }

    /// A second local recognizer for this source, loaded before any native
    /// request. Builds without local transcription refuse the start.
    fn recognizer(app: &tauri::AppHandle) -> Result<Box<dyn Transcriber>, String> {
        #[cfg(feature = "local-whisper")]
        {
            let (model, pinned) = crate::model_path(app)
                .filter(|(path, _)| path.is_file())
                .ok_or("The local speech model is not installed.")?;
            if pinned {
                crate::model::verify(&model, &crate::model::TINY_EN)?;
            }
            let loaded = crate::transcription::whisper::LocalWhisper::load(&model, 4)
                .map_err(|_| "Could not load the local speech model.".to_string())?;
            Ok(Box::new(loaded))
        }
        #[cfg(not(feature = "local-whisper"))]
        {
            let _ = app;
            Err("This build does not include local transcription.".into())
        }
    }

    /// The single command for this development surface, main window only.
    #[tauri::command]
    pub(crate) fn application_audio(
        window: tauri::WebviewWindow,
        host: tauri::State<'_, Host>,
        action: Action,
    ) -> Result<Snapshot, Error> {
        if window.label() != "main" {
            return Err(Error::Unavailable);
        }
        host.apply(action)?;
        Ok(host.snapshot())
    }

    /// Register the host, allow its one command for the main window, and
    /// publish status changes. Nothing is listed or started here.
    pub(crate) fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
        let backend_app = app.clone();
        let host = Host::new(move || {
            Box::new(Native {
                app: backend_app,
                selections: Vec::new(),
            })
        });
        app.manage(host.clone());
        app.add_capability(
            tauri::ipc::CapabilityBuilder::new("application-audio")
                .window("main")
                .permission("allow-application-audio"),
        )?;
        #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
        crate::dev_stop::install(app, host.clone()).map_err(std::io::Error::other)?;
        // The development launch setting, read once here and acted on once,
        // on its own thread: it waits for listing and the start.
        if let Some(settings) = DevSettings::read(|name| std::env::var(name).ok()) {
            let host = host.clone();
            let _ = std::thread::Builder::new()
                .name("talkqte-dev-source".into())
                .spawn(move || {
                    host.start_by_setting(&settings, DevWaits::default());
                });
        }
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(REFRESH);
            if let Some(snapshot) = host.unpublished(Instant::now()) {
                let _ = app.emit_to("main", "application-audio:changed", &snapshot);
                // The shared capture state includes this source.
                if let Ok(mut runtime) = app.state::<AppState>().0.lock() {
                    crate::publish_processing(&app, &mut runtime);
                }
            }
        });
        Ok(())
    }

    /// The source's status for the processing snapshot. Called with the
    /// runtime lock held, so it reads the published copy, never the host
    /// lock: nothing in the host can then stall the runtime.
    pub(crate) fn source_status(app: &tauri::AppHandle) -> Option<SourceCapture> {
        app.try_state::<Host>().map(|host| host.published())
    }

    pub(crate) fn exit(app: &tauri::AppHandle) {
        if let Some(host) = app.try_state::<Host>() {
            host.exit();
        }
    }
}

pub(crate) use app::{exit, install, source_status};

mod dev_start;
pub(crate) use dev_start::{Settings as DevSettings, Waits as DevWaits};

#[cfg(test)]
mod tests;
