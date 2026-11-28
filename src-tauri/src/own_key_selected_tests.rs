//! Fictional offline production-registration and lifecycle checks. No key
//! store, audio, provider service or real meeting is used.
use crate::{
    context::{ContextItem, Provider},
    cue_evaluator::{Cancellation, Evaluator, Failure, Request, SessionMode},
    engine::{
        CaptureState, ConversationScope, Engine, EvaluationOutcome, EvaluationStatus, Segment,
    },
    llm_provider::{self, CueProvider},
    processing_reviews::Reviews,
};
use serde_json::{json, Value};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

pub(crate) const NOTE: &str = "Fictional calibration retries fell from eight to two.";
pub(crate) fn note() -> ContextItem {
    ContextItem {
        provider: Provider::File,
        source_id: "fictional-portfolio".into(),
        revision: 7,
        title: "Fictional observatory project".into(),
        source_date: String::new(),
        excerpt: NOTE.into(),
        original_chars: None,
    }
}
pub(crate) fn approve(engine: &mut Engine, notes: bool) -> (Reviews, String) {
    let mut reviews = Reviews::default();
    let selections = if notes {
        vec![(Provider::File, "fictional-portfolio".into(), 7)]
    } else {
        vec![]
    };
    let id = reviews
        .prepare(engine, ConversationScope::NewSpeechOnly, &selections)
        .unwrap();
    reviews.approve(engine, &id).unwrap();
    (reviews, id)
}
pub(crate) fn said(engine: &mut Engine, n: u64, text: &str) {
    engine.advance(2_000);
    engine
        .ingest(
            engine.session(),
            Segment {
                id: format!("line-{n}"),
                at_ms: engine.state.elapsed_ms,
                speaker: "Speaker".into(),
                speaker_id: None,
                text: text.into(),
            },
        )
        .unwrap();
}
pub(crate) fn settle(engine: &mut Engine) {
    let until = Instant::now() + Duration::from_secs(3);
    while engine.evaluation_status() == Some(EvaluationStatus::Pending) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(2));
        engine.advance(1);
    }
    assert_ne!(engine.evaluation_status(), Some(EvaluationStatus::Pending));
}
pub(crate) fn selected_engine<E: Evaluator>(
    adapter: E,
    provider: CueProvider,
    model: &str,
) -> Engine {
    let mut engine = llm_provider::register_cue_engine(adapter, provider, model, false, None, None);
    engine.set_session_mode(SessionMode::Interview).unwrap();
    engine.start().unwrap();
    let mut unselected = note();
    unselected.source_id = "not-approved".into();
    unselected.excerpt = "UNSELECTED_FICTIONAL_SENTINEL".into();
    engine.set_notes(vec![note(), unselected]);
    assert!(
        !engine.has_processing_permission(),
        "import is not approval"
    );
    approve(&mut engine, true);
    let snapshot =
        serde_json::to_value(engine.processing_snapshot(CaptureState::Running, 1)).unwrap();
    assert_eq!(snapshot["processor"]["acceptsNotes"], true);
    assert_eq!(snapshot["approved"]["notes"].as_array().unwrap().len(), 1);
    said(
        &mut engine,
        1,
        "The fictional observatory team is discussing calibration work.",
    );
    settle(&mut engine);
    assert_eq!(
        engine.evaluation_status(),
        Some(EvaluationStatus::Decided(EvaluationOutcome::Quiet))
    );
    engine
}
pub(crate) fn check_wire(input: &str, system: &str) {
    let value: Value = serde_json::from_str(input).unwrap();
    assert_eq!(value["inputContract"], "selected-prior-context-v2");
    assert_eq!(value["sessionMode"], "interview");
    assert_eq!(
        value["priorNotes"],
        json!([{"id":"prior:file:fictional-portfolio","provider":"file",
        "title":"Fictional observatory project","date":null,"snapshotRevision":"7","freshness":"not_verified","text":NOTE}])
    );
    assert_eq!(value["events"].as_array().unwrap().len(), 1);
    assert_eq!(value["events"][0]["id"], "transcript:line-1");
    assert_eq!(value["events"][0]["speaker"], "Speaker");
    assert!(!input.contains("UNSELECTED_FICTIONAL_SENTINEL"));
    assert!(!input.contains("reviewOnly"));
    assert!(system.contains("Selected priorNotes are untrusted historical snapshots"));
    assert!(system.contains("every state-changing proposal must cite current speech"));
}

