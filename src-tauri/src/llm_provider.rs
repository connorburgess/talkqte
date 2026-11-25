//! Shared model-provider selection, curated model catalog, custom model ID
//! validation, prompt/schema helpers, and usage accounting across Anthropic,
//! OpenAI, and Gemini.

use crate::cue_evaluator::{
    Cancellation, EvaluationLifecycle, Evaluator, Failure, Request, Settlement, Worker,
};
use crate::provider_keys::Provider;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

/// Most cue requests one session may send, across all providers and models.
pub const REQUEST_CAP: u64 = 400;
/// Most estimated spend one session may reach for built-in models ($0.50).
pub const SPEND_CAP_MICRO_USD: u64 = 500_000;
/// Each cue request's deadline.
pub const DEADLINE: Duration = Duration::from_secs(8);
/// Shortest gap between two cue requests on the session clock.
pub const MIN_GAP_MS: u64 = 2_000;
/// Cue reply text bound.
pub const MAX_TEXT_BYTES: usize = 4_096;
/// One server-sent event line.
pub const MAX_LINE_BYTES: usize = 64 * 1024;
/// Whole streamed response bound.
pub const MAX_RESPONSE_BYTES: u64 = 1 << 20;
/// Request body bound.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Unusable cue replies in a row that stop cues.
pub const INVALID_REPLIES_IN_A_ROW: u32 = 3;
/// Maximum length of a user-entered custom model ID.
pub const MAX_MODEL_ID_CHARS: usize = 96;
/// Maximum refusal body bytes inspected to distinguish billing/key errors.
pub const REFUSAL_BYTES: u64 = 4 * 1024;

/// Which cloud provider the person chose for cue decisions and meeting notes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CueProvider {
    #[default]
    Anthropic,
    OpenAi,
    Gemini,
}

impl CueProvider {
    pub const ALL: [Self; 3] = [Self::Anthropic, Self::OpenAi, Self::Gemini];

    pub fn id(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Gemini => "gemini",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Anthropic => "Anthropic",
            Self::OpenAi => "OpenAI",
            Self::Gemini => "Gemini",
        }
    }

    pub fn key_provider(self) -> Provider {
        match self {
            Self::Anthropic => Provider::Anthropic,
            Self::OpenAi => Provider::OpenAi,
            Self::Gemini => Provider::Gemini,
        }
    }

    pub fn processor_id(self) -> &'static str {
        match self {
            Self::Anthropic => crate::anthropic_api::PROCESSOR_ID,
            Self::OpenAi => crate::openai_api::PROCESSOR_ID,
            Self::Gemini => crate::gemini_api::PROCESSOR_ID,
        }
    }

    pub fn disclosure_name(self) -> &'static str {
        match self {
            Self::Anthropic => "Claude (your Anthropic API key)",
            Self::OpenAi => "OpenAI (your OpenAI API key)",
            Self::Gemini => "Gemini (your Gemini API key)",
        }
    }

    pub fn console_name(self) -> &'static str {
        match self {
            Self::Anthropic => "Anthropic Console",
            Self::OpenAi => "OpenAI Platform",
            Self::Gemini => "Google AI Studio",
        }
    }

    pub fn terms_url(self) -> &'static str {
        match self {
            Self::Anthropic => "https://www.anthropic.com/legal/commercial-terms",
            Self::OpenAi => "https://openai.com/policies/business-terms",
            Self::Gemini => "https://ai.google.dev/gemini-api/terms",
        }
    }

    pub fn cue_destination(self) -> &'static str {
        match self {
            Self::Anthropic => "the Anthropic API, with your own API key",
            Self::OpenAi => "the OpenAI API, with your own API key",
            Self::Gemini => "the Gemini API, with your own API key",
        }
    }

    pub fn notes_destination(self) -> &'static str {
        match self {
            Self::Anthropic => {
                "the Anthropic API (US), with your own Anthropic API key, billed to your Anthropic account"
            }
            Self::OpenAi => {
                "the OpenAI API (US), with your own OpenAI API key, billed to your OpenAI account"
            }
            Self::Gemini => {
                "the Gemini API (Google AI Studio), with your own Gemini API key, billed to your Google account"
            }
        }
    }

    pub fn cue_account_scope(self) -> &'static str {
        match self {
            Self::Anthropic => "the Anthropic API (US), with your own Anthropic API key, billed to your Anthropic account per token",
            Self::OpenAi => "the OpenAI API (US), with your own OpenAI API key, billed to your OpenAI account per token",
            Self::Gemini => "the Gemini API (Google AI Studio), with your own Gemini API key, billed to your Google account per token",
        }
    }
}

