//! Cross-boundary acceptance: selected import -> Runtime -> native review ->
//! real evaluator worker -> cited cue. All content and processing are fictional.
use crate::{
    context::{ContextItem, Provider},
    cue_evaluator::{Cancellation, Evaluator, Failure, Provenance, Request, Worker},
    engine::{
        CaptureState, ConversationScope, Engine, EvaluationOutcome, EvaluationStatus,
        NoteSelection, ProcessingLocation, ProcessorConfiguration, ProcessorDisclosure, Scope,
        Segment,
    },
    notes_file::FileSource,
    processing_commands::{Error, ExpectedScope},
    Live, Runtime,
};
use std::{
    sync::mpsc::{self, Receiver, Sender, TryRecvError},
    time::{Duration, Instant},
};

const SPEECH: &str = "Can we send the welcome pack on Friday?";
const CUE: &str = "Will the draft be ready Wednesday for the two-day review?";
const A_TEXT: &str = "The welcome pack needs two days of review before delivery.";
const B_TEXT: &str = "The unrelated orchard visit starts at noon.";

/// The worker deliberately ignores cancellation until released, like a reply
/// already in flight. Completion reports whether cancellation reached it.
struct Scripted {
    calls: Sender<Request>,
    replies: Receiver<String>,
    returned: Sender<bool>,
}
impl Evaluator for Scripted {
    fn evaluate(&mut self, request: &Request, cancel: &Cancellation) -> Result<String, Failure> {
        self.calls.send(request.clone()).unwrap();
        let reply = self
            .replies
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| Failure::EvaluatorUnavailable)?;
        self.returned.send(cancel.is_cancelled()).unwrap();
        Ok(reply)
    }
}

struct Harness {
    runtime: Runtime,
    calls: Receiver<Request>,
    replies: Sender<String>,
    returned: Receiver<bool>,
    next_line: u32,
}
impl Harness {
    fn new(provider: Provider) -> Self {
        let (calls_tx, calls) = mpsc::channel();
        let (replies, replies_rx) = mpsc::channel();
        let (returned_tx, returned) = mpsc::channel();
        let processor = ProcessorConfiguration::new(
            "fictional-context-worker".into(),
            1,
            "scripted".into(),
            ProcessingLocation::OnDevice,
            "fictional-policy".into(),
            ProcessorDisclosure::new(
                "Fictional context worker".into(),
                "In-memory scripted test; no external processing.".into(),
            )
            .unwrap(),
        )
        .unwrap();
        let mut runtime = Runtime {
            engine: Engine::live_with_evaluator(
                Worker::start(
                    Scripted {
                        calls: calls_tx,
                        replies: replies_rx,
                        returned: returned_tx,
                    },
                    Duration::from_secs(10),
                )
                .unwrap(),
                processor,
            ),
            ..Runtime::default()
        };
        runtime.engine.start().unwrap();
        runtime.live = Some(Live {
            operation: None,
            session: runtime.engine.session(),
            microphone: None,
            runner: None,
        });
        // A and B are offered by a picked file; only A is selected. Exercise
        // the store's filtering too by including B in a provider's reply.
        let mut source = FileSource::parse(
            &serde_json::json!({"notes": [
                {"id":"a", "title":"Welcome pack review", "date":"2026-11-01", "text":A_TEXT},
                {"id":"b", "title":"Orchard visit", "date":"2026-11-02", "text":B_TEXT}
            ]})
            .to_string(),
        )
        .unwrap();
        let mut fetched =
            crate::context::NoteSource::fetch(&mut source, &["a".into(), "b".into()]).unwrap();
        // Both existing provider mappings traverse exactly the same runtime
        // handoff. This is not a real Granola fetch or a Tactiq adapter.
        for item in &mut fetched {
            item.provider = provider;
            item.revision = 7;
        }
        let (outcome, _) = runtime.merge_imported_notes(provider, &["a".into()], fetched);
        assert_eq!((outcome.added, outcome.rejected), (1, 1));
        assert_eq!(runtime.context.items().len(), 1);
        Self {
            runtime,
            calls,
            replies,
            returned,
            next_line: 0,
        }
    }

    fn a(&self) -> ContextItem {
        self.runtime.context.items()[0].clone()
    }

    fn expected(&mut self) -> ExpectedScope {
        let (snapshot, _) = self
            .runtime
            .processing_status
            .update(&self.runtime.engine, CaptureState::Running);
        ExpectedScope {
            session: snapshot.session,
            scope_revision: snapshot.scope_revision,
        }
    }

