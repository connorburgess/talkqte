//! Bounded native review ownership for the future command/event controller.
//! No app command or provider is enabled here. A review ID identifies a stored
//! Rust review; it cannot supply new sources, a destination or an executable.
use crate::{
    context::Provider,
    engine::{ConversationScope, Engine, ProcessingError, ProcessingReview},
};

struct Pending {
    id: String,
    review: ProcessingReview,
    context: [u8; 32],
}

/// At most one pending review per native runtime. No history or excerpts are
/// kept here, and neither this store nor its engine token is serialized.
#[derive(Default)]
pub struct Reviews {
    pending: Option<Pending>,
}

impl Reviews {
    /// Prepare a new exact scope, replacing the previous valid review only
    /// after validation succeeds. This never revokes an existing valid grant.
    pub fn prepare(
        &mut self,
        engine: &Engine,
        conversation: ConversationScope,
        notes: &[(Provider, String, u64)],
    ) -> Result<String, ProcessingError> {
        self.reconcile(engine);
        let review = engine.review_processing(conversation, notes)?;
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| ProcessingError::Unavailable)?;
        let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        self.pending = Some(Pending {
            id: id.clone(),
            review,
            context: engine.processing_context_fingerprint(),
        });
        Ok(id)
    }

    /// Consume only the identified review. Unknown, cancelled and replayed IDs
    /// cannot clear a newer review or change its active processing grant.
    pub fn approve(&mut self, engine: &mut Engine, id: &str) -> Result<(), ProcessingError> {
        self.reconcile(engine);
        if !self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            return Err(ProcessingError::StaleReview);
        }
        engine.approve_processing(self.pending.take().unwrap().review)
    }

    pub fn cancel(&mut self, id: &str) -> bool {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            self.pending = None;
            true
        } else {
            false
        }
    }

    /// Called with the runtime lock after source/control/engine changes. A
    /// changed available source invalidates review, not an unchanged grant.
    pub fn reconcile(&mut self, engine: &Engine) {
        if self.pending.as_ref().is_some_and(|pending| {
            pending.context != engine.processing_context_fingerprint()
                || !engine.processing_review_is_current(&pending.review)
        }) {
            self.clear();
        }
    }

    pub fn clear(&mut self) {
        self.pending = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        context::ContextItem,
        cue_evaluator::{Cancellation, Evaluator, Failure, Request, Worker},
        engine::{ProcessingLocation, ProcessorConfiguration, Segment, Status},
        Live, Runtime,
    };
    use std::{sync::mpsc, time::Duration};

    struct Fictional(mpsc::Sender<Request>);
    impl Evaluator for Fictional {
        fn evaluate(&mut self, request: &Request, _: &Cancellation) -> Result<String, Failure> {
            self.0.send(request.clone()).unwrap();
            Ok(serde_json::json!({
                "action":"quiet", "cue":null, "reason":"Fictional quiet decision",
                "sourceIds":[request.sources()[0].id], "observedUse":"not_observed"
            })
            .to_string())
        }
    }

    fn runtime() -> (Runtime, mpsc::Receiver<Request>) {
        let (tx, rx) = mpsc::channel();
        let processor = ProcessorConfiguration::new(
            "fictional".into(),
            1,
            "fixture".into(),
            ProcessingLocation::OnDevice,
            "fictional-policy".into(),
        )
        .unwrap();
        let mut runtime = Runtime {
            engine: Engine::live_with_evaluator(
                Worker::start(Fictional(tx), Duration::from_secs(5)).unwrap(),
                processor,
            ),
            ..Runtime::default()
        };
        runtime.engine.start().unwrap();
        runtime.live = Some(Live {
            session: runtime.engine.session(),
            microphone: None,
            runner: None,
        });
        (runtime, rx)
    }

    fn note(provider: Provider, id: &str) -> ContextItem {
        ContextItem {
            provider,
            source_id: id.into(),
            revision: 7,
            title: "Fictional garden guide".into(),
            source_date: "2026-11-01".into(),
            excerpt: "The guide needs two days of review.".into(),
        }
    }

    fn prepare(runtime: &mut Runtime, notes: &[ContextItem]) -> String {
        runtime
            .processing_reviews
            .prepare(
                &runtime.engine,
                ConversationScope::NewSpeechOnly,
                &notes
                    .iter()
                    .map(|note| (note.provider, note.source_id.clone(), note.revision))
                    .collect::<Vec<_>>(),
            )
            .unwrap()
    }

    fn approve(runtime: &mut Runtime, id: &str) -> Result<(), ProcessingError> {
        runtime.processing_reviews.approve(&mut runtime.engine, id)
    }

    fn line(runtime: &mut Runtime) {
        runtime.engine.advance(10);
        runtime
            .engine
            .ingest(
                runtime.engine.session(),
                Segment {
                    id: format!("line-{}", runtime.engine.state.elapsed_ms),
                    at_ms: runtime.engine.state.elapsed_ms,
                    speaker: "Maya".into(),
                    text: "Who will review the garden guide?".into(),
                },
            )
            .unwrap();
    }

    #[test]
    fn only_the_latest_review_can_approve_its_exact_scope_once() {
        let (mut r, calls) = runtime();
        let file = note(Provider::File, "one");
        let granola = note(Provider::Granola, "one");
        r.engine.set_notes(vec![file.clone(), granola.clone()]);
        let first = prepare(&mut r, &[file]);
        let latest = prepare(&mut r, &[granola]);
        assert_ne!(first, latest);
        assert_eq!(latest.len(), 64);
        assert!(latest.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(approve(&mut r, &first), Err(ProcessingError::StaleReview));
        assert!(!r.processing_reviews.cancel(&first));
        assert!(!r.engine.has_processing_permission());
        assert!(calls.try_recv().is_err());
        approve(&mut r, &latest).unwrap();
        assert_eq!(approve(&mut r, &latest), Err(ProcessingError::StaleReview));
        assert!(!r.processing_reviews.cancel(&latest));
        assert!(r.engine.has_processing_permission());
        line(&mut r);
        let request = calls.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(request.sources().len(), 2);
        assert_eq!(request.sources()[1].id, "prior:granola:one");
    }

    #[test]
    fn cancelled_unknown_and_foreign_ids_cannot_clear_a_newer_review() {
        let (mut r, _) = runtime();
        let first = prepare(&mut r, &[]);
        assert!(r.processing_reviews.cancel(&first));
        assert_eq!(approve(&mut r, &first), Err(ProcessingError::StaleReview));
        let (mut other, _) = runtime();
        let foreign = prepare(&mut other, &[]);
        let current = prepare(&mut r, &[]);
        for stale in [&first, &foreign, &"unknown".to_string(), &"x".repeat(10000)] {
            assert!(!r.processing_reviews.cancel(stale));
            assert_eq!(approve(&mut r, stale), Err(ProcessingError::StaleReview));
        }
        approve(&mut r, &current).unwrap();
    }

    #[test]
    fn invalid_selection_does_not_discard_a_valid_review_or_approve_a_subset() {
        let (mut r, _) = runtime();
        let original = note(Provider::File, "one");
        r.engine.set_notes(vec![original.clone()]);
        let current = prepare(&mut r, std::slice::from_ref(&original));
        for invalid in [
            vec![(Provider::File, "missing".into(), 7)],
            vec![(Provider::File, "one".into(), 8)],
            vec![(Provider::File, "one".into(), 7); 2],
            vec![(Provider::File, "one".into(), 7); 21],
        ] {
            assert_eq!(
                r.processing_reviews
                    .prepare(&r.engine, ConversationScope::NewSpeechOnly, &invalid),
                Err(ProcessingError::InvalidScope)
            );
            assert!(!r.engine.has_processing_permission());
        }
        approve(&mut r, &current).unwrap();
    }

    #[test]
    fn any_available_note_change_invalidates_review_even_with_a_reused_revision() {
        for selected in [false, true] {
            for change in [
                "text", "title", "date", "revision", "provider", "removed", "added",
            ] {
                let (mut r, _) = runtime();
                let mut item = note(Provider::File, "one");
                r.engine.set_notes(vec![item.clone()]);
                let id = prepare(
                    &mut r,
                    if selected {
                        std::slice::from_ref(&item)
                    } else {
                        &[]
                    },
                );
                match change {
                    "text" => item.excerpt = "Updated fictional context.".into(),
                    "title" => item.title = "Fictional spring guide".into(),
                    "date" => item.source_date = "2026-11-02".into(),
                    "revision" => item.revision += 1,
                    "provider" => item.provider = Provider::Granola,
                    _ => (),
                }
                r.engine.set_notes(match change {
                    "removed" => vec![],
                    "added" => vec![item, note(Provider::Granola, "two")],
                    _ => vec![item],
                });
                assert_eq!(
                    approve(&mut r, &id),
                    Err(ProcessingError::StaleReview),
                    "{selected}: {change}"
                );
                assert!(!r.engine.has_processing_permission());
            }
        }
    }

    #[test]
    fn ordering_and_manual_notes_preserve_review_but_removed_then_restored_sources_do_not() {
        let (mut r, _) = runtime();
        let a = note(Provider::File, "one");
        let b = note(Provider::Granola, "two");
        r.engine.set_notes(vec![a.clone(), b.clone()]);
        let id = prepare(&mut r, std::slice::from_ref(&a));
        r.engine.set_notes(vec![b.clone(), a.clone()]);
        r.engine
            .update_notes("An unsent manual draft.".into())
            .unwrap();
        approve(&mut r, &id).unwrap();
        let pending = prepare(&mut r, std::slice::from_ref(&a));
        r.engine.set_notes(vec![a.clone()]);
        r.processing_reviews.reconcile(&r.engine);
        r.engine.set_notes(vec![a, b]);
        assert_eq!(approve(&mut r, &pending), Err(ProcessingError::StaleReview));
        assert!(
            r.engine.has_processing_permission(),
            "unchanged grant stays valid"
        );
        assert_eq!(r.engine.state.notes, "An unsent manual draft.");
    }

    #[test]
    fn session_engine_pause_and_revoke_changes_retire_pending_reviews() {
        for action in ["replay", "replace", "pause", "revoke"] {
            let (mut r, _) = runtime();
            let id = prepare(&mut r, &[]);
            match action {
                "replay" => {
                    r.engine.end();
                    r.engine.start().unwrap();
                }
                "replace" => {
                    let (next, _) = runtime();
                    r.engine = next.engine;
                }
                "pause" => r.engine.set_live_cues_paused(true).unwrap(),
                "revoke" => r.engine.revoke_processing(),
                _ => unreachable!(),
            }
            r.sync();
            if action == "pause" {
                r.engine.set_live_cues_paused(false).unwrap();
            }
            assert_eq!(
                approve(&mut r, &id),
                Err(ProcessingError::StaleReview),
                "{action}"
            );
            assert!(!r.engine.has_processing_permission());
            let fresh = prepare(&mut r, &[]);
            approve(&mut r, &fresh).unwrap();
        }
    }

    #[test]
    fn stop_keeps_transcript_drain_open_but_blocks_fresh_processing_until_a_new_session() {
        let (mut r, calls) = runtime();
        let approved = prepare(&mut r, &[]);
        approve(&mut r, &approved).unwrap();
        let pending = prepare(&mut r, &[]);
        let session = r.engine.session();
        let stopped = r.take_live_for_stop().unwrap();
        assert_eq!(stopped.session, session);
        assert!(r.engine.is_live_stopping());
        let revision = r.engine.state.revision;
        assert!(r.take_live_for_stop().is_none());
        assert_eq!(
            r.engine.state.revision, revision,
            "repeated Stop is idempotent"
        );
        assert_eq!(approve(&mut r, &pending), Err(ProcessingError::StaleReview));
        assert_eq!(
            r.processing_reviews
                .prepare(&r.engine, ConversationScope::NewSpeechOnly, &[]),
            Err(ProcessingError::SessionInactive)
        );
        assert!(r.engine.set_live_cues_paused(false).is_err());
        assert!(r.engine.start().is_err());
        r.engine.revoke_processing();
        assert!(
            r.engine.is_live_stopping(),
            "Disable cannot reopen a draining session"
        );
        line(&mut r);
        assert_eq!(r.engine.state.status, Status::Running);
        assert_eq!(r.engine.state.transcript.len(), 1);
        assert!(r.engine.state.cue.is_none());
        assert!(matches!(
            calls.recv_timeout(Duration::from_millis(30)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        r.engine.end();
        r.engine.start().unwrap();
        assert_ne!(r.engine.session(), session);
        assert!(!r.engine.is_live_stopping());
        assert_eq!(approve(&mut r, &pending), Err(ProcessingError::StaleReview));
        let fresh = prepare(&mut r, &[]);
        approve(&mut r, &fresh).unwrap();
        line(&mut r);
        assert!(calls.recv_timeout(Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn ordinary_app_engines_offer_no_review_or_implicit_adapter() {
        for engine in [Engine::default(), Engine::live()] {
            let mut engine = engine;
            engine.start().unwrap();
            let mut reviews = Reviews::default();
            assert_eq!(
                reviews.prepare(&engine, ConversationScope::NewSpeechOnly, &[]),
                Err(ProcessingError::Unavailable)
            );
            assert_eq!(
                reviews.approve(&mut engine, "unknown"),
                Err(ProcessingError::StaleReview)
            );
            assert!(!engine.has_processing_permission());
        }
    }

    #[test]
    fn late_cleanup_cannot_end_or_unlock_a_replacement_session() {
        let (mut r, _) = runtime();
        let old = r.take_live_for_stop().unwrap();
        // Explicit End permits a new session while old native cleanup returns.
        r.engine.end();
        let (mut next, _) = runtime();
        next.engine.end();
        r.engine = crate::carry_over(&r.engine, next.engine);
        r.engine.start().unwrap();
        r.live = Some(Live {
            session: r.engine.session(),
            microphone: None,
            runner: None,
        });
        let pending = prepare(&mut r, &[]);
        assert_ne!(r.engine.session(), old.session);
        assert!(!r.engine.finish_live_stop(old.session));
        r.processing_reviews.reconcile(&r.engine);
        approve(&mut r, &pending).unwrap();
        let current = r.take_live_for_stop().unwrap();
        assert!(!r.engine.finish_live_stop(old.session));
        assert!(r.engine.is_live_stopping());
        assert!(r.engine.finish_live_stop(current.session));
        assert_eq!(r.engine.state.status, Status::Ended);
        assert!(!r.engine.is_live_stopping());
        let revision = r.engine.state.revision;
        assert!(!r.engine.finish_live_stop(current.session));
        assert_eq!(r.engine.state.revision, revision);
    }

    #[test]
    fn a_delayed_reply_cannot_restore_processing_while_stop_drains_speech() {
        struct Delayed {
            entered: mpsc::Sender<()>,
            release: mpsc::Receiver<()>,
            finished: mpsc::Sender<bool>,
        }
        impl Evaluator for Delayed {
            fn evaluate(
                &mut self,
                request: &Request,
                cancel: &Cancellation,
            ) -> Result<String, Failure> {
                self.entered.send(()).unwrap();
                self.release.recv_timeout(Duration::from_secs(2)).unwrap();
                self.finished.send(cancel.is_cancelled()).unwrap();
                Ok(serde_json::json!({
                    "action":"show", "cue":"Who will review the garden guide?",
                    "sourceIds":[request.sources()[0].id], "reason":"Fictional delayed reply",
                    "observedUse":"not_observed"
                })
                .to_string())
            }
        }
        let (entered_tx, entered) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let (finished_tx, finished) = mpsc::channel();
        let processor = ProcessorConfiguration::new(
            "fictional".into(),
            1,
            "fixture".into(),
            ProcessingLocation::OnDevice,
            "fictional-policy".into(),
        )
        .unwrap();
        let mut r = Runtime {
            engine: Engine::live_with_evaluator(
                Worker::start(
                    Delayed {
                        entered: entered_tx,
                        release: release_rx,
                        finished: finished_tx,
                    },
                    Duration::from_secs(5),
                )
                .unwrap(),
                processor,
            ),
            ..Runtime::default()
        };
        r.engine.start().unwrap();
        r.live = Some(Live {
            session: r.engine.session(),
            microphone: None,
            runner: None,
        });
        let id = prepare(&mut r, &[]);
        approve(&mut r, &id).unwrap();
        line(&mut r);
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        let stopped = r.take_live_for_stop().unwrap();
        line(&mut r);
        release.send(()).unwrap();
        assert!(finished.recv_timeout(Duration::from_secs(2)).unwrap());
        // Give the cancelled worker its return boundary; the transcript is
        // deliberately still draining, with no End call to hide the race.
        assert!(matches!(
            entered.recv_timeout(Duration::from_millis(30)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        r.engine.advance(10);
        assert!(r.engine.is_live_stopping());
        assert_eq!(r.engine.state.transcript.len(), 2);
        assert!(r.engine.state.cue.is_none());
        assert!(!r.engine.has_processing_permission());
        assert!(r.engine.finish_live_stop(stopped.session));
    }
}
