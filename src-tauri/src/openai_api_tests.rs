//! Offline checks of the OpenAI Responses API adapter. A scripted transport
//! stands in for the API; no test reaches the network or uses a real key.

use super::*;
use crate::cue_evaluator::{Action, ExistingCue, Provenance, Source, Worker};
use crate::llm_provider::{curated_model, CueProvider, REQUEST_CAP};
use std::{collections::VecDeque, sync::Mutex};

const KEY: &str = "sk-proj-FICTIONALfictional0123456789abcdefghij-_XYZ";

#[test]
fn real_adapter_401_uses_the_original_credential_revision() {
    use crate::provider_keys::{KeyState, Keys, MemoryStore, Probe, ProbeResult};
    struct Offline;
    impl Probe for Offline {
        fn check(&self, _: Provider, _: &Secret) -> ProbeResult {
            panic!("no provider probe");
        }
    }
    struct Rotating {
        keys: &'static Keys,
        replace: bool,
    }
    impl Transport for Rotating {
        fn post(&mut self, _: &Secret, _: &[u8], _: Duration) -> Result<Reply, NoReply> {
            if self.replace {
                self.keys
                    .set(Provider::OpenAi, &format!("{KEY}replacement"))
                    .unwrap();
            }
            Ok(Reply {
                status: 401,
                body: Box::new(std::io::Cursor::new(Vec::<u8>::new())),
            })
        }
    }
    for replace in [false, true] {
        let keys = Box::leak(Box::new(Keys::new(
            Box::<MemoryStore>::default(),
            Box::new(Offline),
        )));
        keys.set(Provider::OpenAi, KEY).unwrap();
        let mut key_source = keys.request_key(Provider::OpenAi);
        let rejected_source = key_source.rejection_handler();
        let model = built_in_model();
        let usage = Arc::new(CueUsageTracker::new(CueProvider::OpenAi, &model.id, false));
        let adapter = OpenAiApi::new(
            model,
            Rotating { keys, replace },
            Box::new(move || key_source.get()),
            Box::new(move || rejected_source.mark_rejected()),
            usage,
        );
        let mut worker = Worker::start(adapter, crate::llm_provider::DEADLINE).unwrap();
        let request = request(None);
        worker.submit(request.clone()).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(result) = worker.poll(&request) {
                assert_eq!(result.unwrap_err(), Failure::SignIn);
                break;
            }
            assert!(std::time::Instant::now() < until, "fake 401 did not finish");
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            keys.status().of(Provider::OpenAi).state,
            if replace {
                KeyState::Set
            } else {
                KeyState::Rejected
            }
        );
    }
}

#[test]
fn held_generations_keep_separate_receipts_and_cancel_never_overlaps_a_reader() {
    use crate::provider_keys::{KeyState, Keys, MemoryStore, Probe, ProbeResult};
    use std::sync::{atomic::AtomicUsize, mpsc};
    struct Offline;
    impl Probe for Offline {
        fn check(&self, _: Provider, _: &Secret) -> ProbeResult {
            panic!("no provider probe");
        }
    }
    struct Held {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }
    impl Transport for Held {
        fn post(&mut self, _: &Secret, _: &[u8], _: Duration) -> Result<Reply, NoReply> {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            Ok(Reply {
                status: 401,
                body: Box::new(std::io::Cursor::new(Vec::<u8>::new())),
            })
        }
    }
    struct Running {
        worker: Worker,
        started: mpsc::Receiver<()>,
        release: mpsc::Sender<()>,
        reads: Arc<AtomicUsize>,
    }
    fn start(keys: &'static Keys) -> Running {
        let (entered, started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        // Same ownership as connected_engine_for: fresh reader, one callback,
        // then the entire adapter moved into one exclusive worker.
        let mut source = keys.request_key(Provider::OpenAi);
        let rejection = source.rejection_handler();
        let reads = Arc::new(AtomicUsize::new(0));
        let count = reads.clone();
        let model = built_in_model();
        let usage = Arc::new(CueUsageTracker::new(CueProvider::OpenAi, &model.id, false));
        let adapter = OpenAiApi::new(
            model,
            Held {
                entered,
                release: held,
            },
            Box::new(move || {
                count.fetch_add(1, Ordering::AcqRel);
                source.get()
            }),
            Box::new(move || rejection.mark_rejected()),
            usage,
        );
        Running {
            worker: Worker::start(adapter, crate::llm_provider::DEADLINE).unwrap(),
            started,
            release,
            reads,
        }
    }
    fn complete(worker: &mut Worker, input: &Request) {
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(result) = worker.poll(input) {
                assert_eq!(result.unwrap_err(), Failure::SignIn);
                return;
            }
            assert!(Instant::now() < until, "held auth result did not finish");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    for cancel in [false, true] {
        let keys = Box::leak(Box::new(Keys::new(
            Box::<MemoryStore>::default(),
            Box::new(Offline),
        )));
        keys.set(Provider::OpenAi, KEY).unwrap();
        let input = request(None);
        let Running {
            worker: mut old,
            started: old_started,
            release: release_old,
            reads: old_reads,
        } = start(keys);
        old.submit(input.clone()).unwrap();
        old_started.recv_timeout(Duration::from_secs(2)).unwrap();
        if cancel {
            old.cancel_pending();
            assert_eq!(old.poll(&input), Some(Err(Failure::Cancelled)));
        }
        assert_eq!(old.submit(input.clone()), Err(Failure::Busy));
        assert_eq!(old_reads.load(Ordering::Acquire), 1);
        keys.set(Provider::OpenAi, &format!("{KEY}replacement"))
            .unwrap();
        let Running {
            worker: mut new,
            started: new_started,
            release: release_new,
            reads: new_reads,
        } = start(keys);
        new.submit(input.clone()).unwrap();
        new_started.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(new_reads.load(Ordering::Acquire), 1);
        // The newer generation has already acquired its replacement receipt
        // before the older transport returns. Neither callback can swap it.
        release_old.send(()).unwrap();
        if cancel {
            let until = Instant::now() + Duration::from_secs(5);
            while old.is_busy() {
                assert!(Instant::now() < until, "cancelled adapter did not exit");
                std::thread::sleep(Duration::from_millis(2));
            }
        } else {
            complete(&mut old, &input);
        }
        assert_eq!(keys.status().of(Provider::OpenAi).state, KeyState::Set);
        assert_eq!(old_reads.load(Ordering::Acquire), 1);
        release_new.send(()).unwrap();
        complete(&mut new, &input);
        assert_eq!(keys.status().of(Provider::OpenAi).state, KeyState::Rejected);
    }
}

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

#[test]
fn cancellation_during_key_access_sends_no_request() {
    let transport = Scripted::default();
    let (entered, observed) = std::sync::mpsc::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let read: KeySource = Box::new(move || {
        entered.send(()).unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        Ok(Secret::for_test(KEY))
    });
    let adapter = OpenAiApi::new(
        built_in_model(),
        transport.clone(),
        read,
        Box::new(|| {}),
        Arc::new(CueUsageTracker::new(
            CueProvider::OpenAi,
            "fictional",
            false,
        )),
    );
    let mut worker = Worker::start(adapter, Duration::from_secs(10)).unwrap();
    worker.submit(request(None)).unwrap();
    observed.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.cancel_pending();
    release.send(()).unwrap();
    let limit = Instant::now() + Duration::from_secs(5);
    while !worker.adapter_finished() {
        assert!(Instant::now() < limit, "adapter did not finish");
        std::thread::yield_now();
    }
    assert!(transport.sent().is_empty());
}