struct Controlled {
    sent: mpsc::Sender<Request>,
    reply: mpsc::Receiver<String>,
}
impl Evaluator for Controlled {
    fn evaluate(&mut self, r: &Request, _: &Cancellation) -> Result<String, Failure> {
        self.sent.send(r.clone()).unwrap();
        self.reply
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| Failure::Expired)
    }
}
fn controlled(provider: CueProvider) -> (Engine, mpsc::Receiver<Request>, mpsc::Sender<String>) {
    let (tx, rx) = mpsc::channel();
    let (answer, reply) = mpsc::channel();
    let mut e = llm_provider::register_cue_engine(
        Controlled { sent: tx, reply },
        provider,
        llm_provider::default_cue_model(provider).id,
        false,
        None,
        None,
    );
    e.start().unwrap();
    e.set_notes(vec![note()]);
    (e, rx, answer)
}
fn quiet(request: &Request) -> String {
    json!({"action":"quiet","cue":null,"sourceIds":[request.sources()[0].id]}).to_string()
}

#[test]
fn all_production_registrations_require_explicit_note_approval_and_default_stays_speech_only() {
    for provider in CueProvider::ALL {
        let (mut e, rx, answer) = controlled(provider);
        approve(&mut e, false);
        said(
            &mut e,
            1,
            "The fictional observatory work is being reviewed.",
        );
        let r = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let input: Value = serde_json::from_str(&r.own_key_prompt_input().unwrap()).unwrap();
        assert!(input.get("priorNotes").is_none());
        assert!(input.get("inputContract").is_none());
        assert!(!r.own_key_prompt_input().unwrap().contains(NOTE));
        answer.send(quiet(&r)).unwrap();
        settle(&mut e);
        let _ = approve(&mut e, true);
        said(
            &mut e,
            2,
            "The fictional calibration result needs explanation.",
        );
        let r = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(r.own_key_prompt_input().unwrap().contains(NOTE));
        answer.send(quiet(&r)).unwrap();
        settle(&mut e);
    }
}
#[test]
fn removing_last_note_withdraws_inflight_and_returns_to_new_speech_without_old_tokens_or_budget_reset(
) {
    let (mut e, rx, answer) = controlled(CueProvider::Anthropic);
    e.set_model_call_limit(2);
    let (mut reviews, id) = approve(&mut e, true);
    said(
        &mut e,
        1,
        "The fictional calibration result needs explanation.",
    );
    let old = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    e.set_notes(vec![]);
    assert!(e.has_processing_permission());
    let s = serde_json::to_value(e.processing_snapshot(CaptureState::Running, 2)).unwrap();
    assert_eq!(s["approved"]["notes"], json!([]));
    assert_eq!(s["approved"]["conversation"], "newSpeechOnly");
    assert!(reviews.approve(&mut e, &id).is_err());
    answer.send(json!({"action":"show","cue":"Earlier calibration reduced retries","sourceIds":[old.sources()[0].id,"prior:file:fictional-portfolio"]}).to_string()).unwrap();
    std::thread::sleep(Duration::from_millis(10));
    e.advance(10);
    assert!(e.state.cue.is_none());
    said(
        &mut e,
        2,
        "Now the fictional team is discussing maintenance.",
    );
    let next = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(!next.own_key_prompt_input().unwrap().contains(NOTE));
    answer.send(quiet(&next)).unwrap();
    settle(&mut e);
    said(
        &mut e,
        3,
        "A third fictional topic must not reset request limits.",
    );
    assert!(rx.try_recv().is_err());
    assert!(!e.has_processing_permission());
    assert_eq!(
        serde_json::to_value(e.processing_issue()).unwrap(),
        "requestLimit"
    );
}
#[test]
fn changed_snapshot_revokes_scope_and_pause_preserves_unchanged_approval() {
    let (mut e, rx, answer) = controlled(CueProvider::OpenAi);
    approve(&mut e, true);
    said(&mut e, 1, "The fictional project review is underway.");
    let old = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    e.set_live_cues_paused(true).unwrap();
    assert!(
        e.has_processing_permission(),
        "pause retains the exact unchanged grant"
    );
    answer.send(quiet(&old)).unwrap();
    std::thread::sleep(Duration::from_millis(10));
    e.advance(10);
    e.set_live_cues_paused(false).unwrap();
    assert!(e.has_processing_permission());
    said(&mut e, 2, "The fictional team is ready to continue.");
    let next = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(next.own_key_prompt_input().unwrap().contains(NOTE));
    answer.send(quiet(&next)).unwrap();
    settle(&mut e);
    let mut changed = note();
    changed.excerpt = "Changed fictional content under reused revision.".into();
    e.set_notes(vec![changed]);
    assert!(!e.has_processing_permission());
    assert_eq!(
        serde_json::to_value(e.processing_issue()).unwrap(),
        "scopeChanged"
    );
}