    fn prepare(&mut self) -> String {
        let a = self.a();
        let expected = self.expected();
        let review = self
            .runtime
            .review_processing_scope(
                &expected,
                Scope {
                    conversation: ConversationScope::NewSpeechOnly,
                    notes: vec![NoteSelection {
                        provider: a.provider,
                        source_id: a.source_id.clone(),
                        revision: a.revision,
                    }],
                },
            )
            .unwrap();
        assert_eq!(review.notes.len(), 1);
        assert_eq!(review.notes[0].title, a.title);
        review.id
    }

    fn grant(&mut self) {
        let id = self.prepare();
        self.runtime.approve_processing_scope(&id).unwrap();
    }

    fn speech(&mut self) {
        self.runtime.engine.advance(10);
        self.next_line += 1;
        self.runtime
            .engine
            .ingest(
                self.runtime.engine.session(),
                Segment {
                    id: format!("line-{}", self.next_line),
                    at_ms: self.runtime.engine.state.elapsed_ms,
                    speaker: "Maya".into(),
                    text: SPEECH.into(),
                },
            )
            .unwrap();
    }

    fn request(&mut self) -> Request {
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            self.runtime.engine.advance(1);
            match self.calls.try_recv() {
                Ok(request) => return request,
                Err(TryRecvError::Empty) => {
                    assert!(
                        Instant::now() < until,
                        "scripted worker did not receive input"
                    );
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("scripted worker disconnected: {error}"),
            }
        }
    }

