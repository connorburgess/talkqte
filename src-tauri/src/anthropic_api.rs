//! Cue decisions from the app itself: the Anthropic Messages API, called
//! directly with the person's own API key from the Keychain.
//!
//! The request is the lab's direct-API request (`buildAnthropicParams` in
//! `scripts/cue-lab-anthropic-core.mjs`): the same model settings, byte-stable
//! system prompt from `scripts/fixtures/cue-decision.json`, user message,
//! effort, structured-output schema chosen by the cue on screen, output bound
//! and streaming. `scripts/fixtures/anthropic-request.json` pins both to the
//! same requests. Replies are handled as the lab's adapter and broker handle
//! them: the same outcome classes, the same request-scoped non-decisions
//! (a refusal, a reply at its output bound, and fewer than three unusable
//! replies in a row), the same normalisation of a cue-on-screen reply, the
//! same spend estimate from the same price table, and the lab's settlement
//! rules in the engine (`InApp`). There is no retry, no other model and no
//! fallback service.
//!
//! Nothing is sent until the session review is approved. The key is read from
//! the Keychain for each request, sent only in the `x-api-key` header over
//! TLS with certificate validation, and never logged or returned. No provider
//! text reaches a log or the notebook: failures are fixed codes.

use crate::cue_evaluator::{
    Cancellation, EvaluationLifecycle, Evaluator, Failure, Request, Settlement,
};
use crate::provider_keys::{KeyError, Provider, Secret};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

/// The processor id the review and the engine know this connection by.
pub const PROCESSOR_ID: &str = "anthropic-api";
/// The model used unless the owner decides otherwise.
pub const MODEL: &str = "claude-haiku-5-5";
/// Most requests one session may send.
pub const REQUEST_CAP: u64 = 400;
/// Most estimated spend one session may reach, in micro-dollars ($0.50).
pub const SPEND_CAP_MICRO_USD: u64 = 500_000;
/// Each request's deadline, as in the lab.
pub const DEADLINE: Duration = Duration::from_secs(8);
/// The shortest time between two requests on the session clock, as in the lab.
pub const MIN_GAP_MS: u64 = 2_000;

const URL: &str = "https://api.anthropic.com/v1/messages";
const EFFORT: &str = "low";
/// Shared by adaptive thinking and the reply; reaching it is a non-decision.
const MAX_TOKENS: u64 = 2_048;
/// Reply text beyond this is a non-decision, as in the lab.
const MAX_TEXT_BYTES: usize = 4_096;
/// One server-sent event line.
const MAX_LINE_BYTES: usize = 64 * 1024;
/// The whole streamed response.
const MAX_RESPONSE_BYTES: u64 = 1 << 20;
/// The request body; the engine's input bounds keep it far below this.
const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Unusable replies in a row that stop cues, as the lab broker counts them.
const INVALID_REPLIES_IN_A_ROW: u32 = 3;

/// One of the three models the lab measured at effort low, with its
/// thinking setting and its price in dollars per million tokens: input,
/// 5-minute cache write, cache read, output (the lab's table, read
/// 2026-11-16). A dollar per million tokens is a micro-dollar per token.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Model {
    pub id: &'static str,
    thinking: Option<&'static str>,
    pub(crate) price: [f64; 4],
}

pub const MODELS: [Model; 3] = [
    Model {
        id: "claude-opus-5-5",
        thinking: None,
        price: [4.0, 5.0, 0.2, 20.0],
    },
    Model {
        id: "claude-sonnet-5-5",
        thinking: Some("between_tools"),
        price: [2.0, 2.5, 0.1, 10.0],
    },
    Model {
        id: "claude-haiku-5-5",
        thinking: None,
        price: [0.1, 0.125, 0.01, 0.5],
    },
];

pub fn model(id: &str) -> Option<Model> {
    MODELS.into_iter().find(|model| model.id == id)
}

const CONTRACT: &str = include_str!("../../scripts/fixtures/cue-decision.json");

/// The lab's live API system prompt: the live evaluator prompt with the
/// glance rule and the field notes always included. Never changes, so the
/// API can cache it.
pub fn system_prompt() -> &'static str {
    static PROMPT: OnceLock<String> = OnceLock::new();
    PROMPT.get_or_init(|| {
        let contract: Value = serde_json::from_str(CONTRACT).expect("the cue contract is JSON");
        [
            "liveCompact",
            "glanceRule",
            "nameNote",
            "historyNote",
            "askedNote",
        ]
        .iter()
        .map(|name| {
            contract["prompts"][name]
                .as_str()
                .expect("the cue contract has every prompt")
        })
        .collect()
    })
}