/// Curated tested model with known pricing in USD per million tokens:
/// `[input, cache_write, cache_read, output]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CuratedModel {
    pub id: &'static str,
    pub provider: CueProvider,
    pub thinking: Option<&'static str>,
    pub price: [f64; 4],
}

pub const ANTHROPIC_MODELS: [CuratedModel; 3] = [
    CuratedModel {
        id: "claude-opus-5-5",
        provider: CueProvider::Anthropic,
        thinking: None,
        price: [4.0, 5.0, 0.2, 20.0],
    },
    CuratedModel {
        id: "claude-sonnet-5-5",
        provider: CueProvider::Anthropic,
        thinking: Some("between_tools"),
        price: [2.0, 2.5, 0.1, 10.0],
    },
    CuratedModel {
        id: "claude-haiku-5-5",
        provider: CueProvider::Anthropic,
        thinking: None,
        price: [0.1, 0.125, 0.01, 0.5],
    },
];

pub const OPENAI_MODELS: [CuratedModel; 4] = [
    CuratedModel {
        id: "gpt-5-mini",
        provider: CueProvider::OpenAi,
        thinking: None,
        price: [0.25, 0.25, 0.025, 2.0],
    },
    CuratedModel {
        id: "gpt-4.1-mini",
        provider: CueProvider::OpenAi,
        thinking: None,
        price: [0.40, 0.40, 0.10, 1.60],
    },
    CuratedModel {
        id: "gpt-4.1",
        provider: CueProvider::OpenAi,
        thinking: None,
        price: [2.0, 2.0, 0.50, 8.0],
    },
    CuratedModel {
        id: "gpt-5",
        provider: CueProvider::OpenAi,
        thinking: None,
        price: [1.25, 1.25, 0.125, 10.0],
    },
];

pub const GEMINI_MODELS: [CuratedModel; 3] = [
    CuratedModel {
        id: "gemini-2.5-flash",
        provider: CueProvider::Gemini,
        thinking: None,
        price: [0.30, 0.30, 0.075, 2.50],
    },
    CuratedModel {
        id: "gemini-2.5-flash-lite",
        provider: CueProvider::Gemini,
        thinking: None,
        price: [0.10, 0.10, 0.025, 0.40],
    },
    CuratedModel {
        id: "gemini-2.5-pro",
        provider: CueProvider::Gemini,
        thinking: None,
        price: [1.25, 1.25, 0.3125, 10.0],
    },
];

pub fn curated_models(provider: CueProvider) -> &'static [CuratedModel] {
    match provider {
        CueProvider::Anthropic => &ANTHROPIC_MODELS,
        CueProvider::OpenAi => &OPENAI_MODELS,
        CueProvider::Gemini => &GEMINI_MODELS,
    }
}

pub fn curated_model(provider: CueProvider, id: &str) -> Option<&'static CuratedModel> {
    curated_models(provider).iter().find(|model| model.id == id)
}

pub fn default_cue_model(provider: CueProvider) -> &'static CuratedModel {
    match provider {
        CueProvider::Anthropic => &ANTHROPIC_MODELS[2],
        CueProvider::OpenAi => &OPENAI_MODELS[0],
        CueProvider::Gemini => &GEMINI_MODELS[0],
    }
}

pub fn default_notes_model(provider: CueProvider) -> &'static CuratedModel {
    match provider {
        CueProvider::Anthropic => &ANTHROPIC_MODELS[0],
        CueProvider::OpenAi => &OPENAI_MODELS[3],
        CueProvider::Gemini => &GEMINI_MODELS[2],
    }
}