    fn no_calls(&mut self) {
        // Without a grant the synchronous engine boundary must never enqueue
        // any work; yielding also lets an erroneous enqueue reach the worker.
        let until = Instant::now() + Duration::from_millis(30);
        while Instant::now() < until {
            self.runtime.engine.advance(1);
            assert!(matches!(self.calls.try_recv(), Err(TryRecvError::Empty)));
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn release_show(&self, request: &Request) -> bool {
        self.replies
            .send(
                serde_json::json!({
                    "action":"show", "cue":CUE,
                    "sourceIds":request.sources().iter().map(|s| &s.id).collect::<Vec<_>>()
                })
                .to_string(),
            )
            .unwrap();
        self.returned.recv_timeout(Duration::from_secs(2)).unwrap()
    }

    fn shown(&mut self) {
        let until = Instant::now() + Duration::from_secs(2);
        while self.runtime.engine.evaluation_status()
            != Some(EvaluationStatus::Decided(EvaluationOutcome::Shown))
        {
            assert!(
                Instant::now() < until,
                "current scripted cue did not appear"
            );
            std::thread::sleep(Duration::from_millis(1));
            self.runtime.engine.advance(1);
        }
        assert_eq!(
            self.runtime.engine.state.cue.as_ref().unwrap().question,
            CUE
        );
    }

    fn replace_a(&mut self) -> bool {
        let mut a = self.a();
        a.revision += 1;
        a.excerpt = "The welcome pack now needs three days of review.".into();
        let (outcome, changed) =
            self.runtime
                .merge_imported_notes(a.provider, &[a.source_id.clone()], vec![a]);
        assert_eq!(outcome.updated, 1);
        changed
    }

    /// A second request is a worker fence: it cannot enter until the old
    /// non-cooperative call returned through the worker's validation/mailbox.
    fn recover_without_stale_cue(&mut self) {
        assert!(self.runtime.engine.state.cue.is_none());
        self.grant();
        self.speech();
        let fresh = self.request();
        assert!(fresh.existing_cue().is_none());
        assert!(self.runtime.engine.state.cue.is_none());
        assert!(!self.release_show(&fresh));
        self.shown();
    }
}

#[test]
fn selected_snapshot_needs_a_separate_grant_and_cites_only_a_and_current_speech() {
    for provider in [Provider::File, Provider::Granola] {
        let mut h = Harness::new(provider);
        h.speech();
        h.no_calls();
        let review = h.prepare();
        h.no_calls();
        h.runtime.approve_processing_scope(&review).unwrap();
        h.no_calls(); // NewSpeechOnly excludes even buffered pre-approval speech.
        h.speech();
        let request = h.request();
        assert_eq!(request.sources().len(), 2);
        let speech = &request.sources()[0];
        assert_eq!(speech.id, "transcript:line-2");
        assert_eq!(speech.text, SPEECH);
        assert!(matches!(speech.provenance, Provenance::Transcript { .. }));
        let prior = &request.sources()[1];
        assert_eq!(prior.id, format!("prior:{}:a", provider.id()));
        assert_eq!(prior.revision, 7);
        assert_eq!(prior.text, A_TEXT);
        assert!(
            matches!(&prior.provenance, Provenance::PriorNote { provider: p, date, title }
            if *p == provider && date == "2026-11-01" && title == "Welcome pack review")
        );
        assert!(!serde_json::to_string(&request).unwrap().contains(B_TEXT));
        assert!(!h.release_show(&request));
        h.shown();
        let payload = serde_json::to_value(h.runtime.engine.cue_snapshot()).unwrap();
        let sources = payload["cue"]["sources"].as_array().unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[1]["text"], A_TEXT);
        assert_eq!(sources[1]["provenance"]["provider"], provider.id());
        assert_eq!(sources[1]["provenance"]["date"], "2026-11-01");
    }
}

#[test]
fn changed_or_removed_import_invalidates_a_held_native_review() {
    for remove in [false, true] {
        let mut h = Harness::new(Provider::File);
        let review = h.prepare();
        if remove {
            assert!(h
                .runtime
                .remove_imported_note(Provider::File, "a")
                .is_some());
        } else {
            h.replace_a();
        }
        assert_eq!(
            h.runtime.approve_processing_scope(&review),
            Err(Error::ScopeChanged)
        );
        h.speech();
        h.no_calls();
        assert!(!h.runtime.engine.has_processing_permission());
    }
}

#[test]
fn changed_or_removed_import_cancels_a_reply_already_in_flight() {
    for remove in [false, true] {
        let mut h = Harness::new(Provider::Granola);
        h.grant();
        h.speech();
        let old = h.request();
        let kept_a = h.a();
        if remove {
            h.runtime
                .remove_imported_note(Provider::Granola, "a")
                .unwrap();
        } else {
            h.replace_a();
        }
        assert!(!h.runtime.engine.has_processing_permission());
        assert!(h.release_show(&old));
        h.no_calls();
        assert!(h.runtime.engine.state.cue.is_none());
        if remove {
            let mut a = kept_a;
            a.revision = 8;
            h.runtime
                .merge_imported_notes(Provider::Granola, &["a".into()], vec![a]);
        }
        h.recover_without_stale_cue();
    }
}

#[test]
fn changed_or_removed_import_retires_a_cue_held_for_reading() {
    for remove in [false, true] {
        let mut h = Harness::new(Provider::File);
        h.grant();
        h.speech();
        let request = h.request();
        h.release_show(&request);
        h.shown();
        let id = h.runtime.engine.state.cue.as_ref().unwrap().id.clone();
        h.runtime.engine.inspect_cue(&id).unwrap();
        assert!(h.runtime.engine.state.cue.as_ref().unwrap().held);
        let changed = if remove {
            h.runtime.remove_imported_note(Provider::File, "a").unwrap()
        } else {
            h.replace_a()
        };
        assert!(changed, "the windows must be told that the held cue left");
        assert!(h.runtime.engine.state.cue.is_none());
        assert!(!h.runtime.engine.has_processing_permission());
    }
}

#[test]
fn stop_or_revoke_rejects_a_late_prior_context_reply() {
    for stop in [false, true] {
        let mut h = Harness::new(Provider::File);
        h.grant();
        h.speech();
        let old = h.request();
        let mut stopped = None;
        if stop {
            stopped = h.runtime.take_live_for_stop();
            assert!(stopped.is_some());
            assert!(h.runtime.engine.is_live_stopping());
            h.speech(); // Native Stop may still drain accepted transcript lines.
        } else {
            let expected = h.expected();
            h.runtime.disable_processing(&expected).unwrap();
        }
        assert!(h.release_show(&old));
        h.no_calls();
        assert!(h.runtime.engine.state.cue.is_none());
        assert!(!h.runtime.engine.has_processing_permission());
        assert_eq!(h.runtime.context.items().len(), 1);
        if let Some(stopped) = stopped {
            assert!(h.runtime.engine.finish_live_stop(stopped.session));
            h.runtime.engine.start().unwrap();
        }
        h.recover_without_stale_cue();
    }
}

#[test]
fn an_older_import_cannot_roll_back_approved_context_or_cancel_its_reply() {
    let mut h = Harness::new(Provider::Granola);
    h.grant();
    h.speech();
    let current = h.request();
    let mut older = h.a();
    older.revision = 6;
    older.excerpt = "An obsolete one-day review requirement.".into();
    let (outcome, changed) =
        h.runtime
            .merge_imported_notes(Provider::Granola, &["a".into()], vec![older]);
    assert_eq!(outcome.unchanged, 1);
    assert!(!changed);
    assert_eq!(h.a().revision, 7);
    assert_eq!(h.a().excerpt, A_TEXT);
    assert!(h.runtime.engine.has_processing_permission());
    assert!(!h.release_show(&current));
    h.shown();
    assert_eq!(
        h.runtime.engine.state.cue.as_ref().unwrap().sources[1].text,
        A_TEXT
    );
}