/// Which cue is on screen, which chooses the reply schema.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnScreen {
    Nothing,
    Cue,
    /// TalkQTE's own "Asked you" cue: keep it or say it was answered.
    Asked,
}

impl OnScreen {
    fn of(request: &Request) -> Self {
        match request.existing_cue() {
            None => Self::Nothing,
            Some(cue) if cue.asked => Self::Asked,
            Some(_) => Self::Cue,
        }
    }
}

/// The lab's three fixed schemas (`anthropicSchemaFor`).
pub fn schema(on_screen: OnScreen) -> Value {
    let (actions, cue) = match on_screen {
        OnScreen::Nothing => (
            json!(["show", "quiet"]),
            json!({"anyOf": [{"type": "string"}, {"type": "null"}]}),
        ),
        OnScreen::Cue => (
            json!(["quiet", "resolved", "withdraw"]),
            json!({"type": "null"}),
        ),
        OnScreen::Asked => (json!(["quiet", "resolved"]), json!({"type": "null"})),
    };
    json!({
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": actions},
            "cue": cue,
            "sourceIds": {"type": "array", "minItems": 1, "items": {"type": "string"}},
        },
        "required": ["action", "cue", "sourceIds"],
        "additionalProperties": false,
    })
}

/// The request body for one evaluation: `input` is the lab's input JSON
/// (`Request::prompt_input`), sent verbatim as the user message.
pub fn body(model: Model, input: &str, on_screen: OnScreen) -> Value {
    let mut body = json!({
        "model": model.id,
        "max_tokens": MAX_TOKENS,
        "system": [{
            "type": "text",
            "text": system_prompt(),
            "cache_control": {"type": "ephemeral"},
        }],
        "messages": [{"role": "user", "content": input}],
        "output_config": {
            "effort": EFFORT,
            "format": {"type": "json_schema", "schema": schema(on_screen)},
        },
        "stream": true,
    });
    if let Some(thinking) = model.thinking {
        body["thinking"] = json!({"type": thinking});
    }
    body
}

/// The lab's preflight worst case for one call (`worstCaseMicroUsd`): about
/// two bytes per token for the prompt, input and schema plus 1,500 tokens
/// for the structured-output prompt, at the higher of the input and
/// cache-write price, plus the whole output bound.
pub fn worst_case_micro_usd(model: Model, input: &str, on_screen: OnScreen) -> u64 {
    let bytes = system_prompt().len() + input.len() + schema(on_screen).to_string().len();
    let tokens = bytes.div_ceil(2) as f64 + 1_500.0;
    let [input_price, write_price, _, output_price] = model.price;
    (tokens * input_price.max(write_price) + MAX_TOKENS as f64 * output_price).ceil() as u64
}

/// Reported usage, as the lab charges it (`costMicroUsd`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input: Option<u64>,
    pub cache_write: Option<u64>,
    pub cache_read: Option<u64>,
    pub output: Option<u64>,
}

impl TokenUsage {
    fn merge(&mut self, usage: &Value) {
        let read = |key: &str| usage.get(key).and_then(Value::as_u64);
        self.input = read("input_tokens").or(self.input);
        self.cache_write = read("cache_creation_input_tokens").or(self.cache_write);
        self.cache_read = read("cache_read_input_tokens").or(self.cache_read);
        self.output = read("output_tokens").or(self.output);
    }

    pub fn cost_micro_usd(self, model: Model) -> u64 {
        let [input, write, read, output] = model.price;
        let n = |v: Option<u64>| v.unwrap_or(0) as f64;
        (n(self.input) * input
            + n(self.cache_write) * write
            + n(self.cache_read) * read
            + n(self.output) * output)
            .ceil() as u64
    }
}

/// One HTTP exchange. The network transport posts to the Messages API;
/// tests script the reply.
/// No reply was received: the connection failed or timed out. No detail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NoReply;

pub trait Transport: Send + 'static {
    /// Posts `body` with the key, within `timeout`. Ok carries the status and
    /// a reader over the streamed body; Err means no reply was received.
    fn post(&mut self, key: &Secret, body: &[u8], timeout: Duration) -> Result<Reply, NoReply>;
}

