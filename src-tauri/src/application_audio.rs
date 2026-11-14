//! Development-only ownership for selected-application audio. The default build
//! has no OS API, enumeration, permission request or app command. The handoff
//! submodule accepts synthetic buffers without activating any capture.
//! With the optional native-audio-spike feature, one development command
//! reaches the native owner through `application_audio_host`.
//! Native selection, sample handling and release still require acceptance.

pub mod chunks;
pub mod handoff;
pub mod listing;
#[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
pub mod native;
pub mod timing;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

/// Application audio can include other windows; this is never a tab grant.
pub const SCOPE_NOTICE: &str = "Audio from all windows of this application may be included.";

/// Trusted adapter metadata for one concrete selection, not a display name
/// used to look up another process. A changed native filter needs a new review.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Application {
    selection_id: String,
    name: String,
    /// What the native listing knows about it; absent in fixtures.
    traits: Option<listing::Traits>,
}

impl Application {
    pub fn new(selection_id: String, name: String) -> Result<Self, Failure> {
        let safe = |text: &str| {
            !text.chars().any(|c| {
                c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            })
        };
        if selection_id.is_empty()
            || selection_id.len() > 256
            || selection_id.trim() != selection_id
            || !safe(&selection_id)
            || name.trim().is_empty()
            || name.chars().count() > 120
            || !safe(&name)
        {
            return Err(Failure::InvalidSource);
        }
        Ok(Self {
            selection_id,
            name,
            traits: None,
        })
    }

    pub fn with_traits(mut self, traits: listing::Traits) -> Self {
        self.traits = Some(traits);
        self
    }

    pub fn traits(&self) -> Option<&listing::Traits> {
        self.traits.as_ref()
    }

    pub fn selection_id(&self) -> &str {
        &self.selection_id
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Reviewing,
    Starting,
    Capturing,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    InvalidSource,
    Busy,
    ReviewChanged,
    Unavailable,
    Cancelled,
    PermissionDenied,
    SourceUnavailable,
    StartFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub phase: Phase,
    pub application: Option<Application>,
    pub failure: Option<Failure>,
}

struct Operation {
    application: Application,
    cancelled: AtomicBool,
    capturing: AtomicBool,
}

/// Opaque operation identity for scoped Stop and an allocation-free cancel
/// check. An adapter must observe cancellation during asynchronous startup.
#[derive(Clone)]
pub struct Control(Arc<Operation>);

impl Control {
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }

    /// Close this operation with one atomic store and no gate lock, so a
    /// caller may hold another lock. Delivery, readers and returned work
    /// refuse from here on. The gate keeps reporting its earlier phase until
    /// the operation's owner observes this and stops or releases its resource.
    pub(crate) fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
    }

    /// Identity of the reviewed operation, not of its application or name.
    #[cfg(any(all(target_os = "macos", feature = "native-audio-spike"), test))]
    pub(crate) fn same_operation(&self, other: &Control) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

struct State {
    current: Option<Control>,
    phase: Phase,
    failure: Option<Failure>,
}

impl State {
    fn owns(&self, control: &Control) -> bool {
        self.current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.0, &control.0))
    }
}

/// The review/start operation stays reserved through cancellation and stream
/// destruction. It never starts or retries an adapter by itself.
#[derive(Clone)]
pub struct Gate(Arc<Mutex<State>>);

impl Default for Gate {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(State {
            current: None,
            phase: Phase::Idle,
            failure: None,
        })))
    }
}

impl Gate {
    pub fn snapshot(&self) -> Result<Snapshot, Failure> {
        let state = self.0.lock().map_err(|_| Failure::Unavailable)?;
        Ok(Snapshot {
            phase: state.phase,
            application: state.current.as_ref().map(|c| c.0.application.clone()),
            failure: state.failure,
        })
    }