/// Validates an optional user-supplied model ID. Empty/whitespace becomes `None`
/// (use the provider's curated default). Non-empty IDs must be bounded ASCII
/// `[A-Za-z0-9._:/-]+`, at most 96 characters, and contain no `..`.
pub fn validate_model_id(raw: &str) -> Result<Option<String>, &'static str> {
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let trimmed = raw.trim_matches(' ');
    if trimmed.len() <= MAX_MODEL_ID_CHARS
        && !trimmed.contains("..")
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-'))
    {
        Ok(Some(trimmed.to_string()))
    } else {
        Err("Model ID must be up to 96 ASCII characters (letters, digits, ., _, :, /, -).")
    }
}

/// Effective model configuration passed to a provider adapter.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedModel {
    pub provider: CueProvider,
    pub id: String,
    pub price: Option<[f64; 4]>,
    pub thinking: Option<&'static str>,
    /// True when `id` is a custom model string not in TalkQTE's built-in price table.
    pub custom: bool,
}

impl ResolvedModel {
    pub fn from_curated(model: &'static CuratedModel) -> Self {
        Self {
            provider: model.provider,
            id: model.id.to_string(),
            price: Some(model.price),
            thinking: model.thinking,
            custom: false,
        }
    }

    pub fn resolve(
        provider: CueProvider,
        override_id: Option<&str>,
        fallback: &'static CuratedModel,
    ) -> Self {
        match override_id.map(str::trim).filter(|s| !s.is_empty()) {
            None => Self::from_curated(fallback),
            Some(id) => {
                if let Some(known) = curated_model(provider, id) {
                    Self::from_curated(known)
                } else {
                    Self {
                        provider,
                        id: id.to_string(),
                        price: None,
                        thinking: None,
                        custom: true,
                    }
                }
            }
        }
    }
}

/// Active provider and model choices for this launch, synchronized with `settings.rs`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preferences {
    pub cue_provider: CueProvider,
    pub cue_model_override: Option<String>,
    /// Legacy Anthropic curated notes model selection from `settings.json`.
    pub notes_model: &'static str,
    pub notes_model_override: Option<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            cue_provider: CueProvider::Anthropic,
            cue_model_override: None,
            notes_model: crate::meeting_notes::DEFAULT_MODEL,
            notes_model_override: None,
        }
    }
}

impl Preferences {
    pub fn resolved_cue_model(&self) -> ResolvedModel {
        let fallback = default_cue_model(self.cue_provider);
        ResolvedModel::resolve(
            self.cue_provider,
            self.cue_model_override.as_deref(),
            fallback,
        )
    }

    pub fn resolved_notes_model(&self) -> ResolvedModel {
        let fallback = if self.cue_provider == CueProvider::Anthropic {
            curated_model(CueProvider::Anthropic, self.notes_model)
                .unwrap_or_else(|| default_notes_model(CueProvider::Anthropic))
        } else {
            default_notes_model(self.cue_provider)
        };
        ResolvedModel::resolve(
            self.cue_provider,
            self.notes_model_override.as_deref(),
            fallback,
        )
    }

    pub fn snapshot(&self) -> ProviderPreferences {
        let cue = self.resolved_cue_model();
        let notes = self.resolved_notes_model();
        ProviderPreferences {
            cue_provider: self.cue_provider,
            cue_model_override: self.cue_model_override.clone(),
            notes_model: notes.id.clone(),
            notes_model_override: self.notes_model_override.clone(),
            effective_cue_model: cue.id,
            effective_cue_custom: cue.custom,
            effective_notes_model: notes.id,
            effective_notes_custom: notes.custom,
        }
    }
}

/// Serialized provider/model preferences sent to the notebook UI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreferences {
    pub cue_provider: CueProvider,
    pub cue_model_override: Option<String>,
    pub notes_model: String,
    pub notes_model_override: Option<String>,
    pub effective_cue_model: String,
    pub effective_cue_custom: bool,
    pub effective_notes_model: String,
    pub effective_notes_custom: bool,
}

fn store() -> &'static Mutex<Preferences> {
    static PREFS: OnceLock<Mutex<Preferences>> = OnceLock::new();
    PREFS.get_or_init(|| Mutex::new(Preferences::default()))
}

pub fn preferences() -> Preferences {
    store()
        .lock()
        .map(|prefs| prefs.clone())
        .unwrap_or_default()
}