pub struct Reply {
    pub status: u16,
    pub body: Box<dyn Read + Send>,
}

/// The Messages API over HTTPS: ureq with rustls and the bundled web roots,
/// certificate validation on, no redirects, one overall timeout from the
/// request's deadline, and a bound on the response.
pub struct Network;

impl Transport for Network {
    fn post(&mut self, key: &Secret, body: &[u8], timeout: Duration) -> Result<Reply, NoReply> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .https_only(true)
            .http_status_as_error(false)
            .max_redirects(0)
            .user_agent("TalkQTE")
            .build()
            .into();
        let response = agent
            .post(URL)
            .header("x-api-key", key.expose())
            .header("anthropic-version", crate::provider_keys::ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .send(body)
            .map_err(|_| NoReply)?;
        let status = response.status().as_u16();
        let body = response
            .into_body()
            .into_with_config()
            .limit(MAX_RESPONSE_BYTES)
            .reader();
        Ok(Reply {
            status,
            body: Box::new(body),
        })
    }
}

/// Requests sent and estimated spend for the current session, which the
/// notebook shows. Content-free.
#[derive(Debug, Default)]
pub struct Usage {
    requests: AtomicU64,
    spent_micro_usd: AtomicU64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub model: &'static str,
    pub requests: u64,
    pub request_cap: u64,
    pub spent_micro_usd: u64,
    pub spend_cap_micro_usd: u64,
}

impl Usage {
    pub fn snapshot(&self, model: Model) -> UsageSnapshot {
        UsageSnapshot {
            model: model.id,
            requests: self.requests.load(Ordering::Acquire),
            request_cap: REQUEST_CAP,
            spent_micro_usd: self.spent_micro_usd.load(Ordering::Acquire),
            spend_cap_micro_usd: SPEND_CAP_MICRO_USD,
        }
    }

    fn charge(&self, micro_usd: u64) {
        self.spent_micro_usd.fetch_add(micro_usd, Ordering::AcqRel);
    }
}

/// The latest session's usage, if a session has used this connection.
fn current() -> &'static Mutex<Option<Arc<Usage>>> {
    static CURRENT: Mutex<Option<Arc<Usage>>> = Mutex::new(None);
    &CURRENT
}

/// What the notebook shows: this session's requests and estimated spend,
/// or nothing before a session has registered this connection.
pub fn usage() -> Option<UsageSnapshot> {
    let model = model(MODEL)?;
    current()
        .lock()
        .ok()?
        .as_ref()
        .map(|usage| usage.snapshot(model))
}

type KeySource = Box<dyn FnMut() -> Result<Secret, KeyError> + Send>;
type OnRejected = Box<dyn FnMut() + Send>;

/// The adapter the cue worker runs.
pub struct AnthropicApi<T: Transport> {
    model: Model,
    transport: T,
    key: KeySource,
    on_rejected: OnRejected,
    usage: Arc<Usage>,
    spend_cap: u64,
    invalid_in_a_row: u32,
}

impl<T: Transport> AnthropicApi<T> {
    pub fn new(
        model: Model,
        transport: T,
        key: KeySource,
        on_rejected: OnRejected,
        usage: Arc<Usage>,
    ) -> Self {
        Self {
            model,
            transport,
            key,
            on_rejected,
            usage,
            spend_cap: SPEND_CAP_MICRO_USD,
            invalid_in_a_row: 0,
        }
    }

    #[cfg(test)]
    fn with_spend_cap(mut self, cap: u64) -> Self {
        self.spend_cap = cap;
        self
    }
}

/// What a streamed reply came to, before its text is checked.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Decision(String),
    Cancelled,
    Refusal,
    OutputLimit,
    ConfigurationMismatch,
    Protocol,
    Provider,
}