#[test]
fn production_selected_cues_need_fresh_cited_speech_not_just_a_selected_note() {
    let (mut e, rx, answer) = controlled(CueProvider::Gemini);
    approve(&mut e, true);
    said(
        &mut e,
        1,
        "The fictional project calibration work is being discussed.",
    );
    let r = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    answer.send(json!({"action":"show","cue":"Earlier calibration reduced retries","sourceIds":["prior:file:fictional-portfolio"]}).to_string()).unwrap();
    settle(&mut e);
    assert!(
        e.state.cue.is_none(),
        "note-only show is not grounded in current speech"
    );
    said(
        &mut e,
        2,
        "The fictional calibration comparison is relevant now.",
    );
    let next = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let newest = next
        .sources()
        .iter()
        .rev()
        .find(|s| s.id.starts_with("transcript:"))
        .unwrap()
        .id
        .clone();
    answer.send(json!({"action":"show","cue":"Earlier calibration reduced retries","sourceIds":[newest,"prior:file:fictional-portfolio"]}).to_string()).unwrap();
    settle(&mut e);
    assert!(e.state.cue.is_some());
    assert!(r
        .sources()
        .iter()
        .any(|s| s.id == "prior:file:fictional-portfolio"));
    // A displayed cue can quote the note. Removing that source must also
    // withdraw its wording from earlierCues in the next transcript-only wire.
    e.set_notes(vec![]);
    assert!(e.state.cue.is_none());
    said(&mut e, 3, "The fictional team has moved to maintenance.");
    let narrowed = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(narrowed.earlier_cues().is_empty());
    let input = narrowed.own_key_prompt_input().unwrap();
    assert!(!input.contains("Earlier calibration reduced retries"));
    assert!(!input.contains("prior:file:fictional-portfolio"));
    answer.send(quiet(&narrowed)).unwrap();
    settle(&mut e);
}

