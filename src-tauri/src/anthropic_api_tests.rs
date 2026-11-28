//! Offline checks of the in-app Anthropic connection. A scripted transport
//! stands in for the API; no test reaches the network or uses a real key.

use super::*;
use crate::cue_evaluator::{Action, ExistingCue, Provenance, Source, Worker};
use crate::engine::{ConversationScope, Engine, EvaluationStatus, Segment};
use std::collections::VecDeque;

const KEY: &str = "sk-ant-api03-FICTIONALfictional0123456789abcdefghij-_XYZ";

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

/// A streamed reply as the API sends it, text split across two deltas.
fn sse(model: &str, text: &str, stop_reason: &str) -> String {
    let (a, b) = text.split_at(text.len() / 2);
    let events = [
        json!({"type":"message_start","message":{"model":model,"usage":{"input_tokens":1200,"cache_creation_input_tokens":0,"cache_read_input_tokens":2500,"output_tokens":1}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"ping"}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":a}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":b}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":stop_reason},"usage":{"output_tokens":40}}),
        json!({"type":"message_stop"}),
    ];
    events
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect()
}

fn decision(action: &str, cue: Option<&str>, ids: &[&str]) -> String {
    json!({"action": action, "cue": cue, "sourceIds": ids}).to_string()
}

fn haiku() -> Model {
    model(MODEL).unwrap()
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
    usage: Arc<Usage>,
    rejected: Arc<Mutex<u32>>,
    worker: Worker,
}

fn run(transport: Scripted, cap: Option<u64>, key: Option<&'static str>) -> Run {
    let usage = Arc::new(Usage::default());
    let rejected = Arc::new(Mutex::new(0));
    let counted = rejected.clone();
    let mut adapter = AnthropicApi::new(
        haiku(),
        transport,
        Box::new(move || {
            key.map(Secret::for_test)
                .ok_or(KeyError::NotSet(Provider::Anthropic))
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
        worker: Worker::start(adapter, DEADLINE).unwrap(),
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
fn the_app_builds_exactly_the_requests_the_lab_builds() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../scripts/fixtures/anthropic-request.json"
    ))
    .unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 3);
    for case in cases {
        let model = model(case["model"].as_str().unwrap()).unwrap();
        let expected_input = case["input"].as_str().unwrap();
        // Rebuild the engine's request for the same fictional lines.
        let input: Value = serde_json::from_str(expected_input).unwrap();
        let sources = input["events"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, event)| Source {
                id: event["id"].as_str().unwrap().into(),
                revision: 1,
                provenance: Provenance::Transcript {
                    at_ms: i as u64,
                    speaker: "Speaker".into(),
                },
                text: event["text"].as_str().unwrap().into(),
            })
            .collect();
        let cue = input["existingCue"].as_object().map(|cue| ExistingCue {
            id: "cue".into(),
            text: cue["text"].as_str().unwrap().into(),
            source_ids: cue["sourceIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap().into())
                .collect(),
            asked: cue.get("kind").is_some(),
        });
        let earlier = input["earlierCues"].as_array().map_or(vec![], |cues| {
            cues.iter()
                .map(|cue| crate::cue_evaluator::EarlierCue {
                    text: cue["text"].as_str().unwrap().into(),
                    state: crate::cue_evaluator::CueEnd::Expired,
                })
                .collect()
        });
        let request = Request::new(1, 1, sources, cue)
            .unwrap()
            .with_listener(input["userName"].as_str().map(str::to_string), earlier)
            .unwrap();
        let built = request.prompt_input().unwrap();
        assert_eq!(built, expected_input);
        let on_screen = OnScreen::of(&request);
        assert_eq!(body(model, &built, on_screen), case["params"]);
        assert_eq!(
            worst_case_micro_usd(model, &built, on_screen),
            case["worstCaseMicroUsd"].as_u64().unwrap()
        );
    }
}

#[test]
fn a_decision_is_one_streamed_request_with_the_key_only_in_its_header() {
    let reply = decision(
        "show",
        Some("Who owns the checklist?"),
        &["transcript:line-1"],
    );
    let transport = Scripted::default().answer(Ok((200, sse(MODEL, &reply, "end_turn"))));
    let mut run = run(transport.clone(), None, Some(KEY));
    let decision = run.evaluate(&request(None)).unwrap();
    assert_eq!(decision.action, Action::Show);
    assert_eq!(decision.cue.as_deref(), Some("Who owns the checklist?"));
    let sent = transport.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, KEY);
    assert!(!sent[0].1.to_string().contains(KEY));
    assert_eq!(sent[0].1["model"], MODEL);
    assert_eq!(sent[0].1["stream"], true);
    // Charged what the reply reported, from the lab's price table.
    let snapshot = run.usage.snapshot(haiku());
    assert_eq!(snapshot.requests, 1);
    let expected = TokenUsage {
        input: Some(1200),
        cache_write: Some(0),
        cache_read: Some(2500),
        output: Some(40),
    }
    .cost_micro_usd(haiku());
    assert_eq!(expected, 165);
    assert_eq!(snapshot.spent_micro_usd, expected);
}