impl<T: Transport> Evaluator for AnthropicApi<T> {
    fn evaluate(&mut self, request: &Request, cancel: &Cancellation) -> Result<String, Failure> {
        if cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        // Prior notes are never sent on this route; such input fails closed.
        let input = request.prompt_input()?;
        let on_screen = OnScreen::of(request);
        let body = body(self.model, &input, on_screen).to_string();
        if body.len() > MAX_REQUEST_BYTES {
            return Err(Failure::InvalidInput);
        }
        // Refuse before sending if this call's worst case could pass the
        // session's estimate cap; that stops cues for the session.
        let worst = worst_case_micro_usd(self.model, &input, on_screen);
        if self.usage.spent_micro_usd.load(Ordering::Acquire) + worst > self.spend_cap {
            return Err(Failure::SpendLimit);
        }
        let key = match (self.key)() {
            Ok(key) => key,
            // Removed from the Keychain, or the Keychain could not be read:
            // not a refusal by Anthropic.
            Err(_) => return Err(Failure::Credentials),
        };
        let timeout = cancel.deadline().saturating_duration_since(Instant::now());
        if timeout.is_zero() {
            return Err(Failure::Cancelled);
        }
        self.usage.requests.fetch_add(1, Ordering::AcqRel);
        let reply = self.transport.post(&key, body.as_bytes(), timeout);
        drop(key);
        let reply = match reply {
            Ok(reply) => reply,
            Err(NoReply) => {
                // Whatever reached the provider may still be billed.
                self.usage.charge(worst);
                return Err(if cancel.is_cancelled() {
                    Failure::Cancelled
                } else {
                    Failure::Unreachable
                });
            }
        };
        match reply.status {
            200 => {}
            401 | 403 => {
                (self.on_rejected)();
                return Err(Failure::SignIn);
            }
            429 => {
                self.usage.charge(worst);
                return Err(Failure::UsageLimit);
            }
            _ => {
                self.usage.charge(worst);
                return Err(Failure::Unreachable);
            }
        }
        let (outcome, usage, complete) = read_stream(reply.body, self.model, cancel);
        // Only a reply that reached message_stop with its usage is charged
        // what it reported; anything else is charged the worst case.
        self.usage.charge(if complete {
            usage.cost_micro_usd(self.model)
        } else {
            worst
        });
        match outcome {
            Outcome::Decision(text) => self.checked(text, request, on_screen),
            Outcome::Cancelled => Err(Failure::Cancelled),
            Outcome::Refusal => Err(Failure::Refused),
            Outcome::OutputLimit => Err(Failure::OutputLimit),
            Outcome::ConfigurationMismatch | Outcome::Protocol => {
                Err(Failure::EvaluatorUnavailable)
            }
            Outcome::Provider => Err(Failure::Unreachable),
        }
    }
}

impl<T: Transport> AnthropicApi<T> {
    /// The broker's handling of an API reply: a cue-on-screen `show`, or a
    /// `withdraw` of an "Asked you" cue, means keep it (quiet). A reply that
    /// still fails the checks is a non-decision for this request only,
    /// unless it is the third in a row, which stops cues.
    fn checked(
        &mut self,
        text: String,
        request: &Request,
        on_screen: OnScreen,
    ) -> Result<String, Failure> {
        match normalized(&text, request, on_screen) {
            Some(reply) => {
                self.invalid_in_a_row = 0;
                Ok(reply)
            }
            None => {
                self.invalid_in_a_row += 1;
                Err(if self.invalid_in_a_row < INVALID_REPLIES_IN_A_ROW {
                    Failure::Refused
                } else {
                    Failure::InvalidDecision
                })
            }
        }
    }
}

fn normalized(text: &str, request: &Request, on_screen: OnScreen) -> Option<String> {
    let mut value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object_mut()?;
    // Enum casing is not guaranteed by the API.
    if let Some(action) = object.get("action").and_then(Value::as_str) {
        let action = action.to_lowercase();
        object.insert("action".into(), Value::String(action));
    }
    let action = object.get("action").and_then(Value::as_str);
    let keep = matches!(
        (on_screen, action),
        (OnScreen::Cue | OnScreen::Asked, Some("show")) | (OnScreen::Asked, Some("withdraw"))
    );
    if keep {
        let sources = object.get("sourceIds").cloned()?;
        value = json!({"action": "quiet", "cue": null, "sourceIds": sources});
    }
    if reply_problem(&value, request) {
        None
    } else {
        Some(value.to_string())
    }
}

