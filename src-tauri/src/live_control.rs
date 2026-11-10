//! Native startup ownership across model loading and microphone reservation.
//! No device or model is opened here; the same gates accept fictional loaders.
#[cfg(any(feature = "local-whisper", test))]
use crate::{carry_over, engine, Engine};
use crate::{Live, Runtime};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[cfg(any(feature = "local-whisper", test))]
const CANCELLED: &str = "Live session start was cancelled.";

#[derive(Clone, Default)]
pub(crate) struct StartGate(Arc<Mutex<StartState>>);

#[derive(Default)]
struct StartState {
    current: Option<Arc<AtomicBool>>,
    // Retained after the loader exits, through capture and drain. A new
    // explicit start replaces it, so old Stop requests cannot cancel a retry.
    operation: Option<String>,
}

#[derive(Clone)]
#[cfg(any(feature = "local-whisper", test))]
pub(crate) struct StartGuard(Arc<AtomicBool>);

#[cfg(any(feature = "local-whisper", test))]
pub(crate) struct StartTicket {
    gate: StartGate,
    guard: StartGuard,
    operation: String,
}

impl StartGate {
    #[cfg(any(feature = "local-whisper", test))]
    fn begin(&self) -> Result<StartTicket, String> {
        let mut current = self.0.lock().map_err(|_| "Live startup is unavailable.")?;
        if current.current.is_some() {
            return Err(
                "A live session is still starting or cancelling. Wait for it to finish.".into(),
            );
        }
        let flag = Arc::new(AtomicBool::new(false));
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| "Live startup is unavailable.")?;
        let operation: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        current.operation = Some(operation.clone());
        current.current = Some(flag.clone());
        Ok(StartTicket {
            gate: self.clone(),
            guard: StartGuard(flag),
            operation,
        })
    }

    pub(crate) fn cancel(&self) {
        if let Ok(current) = self.0.lock() {
            if let Some(flag) = current.current.as_ref() {
                flag.store(true, Ordering::Release);
            }
        }
    }

    pub(crate) fn control(&self) -> Result<(Option<String>, crate::engine::StartupState), String> {
        use crate::engine::StartupState;
        let state = self.0.lock().map_err(|_| "Live startup is unavailable.")?;
        let phase = match &state.current {
            None => StartupState::Idle,
            Some(flag) if flag.load(Ordering::Acquire) => StartupState::Cancelling,
            Some(_) => StartupState::Loading,
        };
        Ok((state.operation.clone(), phase))
    }

    #[cfg(any(feature = "local-whisper", test))]
    fn accepts(&self, guard: &StartGuard) -> bool {
        self.0.lock().is_ok_and(|current| {
            current
                .current
                .as_ref()
                .is_some_and(|flag| Arc::ptr_eq(flag, &guard.0) && !flag.load(Ordering::Acquire))
        })
    }
}

#[cfg(any(feature = "local-whisper", test))]
impl StartTicket {
    pub(crate) fn guard(&self) -> StartGuard {
        self.guard.clone()
    }

    /// Move the ticket onto the loading worker. Cancelling an async waiter
    /// cannot release the reservation while its blocking loader still runs.
    pub(crate) fn load<T>(
        self,
        load: impl FnOnce() -> Result<T, String>,
    ) -> Result<(Self, T), String> {
        if !self.gate.accepts(&self.guard) {
            return Err(CANCELLED.into());
        }
        let loaded = load()?;
        if !self.gate.accepts(&self.guard) {
            return Err(CANCELLED.into());
        }
        Ok((self, loaded))
    }
}

#[cfg(any(feature = "local-whisper", test))]
impl Drop for StartTicket {
    fn drop(&mut self) {
        if let Ok(mut current) = self.gate.0.lock() {
            if current
                .current
                .as_ref()
                .is_some_and(|flag| Arc::ptr_eq(flag, &self.guard.0))
            {
                current.current = None;
            }
        }
    }
}

impl Runtime {
    #[cfg(any(feature = "local-whisper", test))]
    pub(crate) fn begin_live_start(&mut self) -> Result<StartTicket, String> {
        self.check_live_start()?;
        self.live_start.begin()
    }