#[test]
fn request_scoped_non_decisions_continue_and_terminal_failures_stop() {
    let worst = worst_case_micro_usd(
        haiku(),
        &request(None).prompt_input().unwrap(),
        OnScreen::Nothing,
    );
    let long = "x".repeat(MAX_TEXT_BYTES + 1);
    for (reply, expected, charged) in [
        (
            Ok((200, sse(MODEL, "{}", "refusal"))),
            Failure::Refused,
            165,
        ),
        (
            Ok((200, sse(MODEL, "{}", "max_tokens"))),
            Failure::OutputLimit,
            worst,
        ),
        (
            Ok((200, sse(MODEL, &long, "end_turn"))),
            Failure::OutputLimit,
            worst,
        ),
        (
            Ok((200, sse("claude-opus-5-5", "{}", "end_turn"))),
            Failure::EvaluatorUnavailable,
            165,
        ),
        (
            Ok((
                200,
                sse(MODEL, "{}", "end_turn").replace("message_stop", "message_stopx"),
            )),
            Failure::EvaluatorUnavailable,
            worst,
        ),
        (
            Ok((200, "data: {\"type\":\"error\"}\n\n".into())),
            Failure::Unreachable,
            worst,
        ),
        (
            Ok((200, "data: not json\n\n".into())),
            Failure::EvaluatorUnavailable,
            worst,
        ),
        (Ok((429, String::new())), Failure::UsageLimit, worst),
        // An account out of credit is told apart from an outage, and is not
        // charged: nothing was generated.
        (Ok((402, String::new())), Failure::Billing, 0),
        (
            Ok((
                400,
                r#"{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}"#.into(),
            )),
            Failure::Billing,
            0,
        ),
        (
            Ok((
                400,
                r#"{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: field required"}}"#.into(),
            )),
            Failure::Unreachable,
            worst,
        ),
        (Ok((500, String::new())), Failure::Unreachable, worst),
        (Ok((529, String::new())), Failure::Unreachable, worst),
        (Err(NoReply::Lost), Failure::Unreachable, worst),
        // Never left the Mac: nothing to bill.
        (Err(NoReply::Unsent), Failure::Unreachable, 0),
    ] {
        let mut run = run(Scripted::default().answer(reply), None, Some(KEY));
        assert_eq!(run.evaluate(&request(None)).unwrap_err(), expected);
        assert_eq!(run.usage.snapshot(haiku()).spent_micro_usd, charged);
        assert_eq!(*run.rejected.lock().unwrap(), 0);
    }
}

#[test]
fn a_refused_key_is_marked_rejected_and_a_missing_key_sends_nothing() {
    for status in [401, 403] {
        let mut run = run(
            Scripted::default().answer(Ok((status, String::new()))),
            None,
            Some(KEY),
        );
        assert_eq!(run.evaluate(&request(None)).unwrap_err(), Failure::SignIn);
        assert_eq!(*run.rejected.lock().unwrap(), 1);
    }
    let transport = Scripted::default();
    let mut run = run(transport.clone(), None, None);
    // A key no longer in the Keychain is not a refusal by Anthropic.
    assert_eq!(
        run.evaluate(&request(None)).unwrap_err(),
        Failure::Credentials
    );
    assert_eq!(*run.rejected.lock().unwrap(), 0);
    assert!(transport.sent().is_empty());
    assert_eq!(run.usage.snapshot(haiku()).requests, 0);
}