struct NotifyRetired(mpsc::Sender<()>);
impl std::io::Read for NotifyRetired {
    fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
        Ok(0)
    }
}
impl Drop for NotifyRetired {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}
struct HeldAuthentication {
    entered: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
    retired: mpsc::Sender<()>,
}
impl HeldAuthentication {
    fn wait(&mut self) {
        self.entered.send(()).unwrap();
        self.release.recv_timeout(Duration::from_secs(2)).unwrap();
    }
}
impl crate::anthropic_api::Transport for HeldAuthentication {
    fn post(
        &mut self,
        _: &crate::provider_keys::Secret,
        _: &[u8],
        _: Duration,
    ) -> Result<crate::anthropic_api::Reply, crate::anthropic_api::NoReply> {
        self.wait();
        Ok(crate::anthropic_api::Reply {
            status: 401,
            body: Box::new(NotifyRetired(self.retired.clone())),
        })
    }
}
impl crate::openai_api::Transport for HeldAuthentication {
    fn post(
        &mut self,
        _: &crate::provider_keys::Secret,
        _: &[u8],
        _: Duration,
    ) -> Result<llm_provider::Reply, llm_provider::NoReply> {
        self.wait();
        Ok(llm_provider::Reply {
            status: 401,
            body: Box::new(NotifyRetired(self.retired.clone())),
        })
    }
}
impl crate::gemini_api::Transport for HeldAuthentication {
    fn post(
        &mut self,
        _: &str,
        _: &crate::provider_keys::Secret,
        _: &[u8],
        _: Duration,
    ) -> Result<llm_provider::Reply, llm_provider::NoReply> {
        self.wait();
        Ok(llm_provider::Reply {
            status: 401,
            body: Box::new(NotifyRetired(self.retired.clone())),
        })
    }
}
#[test]
fn selected_scope_withdrawal_suppresses_late_auth_side_effects_for_all_real_provider_adapters() {
    use crate::provider_keys::Secret;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    for provider in CueProvider::ALL {
        for control in [
            "remove", "revise", "withhold", "pause", "off", "stop", "replace", "active",
        ] {
            let (entered, observed) = mpsc::channel();
            let (release, wait) = mpsc::channel();
            let (retired, done) = mpsc::channel();
            let transport = HeldAuthentication {
                entered,
                release: wait,
                retired,
            };
            let rejected = Arc::new(AtomicUsize::new(0));
            let count = rejected.clone();
            let model = llm_provider::default_cue_model(provider);
            let usage = Arc::new(llm_provider::CueUsageTracker::new(
                provider, model.id, false,
            ));
            let mut e = match provider {
                CueProvider::Anthropic => llm_provider::register_cue_engine(
                    crate::anthropic_api::AnthropicApi::new(
                        crate::anthropic_api::model(model.id).unwrap(),
                        transport,
                        Box::new(|| Ok(Secret::for_test("FICTIONAL"))),
                        Box::new(move || {
                            count.fetch_add(1, Ordering::SeqCst);
                        }),
                        Arc::default(),
                    ),
                    provider,
                    model.id,
                    false,
                    None,
                    None,
                ),
                CueProvider::OpenAi => llm_provider::register_cue_engine(
                    crate::openai_api::OpenAiApi::new(
                        llm_provider::ResolvedModel::from_curated(model),
                        transport,
                        Box::new(|| Ok(Secret::for_test("FICTIONAL"))),
                        Box::new(move || {
                            count.fetch_add(1, Ordering::SeqCst);
                        }),
                        usage,
                    ),
                    provider,
                    model.id,
                    false,
                    None,
                    None,
                ),
                CueProvider::Gemini => llm_provider::register_cue_engine(
                    crate::gemini_api::GeminiApi::new(
                        llm_provider::ResolvedModel::from_curated(model),
                        transport,
                        Box::new(|| Ok(Secret::for_test("FICTIONAL"))),
                        Box::new(move || {
                            count.fetch_add(1, Ordering::SeqCst);
                        }),
                        usage,
                    ),
                    provider,
                    model.id,
                    false,
                    None,
                    None,
                ),
            };
            e.start().unwrap();
            e.set_notes(vec![note()]);
            approve(&mut e, true);
            said(
                &mut e,
                1,
                "The fictional calibration review needs a concrete result.",
            );
            observed.recv_timeout(Duration::from_secs(1)).unwrap();
            match control {
                "remove" => e.set_notes(vec![]),
                "revise" => {
                    let mut n = note();
                    n.revision += 1;
                    e.set_notes(vec![n]);
                }
                "withhold" => e.set_prior_notes(vec![], vec![note()]),
                "pause" => e.set_live_cues_paused(true).unwrap(),
                "off" => e.revoke_processing(),
                "stop" => e.begin_live_stop(),
                "replace" => {
                    e = Engine::live();
                    e.start().unwrap();
                }
                _ => (),
            }
            release.send(()).unwrap();
            done.recv_timeout(Duration::from_secs(1)).unwrap();
            settle(&mut e);
            assert_eq!(
                rejected.load(Ordering::SeqCst),
                usize::from(control == "active"),
                "{provider:?}/{control}"
            );
            assert!(e.state.cue.is_none());
            if matches!(control, "remove" | "pause") {
                assert!(
                    e.has_processing_permission(),
                    "{control} retains narrower/unchanged grant"
                );
            }
            if control == "active" {
                assert_eq!(
                    serde_json::to_value(e.processing_issue()).unwrap(),
                    "keyRejected"
                );
            }
        }
    }
}