    #[cfg(any(feature = "local-whisper", test))]
    fn check_live_start(&self) -> Result<(), String> {
        if self.live.is_some()
            || matches!(
                self.engine.state.status,
                engine::Status::Running | engine::Status::Paused
            )
        {
            return Err(if self.engine.state.live || self.live.is_some() {
                "A live session is already running."
            } else {
                "End the demo before starting a live session."
            }
            .into());
        }
        Ok(())
    }

    #[cfg(any(feature = "local-whisper", test))]
    pub(crate) fn install_live_start(&mut self, ticket: &StartTicket) -> Result<u64, String> {
        if !self.live_start.accepts(&ticket.guard) {
            return Err(CANCELLED.into());
        }
        self.check_live_start()?;
        let mut engine = carry_over(&self.engine, Engine::live());
        engine.start()?;
        self.export = None;
        self.processing_reviews.clear();
        self.engine = engine;
        self.last_tick = std::time::Instant::now();
        let session = self.engine.session();
        self.live = Some(Live {
            operation: Some(ticket.operation.clone()),
            session,
            microphone: None,
            runner: None,
        });
        Ok(session)
    }

    #[cfg(any(feature = "local-whisper", test))]
    pub(crate) fn reserve_live_microphone(
        &mut self,
        guard: &StartGuard,
        session: u64,
        generation: u64,
    ) -> bool {
        if !self.live_start.accepts(guard)
            || !self.engine.state.live
            || self.engine.session() != session
            || self.engine.state.status != engine::Status::Running
        {
            return false;
        }
        let Some(live) = self
            .live
            .as_mut()
            .filter(|live| live.session == session && live.microphone.is_none())
        else {
            return false;
        };
        live.microphone = Some(generation);
        true
    }

