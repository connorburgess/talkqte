//! Kept meetings as prior context, with fictional meetings in temporary
//! folders only. No provider, account or network is used: the cue processor
//! here is an in-memory stand-in that records what it was given.

use super::*;
use crate::{
    context::{ContextItem, Provider},
    cue_evaluator::{Cancellation, Evaluator, Failure, Provenance, Request, Worker},
    engine::{ConversationScope, Engine, ProcessingLocation, ProcessorConfiguration, Segment},
    meeting_history::{Content, Line, Sources, Store},
    processing_commands::{Error as CommandError, ExpectedScope},
    Live, Runtime,
};
use std::{path::PathBuf, sync::mpsc, time::Duration};

const LEGAL: &str = "Legal said review takes two days.";
const SECRET_LINE: &str = "The fictional padlock code is 4417.";
/// 2 November 2026, 23:30 UTC.
const LATE: u64 = 1_793_662_200_000;

struct Folder(PathBuf);
impl Folder {
    fn new(name: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "talkqte-meeting-context-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        Self(path)
    }
    fn store(&self) -> Store {
        Store::open(Some(self.0.join("meetings")), false)
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn content(notes: &str, meeting_notes: Option<&str>) -> Content {
    Content {
        started_at_ms: LATE,
        duration_ms: 1_200_000,
        sources: Sources::Microphone,
        application: None,
        transcribed_by: Some("Deepgram".into()),
        transcript: vec![Line {
            at_ms: 1_000,
            label: None,
            echo: false,
            text: SECRET_LINE.into(),
        }],
        notes: notes.into(),
        cues: vec![],
        meeting_notes: meeting_notes.map(str::to_string),
    }
}

fn meeting(title: &str, content: Content) -> Meeting {
    Meeting {
        id: "0123456789abcdef0123456789abcdef".into(),
        title: title.into(),
        revision: 3,
        content,
    }
}

#[test]
fn a_meeting_brings_its_meeting_notes_then_the_persons_notes_and_never_its_transcript() {
    let both = meeting(
        "Welcome pack review",
        content(
            "Ask about Friday.",
            Some(&format!("## Decisions\n\n- {LEGAL}")),
        ),
    );
    assert_eq!(
        excerpt(&both).unwrap(),
        format!("Meeting notes:\n## Decisions\n\n- {LEGAL}\n\nYour notes:\nAsk about Friday.")
    );
    let notes_only = meeting("Welcome pack review", content(LEGAL, None));
    assert_eq!(
        excerpt(&notes_only).unwrap(),
        format!("Your notes:\n{LEGAL}")
    );
    let kept_only = meeting("Welcome pack review", content("  ", Some(LEGAL)));
    assert_eq!(
        excerpt(&kept_only).unwrap(),
        format!("Meeting notes:\n{LEGAL}")
    );
    // Nothing to bring: a transcript alone is never used.
    assert_eq!(excerpt(&meeting("Silent", content(" \n", None))), None);
    for text in [excerpt(&both), excerpt(&notes_only)].into_iter().flatten() {
        assert!(!text.contains("padlock"));
    }
    // Bounded like any imported note.
    let long = meeting("Long", content(&"n".repeat(5_000), None));
    assert_eq!(
        excerpt(&long).unwrap().chars().count(),
        crate::context::MAX_EXCERPT_CHARS
    );
}

#[test]
fn the_date_is_the_persons_local_date() {
    let late = meeting("Late", content("x", None));
    assert_eq!(local_date(&late, 0).as_deref(), Some("2026-11-02"));
    assert_eq!(local_date(&late, 60).as_deref(), Some("2026-11-03"));
    assert_eq!(local_date(&late, -300).as_deref(), Some("2026-11-02"));
    assert_eq!(local_date(&late, 100_000), None);
}

#[test]
fn the_chooser_lists_meetings_with_notes_and_imports_only_those_chosen() {
    let folder = Folder::new("chooser");
    let store = folder.store();
    let with_notes = store
        .keep("Welcome pack review", content(LEGAL, None))
        .unwrap();
    store.keep("No notes", content("", None)).unwrap();
    let other = store
        .keep(
            "Orchard visit",
            content("Bring ladders.", Some("- Visit on Sunday.")),
        )
        .unwrap();
    let mut source = MeetingSource::read(&store, 0);
    assert_eq!(source.skipped, 1, "the meeting with nothing to bring");
    let listed: Vec<_> = source.summaries();
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().all(|note| !note.preview.contains("padlock")));
    let fetched = source.fetch(std::slice::from_ref(&with_notes.id)).unwrap();
    assert_eq!(fetched.len(), 1);
    assert_eq!(
        fetched[0],
        ContextItem {
            provider: Provider::Meeting,
            source_id: with_notes.id.clone(),
            title: "Welcome pack review".into(),
            source_date: "2026-11-02".into(),
            excerpt: format!("Your notes:\n{LEGAL}"),
            revision: 1,
        }
    );
    assert!(!fetched.iter().any(|item| item.source_id == other.id));

    // A lab run lists nothing.
    let lab = Store::open(Some(folder.0.join("meetings")), true);
    assert!(MeetingSource::read(&lab, 0).summaries().is_empty());
}

struct Recording(mpsc::Sender<Request>);
impl Evaluator for Recording {
    fn evaluate(&mut self, request: &Request, _: &Cancellation) -> Result<String, Failure> {
        self.0.send(request.clone()).unwrap();
        Ok(serde_json::json!({
            "action": "quiet", "cue": null, "sourceIds": [request.sources()[0].id]
        })
        .to_string())
    }
}

fn runtime(accepts_notes: bool) -> (Runtime, mpsc::Receiver<Request>) {
    let (tx, rx) = mpsc::channel();
    let processor = ProcessorConfiguration::new(
        "fictional".into(),
        1,
        "fixture".into(),
        ProcessingLocation::OnDevice,
        "fictional-policy".into(),
        crate::engine::ProcessorDisclosure::new(
            "Fictional worker".into(),
            "Fictional in-memory test only.".into(),
        )
        .unwrap(),
    )
    .unwrap();
    let processor = if accepts_notes {
        processor
    } else {
        processor.without_notes()
    };
    let mut runtime = Runtime {
        engine: Engine::live_with_evaluator(
            Worker::start(Recording(tx), Duration::from_secs(5)).unwrap(),
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
    (runtime, rx)
}

fn imported(runtime: &mut Runtime) -> ContextItem {
    let folder = Folder::new("runtime");
    let store = folder.store();
    let kept = store
        .keep("Welcome pack review", content(LEGAL, None))
        .unwrap();
    let mut source = MeetingSource::read(&store, 0);
    let fetched = source.fetch(std::slice::from_ref(&kept.id)).unwrap();
    let (outcome, _) = runtime.merge_imported_notes(Provider::Meeting, &[kept.id], fetched);
    assert_eq!(outcome.added, 1, "{outcome:?}");
    runtime.context.items()[0].clone()
}

fn expected(runtime: &mut Runtime) -> ExpectedScope {
    let (snapshot, _) = runtime
        .processing_status
        .update(&runtime.engine, crate::engine::CaptureState::Running);
    ExpectedScope {
        session: snapshot.session,
        scope_revision: snapshot.scope_revision,
    }
}

fn scope(notes: &[ContextItem]) -> crate::engine::Scope {
    crate::engine::Scope {
        conversation: ConversationScope::NewSpeechOnly,
        notes: notes
            .iter()
            .map(|note| crate::engine::NoteSelection {
                provider: note.provider,
                source_id: note.source_id.clone(),
                revision: note.revision,
            })
            .collect(),
    }
}

fn say(runtime: &mut Runtime, text: &str) {
    runtime.engine.advance(10);
    let at_ms = runtime.engine.state.elapsed_ms;
    runtime
        .engine
        .ingest(
            runtime.engine.session(),
            Segment {
                id: format!("line-{at_ms}"),
                at_ms,
                speaker: "Speaker".into(),
                text: text.into(),
            },
        )
        .unwrap();
}

#[test]
fn a_chosen_meeting_is_sent_only_when_the_review_includes_it_and_cites_that_meeting() {
    let (mut r, calls) = runtime(true);
    let item = imported(&mut r);

    // Imported but not selected in the review: the request carries no note.
    let guard = expected(&mut r);
    let review = r.review_processing_scope(&guard, scope(&[])).unwrap();
    assert!(review.notes.is_empty());
    r.approve_processing_scope(&review.id).unwrap();
    say(&mut r, "Can we send the welcome pack on Friday?");
    let request = calls.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(request
        .sources()
        .iter()
        .all(|source| matches!(source.provenance, Provenance::Transcript { .. })));
    r.engine.revoke_processing();

    // Selected: the review names the meeting, and the request carries
    // exactly its bounded text with its title, date and provider.
    let guard = expected(&mut r);
    let review = r
        .review_processing_scope(&guard, scope(std::slice::from_ref(&item)))
        .unwrap();
    assert_eq!(review.notes.len(), 1);
    assert_eq!(review.notes[0].source.provider, Provider::Meeting);
    r.approve_processing_scope(&review.id).unwrap();
    while calls.try_recv().is_ok() {}
    say(&mut r, "So can the welcome pack go out on Friday?");
    let request = calls.recv_timeout(Duration::from_secs(2)).unwrap();
    let prior: Vec<_> = request
        .sources()
        .iter()
        .filter_map(|source| match &source.provenance {
            Provenance::PriorNote {
                provider,
                date,
                title,
            } => Some((*provider, date.clone(), title.clone(), source.text.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        prior,
        vec![(
            Provider::Meeting,
            "2026-11-02".to_string(),
            "Welcome pack review".to_string(),
            format!("Your notes:\n{LEGAL}"),
        )]
    );
    assert!(!format!("{:?}", request.sources()).contains("padlock"));
}

#[test]
fn the_own_key_connection_never_takes_a_chosen_meeting() {
    let (mut r, _calls) = runtime(false);
    let item = imported(&mut r);
    let guard = expected(&mut r);
    assert_eq!(
        r.review_processing_scope(&guard, scope(std::slice::from_ref(&item)))
            .err(),
        Some(CommandError::InvalidScope)
    );
}

#[test]
fn removing_a_chosen_meeting_takes_it_out_of_the_session() {
    let (mut r, _calls) = runtime(true);
    let item = imported(&mut r);
    assert!(r
        .remove_imported_note(Provider::Meeting, &item.source_id)
        .is_some());
    assert!(r.context.items().is_empty());
    let guard = expected(&mut r);
    assert!(r
        .review_processing_scope(&guard, scope(std::slice::from_ref(&item)))
        .is_err());
}

#[test]
fn a_session_whose_cue_model_takes_no_prior_notes_sends_nothing_from_a_chosen_meeting() {
    let line = "Let us get the welcome pack review sorted before the garden day.";
    // A session with a cue model that takes no prior notes (the own-key
    // connection): the model decides, the rule does not run, and the
    // meeting is never sent.
    let (mut r, calls) = runtime(false);
    imported(&mut r);
    let guard = expected(&mut r);
    let review = r.review_processing_scope(&guard, scope(&[])).unwrap();
    r.approve_processing_scope(&review.id).unwrap();
    say(&mut r, line);
    let request = calls.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(request
        .sources()
        .iter()
        .all(|source| matches!(source.provenance, Provenance::Transcript { .. })));
    assert!(!format!("{:?}", request.sources()).contains("Legal said"));
    assert!(r
        .engine
        .state
        .cue
        .as_ref()
        .is_none_or(|cue| cue.note.is_none()));
}