    /// Prepare the exact application-wide disclosure. No adapter is called.
    /// A later selection replaces an unapproved review, never active capture.
    /// The caller must disclose scope BEFORE any native selection/enumeration
    /// that can itself request access; this method grants no OS permission.
    pub fn review(&self, application: Application) -> Result<Review, Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::Unavailable)?;
        if matches!(
            state.phase,
            Phase::Starting | Phase::Capturing | Phase::Stopping
        ) {
            return Err(Failure::Busy);
        }
        if let Some(old) = state.current.take() {
            old.0.cancelled.store(true, Ordering::Release);
        }
        let control = Control(Arc::new(Operation {
            application,
            cancelled: AtomicBool::new(false),
            capturing: AtomicBool::new(false),
        }));
        state.current = Some(control.clone());
        state.phase = Phase::Reviewing;
        state.failure = None;
        Ok(Review {
            control: control.clone(),
            lease: Some(Lease {
                gate: self.clone(),
                control,
                failure: None,
            }),
        })
    }

    /// Consume this exact review once, after explicit user approval. Future
    /// IPC must bind an opaque review ID to this object, not accept a source
    /// supplied by the frontend. Approval never transfers to another source.
    pub fn approve(&self, review: &mut Review) -> Result<Start, Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::Unavailable)?;
        if !state.owns(&review.control)
            || state.phase != Phase::Reviewing
            || review.control.is_cancelled()
        {
            return Err(Failure::ReviewChanged);
        }
        let lease = review.lease.take().ok_or(Failure::ReviewChanged)?;
        state.phase = Phase::Starting;
        Ok(Start {
            lease,
            handoff_created: false,
        })
    }

    /// Retire only this operation. During start/capture, Stopping remains
    /// until the pending start and its returned resource have been released.
    /// The owning worker must observe cancellation and drop its Capture.
    pub fn stop(&self, control: &Control) -> Result<bool, Failure> {
        let mut state = self.0.lock().map_err(|_| Failure::Unavailable)?;
        if !state.owns(control) {
            return Ok(false);
        }
        control.0.cancelled.store(true, Ordering::Release);
        if state.phase == Phase::Reviewing {
            state.current = None;
            state.phase = Phase::Idle;
        } else {
            state.phase = Phase::Stopping;
        }
        Ok(true)
    }
}

struct Lease {
    gate: Gate,
    control: Control,
    failure: Option<Failure>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.control.0.cancelled.store(true, Ordering::Release);
        let mut state = self.gate.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.owns(&self.control) {
            // Stop can arrive after an adapter error was observed but before
            // this lease retires. Keep that cancellation authoritative.
            if state.phase == Phase::Stopping {
                self.failure = None;
            }
            state.current = None;
            state.failure = self.failure;
            state.phase = if self.failure.is_some() {
                Phase::Failed
            } else {
                Phase::Idle
            };
        }
    }
}

#[must_use = "Dropping an unapproved review cancels that selection"]
pub struct Review {
    control: Control,
    lease: Option<Lease>,
}

impl Review {
    pub fn application(&self) -> &Application {
        &self.control.0.application
    }

    pub fn scope_notice(&self) -> &'static str {
        SCOPE_NOTICE
    }

    pub fn control(&self) -> Control {
        self.control.clone()
    }
}

#[must_use = "Dropping an unused start cancels it"]
pub struct Start {
    lease: Lease,
    handoff_created: bool,
}

impl Start {
    /// The approved operation's identity, for scoped Stop and source checks.
    pub fn control(&self) -> Control {
        self.lease.control.clone()
    }

    /// Run on a worker, never the UI thread or audio callback. The adapter
    /// receives only the reviewed selection and cancellation token. It must
    /// clean up before returning Err, and release its stream in a non-panicking
    /// destructor. It must not retry, broaden filters, record, or upload.
    /// Those native obligations require separate verification.
    pub fn run<S>(
        mut self,
        start: impl FnOnce(&Application, &Control) -> Result<S, Failure>,
    ) -> Result<Capture<S>, Failure> {
        if self.lease.control.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        // No state lock spans adapter work or destruction. Stop can retire an
        // in-flight start; cancellation cannot undo an OS request already sent.
        let stream = match start(&self.lease.control.0.application, &self.lease.control) {
            Ok(stream) => stream,
            Err(error) => {
                let state = self.lease.gate.0.lock().map_err(|_| Failure::Unavailable)?;
                if self.lease.control.is_cancelled() {
                    return Err(Failure::Cancelled);
                }
                self.lease.failure = Some(error);
                drop(state);
                return Err(error);
            }
        };
        let accepted = {
            let mut state = self.lease.gate.0.lock().map_err(|_| Failure::Unavailable)?;
            if state.owns(&self.lease.control)
                && state.phase == Phase::Starting
                && !self.lease.control.is_cancelled()
            {
                state.phase = Phase::Capturing;
                self.lease
                    .control
                    .0
                    .capturing
                    .store(true, Ordering::Release);
                true
            } else {
                false
            }
        };
        if !accepted {
            drop(stream); // Still reserved throughout late-stream destruction.
            return Err(Failure::Cancelled);
        }
        Ok(Capture {
            stream: Some(stream),
            lease: self.lease,
        })
    }
}

/// Owns the adapter resource. Drop on a worker after cancellation/error/Stop;
/// the next review is blocked until that resource's destructor returns.
/// This proves resource ownership, not actual OS release or release latency.
#[must_use = "Dropping capture releases its stream and operation"]
pub struct Capture<S> {
    stream: Option<S>,
    lease: Lease,
}

