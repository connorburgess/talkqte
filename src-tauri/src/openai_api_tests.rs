//! Offline checks of the OpenAI Responses API adapter. A scripted transport
//! stands in for the API; no test reaches the network or uses a real key.

use super::*;
use crate::cue_evaluator::{Action, ExistingCue, Provenance, Source, Worker};
use crate::llm_provider::{curated_model, CueProvider, REQUEST_CAP};
use std::{collections::VecDeque, sync::Mutex};

const KEY: &str = "sk-proj-FICTIONALfictional0123456789abcdefghij-_XYZ";

#[derive(Default)]
struct Script {
    replies: VecDeque<Result<(u16, String), NoReply>>,
    sent: Vec<(String, Value)>,
}

#[derive(Clone, Default)]
struct Scripted(Arc<Mutex<Script>>);

impl Scripted {
    fn answer(self, reply: Result<(u16, String), NoReply>) -> Self {
        self.0.lock().unwrap().replies.push_back(reply);
        self
    }
    fn sent(&self) -> Vec<(String, Value)> {
        self.0.lock().unwrap().sent.clone()
    }
}

impl Transport for Scripted {
    fn post(&mut self, key: &Secret, body: &[u8], _: Duration) -> Result<Reply, NoReply> {
        let mut script = self.0.lock().unwrap();
        script.sent.push((
            key.expose().to_string(),
            serde_json::from_slice(body).unwrap(),
        ));
        let (status, text) = script.replies.pop_front().unwrap_or(Err(NoReply::Lost))?;
        Ok(Reply {
            status,
            body: Box::new(std::io::Cursor::new(text.into_bytes())),
        })
    }
}

fn sse(model: &str, text: &str) -> String {
    let (a, b) = text.split_at(text.len() / 2);
    let events = [
        json!({"type": "response.created", "response": {"model": model, "status": "in_progress"}}),
        json!({"type": "response.output_text.delta", "delta": a}),
        json!({"type": "response.output_text.delta", "delta": b}),
        json!({
            "type": "response.completed",
            "response": {
                "model": model,
                "status": "completed",
                "usage": {
                    "input_tokens": 1000,
                    "input_tokens_details": {"cached_tokens": 400},
                    "output_tokens": 50
                }
            }
        }),
    ];
    let mut out: String = events
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect();
    out.push_str("data: [DONE]\n\n");
    out
}

fn decision(action: &str, cue: Option<&str>, ids: &[&str]) -> String {
    json!({"action": action, "cue": cue, "sourceIds": ids}).to_string()
}

fn built_in_model() -> ResolvedModel {
    ResolvedModel::from_curated(curated_model(CueProvider::OpenAi, "gpt-5-mini").unwrap())
}

fn custom_model() -> ResolvedModel {
    ResolvedModel::resolve(
        CueProvider::OpenAi,
        Some("gpt-5.4-codex"),
        curated_model(CueProvider::OpenAi, "gpt-5-mini").unwrap(),
    )
}

fn line(n: u64, text: &str) -> Source {
    Source {
        id: format!("transcript:line-{n}"),
        revision: 1,
        provenance: Provenance::Transcript {
            at_ms: n * 1_000,
            speaker: "Speaker".into(),
        },
        text: text.into(),
    }
}

fn request(cue: Option<(&str, bool)>) -> Request {
    let sources = vec![
        line(1, "Who owns the fictional Atlas checklist?"),
        line(2, "Priya will take it by Friday."),
    ];
    Request::new(
        1,
        1,
        sources,
        cue.map(|(text, asked)| ExistingCue {
            id: "cue-1".into(),
            text: text.into(),
            source_ids: vec!["transcript:line-1".into()],
            asked,
        }),
    )
    .unwrap()
}

struct Run {
    usage: Arc<CueUsageTracker>,
    rejected: Arc<Mutex<u32>>,
    worker: Worker,
}

fn run(
    model: ResolvedModel,
    transport: Scripted,
    cap: Option<u64>,
    key: Option<&'static str>,
) -> Run {
    let usage = Arc::new(CueUsageTracker::new(
        CueProvider::OpenAi,
        &model.id,
        model.custom,
    ));
    let rejected = Arc::new(Mutex::new(0));
    let counted = rejected.clone();
    let mut adapter = OpenAiApi::new(
        model,
        transport,
        Box::new(move || {
            key.map(Secret::for_test)
                .ok_or(KeyError::NotSet(Provider::OpenAi))
        }),
        Box::new(move || *counted.lock().unwrap() += 1),
        usage.clone(),
    );
    if let Some(cap) = cap {
        adapter = adapter.with_spend_cap(cap);
    }
    Run {
        usage,
        rejected,
        worker: Worker::start(adapter, crate::llm_provider::DEADLINE).unwrap(),
    }
}