/// The broker's `replyProblem`, as a yes/no: the exact three fields, a known
/// action, one to four distinct cited lines from this request, an action that
/// fits the cue on screen, a bounded cue only with `show`, and the glance rule.
fn reply_problem(value: &Value, request: &Request) -> bool {
    let Some(object) = value.as_object() else {
        return true;
    };
    if object.len() != 3
        || !["action", "cue", "sourceIds"]
            .iter()
            .all(|k| object.contains_key(*k))
    {
        return true;
    }
    let action = object["action"].as_str().unwrap_or("");
    if !["show", "quiet", "resolved", "withdraw"].contains(&action) {
        return true;
    }
    let Some(ids) = object["sourceIds"].as_array() else {
        return true;
    };
    let known = |id: &Value| {
        id.as_str()
            .is_some_and(|id| request.sources().iter().any(|source| source.id == id))
    };
    if ids.is_empty()
        || ids.len() > 4
        || !ids.iter().all(known)
        || ids.iter().enumerate().any(|(i, id)| ids[..i].contains(id))
    {
        return true;
    }
    let existing = request.existing_cue().is_some();
    if matches!(action, "resolved" | "withdraw") && !existing {
        return true;
    }
    if action == "show" && existing {
        return true;
    }
    match (action, &object["cue"]) {
        ("show", Value::String(cue)) => {
            cue.trim().is_empty()
                || cue.encode_utf16().count() > 240
                || cue.split_whitespace().count() > 10
        }
        ("show", _) => true,
        (_, Value::Null) => value.to_string().len() > MAX_TEXT_BYTES,
        _ => true,
    }
}

/// Reads the server-sent events of one reply, as the lab's
/// `runAnthropicRequest` does: the model echo, text deltas within the text
/// bound, the stop reason and usage. Returns the outcome, the usage seen and
/// whether the reply was complete enough to be charged its reported usage.
fn read_stream(
    body: Box<dyn Read + Send>,
    model: Model,
    cancel: &Cancellation,
) -> (Outcome, TokenUsage, bool) {
    read_bounded_stream(body, model, MAX_TEXT_BYTES, &|| cancel.is_cancelled())
}

/// [`read_stream`] with its own bound on the reply text and its own
/// cancellation check, for the one meeting-notes request.
pub(crate) fn read_bounded_stream(
    body: Box<dyn Read + Send>,
    model: Model,
    max_text_bytes: usize,
    cancelled: &dyn Fn() -> bool,
) -> (Outcome, TokenUsage, bool) {
    let mut reader = BufReader::new(body);
    let mut usage = TokenUsage::default();
    let mut text = String::new();
    let mut echo: Option<String> = None;
    let mut stop_reason: Option<String> = None;
    let mut stopped = false;
    let mut line = Vec::new();
    let outcome = loop {
        if cancelled() {
            break Some(Outcome::Cancelled);
        }
        line.clear();
        let read = (&mut reader)
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut line);
        match read {
            Ok(0) => break None,
            Ok(_) if line.len() > MAX_LINE_BYTES => break Some(Outcome::Protocol),
            Ok(_) => {}
            Err(_) => {
                break Some(if cancelled() {
                    Outcome::Cancelled
                } else {
                    Outcome::Provider
                })
            }
        }
        let Some(data) = line.strip_prefix(b"data:") else {
            continue;
        };
        let Ok(event) = serde_json::from_slice::<Value>(data) else {
            break Some(Outcome::Protocol);
        };
        match event["type"].as_str() {
            Some("message_start") => {
                if echo.is_none() {
                    echo = event["message"]["model"].as_str().map(str::to_string);
                }
                usage.merge(&event["message"]["usage"]);
            }
            Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                text.push_str(event["delta"]["text"].as_str().unwrap_or(""));
                if text.len() > max_text_bytes {
                    break Some(Outcome::OutputLimit);
                }
            }
            Some("message_delta") => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    stop_reason = Some(reason.to_string());
                }
                usage.merge(&event["usage"]);
            }
            Some("message_stop") => {
                stopped = true;
                break None;
            }
            Some("error") => break Some(Outcome::Provider),
            _ => {}
        }
    };
    let outcome = outcome.unwrap_or_else(|| {
        if echo.as_deref() != Some(model.id) {
            Outcome::ConfigurationMismatch
        } else if stop_reason.as_deref() == Some("refusal") {
            Outcome::Refusal
        } else if stop_reason.as_deref() == Some("max_tokens") {
            Outcome::OutputLimit
        } else if stop_reason.as_deref() != Some("end_turn") || !stopped {
            Outcome::Protocol
        } else {
            Outcome::Decision(std::mem::take(&mut text))
        }
    });
    let complete = stopped
        && usage.input.is_some()
        && usage.output.is_some()
        && outcome != Outcome::OutputLimit;
    (outcome, usage, complete)
}