impl<S> Drop for Capture<S> {
    fn drop(&mut self) {
        let _ = self.lease.gate.stop(&self.lease.control);
        drop(self.stream.take());
        // Lease is dropped only after the resource above, outside the lock.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{atomic::AtomicUsize, mpsc},
        thread,
        time::Duration,
    };

    fn application(id: &str) -> Application {
        Application::new(id.into(), "Fictional meeting player".into()).unwrap()
    }

    struct Stream(Arc<AtomicUsize>);

    impl Drop for Stream {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct SlowRelease {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl Drop for SlowRelease {
        fn drop(&mut self) {
            self.entered.send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(3)).unwrap();
        }
    }

    #[test]
    fn review_discloses_one_application_and_approval_is_consumed_once() {
        let gate = Gate::default();
        let calls = AtomicUsize::new(0);
        let releases = Arc::new(AtomicUsize::new(0));
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
        let mut review = gate.review(application("selected-instance-1")).unwrap();
        assert_eq!(review.application().name(), "Fictional meeting player");
        assert!(review.scope_notice().contains("all windows"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let control = review.control();
        let start = gate.approve(&mut review).unwrap();
        assert!(matches!(
            gate.approve(&mut review),
            Err(Failure::ReviewChanged)
        ));
        drop(review); // Consumed review no longer owns the active operation.
        let capture = start
            .run(|source, cancel| {
                assert_eq!(source.selection_id(), "selected-instance-1");
                assert!(!cancel.is_cancelled());
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(Stream(releases.clone()))
            })
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Capturing);
        assert!(matches!(
            gate.review(application("other")),
            Err(Failure::Busy)
        ));
        assert!(gate.stop(&control).unwrap());
        assert!(control.is_cancelled());
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Stopping);
        assert_eq!(releases.load(Ordering::SeqCst), 0);
        drop(capture);
        assert_eq!(releases.load(Ordering::SeqCst), 1);
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
        assert!(gate.snapshot().unwrap().application.is_none());
    }

    #[test]
    fn changed_selection_and_foreign_reviews_cannot_authorize_capture() {
        let gate = Gate::default();
        let other = Gate::default();
        let mut old = gate
            .review(application("same-visible-name-old-instance"))
            .unwrap();
        let old_control = old.control();
        let mut current = gate
            .review(application("same-visible-name-new-instance"))
            .unwrap();
        assert!(old_control.is_cancelled());
        assert!(matches!(
            gate.approve(&mut old),
            Err(Failure::ReviewChanged)
        ));
        assert!(matches!(
            other.approve(&mut current),
            Err(Failure::ReviewChanged)
        ));
        assert!(!gate.stop(&old_control).unwrap());
        drop(old);
        let capture = gate
            .approve(&mut current)
            .unwrap()
            .run(|source, _| {
                assert_eq!(source.selection_id(), "same-visible-name-new-instance");
                Ok(())
            })
            .unwrap();
        drop(capture);
    }

    #[test]
    fn invalid_or_unreadable_source_metadata_never_creates_a_review() {
        for (id, name) in [
            ("".into(), "Player".into()),
            (" ".into(), "Player".into()),
            ("id".into(), "  ".into()),
            ("x".repeat(257), "Player".into()),
            ("id".into(), "x".repeat(121)),
            ("id\nother".into(), "Player".into()),
            ("id".into(), "Player\u{202e}other".into()),
        ] {
            assert_eq!(Application::new(id, name), Err(Failure::InvalidSource));
        }
        assert!(Application::new("native-token".into(), "Lecteur — Fiction".into()).is_ok());
    }