impl Run {
    fn evaluate(&mut self, request: &Request) -> Result<crate::cue_evaluator::Decision, Failure> {
        self.worker.submit(request.clone()).unwrap();
        loop {
            if let Some(result) = self.worker.poll(request) {
                return result;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

#[test]
fn request_body_matches_responses_api_and_same_cue_contract() {
    let body = cue_body("gpt-5-mini", "{\"events\":[]}", OnScreen::Nothing);
    assert_eq!(body["model"], "gpt-5-mini");
    assert_eq!(body["instructions"], cue_system_prompt());
    assert_eq!(body["input"], "{\"events\":[]}");
    assert_eq!(body["max_output_tokens"], MAX_OUTPUT_TOKENS);
    assert_eq!(body["store"], false);
    assert_eq!(body["stream"], true);
    assert_eq!(body["text"]["format"]["type"], "json_schema");
    assert_eq!(body["text"]["format"]["strict"], true);
    assert_eq!(
        body["text"]["format"]["schema"],
        cue_schema(OnScreen::Nothing)
    );
    assert!(body.get("reasoning").is_none());
}

#[test]
fn streamed_decision_including_snapshot_echo_applies_and_charges_usage() {
    let body = sse(
        "gpt-5-mini-2025-08-07",
        &decision(
            "show",
            Some("Who owns the Atlas checklist?"),
            &["transcript:line-1"],
        ),
    );
    let transport = Scripted::default().answer(Ok((200, body)));
    let mut r = run(built_in_model(), transport.clone(), None, Some(KEY));
    let out = r.evaluate(&request(None)).unwrap();
    assert_eq!(out.action, Action::Show);
    assert_eq!(out.cue.as_deref(), Some("Who owns the Atlas checklist?"));
    let snap = r.usage.snapshot();
    assert_eq!(snap.requests, 1);
    assert_eq!(snap.request_cap, REQUEST_CAP);
    assert!(!snap.custom_model);
    // 600 uncached * 0.25 + 400 cached * 0.025 + 50 output * 2.0 = 150 + 10 + 100 = 260
    assert_eq!(snap.spent_micro_usd, Some(260));
    assert_eq!(transport.sent()[0].0, KEY);
}

#[test]
fn custom_model_enforces_request_cap_and_reports_no_fabricated_spend() {
    let body = sse(
        "gpt-5.4-codex",
        &decision("quiet", None, &["transcript:line-2"]),
    );
    let transport = Scripted::default().answer(Ok((200, body)));
    let mut r = run(custom_model(), transport, Some(1), Some(KEY));
    let out = r.evaluate(&request(None)).unwrap();
    assert_eq!(out.action, Action::Quiet);
    let snap = r.usage.snapshot();
    assert_eq!(snap.requests, 1);
    assert_eq!(snap.request_cap, REQUEST_CAP);
    assert_eq!(snap.spent_micro_usd, None);
    assert_eq!(snap.spend_cap_micro_usd, None);
    assert!(snap.custom_model);
}

#[test]
fn error_statuses_and_refusals_map_truthfully() {
    let transport = Scripted::default()
        .answer(Ok((401, String::new())))
        .answer(Ok((
            429,
            r#"{"error":{"code":"insufficient_quota"}}"#.into(),
        )))
        .answer(Ok((429, r#"{"error":{"code":"rate_limit_exceeded"}}"#.into())))
        .answer(Ok((
            200,
            format!(
                "data: {}\n\n",
                json!({"type":"response.incomplete","response":{"model":"gpt-5-mini","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}})
            ),
        )))
        .answer(Ok((
            200,
            format!(
                "data: {}\n\n",
                json!({"type":"response.created","response":{"model":"other-model","status":"in_progress"}})
            ) + &format!(
                "data: {}\n\n",
                json!({"type":"response.completed","response":{"model":"other-model","status":"completed"}})
            ),
        )));
    let mut r = run(built_in_model(), transport, None, Some(KEY));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::SignIn));
    assert_eq!(*r.rejected.lock().unwrap(), 1);
    assert_eq!(r.evaluate(&request(None)), Err(Failure::Billing));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::UsageLimit));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::OutputLimit));
    assert_eq!(
        r.evaluate(&request(None)),
        Err(Failure::EvaluatorUnavailable)
    );
}

#[test]
fn spend_cap_and_three_invalid_replies_stop_cues() {
    let transport = Scripted::default();
    let mut capped = run(built_in_model(), transport, Some(10), Some(KEY));
    assert_eq!(capped.evaluate(&request(None)), Err(Failure::SpendLimit));

    let bad = sse("gpt-5-mini", "{\"not\":\"schema\"}");
    let transport = Scripted::default()
        .answer(Ok((200, bad.clone())))
        .answer(Ok((200, bad.clone())))
        .answer(Ok((200, bad)));
    let mut r = run(built_in_model(), transport, None, Some(KEY));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::Refused));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::Refused));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::InvalidDecision));
}

#[test]
fn unsent_network_error_charges_nothing() {
    let transport = Scripted::default().answer(Err(NoReply::Unsent));
    let mut r = run(built_in_model(), transport, None, Some(KEY));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::Unreachable));
    assert_eq!(r.usage.snapshot().spent_micro_usd, Some(0));
}
