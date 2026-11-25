//! Offline checks of the Google Gemini REST API adapter. A scripted
//! transport stands in for the API; no test reaches the network or uses a real
//! key.

use super::*;
use crate::cue_evaluator::{Action, ExistingCue, Provenance, Source, Worker};
use crate::llm_provider::{curated_model, CueProvider, REQUEST_CAP};
use std::{collections::VecDeque, sync::Mutex};

const KEY: &str = "AIzaSyFICTIONALfictional0123456789abcdef";

#[derive(Default)]
struct Script {
    replies: VecDeque<Result<(u16, String), NoReply>>,
    sent: Vec<(String, String, Value)>,
}

#[derive(Clone, Default)]
struct Scripted(Arc<Mutex<Script>>);

impl Scripted {
    fn answer(self, reply: Result<(u16, String), NoReply>) -> Self {
        self.0.lock().unwrap().replies.push_back(reply);
        self
    }
    fn sent(&self) -> Vec<(String, String, Value)> {
        self.0.lock().unwrap().sent.clone()
    }
}

impl Transport for Scripted {
    fn post(
        &mut self,
        model_id: &str,
        key: &Secret,
        body: &[u8],
        _: Duration,
    ) -> Result<Reply, NoReply> {
        let mut script = self.0.lock().unwrap();
        script.sent.push((
            model_id.to_string(),
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

fn sse(model: &str, text: &str, with_thought: bool) -> String {
    let (a, b) = text.split_at(text.len() / 2);
    let mut chunks = Vec::new();
    if with_thought {
        chunks.push(json!({
            "modelVersion": model,
            "candidates": [{
                "content": {"parts": [{"thought": true, "text": "thinking..."}]}
            }]
        }));
    }
    chunks.push(json!({
        "modelVersion": model,
        "candidates": [{
            "content": {"parts": [{"text": a}]}
        }]
    }));
    chunks.push(json!({
        "modelVersion": model,
        "candidates": [{
            "content": {"parts": [{"text": b}]},
            "finishReason": "STOP"
        }],
        "usageMetadata": {
            "promptTokenCount": 1000,
            "cachedContentTokenCount": 200,
            "candidatesTokenCount": 40,
            "thoughtsTokenCount": 10
        }
    }));
    chunks
        .iter()
        .map(|chunk| format!("data: {chunk}\n\n"))
        .collect()
}

fn decision(action: &str, cue: Option<&str>, ids: &[&str]) -> String {
    json!({"action": action, "cue": cue, "sourceIds": ids}).to_string()
}

fn built_in_model() -> ResolvedModel {
    ResolvedModel::from_curated(curated_model(CueProvider::Gemini, "gemini-2.5-flash").unwrap())
}

fn custom_model() -> ResolvedModel {
    ResolvedModel::resolve(
        CueProvider::Gemini,
        Some("gemini-3-flash-preview"),
        curated_model(CueProvider::Gemini, "gemini-2.5-flash").unwrap(),
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
        CueProvider::Gemini,
        &model.id,
        model.custom,
    ));
    let rejected = Arc::new(Mutex::new(0));
    let counted = rejected.clone();
    let mut adapter = GeminiApi::new(
        model,
        transport,
        Box::new(move || {
            key.map(Secret::for_test)
                .ok_or(KeyError::NotSet(Provider::Gemini))
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
fn stream_url_never_embeds_key_and_rejects_unsafe_model_paths() {
    let url = stream_url("gemini-2.5-flash").unwrap();
    assert_eq!(
        url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
    assert!(!url.contains("key="));
    assert_eq!(
        stream_url("models/gemini-2.5-pro").unwrap(),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
    );
    for bad in ["", "a/b", "../x", "gemini:other", "gemini?key=1", "a#b"] {
        assert_eq!(stream_url(bad), Err(Failure::EvaluatorUnavailable), "{bad}");
    }
}

#[test]
fn request_body_uses_system_instruction_and_json_schema() {
    let body = cue_body("{\"events\":[]}", OnScreen::Nothing);
    assert_eq!(
        body["systemInstruction"]["parts"][0]["text"],
        cue_system_prompt()
    );
    assert_eq!(body["contents"][0]["role"], "user");
    assert_eq!(body["contents"][0]["parts"][0]["text"], "{\"events\":[]}");
    assert_eq!(
        body["generationConfig"]["maxOutputTokens"],
        MAX_OUTPUT_TOKENS
    );
    assert_eq!(
        body["generationConfig"]["responseMimeType"],
        "application/json"
    );
    assert_eq!(
        body["generationConfig"]["responseJsonSchema"],
        cue_schema(OnScreen::Nothing)
    );
}

#[test]
fn streamed_decision_ignores_thought_parts_and_charges_usage() {
    let body = sse(
        "gemini-2.5-flash-001",
        &decision(
            "show",
            Some("Who owns the Atlas checklist?"),
            &["transcript:line-1"],
        ),
        true,
    );
    let transport = Scripted::default().answer(Ok((200, body)));
    let mut r = run(built_in_model(), transport.clone(), None, Some(KEY));
    let out = r.evaluate(&request(None)).unwrap();
    assert_eq!(out.action, Action::Show);
    assert_eq!(out.cue.as_deref(), Some("Who owns the Atlas checklist?"));
    let snap = r.usage.snapshot();
    assert_eq!(snap.requests, 1);
    assert!(!snap.custom_model);
    // 800 uncached * 0.30 + 200 cached * 0.075 + (40 + 10) * 2.50 = 240 + 15 + 125 = 380
    assert_eq!(snap.spent_micro_usd, Some(380));
    assert_eq!(transport.sent()[0].1, KEY);
}

#[test]
fn custom_model_enforces_request_cap_and_reports_no_fabricated_spend() {
    let body = sse(
        "gemini-3-flash-preview",
        &decision("quiet", None, &["transcript:line-2"]),
        false,
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
fn error_statuses_safety_blocks_and_mismatches_map_truthfully() {
    let transport = Scripted::default()
        .answer(Ok((403, String::new())))
        .answer(Ok((400, r#"{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid."}}"#.into())))
        .answer(Ok((429, String::new())))
        .answer(Ok((
            200,
            format!(
                "data: {}\n\n",
                json!({"modelVersion":"gemini-2.5-flash","candidates":[{"content":{"parts":[{"text":"{\"act"}]},"finishReason":"MAX_TOKENS"}]})
            ),
        )))
        .answer(Ok((
            200,
            format!(
                "data: {}\n\n",
                json!({"promptFeedback":{"blockReason":"SAFETY"}})
            ),
        )))
        .answer(Ok((
            200,
            format!(
                "data: {}\n\n",
                json!({"modelVersion":"other-model","candidates":[{"content":{"parts":[{"text":"{}"}]},"finishReason":"STOP"}]})
            ),
        )));
    let mut r = run(built_in_model(), transport, None, Some(KEY));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::SignIn));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::SignIn));
    assert_eq!(*r.rejected.lock().unwrap(), 2);
    assert_eq!(r.evaluate(&request(None)), Err(Failure::UsageLimit));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::OutputLimit));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::Refused));
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

    let bad = sse("gemini-2.5-flash", "{\"not\":\"schema\"}", false);
    let transport = Scripted::default()
        .answer(Ok((200, bad.clone())))
        .answer(Ok((200, bad.clone())))
        .answer(Ok((200, bad)));
    let mut r = run(built_in_model(), transport, None, Some(KEY));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::Refused));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::Refused));
    assert_eq!(r.evaluate(&request(None)), Err(Failure::InvalidDecision));
}