pub fn cue_provider() -> CueProvider {
    preferences().cue_provider
}

pub fn resolved_cue_model() -> ResolvedModel {
    preferences().resolved_cue_model()
}

pub fn resolved_notes_model() -> ResolvedModel {
    preferences().resolved_notes_model()
}

pub fn apply_preferences(next: Preferences) {
    if let Ok(mut prefs) = store().lock() {
        *prefs = next;
    }
}

pub fn set_cue_provider(provider: CueProvider) -> ProviderPreferences {
    if let Ok(mut prefs) = store().lock() {
        if prefs.cue_provider != provider {
            prefs.cue_provider = provider;
            // Clear overrides when switching provider so a model ID for one
            // provider is never sent to another.
            prefs.cue_model_override = None;
            prefs.notes_model_override = None;
        }
        return prefs.snapshot();
    }
    Preferences::default().snapshot()
}

pub fn set_cue_model_override(override_id: Option<String>) -> ProviderPreferences {
    if let Ok(mut prefs) = store().lock() {
        prefs.cue_model_override = override_id;
        return prefs.snapshot();
    }
    Preferences::default().snapshot()
}

pub fn set_notes_model_override(override_id: Option<String>) -> ProviderPreferences {
    if let Ok(mut prefs) = store().lock() {
        prefs.notes_model_override = override_id;
        return prefs.snapshot();
    }
    Preferences::default().snapshot()
}

pub fn set_curated_notes_model(id: &str) -> Result<ProviderPreferences, String> {
    let mut prefs = store()
        .lock()
        .map_err(|_| "Settings are unavailable.".to_string())?;
    let model = curated_model(prefs.cue_provider, id)
        .ok_or_else(|| "That model is not offered.".to_string())?;
    if prefs.cue_provider == CueProvider::Anthropic {
        prefs.notes_model = model.id;
        prefs.notes_model_override = None;
    } else if model.id == default_notes_model(prefs.cue_provider).id {
        prefs.notes_model_override = None;
    } else {
        prefs.notes_model_override = Some(model.id.to_string());
    }
    Ok(prefs.snapshot())
}

const CUE_CONTRACT: &str = include_str!("../../scripts/fixtures/cue-decision.json");