    #[test]
    fn cancelling_before_worker_entry_never_calls_the_adapter() {
        let gate = Gate::default();
        let mut review = gate.review(application("selected")).unwrap();
        let control = review.control();
        let start = gate.approve(&mut review).unwrap();
        assert!(gate.stop(&control).unwrap());
        assert!(gate.stop(&control).unwrap());
        assert!(matches!(
            gate.review(application("next")),
            Err(Failure::Busy)
        ));
        let calls = AtomicUsize::new(0);
        assert!(matches!(
            start.run(|_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
            Err(Failure::Cancelled)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
        assert!(gate.review(application("explicit-retry")).is_ok());
    }

    #[test]
    fn cancelled_inflight_start_discards_late_stream_and_waits_for_its_release() {
        let gate = Gate::default();
        let mut review = gate.review(application("selected")).unwrap();
        let control = review.control();
        let start = gate.approve(&mut review).unwrap();
        let (entered_tx, entered) = mpsc::channel();
        let (return_stream, return_rx) = mpsc::channel();
        let (dropping_tx, dropping) = mpsc::channel();
        let (release_stream, release_rx) = mpsc::channel();
        let task = thread::spawn(move || {
            start.run(|_, cancellation| {
                entered_tx.send(()).unwrap();
                return_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                assert!(cancellation.is_cancelled());
                Ok(SlowRelease {
                    entered: dropping_tx,
                    release: release_rx,
                })
            })
        });
        entered.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(gate.stop(&control).unwrap());
        assert!(matches!(
            gate.review(application("next")),
            Err(Failure::Busy)
        ));
        return_stream.send(()).unwrap();
        dropping.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Stopping);
        assert!(matches!(
            gate.review(application("next")),
            Err(Failure::Busy)
        ));
        release_stream.send(()).unwrap();
        assert!(matches!(task.join().unwrap(), Err(Failure::Cancelled)));
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
        let mut retry = gate.review(application("explicit-retry")).unwrap();
        assert!(
            !gate.stop(&control).unwrap(),
            "old Stop cannot cancel retry"
        );
        assert!(gate.approve(&mut retry).unwrap().run(|_, _| Ok(())).is_ok());
    }

    #[test]
    fn active_resource_cleanup_keeps_stop_visible_without_holding_the_gate_lock() {
        let gate = Gate::default();
        let mut review = gate.review(application("selected")).unwrap();
        let control = review.control();
        let (dropping_tx, dropping) = mpsc::channel();
        let (release_stream, release_rx) = mpsc::channel();
        let capture = gate
            .approve(&mut review)
            .unwrap()
            .run(|_, _| {
                Ok(SlowRelease {
                    entered: dropping_tx,
                    release: release_rx,
                })
            })
            .unwrap();
        gate.stop(&control).unwrap();
        let task = thread::spawn(move || drop(capture));
        dropping.recv_timeout(Duration::from_secs(3)).unwrap();
        let snapshot = gate.snapshot().unwrap();
        assert_eq!(snapshot.phase, Phase::Stopping);
        assert_eq!(snapshot.application.unwrap().selection_id(), "selected");
        assert!(gate.stop(&control).unwrap());
        assert!(matches!(
            gate.review(application("next")),
            Err(Failure::Busy)
        ));
        release_stream.send(()).unwrap();
        task.join().unwrap();
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
    }

    #[test]
    fn permission_source_and_start_failures_never_retry_or_broaden_scope() {
        for error in [
            Failure::PermissionDenied,
            Failure::SourceUnavailable,
            Failure::StartFailed,
        ] {
            let gate = Gate::default();
            let calls = AtomicUsize::new(0);
            let mut review = gate.review(application("only-selected-source")).unwrap();
            let control = review.control();
            let result = gate.approve(&mut review).unwrap().run(|source, _| {
                assert_eq!(source.selection_id(), "only-selected-source");
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>(error)
            });
            assert!(matches!(result, Err(actual) if actual == error));
            assert_eq!(
                gate.snapshot().unwrap(),
                Snapshot {
                    phase: Phase::Failed,
                    application: None,
                    failure: Some(error),
                }
            );
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert!(control.is_cancelled());
            assert!(matches!(
                gate.approve(&mut review),
                Err(Failure::ReviewChanged)
            ));
            let mut retry = gate.review(application("new-explicit-choice")).unwrap();
            assert!(gate.snapshot().unwrap().failure.is_none());
            assert!(gate.approve(&mut retry).unwrap().run(|_, _| Ok(())).is_ok());
        }
    }

    #[test]
    fn cancelled_denial_does_not_replace_stop_with_a_stale_error() {
        let gate = Gate::default();
        let mut review = gate.review(application("selected")).unwrap();
        let control = review.control();
        let result = gate.approve(&mut review).unwrap().run(|_, _| {
            gate.stop(&control).unwrap();
            Err::<(), _>(Failure::PermissionDenied)
        });
        assert!(matches!(result, Err(Failure::Cancelled)));
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
        assert!(gate.snapshot().unwrap().failure.is_none());
    }

    #[test]
    fn abandoned_review_start_and_panicking_adapter_release_only_their_own_operation() {
        let gate = Gate::default();
        drop(gate.review(application("unused-review")).unwrap());
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
        let mut review = gate.review(application("unused-start")).unwrap();
        drop(gate.approve(&mut review).unwrap());
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
        let mut review = gate.review(application("panicking-adapter")).unwrap();
        let start = gate.approve(&mut review).unwrap();
        assert!(
            thread::spawn(move || start.run::<()>(|_, _| panic!("fictional failure")))
                .join()
                .is_err()
        );
        assert_eq!(gate.snapshot().unwrap().phase, Phase::Idle);
        let other = Gate::default();
        let foreign = other.review(application("same-label")).unwrap();
        let current = gate.review(application("same-label")).unwrap();
        assert!(!gate.stop(&foreign.control()).unwrap());
        assert!(!current.control().is_cancelled());
    }
}
