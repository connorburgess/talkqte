//! Cue decisions and meeting notes through the Google Gemini REST API,
//! called directly with the person's own API key from the OS secret store.
//!
//! Nothing is sent until the session's processing review (or meeting notes
//! confirmation) is approved. The key is read for each request, sent only in
//! the `x-goog-api-key` HTTP header (never in the URL query string) over HTTPS
//! with TLS verification, and never logged or returned.

use crate::cue_evaluator::{Cancellation, Evaluator, Failure, Request};
use crate::llm_provider::{
    check_cue_spend_cap, cue_schema, cue_system_prompt, finish_no_reply, model_echo_matches,
    read_refusal_prefix, register_cue_engine, register_usage, token_cost_micro_usd, CueProvider,
    CueUsageTracker, DecisionValidator, NoReply, OnScreen, Outcome, Reply, ResolvedModel,
    MAX_LINE_BYTES, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_TEXT_BYTES, SPEND_CAP_MICRO_USD,
};
use crate::provider_keys::{KeyError, Provider, Secret};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read},
    sync::Arc,
    time::{Duration, Instant},
};

pub const PROCESSOR_ID: &str = "gemini-api";
const MAX_OUTPUT_TOKENS: u64 = 2_048;

pub trait Transport: Send + 'static {
    fn post(
        &mut self,
        model_id: &str,
        key: &Secret,
        body: &[u8],
        timeout: Duration,
    ) -> Result<Reply, NoReply>;
}

/// Validates and normalizes the model path segment for Gemini URLs so a custom
/// model ID can never alter the path or query string.
pub fn stream_url(model_id: &str) -> Result<String, Failure> {
    let segment = model_id.trim();
    let segment = segment.strip_prefix("models/").unwrap_or(segment);
    if segment.is_empty()
        || segment.contains("..")
        || !segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(Failure::EvaluatorUnavailable);
    }
    Ok(format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{segment}:streamGenerateContent?alt=sse"
    ))
}

pub struct Network;

