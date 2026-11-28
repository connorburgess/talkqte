//! Cue decisions and meeting notes through the OpenAI Responses API,
//! called directly with the person's own API key from the OS secret store.
//!
//! Nothing is sent until the session's processing review (or meeting notes
//! confirmation) is approved. The key is read for each request, sent only in
//! `Authorization: Bearer ...` over HTTPS with TLS verification, and never
//! logged or returned.

use crate::cue_evaluator::{Cancellation, Evaluator, Failure, Request};
use crate::llm_provider::{
    check_cue_spend_cap, cue_schema, finish_no_reply, model_echo_matches, read_refusal_prefix,
    register_cue_engine, register_usage, token_cost_micro_usd, CueProvider, CueUsageTracker,
    DecisionValidator, NoReply, OnScreen, Outcome, Reply, ResolvedModel, MAX_LINE_BYTES,
    MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_TEXT_BYTES, SPEND_CAP_MICRO_USD,
};
use crate::provider_keys::{KeyError, Provider, Secret};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read},
    sync::Arc,
    time::{Duration, Instant},
};

pub const PROCESSOR_ID: &str = "openai-api";
const URL: &str = "https://api.openai.com/v1/responses";
const MAX_OUTPUT_TOKENS: u64 = 2_048;

pub trait Transport: Send + 'static {
    fn post(&mut self, key: &Secret, body: &[u8], timeout: Duration) -> Result<Reply, NoReply>;
}

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
        let auth = zeroize::Zeroizing::new(format!("Bearer {}", key.expose()));
        let response = agent
            .post(URL)
            .header("Authorization", auth.as_str())
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .send(body)
            .map_err(|error| NoReply::from_ureq(&error))?;
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

/// Builds an OpenAI Responses API request body for cue evaluation.
pub fn cue_body(model_id: &str, input: &str, on_screen: OnScreen) -> Value {
    json!({
        "model": model_id,
        "instructions": crate::llm_provider::cue_system_prompt_for_input(input),
        "input": input,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        "store": false,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "talkqte_cue",
                "strict": true,
                "schema": cue_schema(on_screen),
            }
        },
        "stream": true,
    })
}

/// Builds an OpenAI Responses API request body for post-session meeting notes.
pub fn notes_body(
    model_id: &str,
    system: &str,
    user: &str,
    schema: &Value,
    max_output_tokens: u64,
) -> Value {
    json!({
        "model": model_id,
        "instructions": system,
        "input": user,
        "max_output_tokens": max_output_tokens,
        "store": false,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "talkqte_meeting_notes",
                "strict": true,
                "schema": schema,
            }
        },
        "stream": true,
    })
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input: Option<u64>,
    pub cache_read: Option<u64>,
    pub output: Option<u64>,
}

impl TokenUsage {
    fn merge(&mut self, usage: &Value) {
        let input = usage.get("input_tokens").and_then(Value::as_u64);
        let cached = usage
            .get("input_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(Value::as_u64);
        let output = usage.get("output_tokens").and_then(Value::as_u64);
        if let Some(total_in) = input {
            let cached_in = cached.unwrap_or(0).min(total_in);
            self.input = Some(total_in - cached_in);
            self.cache_read = if cached.is_some() {
                Some(cached_in)
            } else {
                self.cache_read
            };
        }
        self.output = output.or(self.output);
    }

    pub fn cost_micro_usd(self, price: [f64; 4]) -> u64 {
        token_cost_micro_usd(price, self.input, None, self.cache_read, self.output)
    }
}

fn refused_for_billing(body: Box<dyn std::io::Read + Send>) -> bool {
    let lower = read_refusal_prefix(body).to_ascii_lowercase();
    lower.contains("insufficient_quota") || lower.contains("billing")
}

/// Reads an OpenAI Responses API SSE stream within `max_text_bytes`.
pub fn read_bounded_stream(
    body: Box<dyn std::io::Read + Send>,
    model_id: &str,
    max_text_bytes: usize,
    cancelled: &dyn Fn() -> bool,
) -> (Outcome, TokenUsage, bool) {
    let mut reader = BufReader::new(body);
    let mut usage = TokenUsage::default();
    let mut text = String::new();
    let mut echo: Option<String> = None;
    let mut status: Option<String> = None;
    let mut incomplete_reason: Option<String> = None;
    let mut completed = false;
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
        let trimmed = data.trim_ascii();
        if trimmed == b"[DONE]" {
            break None;
        }
        let Ok(event) = serde_json::from_slice::<Value>(trimmed) else {
            break Some(Outcome::Protocol);
        };
        match event["type"].as_str() {
            Some("response.created" | "response.in_progress") => {
                if echo.is_none() {
                    echo = event["response"]["model"].as_str().map(str::to_string);
                }
            }
            Some("response.output_text.delta") => {
                text.push_str(event["delta"].as_str().unwrap_or(""));
                if text.len() > max_text_bytes {
                    break Some(Outcome::OutputLimit);
                }
            }
            Some("response.refusal.delta" | "response.refusal.done") => {
                break Some(Outcome::Refusal);
            }
            Some("response.completed") => {
                if echo.is_none() {
                    echo = event["response"]["model"].as_str().map(str::to_string);
                }
                status = event["response"]["status"].as_str().map(str::to_string);
                incomplete_reason = event["response"]["incomplete_details"]["reason"]
                    .as_str()
                    .map(str::to_string);
                usage.merge(&event["response"]["usage"]);
                completed = true;
                break None;
            }
            Some("response.incomplete") => {
                if echo.is_none() {
                    echo = event["response"]["model"].as_str().map(str::to_string);
                }
                status = Some("incomplete".into());
                incomplete_reason = event["response"]["incomplete_details"]["reason"]
                    .as_str()
                    .map(str::to_string);
                usage.merge(&event["response"]["usage"]);
                completed = true;
                break None;
            }
            Some("response.failed" | "error") => break Some(Outcome::Provider),
            _ => {}
        }
    };
    let outcome = outcome.unwrap_or_else(|| {
        if !model_echo_matches(model_id, echo.as_deref()) {
            Outcome::ConfigurationMismatch
        } else if status.as_deref() == Some("incomplete") {
            match incomplete_reason.as_deref() {
                Some("max_output_tokens") => Outcome::OutputLimit,
                Some("content_filter") => Outcome::Refusal,
                _ => Outcome::Protocol,
            }
        } else if status.as_deref() != Some("completed") || !completed {
            Outcome::Protocol
        } else {
            Outcome::Decision(std::mem::take(&mut text))
        }
    });
    let has_usage = completed
        && usage.input.is_some()
        && usage.output.is_some()
        && outcome != Outcome::OutputLimit;
    (outcome, usage, has_usage)
}