    /// Call under the runtime lock BEFORE draining queued transcription.
    pub(crate) fn take_live_for_stop(&mut self) -> Option<Live> {
        self.live_start.cancel();
        self.processing_reviews.clear();
        self.engine.begin_live_stop();
        self.live.take()
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

    #[test]
    fn stop_during_loading_prevents_install_and_blocks_an_overlapping_loader() {
        let runtime = Arc::new(Mutex::new(Runtime::default()));
        let ticket = runtime.lock().unwrap().begin_live_start().unwrap();
        let original_session = runtime.lock().unwrap().engine.session();
        let (entered_tx, entered) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let owner = runtime.clone();
        let task = thread::spawn(move || {
            let (ticket, ()) = ticket.load(|| {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(()) // Fictional loaded model; no device or inference.
            })?;
            owner.lock().unwrap().install_live_start(&ticket)
        });
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        {
            let mut runtime = runtime.lock().unwrap();
            assert!(runtime.begin_live_start().is_err(), "one load at a time");
            assert!(runtime.take_live_for_stop().is_none());
            assert!(
                runtime.take_live_for_stop().is_none(),
                "repeated Stop is safe"
            );
            assert!(
                runtime.begin_live_start().is_err(),
                "cancelled loader still owns resources"
            );
        }
        release.send(()).unwrap();
        assert_eq!(task.join().unwrap().unwrap_err(), CANCELLED);
        let mut runtime = runtime.lock().unwrap();
        assert!(runtime.live.is_none());
        assert_eq!(runtime.engine.session(), original_session);
        assert!(!runtime.engine.state.live);
        let retry = runtime.begin_live_start().unwrap();
        let (retry, ()) = retry.load(|| Ok(())).unwrap();
        assert!(runtime.install_live_start(&retry).is_ok());
    }

    #[test]
    fn cancellation_before_worker_start_skips_loading_and_releases_the_slot() {
        let mut runtime = Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        runtime.take_live_for_stop();
        let calls = AtomicUsize::new(0);
        assert!(ticket
            .load(|| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(runtime.begin_live_start().is_ok());
    }

    #[test]
    fn load_failure_and_worker_panic_release_start_for_explicit_retry() {
        let mut runtime = Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        assert!(ticket
            .load(|| Err::<(), _>("Fictional load failure".into()))
            .is_err());
        let ticket = runtime.begin_live_start().unwrap();
        assert!(thread::spawn(
            move || ticket.load(|| -> Result<(), String> { panic!("fictional loader panic") })
        )
        .join()
        .is_err());
        assert!(runtime.live.is_none());
        let ticket = runtime.begin_live_start().unwrap();
        assert!(runtime.install_live_start(&ticket).is_ok());
    }

    #[test]
    fn foreign_or_cancelled_start_cannot_install_or_claim_a_new_session() {
        let mut runtime = Runtime::default();
        let mut other = Runtime::default();
        let foreign = other.begin_live_start().unwrap();
        assert!(runtime.install_live_start(&foreign).is_err());
        let old = runtime.begin_live_start().unwrap();
        let old_guard = old.guard();
        let old_session = runtime.install_live_start(&old).unwrap();
        assert!(runtime.take_live_for_stop().is_some());
        runtime.engine.end();
        assert!(runtime.install_live_start(&old).is_err());
        drop(old);
        let current = runtime.begin_live_start().unwrap();
        let session = runtime.install_live_start(&current).unwrap();
        assert_ne!(session, old_session);
        assert!(!runtime.reserve_live_microphone(&old_guard, session, 10));
        assert!(!runtime.reserve_live_microphone(&current.guard(), old_session, 10));
        assert!(runtime.reserve_live_microphone(&current.guard(), session, 11));
        assert_eq!(runtime.take_live_for_stop().unwrap().microphone, Some(11));
    }

    #[test]
    fn stop_revokes_processing_before_queued_transcript_drains() {
        use crate::cue_evaluator::{Cancellation, Evaluator, Failure, Request, Worker};
        struct Fictional(Arc<AtomicUsize>);
        impl Evaluator for Fictional {
            fn evaluate(&mut self, _: &Request, _: &Cancellation) -> Result<String, Failure> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(Failure::EvaluatorUnavailable)
            }
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let processor = engine::ProcessorConfiguration::new(
            "fictional".into(),
            1,
            "fixture".into(),
            engine::ProcessingLocation::OnDevice,
            "fictional-policy".into(),
            engine::ProcessorDisclosure::new(
                "Fictional worker".into(),
                "Fictional in-memory test only.".into(),
            )
            .unwrap(),
        )
        .unwrap();
        let mut runtime = Runtime {
            engine: Engine::live_with_evaluator(
                Worker::start(Fictional(calls.clone()), Duration::from_secs(1)).unwrap(),
                processor,
            ),
            ..Runtime::default()
        };
        runtime.engine.start().unwrap();
        runtime
            .engine
            .update_notes("Keep this manual note.".into())
            .unwrap();
        let review = runtime
            .engine
            .review_processing(engine::ConversationScope::NewSpeechOnly, &[])
            .unwrap();
        runtime.engine.approve_processing(review).unwrap();
        let old_review = runtime
            .engine
            .review_processing(engine::ConversationScope::NewSpeechOnly, &[])
            .unwrap();
        let session = runtime.engine.session();
        runtime.live = Some(Live {
            operation: None,
            session,
            microphone: Some(12),
            runner: None,
        });
        let live = runtime.take_live_for_stop().unwrap();
        assert_eq!(live.microphone, Some(12));
        assert!(!runtime.engine.has_processing_permission());
        assert_eq!(
            runtime.engine.approve_processing(old_review),
            Err(engine::ProcessingError::SessionInactive)
        );
        assert!(runtime.engine.is_live_stopping());
        assert!(runtime.engine.set_live_cues_paused(false).is_err());
        assert_eq!(
            runtime
                .engine
                .review_processing(engine::ConversationScope::NewSpeechOnly, &[])
                .unwrap_err(),
            engine::ProcessingError::SessionInactive
        );
        assert_eq!(
            runtime.engine.state.status,
            engine::Status::Running,
            "transcript can drain"
        );
        runtime.engine.advance(10);
        runtime
            .engine
            .ingest(
                session,
                engine::Segment {
                    id: "drained".into(),
                    at_ms: 10,
                    speaker: "Maya".into(),
                    text: "Someone should take the checklist.".into(),
                },
            )
            .unwrap();
        assert_eq!(runtime.engine.state.transcript.len(), 1);
        assert_eq!(runtime.engine.state.notes, "Keep this manual note.");
        assert!(runtime.engine.state.cue.is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(runtime
            .engine
            .evaluation_status()
            .is_some_and(|state| state == engine::EvaluationStatus::Idle));
    }
}