#[test]
fn the_spend_cap_is_checked_before_anything_is_sent() {
    let input = request(None).prompt_input().unwrap();
    let worst = worst_case_micro_usd(haiku(), &input, OnScreen::Nothing);
    let reply = decision("quiet", None, &["transcript:line-2"]);
    let transport = Scripted::default()
        .answer(Ok((200, sse(MODEL, &reply, "end_turn"))))
        .answer(Ok((200, sse(MODEL, &reply, "end_turn"))));
    // Room for exactly one worst case: the first is sent and charged its
    // reported cost; the second's worst case would pass the cap.
    let mut run = run(transport.clone(), Some(worst + 100), Some(KEY));
    assert_eq!(run.evaluate(&request(None)).unwrap().action, Action::Quiet);
    assert_eq!(
        run.evaluate(&request(None)).unwrap_err(),
        Failure::SpendLimit
    );
    assert_eq!(transport.sent().len(), 1);
    assert_eq!(run.usage.snapshot(haiku()).requests, 1);
}

#[test]
fn replies_are_settled_as_the_lab_broker_settles_them() {
    let shown = Some(("Who owns the checklist?", false));
    let asked = Some(("Can you send the notes?", true));
    let line_1 = ["transcript:line-1"];
    for (cue, reply, expected) in [
        // With a cue on screen, show means keep it.
        (
            shown,
            decision("show", Some("Another cue"), &line_1),
            Action::Quiet,
        ),
        // An "Asked you" cue is not the model's to withdraw.
        (asked, decision("withdraw", None, &line_1), Action::Quiet),
        (shown, decision("withdraw", None, &line_1), Action::Withdraw),
        (asked, decision("resolved", None, &line_1), Action::Resolved),
        // Casing is not guaranteed.
        (None, decision("QUIET", None, &line_1), Action::Quiet),
    ] {
        let transport = Scripted::default().answer(Ok((200, sse(MODEL, &reply, "end_turn"))));
        let mut run = run(transport, None, Some(KEY));
        assert_eq!(run.evaluate(&request(cue)).unwrap().action, expected);
    }
}

#[test]
fn unusable_replies_skip_the_request_until_three_in_a_row() {
    let eleven = "one two three four five six seven eight nine ten eleven";
    let bad = [
        decision("show", Some(eleven), &["transcript:line-1"]),
        decision("show", Some("Fine"), &["transcript:line-9"]),
        decision("resolved", None, &["transcript:line-1"]),
        json!({"action":"quiet","cue":null,"sourceIds":["transcript:line-1"],"why":"x"})
            .to_string(),
        "not json".into(),
    ];
    // Two in a row are skipped; a good reply resets the count.
    let good = decision("quiet", None, &["transcript:line-1"]);
    let mut transport = Scripted::default();
    for reply in [&bad[0], &bad[1], &good, &bad[2], &bad[3], &bad[4]] {
        transport = transport.answer(Ok((200, sse(MODEL, reply, "end_turn"))));
    }
    let mut run = run(transport, None, Some(KEY));
    let request = request(None);
    assert_eq!(run.evaluate(&request).unwrap_err(), Failure::Refused);
    assert_eq!(run.evaluate(&request).unwrap_err(), Failure::Refused);
    assert_eq!(run.evaluate(&request).unwrap().action, Action::Quiet);
    assert_eq!(run.evaluate(&request).unwrap_err(), Failure::Refused);
    assert_eq!(run.evaluate(&request).unwrap_err(), Failure::Refused);
    assert_eq!(
        run.evaluate(&request).unwrap_err(),
        Failure::InvalidDecision
    );
}