/// The shared live cue system prompt from `scripts/fixtures/cue-decision.json`.
pub fn cue_system_prompt() -> &'static str {
    static PROMPT: OnceLock<String> = OnceLock::new();
    PROMPT.get_or_init(|| {
        let contract: Value = serde_json::from_str(CUE_CONTRACT).expect("the cue contract is JSON");
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
    pub fn of(request: &Request) -> Self {
        match request.existing_cue() {
            None => Self::Nothing,
            Some(cue) if cue.asked => Self::Asked,
            Some(_) => Self::Cue,
        }
    }
}

/// The three fixed structured-output schemas for cue evaluation.
pub fn cue_schema(on_screen: OnScreen) -> Value {
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

/// Normalizes a provider's JSON reply and checks the shared cue rules.
pub fn normalized(text: &str, request: &Request, on_screen: OnScreen) -> Option<String> {
    let mut value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object_mut()?;
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

/// Validates a normalized cue reply: exact three fields, known action,
/// one to four distinct cited lines from this request, bounded cue only with
/// `show`, and the 10-word glance rule.
pub fn reply_problem(value: &Value, request: &Request) -> bool {
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

/// Tracks consecutive unusable cue replies across requests in a session.
#[derive(Default)]
pub struct DecisionValidator {
    invalid_in_a_row: u32,
}

impl DecisionValidator {
    pub fn check(
        &mut self,
        text: &str,
        request: &Request,
        on_screen: OnScreen,
    ) -> Result<String, Failure> {
        match normalized(text, request, on_screen) {
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

/// No reply was received. No detail beyond whether the request could have
/// left the device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoReply {
    Unsent,
    Lost,
}

impl NoReply {
    pub fn from_ureq(error: &ureq::Error) -> Self {
        use std::io::ErrorKind;
        match error {
            ureq::Error::HostNotFound
            | ureq::Error::ConnectionFailed
            | ureq::Error::Tls(_)
            | ureq::Error::Rustls(_)
            | ureq::Error::Timeout(ureq::Timeout::Resolve | ureq::Timeout::Connect) => Self::Unsent,
            ureq::Error::Io(io)
                if matches!(
                    io.kind(),
                    ErrorKind::ConnectionRefused
                        | ErrorKind::NotConnected
                        | ErrorKind::AddrNotAvailable
                        | ErrorKind::NetworkUnreachable
                        | ErrorKind::HostUnreachable
                ) =>
            {
                Self::Unsent
            }
            _ => Self::Lost,
        }
    }
}

pub struct Reply {
    pub status: u16,
    pub body: Box<dyn Read + Send>,
}

/// What a streamed reply came to, before its text is checked.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Decision(String),
    Cancelled,
    Refusal,
    OutputLimit,
    ConfigurationMismatch,
    Protocol,
    Provider,
}

/// Reads the start of an HTTP refusal body without keeping or exposing text.
pub fn read_refusal_prefix(body: Box<dyn Read + Send>) -> String {
    let mut text = String::new();
    let _ = body.take(REFUSAL_BYTES).read_to_string(&mut text);
    text
}

/// Whether `echo` matches `expected` or a dated snapshot of `expected`
/// (e.g. `gpt-5-mini-2025-08-07` for `gpt-5-mini`, or `gemini-2.5-flash-001`).
pub fn model_echo_matches(expected: &str, echo: Option<&str>) -> bool {
    let Some(echo) = echo else {
        return false;
    };
    let expected = expected.strip_prefix("models/").unwrap_or(expected);
    let echo = echo.strip_prefix("models/").unwrap_or(echo);
    echo == expected
        || echo
            .strip_prefix(expected)
            .is_some_and(|rest| rest.starts_with('-'))
}

/// Worst-case micro-USD estimate for a known price table.
pub fn worst_case_micro_usd(price: [f64; 4], prompt_bytes: usize, max_output_tokens: u64) -> u64 {
    let tokens = prompt_bytes.div_ceil(2) as f64 + 1_500.0;
    let [input_price, write_price, _, output_price] = price;
    (tokens * input_price.max(write_price) + max_output_tokens as f64 * output_price).ceil() as u64
}

pub fn token_cost_micro_usd(
    price: [f64; 4],
    input: Option<u64>,
    cache_write: Option<u64>,
    cache_read: Option<u64>,
    output: Option<u64>,
) -> u64 {
    let [input_p, write_p, read_p, output_p] = price;
    let n = |v: Option<u64>| v.unwrap_or(0) as f64;
    (n(input) * input_p + n(cache_write) * write_p + n(cache_read) * read_p + n(output) * output_p)
        .ceil() as u64
}

/// Content-free session cue usage for any provider, honoring custom-model spend honesty.
#[derive(Debug)]
pub struct CueUsageTracker {
    pub provider: CueProvider,
    pub model: String,
    pub custom_model: bool,
    pub requests: AtomicU64,
    pub spent_micro_usd: AtomicU64,
}

impl CueUsageTracker {
    pub fn new(provider: CueProvider, model: impl Into<String>, custom_model: bool) -> Self {
        Self {
            provider,
            model: model.into(),
            custom_model,
            requests: AtomicU64::new(0),
            spent_micro_usd: AtomicU64::new(0),
        }
    }

    pub fn snapshot(&self) -> CueUsageSnapshot {
        CueUsageSnapshot {
            provider: self.provider,
            model: self.model.clone(),
            requests: self.requests.load(Ordering::Acquire),
            request_cap: REQUEST_CAP,
            spent_micro_usd: (!self.custom_model)
                .then(|| self.spent_micro_usd.load(Ordering::Acquire)),
            spend_cap_micro_usd: (!self.custom_model).then_some(SPEND_CAP_MICRO_USD),
            custom_model: self.custom_model,
        }
    }

    pub fn record_request(&self) {
        self.requests.fetch_add(1, Ordering::AcqRel);
    }

    pub fn charge(&self, micro_usd: u64) {
        if !self.custom_model {
            self.spent_micro_usd.fetch_add(micro_usd, Ordering::AcqRel);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueUsageSnapshot {
    pub provider: CueProvider,
    pub model: String,
    pub requests: u64,
    pub request_cap: u64,
    pub spent_micro_usd: Option<u64>,
    pub spend_cap_micro_usd: Option<u64>,
    pub custom_model: bool,
}

fn current_tracker() -> &'static Mutex<Option<Arc<CueUsageTracker>>> {
    static CURRENT: Mutex<Option<Arc<CueUsageTracker>>> = Mutex::new(None);
    &CURRENT
}

pub fn register_usage(tracker: Arc<CueUsageTracker>) {
    if let Ok(mut current) = current_tracker().lock() {
        *current = Some(tracker);
    }
}

pub fn cue_usage() -> Option<CueUsageSnapshot> {
    current_tracker()
        .lock()
        .ok()?
        .as_ref()
        .map(|tracker| tracker.snapshot())
}

/// The in-app settlement lifecycle shared by Anthropic, OpenAI, and Gemini cue runs.
pub struct InApp;

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

/// What the session processing review shows before anything is sent.
pub fn cue_data_policy(provider: CueProvider, model_id: &str, custom_model: bool) -> String {
    let cap_text = if custom_model {
        format!(
            "At most {REQUEST_CAP} requests per session. Estimated spend unavailable for custom model; there is no daily cap."
        )
    } else {
        format!(
            "At most {REQUEST_CAP} requests and an estimated ${:.2} per session (an estimate, not your bill; there is no daily cap).",
            SPEND_CAP_MICRO_USD as f64 / 1_000_000.0
        )
    };
    format!(
        "Sends to {}: up to six recent transcript lines and any lines the cue on screen cites, the cue on screen, up to four earlier cues with how each ended, and your session name if you set one. It sends after new lines, at most once every two seconds and one request at a time, until you turn this off, stop the session, or a failure stops it, so nearly every transcript line is sent, a few at a time. {} Pause cues stops these requests but not the audio to Deepgram; Off and Stop end both. Model {}. It never sends {} audio, the full transcript, your notes, imported notes or focus lines. {} handles what is sent under your API account's terms ({}); lines already sent cannot be recalled. If it fails, no other service is used.",
        provider.cue_account_scope(),
        cap_text,
        model_id,
        provider.name(),
        provider.name(),
        provider.terms_url()
    )
}

/// Registers any provider evaluator into an `Engine` under the shared caps and settlement rules.
pub fn register_cue_engine<E: Evaluator>(
    adapter: E,
    provider: CueProvider,
    model_id: &str,
    custom_model: bool,
    effort: Option<&str>,
    transcription: Option<String>,
) -> crate::engine::Engine {
    use crate::engine::{ProcessingLocation, ProcessorConfiguration, ProcessorDisclosure};
    let policy = cue_data_policy(provider, model_id, custom_model);
    let policy = match &transcription {
        Some(transcription) => format!("{policy} {transcription}"),
        None => policy,
    };
    let mut config = ProcessorConfiguration::new(
        provider.processor_id().into(),
        1,
        model_id.into(),
        ProcessingLocation::Hosted {
            service: provider.cue_destination().into(),
        },
        "own-key-cues-v1".into(),
        ProcessorDisclosure::new(provider.disclosure_name().into(), policy)
            .expect("the fixed disclosure is within its bound"),
    )
    .expect("the fixed configuration is valid")
    .without_notes();
    if let Some(effort) = effort {
        config = config.with_effort(effort.into());
    }
    if transcription.is_some() {
        config = config.with_audio_destination(
            "Deepgram (US), for transcription of the session's audio".into(),
        );
    }
    let worker =
        Worker::start(adapter, DEADLINE).expect("the deadline is within the worker's ceiling");
    let mut engine = crate::engine::Engine::live_with_evaluator(worker, config)
        .with_lab_lifecycle(Arc::new(InApp))
        .with_min_gap_ms(MIN_GAP_MS);
    engine.set_model_call_limit(REQUEST_CAP);
    engine
}

/// Evaluates whether `body_bytes` would exceed the session spend cap for a built-in model.
pub fn check_cue_spend_cap(
    usage: &CueUsageTracker,
    price: Option<[f64; 4]>,
    prompt_bytes: usize,
    max_output_tokens: u64,
    spend_cap: u64,
) -> Result<u64, Failure> {
    let Some(price) = price else {
        return Ok(0);
    };
    let worst = worst_case_micro_usd(price, prompt_bytes, max_output_tokens);
    if usage.spent_micro_usd.load(Ordering::Acquire) + worst > spend_cap {
        Err(Failure::SpendLimit)
    } else {
        Ok(worst)
    }
}

/// Helper used by HTTP transports for mapping `NoReply` and returning an error.
pub fn finish_no_reply(
    usage: &CueUsageTracker,
    worst: u64,
    no_reply: NoReply,
    cancel: &Cancellation,
) -> Failure {
    if no_reply == NoReply::Lost {
        usage.charge(worst);
    }
    if cancel.is_cancelled() {
        Failure::Cancelled
    } else {
        Failure::Unreachable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_model_id_validation_accepts_safe_ids_and_rejects_unsafe_ones() {
        assert_eq!(validate_model_id(""), Ok(None));
        assert_eq!(validate_model_id("   \n\t  "), Ok(None));
        assert_eq!(
            validate_model_id("  gpt-5.4-codex:latest  "),
            Ok(Some("gpt-5.4-codex:latest".into()))
        );
        assert_eq!(
            validate_model_id("ft:gpt-4.1-mini:org/team_1-v2"),
            Ok(Some("ft:gpt-4.1-mini:org/team_1-v2".into()))
        );
        assert_eq!(
            validate_model_id(&"a".repeat(MAX_MODEL_ID_CHARS)),
            Ok(Some("a".repeat(MAX_MODEL_ID_CHARS)))
        );
        for bad in [
            "a".repeat(MAX_MODEL_ID_CHARS + 1),
            "gpt 5".into(),
            "gpt-5\n".into(),
            "gpt-5?key=secret".into(),
            "../other".into(),
            "models/../secret".into(),
            "gemini-2.5#frag".into(),
            "café".into(),
        ] {
            assert!(validate_model_id(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn curated_vs_custom_models_report_spend_honestly() {
        let curated = ResolvedModel::resolve(
            CueProvider::OpenAi,
            Some("gpt-4.1-mini"),
            default_cue_model(CueProvider::OpenAi),
        );
        assert!(!curated.custom);
        assert!(curated.price.is_some());

        let custom = ResolvedModel::resolve(
            CueProvider::OpenAi,
            Some("gpt-5.4-codex"),
            default_cue_model(CueProvider::OpenAi),
        );
        assert!(custom.custom);
        assert!(custom.price.is_none());

        let tracker = CueUsageTracker::new(CueProvider::OpenAi, &custom.id, custom.custom);
        tracker.record_request();
        tracker.charge(999); // ignored for custom models
        let snap = tracker.snapshot();
        assert_eq!(snap.requests, 1);
        assert_eq!(snap.request_cap, REQUEST_CAP);
        assert_eq!(snap.spent_micro_usd, None);
        assert_eq!(snap.spend_cap_micro_usd, None);
        assert!(snap.custom_model);

        let policy = cue_data_policy(CueProvider::OpenAi, &custom.id, true);
        assert!(policy.contains("Estimated spend unavailable for custom model"));
        assert!(policy.contains("400 requests"));
        assert!(policy.contains("OpenAI"));
    }

    #[test]
    fn model_echo_matches_exact_and_dated_snapshots() {
        assert!(model_echo_matches("gpt-5-mini", Some("gpt-5-mini")));
        assert!(model_echo_matches(
            "gpt-5-mini",
            Some("gpt-5-mini-2025-08-07")
        ));
        assert!(model_echo_matches(
            "gemini-2.5-flash",
            Some("gemini-2.5-flash-001")
        ));
        assert!(model_echo_matches(
            "models/gemini-2.5-flash",
            Some("gemini-2.5-flash")
        ));
        assert!(!model_echo_matches("gpt-5-mini", Some("gpt-5")));
        assert!(!model_echo_matches("gpt-5-mini", Some("gpt-5-mini2")));
        assert!(!model_echo_matches("gpt-5-mini", None));
    }
}