type KeySource = Box<dyn FnMut() -> Result<Secret, KeyError> + Send>;
type OnRejected = Box<dyn FnMut() + Send>;

pub struct OpenAiApi<T: Transport> {
    model: ResolvedModel,
    transport: T,
    key: KeySource,
    on_rejected: OnRejected,
    usage: Arc<CueUsageTracker>,
    spend_cap: u64,
    validator: DecisionValidator,
}

impl<T: Transport> OpenAiApi<T> {
    pub fn new(
        model: ResolvedModel,
        transport: T,
        key: KeySource,
        on_rejected: OnRejected,
        usage: Arc<CueUsageTracker>,
    ) -> Self {
        Self {
            model,
            transport,
            key,
            on_rejected,
            usage,
            spend_cap: SPEND_CAP_MICRO_USD,
            validator: DecisionValidator::default(),
        }
    }

    #[cfg(test)]
    fn with_spend_cap(mut self, cap: u64) -> Self {
        self.spend_cap = cap;
        self
    }
}

impl<T: Transport> Evaluator for OpenAiApi<T> {
    fn evaluate(&mut self, request: &Request, cancel: &Cancellation) -> Result<String, Failure> {
        if cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        let input = request.own_key_prompt_input()?;
        let on_screen = OnScreen::of(request);
        let body = cue_body(&self.model.id, &input, on_screen).to_string();
        if body.len() > MAX_REQUEST_BYTES {
            return Err(Failure::InvalidInput);
        }
        let prompt_bytes = crate::llm_provider::cue_system_prompt_for_input(&input).len()
            + input.len()
            + cue_schema(on_screen).to_string().len();
        let worst = check_cue_spend_cap(
            &self.usage,
            self.model.price,
            prompt_bytes,
            MAX_OUTPUT_TOKENS,
            self.spend_cap,
        )?;
        // Request preparation can outlast the deadline. Avoid a Keychain
        // access prompt for work that has already been cancelled.
        if cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        let key = match (self.key)() {
            Ok(key) => key,
            Err(_) => return Err(Failure::Credentials),
        };
        let timeout = cancel.deadline().saturating_duration_since(Instant::now());
        if cancel.is_cancelled() || timeout.is_zero() {
            return Err(Failure::Cancelled);
        }
        self.usage.record_request();
        let reply = self.transport.post(&key, body.as_bytes(), timeout);
        drop(key);
        let reply = match reply {
            Ok(reply) => reply,
            Err(no_reply) => {
                return Err(finish_no_reply(&self.usage, worst, no_reply, cancel));
            }
        };
        match reply.status {
            200 => {}
            401 | 403 => {
                // Retired work cannot mark the key rejected for a resumed
                // or replacement session.
                if cancel.is_withdrawn() {
                    return Err(Failure::Cancelled);
                }
                (self.on_rejected)();
                return Err(Failure::SignIn);
            }
            402 => return Err(Failure::Billing),
            429 => {
                if refused_for_billing(reply.body) {
                    return Err(Failure::Billing);
                }
                self.usage.charge(worst);
                return Err(Failure::UsageLimit);
            }
            _ => {
                self.usage.charge(worst);
                return Err(Failure::Unreachable);
            }
        }
        let (outcome, usage, complete) =
            read_bounded_stream(reply.body, &self.model.id, MAX_TEXT_BYTES, &|| {
                cancel.is_cancelled()
            });
        if let Some(price) = self.model.price {
            self.usage.charge(if complete {
                usage.cost_micro_usd(price)
            } else {
                worst
            });
        }
        match outcome {
            Outcome::Decision(text) => self.validator.check(&text, request, on_screen),
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

pub fn connected_engine(
    model: ResolvedModel,
    sources: &crate::engine::SessionSources,
) -> crate::engine::Engine {
    let usage = Arc::new(CueUsageTracker::new(
        CueProvider::OpenAi,
        &model.id,
        model.custom,
    ));
    register_usage(usage.clone());
    let model_id = model.id.clone();
    let custom = model.custom;
    let mut key_source = crate::provider_keys::global().request_key(Provider::OpenAi);
    let rejected_source = key_source.rejection_handler();
    let adapter = OpenAiApi::new(
        model,
        Network,
        Box::new(move || key_source.get()),
        Box::new(move || rejected_source.mark_rejected()),
        usage,
    );
    register_cue_engine(
        adapter,
        CueProvider::OpenAi,
        &model_id,
        custom,
        None,
        crate::transcription::cloud::review_sentence(sources),
    )
}

#[cfg(test)]
#[path = "openai_api_tests.rs"]
mod tests;