#[test]
fn the_review_names_the_provider_key_billing_caps_and_both_destinations() {
    use crate::transcription::cloud::Language;
    // The longer, multilingual wording must also fit the review's bound.
    // The longest: Multilingual, with both sources and the longest name.
    let multi = crate::transcription::cloud::review_sentence_for_own_key(
        Language::Multilingual,
        &crate::engine::SessionSources::both(("W".repeat(200).as_str(), "fictional-long")),
    );
    let longest = format!("{} {multi}", data_policy(haiku()));
    assert!(
        longest.len() <= 2_048,
        "the review's bound: {}",
        longest.len()
    );
    let deepgram = crate::transcription::cloud::review_sentence_for_own_key(
        Language::English,
        &crate::engine::SessionSources::microphone(),
    );
    let policy = format!("{} {deepgram}", data_policy(haiku()));
    for part in [
        "Anthropic API (US), with your own Anthropic API key",
        "billed to your Anthropic account per token",
        "At most 400 requests and an estimated $0.50 per session",
        "Model claude-haiku-5-5",
        "never sends Anthropic audio",
        "no other service is used",
        "Pause cues stops these requests but not the audio to Deepgram; Off and Stop end both",
        "Pausing cues does not stop the audio; turning processing off or Stop does",
        "to Deepgram (US, model Nova-3, English)",
        "with your own Deepgram API key",
        "opt out of its Model Improvement Program",
    ] {
        assert!(policy.contains(part), "missing: {part}");
    }
    let engine = registered(
        AnthropicApi::new(
            haiku(),
            Scripted::default(),
            Box::new(|| Err(KeyError::NotSet(Provider::Anthropic))),
            Box::new(|| {}),
            Arc::default(),
        ),
        haiku(),
        Some(deepgram),
    );
    let snapshot =
        serde_json::to_value(engine.processing_snapshot(crate::engine::CaptureState::Off, 0))
            .unwrap();
    let text = snapshot["processor"].to_string();
    assert!(text.contains("Claude (your Anthropic API key)"));
    assert!(text.contains("Deepgram (US), for transcription"));
    assert!(!text.contains(KEY));

    // ElevenLabs review wording also fits within the policy bound and names
    // ElevenLabs honestly in both policy and audio destination.
    let el_multi = crate::transcription::cloud::review_sentence_for_own_key_provider(
        crate::transcription::cloud::Provider::ElevenLabs,
        Language::Multilingual,
        &crate::engine::SessionSources::both(("W".repeat(200).as_str(), "fictional-long")),
    );
    let el_longest = format!("{} {el_multi}", data_policy_for(haiku(), "ElevenLabs"));
    assert!(
        el_longest.len() <= 2_048,
        "the ElevenLabs review's bound: {}",
        el_longest.len()
    );
    let elevenlabs = crate::transcription::cloud::review_sentence_for_own_key_provider(
        crate::transcription::cloud::Provider::ElevenLabs,
        Language::English,
        &crate::engine::SessionSources::microphone(),
    );
    let el_engine = registered_with(
        AnthropicApi::new(
            haiku(),
            Scripted::default(),
            Box::new(|| Err(KeyError::NotSet(Provider::Anthropic))),
            Box::new(|| {}),
            Arc::default(),
        ),
        haiku(),
        Some(elevenlabs),
        Some(
            crate::transcription::cloud::Provider::ElevenLabs
                .destination()
                .into(),
        ),
        "ElevenLabs",
    );
    let el_snapshot =
        serde_json::to_value(el_engine.processing_snapshot(crate::engine::CaptureState::Off, 0))
            .unwrap();
    let el_text = el_snapshot["processor"].to_string();
    assert!(el_text.contains("ElevenLabs (model Scribe v2 Realtime, English)"));
    assert!(el_text.contains("with your own ElevenLabs API key"));
    assert!(el_text.contains(
        "Pause cues stops these requests but not the audio to ElevenLabs; Off and Stop end both"
    ));
    assert!(el_text.contains("ElevenLabs, for transcription of the session's audio"));
}

// ---- in the engine ----

struct Session {
    engine: Engine,
    transport: Scripted,
    line: u64,
}

fn session(transport: Scripted) -> Session {
    session_with_cap(transport, SPEND_CAP_MICRO_USD)
}

#[test]
fn a_key_removed_mid_session_stops_cues_as_unavailable_not_rejected() {
    let transport = Scripted::default();
    let adapter = AnthropicApi::new(
        haiku(),
        transport.clone(),
        Box::new(|| Err(KeyError::NotSet(Provider::Anthropic))),
        Box::new(|| panic!("a missing key is not a refusal")),
        Arc::default(),
    );
    let mut engine = registered(adapter, haiku(), None);
    engine.start().unwrap();
    let mut s = Session {
        engine,
        transport,
        line: 0,
    };
    s.approve();
    s.say("The fictional rota has two gaps.");
    s.settle();
    assert_eq!(s.issue(), "keyUnavailable");
    assert!(s.transport.sent().is_empty());
}

fn session_with_cap(transport: Scripted, cap: u64) -> Session {
    let usage = Arc::new(Usage::default());
    let adapter = AnthropicApi::new(
        haiku(),
        transport.clone(),
        Box::new(|| Ok(Secret::for_test(KEY))),
        Box::new(|| {}),
        usage,
    )
    .with_spend_cap(cap);
    let mut engine = registered(adapter, haiku(), None);
    engine.start().unwrap();
    Session {
        engine,
        transport,
        line: 0,
    }
}