/// The lab's settlement rules without a broker: new speech coalesces, a
/// reply to a transcript that has only grown applies, and a deadline, a
/// refusal or a reply at its output bound retires only that request. Unlike
/// the lab run, Pause and Dismiss cancel the request in flight without
/// ending cues for the session, and Resume continues.
struct InApp;

impl EvaluationLifecycle for InApp {
    fn terminal(&self) -> Option<Failure> {
        None
    }
    fn cancel(&self) {}
    fn settle(&self, _: &Request, _: Settlement) -> Result<(), Failure> {
        Ok(())
    }
    fn ends_run_on_control(&self) -> bool {
        false
    }
}

/// What the review shows before anything is sent. Kept short: the
/// review's whole policy, with the Deepgram sentence, is bounded.
fn data_policy(model: Model) -> String {
    format!(
        "Sends to the Anthropic API (US), with your own Anthropic API key, billed to your Anthropic account per token: up to six recent transcript lines and any lines the cue on screen cites, the cue on screen, up to four earlier cues with how each ended, and your session name if you set one. It sends after new lines, at most once every two seconds and one request at a time, until you turn this off, stop the session, or a failure stops it, so nearly every transcript line is sent, a few at a time. At most {REQUEST_CAP} requests and an estimated ${:.2} per session (an estimate, not your bill; there is no daily cap). Pause cues stops these requests but not the audio to Deepgram; Off and Stop end both. Model {}. It never sends Anthropic audio, the full transcript, your notes, imported notes or focus lines. Anthropic handles what is sent under your API account's terms (https://www.anthropic.com/legal/commercial-terms); lines already sent cannot be recalled. If it fails, no other service is used.",
        SPEND_CAP_MICRO_USD as f64 / 1_000_000.0,
        model.id
    )
}

/// The engine for a live session with this connection registered. Sends
/// nothing until the person reviews and approves the session.
pub fn connected_engine(sources: &crate::engine::SessionSources) -> crate::engine::Engine {
    let model = model(MODEL).expect("the default model is known");
    let usage = Arc::new(Usage::default());
    if let Ok(mut current) = current().lock() {
        *current = Some(usage.clone());
    }
    let adapter = AnthropicApi::new(
        model,
        Network,
        Box::new(|| crate::provider_keys::global().get(Provider::Anthropic)),
        Box::new(|| crate::provider_keys::global().mark_rejected(Provider::Anthropic)),
        usage,
    );
    registered(
        adapter,
        model,
        crate::transcription::cloud::review_sentence(sources),
    )
}

/// The engine with an adapter registered under this connection's reviewed
/// configuration, request cap, gap and settlement rules.
fn registered<T: Transport>(
    adapter: AnthropicApi<T>,
    model: Model,
    transcription: Option<String>,
) -> crate::engine::Engine {
    use crate::engine::{ProcessingLocation, ProcessorConfiguration, ProcessorDisclosure};
    let policy = match &transcription {
        Some(transcription) => format!("{} {transcription}", data_policy(model)),
        None => data_policy(model),
    };
    let config = ProcessorConfiguration::new(
        PROCESSOR_ID.into(),
        1,
        model.id.into(),
        ProcessingLocation::Hosted {
            service: "the Anthropic API, with your own API key".into(),
        },
        "own-key-cues-v1".into(),
        ProcessorDisclosure::new("Claude (your Anthropic API key)".into(), policy)
            .expect("the fixed disclosure is within its bound"),
    )
    .expect("the fixed configuration is valid")
    .with_effort(EFFORT.into())
    .without_notes();
    let config = match transcription {
        Some(_) => config.with_audio_destination(
            "Deepgram (US), for transcription of the session's audio".into(),
        ),
        None => config,
    };
    let worker = crate::cue_evaluator::Worker::start(adapter, DEADLINE)
        .expect("the deadline is within the worker's ceiling");
    let mut engine = crate::engine::Engine::live_with_evaluator(worker, config)
        .with_lab_lifecycle(Arc::new(InApp))
        .with_min_gap_ms(MIN_GAP_MS);
    engine.set_model_call_limit(REQUEST_CAP);
    engine
}

#[cfg(test)]
#[path = "anthropic_api_tests.rs"]
mod tests;