impl Transport for Network {
    fn post(
        &mut self,
        model_id: &str,
        key: &Secret,
        body: &[u8],
        timeout: Duration,
    ) -> Result<Reply, NoReply> {
        let Ok(url) = stream_url(model_id) else {
            return Err(NoReply::Unsent);
        };
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .https_only(true)
            .http_status_as_error(false)
            .max_redirects(0)
            .user_agent("TalkQTE")
            .build()
            .into();
        // API key is strictly in the x-goog-api-key header, never in the URL.
        let response = agent
            .post(&url)
            .header("x-goog-api-key", key.expose())
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

/// Builds a Gemini `streamGenerateContent` request body for cue evaluation.
pub fn cue_body(input: &str, on_screen: OnScreen) -> Value {
    json!({
        "systemInstruction": {
            "parts": [{"text": cue_system_prompt()}]
        },
        "contents": [{
            "role": "user",
            "parts": [{"text": input}]
        }],
        "generationConfig": {
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
            "responseMimeType": "application/json",
            "responseJsonSchema": cue_schema(on_screen),
        },
    })
}

/// Builds a Gemini `streamGenerateContent` request body for post-session meeting notes.
pub fn notes_body(system: &str, user: &str, schema: &Value, max_output_tokens: u64) -> Value {
    json!({
        "systemInstruction": {
            "parts": [{"text": system}]
        },
        "contents": [{
            "role": "user",
            "parts": [{"text": user}]
        }],
        "generationConfig": {
            "maxOutputTokens": max_output_tokens,
            "responseMimeType": "application/json",
            "responseJsonSchema": schema,
        },
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
        let prompt = usage.get("promptTokenCount").and_then(Value::as_u64);
        let cached = usage.get("cachedContentTokenCount").and_then(Value::as_u64);
        let candidates = usage.get("candidatesTokenCount").and_then(Value::as_u64);
        let thoughts = usage
            .get("thoughtsTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if let Some(total_in) = prompt {
            let cached_in = cached.unwrap_or(0).min(total_in);
            self.input = Some(total_in - cached_in);
            self.cache_read = if cached.is_some() {
                Some(cached_in)
            } else {
                self.cache_read
            };
        }
        if let Some(out) = candidates {
            self.output = Some(out + thoughts);
        }
    }

    pub fn cost_micro_usd(self, price: [f64; 4]) -> u64 {
        token_cost_micro_usd(price, self.input, None, self.cache_read, self.output)
    }
}

pub(crate) fn is_invalid_api_key_400(body: Box<dyn std::io::Read + Send>) -> bool {
    let lower = read_refusal_prefix(body).to_ascii_lowercase();
    lower.contains("api_key_invalid") || lower.contains("api key not valid")
}

/// Reads a Gemini `streamGenerateContent?alt=sse` stream within `max_text_bytes`.
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
    let mut finish_reason: Option<String> = None;
    let mut blocked = false;
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
        if trimmed.is_empty() {
            continue;
        }
        let Ok(chunk) = serde_json::from_slice::<Value>(trimmed) else {
            break Some(Outcome::Protocol);
        };
        if chunk.get("error").is_some() {
            break Some(Outcome::Provider);
        }
        if echo.is_none() {
            echo = chunk["modelVersion"].as_str().map(str::to_string);
        }
        if chunk["promptFeedback"]["blockReason"].as_str().is_some() {
            blocked = true;
            break None;
        }
        if let Some(parts) = chunk["candidates"][0]["content"]["parts"].as_array() {
            for part in parts {
                if part.get("thought").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                if let Some(delta) = part["text"].as_str() {
                    text.push_str(delta);
                    if text.len() > max_text_bytes {
                        break;
                    }
                }
            }
            if text.len() > max_text_bytes {
                break Some(Outcome::OutputLimit);
            }
        }
        if let Some(reason) = chunk["candidates"][0]["finishReason"].as_str() {
            finish_reason = Some(reason.to_string());
        }
        if let Some(meta) = chunk.get("usageMetadata") {
            usage.merge(meta);
        }
    };
    let outcome = outcome.unwrap_or_else(|| {
        if blocked {
            Outcome::Refusal
        } else if echo.is_some() && !model_echo_matches(model_id, echo.as_deref()) {
            Outcome::ConfigurationMismatch
        } else {
            match finish_reason.as_deref() {
                Some("STOP") => Outcome::Decision(std::mem::take(&mut text)),
                Some("MAX_TOKENS") => Outcome::OutputLimit,
                Some(
                    "SAFETY" | "RECITATION" | "PROHIBITED_CONTENT" | "BLOCKLIST" | "SPII"
                    | "IMAGE_SAFETY" | "MODEL_ARMOR",
                ) => Outcome::Refusal,
                _ => Outcome::Protocol,
            }
        }
    });
    let complete = finish_reason.as_deref() == Some("STOP")
        && usage.input.is_some()
        && usage.output.is_some()
        && outcome != Outcome::OutputLimit;
    (outcome, usage, complete)
}

type KeySource = Box<dyn FnMut() -> Result<Secret, KeyError> + Send>;
type OnRejected = Box<dyn FnMut() + Send>;

pub struct GeminiApi<T: Transport> {
    model: ResolvedModel,
    transport: T,
    key: KeySource,
    on_rejected: OnRejected,
    usage: Arc<CueUsageTracker>,
    spend_cap: u64,
    validator: DecisionValidator,
}

impl<T: Transport> GeminiApi<T> {
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

impl<T: Transport> Evaluator for GeminiApi<T> {
    fn evaluate(&mut self, request: &Request, cancel: &Cancellation) -> Result<String, Failure> {
        if cancel.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        if stream_url(&self.model.id).is_err() {
            return Err(Failure::EvaluatorUnavailable);
        }
        let input = request.prompt_input()?;
        let on_screen = OnScreen::of(request);
        let body = cue_body(&input, on_screen).to_string();
        if body.len() > MAX_REQUEST_BYTES {
            return Err(Failure::InvalidInput);
        }
        let prompt_bytes =
            cue_system_prompt().len() + input.len() + cue_schema(on_screen).to_string().len();
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
        let reply = self
            .transport
            .post(&self.model.id, &key, body.as_bytes(), timeout);
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
            400 if is_invalid_api_key_400(reply.body) => {
                // The error-body read can cross withdrawal after headers.
                // Recheck before changing shared provider readiness.
                if cancel.is_withdrawn() {
                    return Err(Failure::Cancelled);
                }
                (self.on_rejected)();
                return Err(Failure::SignIn);
            }
            402 => return Err(Failure::Billing),
            429 => {
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
        CueProvider::Gemini,
        &model.id,
        model.custom,
    ));
    register_usage(usage.clone());
    let model_id = model.id.clone();
    let custom = model.custom;
    let key_source = crate::provider_keys::global().request_key(Provider::Gemini);
    let rejected_source = key_source.clone();
    let adapter = GeminiApi::new(
        model,
        Network,
        Box::new(move || key_source.get()),
        Box::new(move || rejected_source.mark_rejected()),
        usage,
    );
    register_cue_engine(
        adapter,
        CueProvider::Gemini,
        &model_id,
        custom,
        None,
        crate::transcription::cloud::review_sentence(sources),
    )
}

#[cfg(test)]
#[path = "gemini_api_tests.rs"]
mod tests;