impl Session {
    fn approve(&mut self) {
        let review = self
            .engine
            .review_processing(ConversationScope::NewSpeechOnly, &[])
            .unwrap();
        self.engine.approve_processing(review).unwrap();
    }

    fn say(&mut self, text: &str) {
        self.engine.advance(MIN_GAP_MS);
        self.line += 1;
        self.engine
            .ingest(
                self.engine.session(),
                Segment {
                    id: format!("line-{}", self.line),
                    at_ms: self.engine.state.elapsed_ms,
                    speaker: "Speaker".into(),
                    speaker_id: None,
                    text: text.into(),
                },
            )
            .unwrap();
    }

    /// Advances the clock until the request in flight settles.
    fn settle(&mut self) {
        for _ in 0..2_000 {
            if self.engine.evaluation_status() != Some(EvaluationStatus::Pending) {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
            self.engine.advance(1);
        }
        panic!("the request never settled");
    }

    fn issue(&self) -> Value {
        serde_json::to_value(self.engine.processing_issue()).unwrap()
    }
}

#[test]
fn nothing_is_sent_before_approval_and_an_approved_line_can_raise_a_cue() {
    let reply = decision(
        "show",
        Some("Who owns the checklist?"),
        &["transcript:line-2"],
    );
    let mut s = session(Scripted::default().answer(Ok((200, sse(MODEL, &reply, "end_turn")))));
    s.say("Who owns the fictional Atlas checklist?");
    s.settle();
    assert!(s.transport.sent().is_empty());
    s.approve();
    s.say("Who owns the fictional Atlas checklist, then?");
    assert_eq!(
        s.engine.evaluation_status(),
        Some(EvaluationStatus::Pending)
    );
    s.settle();
    assert_eq!(s.transport.sent().len(), 1);
    let cue = s.engine.state.cue.as_ref().expect("a cue is shown");
    assert_eq!(cue.question, "Who owns the checklist?");
    // A line said before approval was not sent.
    let sent = s.transport.sent()[0].1["messages"][0]["content"].clone();
    assert!(!sent.as_str().unwrap().contains("line-1"));
}

#[test]
fn pause_cancels_the_request_without_ending_cues_and_resume_continues() {
    let quiet = decision("quiet", None, &["transcript:line-2"]);
    let mut s = session(
        Scripted::default()
            .answer(Ok((200, sse(MODEL, &quiet, "end_turn"))))
            .answer(Ok((200, sse(MODEL, &quiet, "end_turn")))),
    );
    s.approve();
    let session = s.engine.session();
    s.say("The fictional rota has two gaps.");
    s.engine.set_live_cues_paused(true).unwrap();
    // Paused: cue requests stop, but the approval holds, so the session's
    // audio is still sent to Deepgram, as the review and Pause help say.
    assert!(s.engine.audio_approval(session).is_some());
    assert_eq!(s.engine.audio_withdrawal(session), None);
    s.engine.set_live_cues_paused(false).unwrap();
    assert!(s.engine.has_processing_permission());
    assert_eq!(s.issue(), Value::Null);
    s.say("Who covers the fictional Friday shift?");
    s.settle();
    assert!(s.engine.has_processing_permission());
    assert_eq!(s.issue(), Value::Null);
    // Off ends the audio too.
    s.engine.revoke_processing();
    assert_eq!(s.engine.audio_withdrawal(session), Some("withdrawn"));
}

#[test]
fn a_refusal_skips_one_request_and_the_session_continues() {
    let quiet = decision("quiet", None, &["transcript:line-2"]);
    let mut s = session(
        Scripted::default()
            .answer(Ok((200, sse(MODEL, "{}", "refusal"))))
            .answer(Ok((200, sse(MODEL, &quiet, "end_turn")))),
    );
    s.approve();
    s.say("The fictional rota has two gaps.");
    s.settle();
    assert!(s.engine.has_processing_permission());
    s.say("Who covers the fictional Friday shift?");
    s.settle();
    assert_eq!(s.transport.sent().len(), 2);
    assert_eq!(s.issue(), Value::Null);
}

#[test]
fn a_refused_key_and_the_caps_stop_cues_with_their_own_reasons() {
    let mut s = session(Scripted::default().answer(Ok((401, String::new()))));
    s.approve();
    s.say("The fictional rota has two gaps.");
    s.settle();
    assert!(!s.engine.has_processing_permission());
    assert_eq!(s.issue(), "keyRejected");

    // A rate limit and an empty credit balance on the person's own key
    // each say so, not that Anthropic could not be reached. Neither marks
    // the key rejected (checked with the other replies above).
    for (status, body, issue) in [
        (429, String::new(), "keyRateLimited"),
        (402, String::new(), "billing"),
        (
            400,
            r#"{"type":"error","error":{"message":"Your credit balance is too low"}}"#.to_string(),
            "billing",
        ),
    ] {
        let mut s = session(Scripted::default().answer(Ok((status, body))));
        s.approve();
        s.say("The fictional rota has two gaps.");
        s.settle();
        assert!(!s.engine.has_processing_permission());
        assert_eq!(s.issue(), issue);
    }

    let mut s = session_with_cap(Scripted::default(), 1);
    s.approve();
    s.say("The fictional rota has two gaps.");
    s.settle();
    assert_eq!(s.issue(), "spendLimit");
    assert!(s.transport.sent().is_empty());

    let mut s = session(Scripted::default());
    s.approve();
    s.engine.set_model_call_limit(0);
    s.say("The fictional rota has two gaps.");
    assert_eq!(s.issue(), "requestLimit");
    assert!(s.transport.sent().is_empty());
}

#[test]
fn usage_is_reported_only_for_a_registered_session() {
    // The test build registers nothing globally until a session asks.
    let snapshot = Usage::default().snapshot(haiku());
    assert_eq!(
        serde_json::to_value(snapshot).unwrap(),
        json!({"model":"claude-haiku-5-5","requests":0,"requestCap":400,"spentMicroUsd":0,"spendCapMicroUsd":500_000})
    );
}

/// Fictional content that must never reach a file, a log or the terminal.
const PRIVATE_LINE: &str = "Who owns the fictional Marigold checklist?";
const PRIVATE_CUE: &str = "Who owns the Marigold checklist?";
const PRIVATE_NOTE: &str = "Fictional note: the Marigold keys are in the blue tin.";
const PRIVATE_FOCUS: &str = "Agree the Marigold potluck seating";
const PRIVATE_NAME: &str = "Ottoline";

#[test]
#[ignore = "run in an isolated process by a_cue_session_with_failures_and_notes_writes_nothing_and_prints_nothing"]
fn isolated_cue_session_with_failures_and_notes() {
    // A cue, then an outage, with the person's key, notes, focus and name.
    let shown = decision("show", Some(PRIVATE_CUE), &["transcript:line-1"]);
    let mut s = session(
        Scripted::default()
            .answer(Ok((200, sse(MODEL, &shown, "end_turn"))))
            .answer(Ok((529, String::new()))),
    );
    s.engine.update_notes(PRIVATE_NOTE.into()).unwrap();
    s.engine.set_focus(vec![PRIVATE_FOCUS.into()]).unwrap();
    s.engine.set_user_name(Some(PRIVATE_NAME.into())).unwrap();
    s.approve();
    s.say(PRIVATE_LINE);
    s.settle();
    assert!(s.engine.state.cue.is_some());
    s.say("The fictional Marigold list is in the shared folder.");
    s.settle();
    assert_eq!(s.issue(), "unreachable");
    // The kept meeting is built in memory; only Export writes it, to a file
    // the person chooses.
    s.engine.set_keep_meeting(true);
    assert!(s.engine.markdown().contains(PRIVATE_LINE));
    // Meeting notes after the session: refused for the key, then offline.
    s.engine.end();
    let plan = s.engine.meeting_notes_plan(true).unwrap();
    let prepared = s
        .engine
        .begin_meeting_notes(true, &plan.fingerprint)
        .unwrap();
    let mut refused = Scripted::default().answer(Ok((401, String::new())));
    let written =
        crate::meeting_notes::write(&mut refused, Secret::for_test(KEY), &prepared, || {});
    assert!(written.result.is_err());
}

#[test]
fn a_cue_session_with_failures_and_notes_writes_nothing_and_prints_nothing() {
    // The timing log is asked for: only a development build with the
    // `timing-log` feature may write it, and then only that one file.
    let crate::test_isolation::Isolated { left, printed } = crate::test_isolation::run(
        "anthropic_api::tests::isolated_cue_session_with_failures_and_notes",
        &[("TALKQTE_TIMING_LOG", "timing.jsonl")],
        &[],
    );
    if cfg!(feature = "timing-log") {
        assert!(
            left.iter().all(|name| name == "timing.jsonl"),
            "the session left files: {left:?}"
        );
    } else {
        assert!(left.is_empty(), "the session left files: {left:?}");
    }
    for private in [
        KEY,
        "Marigold",
        PRIVATE_LINE,
        PRIVATE_CUE,
        PRIVATE_NOTE,
        PRIVATE_FOCUS,
        PRIVATE_NAME,
    ] {
        assert!(!printed.contains(private), "printed {private}: {printed}");
    }
}

fn sse_with_usage(
    model: &str,
    text: &str,
    stop_reason: &str,
    message_start_usage: Value,
) -> String {
    let (a, b) = text.split_at(text.len() / 2);
    let events = [
        json!({"type":"message_start","message":{"model":model,"usage":message_start_usage}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":a}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":b}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":stop_reason},"usage":{"output_tokens":40}}),
        json!({"type":"message_stop"}),
    ];
    events
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn cache_control_is_serialized_on_system_prefix_without_leaking_focus_or_notes() {
    let quiet = decision("quiet", None, &["transcript:line-1"]);
    let transport = Scripted::default()
        .answer(Ok((200, sse(MODEL, &quiet, "end_turn"))))
        .answer(Ok((200, sse(MODEL, &quiet, "end_turn"))));
    let usage = Arc::new(Usage::default());
    let adapter = AnthropicApi::new(
        haiku(),
        transport.clone(),
        Box::new(|| Ok(Secret::for_test(KEY))),
        Box::new(|| {}),
        usage,
    );
    let mut engine = registered(adapter, haiku(), None);
    engine.start().unwrap();
    engine.set_focus(vec![PRIVATE_FOCUS.into()]).unwrap();
    engine.update_notes(PRIVATE_NOTE.into()).unwrap();
    let review = engine
        .review_processing(ConversationScope::NewSpeechOnly, &[])
        .unwrap();
    engine.approve_processing(review).unwrap();
    let mut s = Session {
        engine,
        transport: transport.clone(),
        line: 0,
    };
    s.say("Who owns the fictional Atlas checklist?");
    s.settle();
    s.say("Priya will take the Atlas checklist by Friday.");
    s.settle();

    let sent = transport.sent();
    assert_eq!(sent.len(), 2);
    for (_, payload) in &sent {
        let system = payload["system"].as_array().expect("system array");
        assert_eq!(system.len(), 1);
        assert_eq!(system[0]["type"], "text");
        assert_eq!(system[0]["text"], system_prompt());
        assert_eq!(system[0]["cache_control"], json!({"type": "ephemeral"}));
        let serialized = payload.to_string();
        assert!(!serialized.contains(PRIVATE_FOCUS));
        assert!(!serialized.contains(PRIVATE_NOTE));
    }
}

#[test]
fn cache_creation_and_cache_read_tokens_account_accurately_across_turns() {
    // Haiku 5.5 prices ($/M = micro-USD/token):
    // input = 0.1, cache_write = 0.125 (1.25x), cache_read = 0.01 (0.1x), output = 0.5.
    let model = haiku();
    let uncached_only = TokenUsage {
        input: Some(2_000),
        cache_write: None,
        cache_read: None,
        output: Some(40),
    }
    .cost_micro_usd(model);
    assert_eq!(uncached_only, 220); // 200 + 20

    let cache_write_turn = TokenUsage {
        input: Some(200),
        cache_write: Some(2_000),
        cache_read: Some(0),
        output: Some(40),
    }
    .cost_micro_usd(model);
    assert_eq!(cache_write_turn, 290); // 20 + 250 (1.25x) + 0 + 20

    let cache_read_turn = TokenUsage {
        input: Some(200),
        cache_write: Some(0),
        cache_read: Some(2_000),
        output: Some(40),
    }
    .cost_micro_usd(model);
    assert_eq!(cache_read_turn, 60); // 20 + 0 + 20 (0.1x) + 20

    // Verify end-to-end stream parsing + session spend accumulation through
    // CueUsageTracker and Usage across cache-write, cache-read, and no-cache turns.
    let quiet = decision("quiet", None, &["transcript:line-1"]);
    let transport = Scripted::default()
        .answer(Ok((
            200,
            sse_with_usage(
                MODEL,
                &quiet,
                "end_turn",
                json!({"input_tokens": 200, "cache_creation_input_tokens": 2000, "cache_read_input_tokens": 0, "output_tokens": 1}),
            ),
        )))
        .answer(Ok((
            200,
            sse_with_usage(
                MODEL,
                &quiet,
                "end_turn",
                json!({"input_tokens": 200, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 2000, "output_tokens": 1}),
            ),
        )))
        .answer(Ok((
            200,
            sse_with_usage(
                MODEL,
                &quiet,
                "end_turn",
                json!({"input_tokens": 2000, "output_tokens": 1}),
            ),
        )));
    let usage = Arc::new(Usage::default());
    let tracker = Arc::new(crate::llm_provider::CueUsageTracker::new(
        crate::llm_provider::CueProvider::Anthropic,
        MODEL,
        false,
    ));
    let resolved = crate::llm_provider::ResolvedModel::from_curated(
        crate::llm_provider::default_cue_model(crate::llm_provider::CueProvider::Anthropic),
    );
    let adapter = AnthropicApi::for_resolved(
        resolved,
        transport,
        Box::new(|| Ok(Secret::for_test(KEY))),
        Box::new(|| {}),
        usage.clone(),
        tracker.clone(),
    );
    let worker = Worker::start(adapter, DEADLINE).unwrap();
    let mut run = Run {
        usage,
        rejected: Arc::default(),
        worker,
    };
    let req = request(None);
    assert_eq!(run.evaluate(&req).unwrap().action, Action::Quiet);
    assert_eq!(run.usage.snapshot(model).spent_micro_usd, 290);
    assert_eq!(tracker.snapshot().spent_micro_usd, Some(290));

    assert_eq!(run.evaluate(&req).unwrap().action, Action::Quiet);
    assert_eq!(run.usage.snapshot(model).spent_micro_usd, 290 + 60);
    assert_eq!(tracker.snapshot().spent_micro_usd, Some(350));

    // Omitted cache fields default cleanly to zero without error.
    assert_eq!(run.evaluate(&req).unwrap().action, Action::Quiet);
    assert_eq!(run.usage.snapshot(model).spent_micro_usd, 290 + 60 + 220);
    assert_eq!(tracker.snapshot().spent_micro_usd, Some(570));
    assert_eq!(tracker.snapshot().requests, 3);
}

#[test]
fn filler_lines_do_not_trigger_anthropic_requests_in_live_session() {
    let quiet = decision("quiet", None, &["transcript:line-5"]);
    let mut s = session(Scripted::default().answer(Ok((200, sse(MODEL, &quiet, "end_turn")))));
    s.approve();
    s.say("Yeah.");
    s.say("Okay.");
    s.say("Mm-hmm.");
    s.say("Sure.");
    assert!(s.transport.sent().is_empty());
    s.say("Who owns the fictional Atlas checklist?");
    s.settle();
    assert_eq!(s.transport.sent().len(), 1);
    let content = s.transport.sent()[0].1["messages"][0]["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(content.contains("Who owns the fictional Atlas checklist?"));
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
    let adapter = AnthropicApi::new(
        haiku(),
        transport.clone(),
        read,
        Box::new(|| {}),
        Arc::new(Usage::default()),
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

#[test]
fn production_approved_selected_notes_reach_anthropic_wire_with_unknown_date_and_interview_mode() {
    let transport = Scripted::default().answer(Ok((
        200,
        sse(
            MODEL,
            &decision("quiet", None, &["transcript:line-1"]),
            "end_turn",
        ),
    )));
    let adapter = AnthropicApi::new(
        haiku(),
        transport.clone(),
        Box::new(|| Ok(Secret::for_test(KEY))),
        Box::new(|| panic!("scripted success")),
        Arc::default(),
    );
    crate::own_key_selected_tests::selected_engine(
        adapter,
        crate::llm_provider::CueProvider::Anthropic,
        MODEL,
    );
    let sent = transport.sent();
    assert_eq!(sent.len(), 1);
    crate::own_key_selected_tests::check_wire(
        sent[0].1["messages"][0]["content"].as_str().unwrap(),
        sent[0].1["system"][0]["text"].as_str().unwrap(),
    );
    assert_eq!(
        sent[0].1["output_config"]["format"]["schema"],
        schema(OnScreen::Nothing)
    );
}
