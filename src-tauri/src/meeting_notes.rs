//! Meeting notes written by a model, with the person's own Anthropic key,
//! after a live session has ended.
//!
//! This is an explicit request after a meeting, never automatic. The notebook
//! first shows a plan: what will be sent (the session's transcript and, only
//! if the person ticks it, their own notes), to whom, and an estimate of size
//! and cost. A failed validation alone can be reviewed for one final retry,
//! within a combined $1 worst-case estimate. No automatic resend or fallback.
//!
//! The system prompt, the reply schema, the bounds and the fictional cases
//! the tests use all live in `scripts/fixtures/meeting-notes.json`. The reply
//! is checked against the schema and against the lines that were sent: every
//! item cites lines that exist, and an owner or a due date is accepted only
//! when its words appear, as whole words, in the lines the item cites. That
//! proves the words were said, not that the person took the task. A reply
//! that fails any check is shown as failed and never repaired. Model text is
//! neutralised before it becomes editable, so no link, image or HTML from the
//! reply reaches the export.
//!
//! The network path is the cue path's: the fixed Messages API host over TLS
//! with certificate validation, no redirects, one overall timeout and a bound
//! on the response ([`crate::anthropic_api::Network`]). The key is read from
//! the Keychain for the request only and sent only in its header; no key and
//! no provider text reaches a log or the notebook.

use crate::anthropic_api::{self, Model, NoReply, Outcome, Transport};
use crate::engine::Segment;
use crate::llm_provider::{self, CueProvider, ResolvedModel};
use crate::provider_keys::{KeyError, Secret};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

const CONTRACT: &str = include_str!("../../scripts/fixtures/meeting-notes.json");

/// The model used for notes unless the person chooses another in Settings.
/// Notes are explicitly requested and are what people keep, so the
/// default is the most careful of the models the cue path already lists.
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
/// Shared by adaptive thinking and the reply; reaching it is a failure.
pub const MAX_TOKENS: u64 = 16_000;
const EFFORT: &str = "medium";
/// The whole request, from sending to the last byte of the reply.
pub const DEADLINE: Duration = Duration::from_secs(180);
/// The reply's JSON text; beyond this it is a failure.
const MAX_TEXT_BYTES: usize = 96 * 1024;
/// The request body, well above the transcript and notes bounds below.
const MAX_REQUEST_BYTES: usize = 512 * 1024;
/// The most one meeting's notes request may be estimated to cost, in
/// micro-dollars ($1.00), worst case, before it is sent.
pub const SPEND_CAP_MICRO_USD: u64 = 1_000_000;
/// Output tokens assumed for the likely estimate (not the worst case).
const LIKELY_OUTPUT_TOKENS: f64 = 3_000.0;

// Bounds, also written in the contract's `limits`; a test keeps them equal.
const MAX_TRANSCRIPT_LINES: usize = 10_000;
const MAX_TRANSCRIPT_BYTES: usize = 240_000;
const MAX_SUMMARY_ITEMS: usize = 5;
const MAX_SECTION_ITEMS: usize = 20;
const MAX_ITEM_CHARS: usize = 400;
const MAX_LINES_PER_ITEM: usize = 8;
const MAX_NAME_CHARS: usize = 80;

/// Where the request goes, as the confirmation names it.
pub const DESTINATION: &str =
    "the Anthropic API (US), with your own Anthropic API key, billed to your Anthropic account";

struct Contract {
    system: String,
    schema: Value,
}

fn contract() -> &'static Contract {
    static CONTRACT_VALUE: OnceLock<Contract> = OnceLock::new();
    CONTRACT_VALUE.get_or_init(|| {
        let value: Value =
            serde_json::from_str(CONTRACT).expect("the meeting-notes contract is JSON");
        Contract {
            system: value["system"]
                .as_str()
                .expect("the contract has a system prompt")
                .to_string(),
            schema: value["schema"].clone(),
        }
    })
}

pub fn system_prompt() -> &'static str {
    &contract().system
}

pub fn schema() -> &'static Value {
    &contract().schema
}

/// Anthropic's supported schema subset excludes maxItems. Keep its explicit
/// descriptions and prompt limits, and apply the same strict local validator.
/// OpenAI and Gemini receive the canonical array bounds as well.
fn provider_schema(provider: CueProvider) -> Value {
    fn compatible(value: &mut Value) {
        match value {
            Value::Object(object) => {
                object.remove("maxItems");
                for child in object.values_mut() {
                    compatible(child);
                }
            }
            Value::Array(values) => values.iter_mut().for_each(compatible),
            _ => {}
        }
    }
    let mut value = schema().clone();
    if provider == CueProvider::Anthropic {
        compatible(&mut value);
    }
    value
}

/// The notes model chosen in Settings; saved in the settings file.
fn chosen() -> &'static Mutex<&'static str> {
    static CHOSEN: Mutex<&'static str> = Mutex::new(DEFAULT_MODEL);
    &CHOSEN
}

/// The model the next notes request will use.
pub fn notes_model() -> Model {
    let id = chosen().lock().map(|id| *id).unwrap_or(DEFAULT_MODEL);
    anthropic_api::model(id).expect("the chosen notes model is known")
}

/// Chooses the notes model; only one the cue path lists is accepted.
pub fn set_notes_model(id: &str) -> Result<&'static str, String> {
    let model = anthropic_api::model(id).ok_or("That model is not offered.")?;
    if let Ok(mut chosen) = chosen().lock() {
        *chosen = model.id;
    }
    Ok(model.id)
}

/// Active resolved model (provider, model ID, optional pricing) from settings.
pub fn active_target() -> ResolvedModel {
    llm_provider::resolved_notes_model()
}

/// One line the reply may cite: a transcript line (`L…`) or a line of the
/// person's notes (`N…`, numbered as in the editor).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    #[serde(skip)]
    id: String,
    /// Where to find it: "transcript 03:41" or "your notes line 3".
    pub label: String,
    pub text: String,
    /// Resolved custom speaker name when the person renamed a remote speaker.
    #[serde(skip)]
    owner_speaker: Option<String>,
}

/// Why nothing was sent. Every message says so.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Empty,
    TooLong,
    NotEnded,
    AlreadySent,
    Writing,
    SpendCap,
    RetryUnavailable,
    RetryUnpriced,
    KeyNotSet,
    KeyRejected,
    KeyUnreadable,
    /// What would be sent differs from the plan the person confirmed.
    Changed,
    /// The person chose Stop waiting before anything was sent.
    Cancelled,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::TooLong => "tooLong",
            Self::NotEnded => "notEnded",
            Self::AlreadySent => "alreadySent",
            Self::Writing => "writing",
            Self::SpendCap => "spendCap",
            Self::RetryUnavailable => "retryUnavailable",
            Self::RetryUnpriced => "retryUnpriced",
            Self::KeyNotSet => "keyNotSet",
            Self::KeyRejected => "keyRejected",
            Self::KeyUnreadable => "keyUnreadable",
            Self::Changed => "changed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn message(self) -> &'static str {
        self.message_for(CueProvider::Anthropic)
    }

    pub fn message_for(self, provider: CueProvider) -> &'static str {
        match (self, provider) {
            (Self::Empty, _) => "This session has no transcript to write notes from. Nothing was sent.",
            (Self::TooLong, _) => "This meeting's transcript is longer than one request can take (about two hours of talk), so notes cannot be written for it. Nothing was sent.",
            (Self::NotEnded, _) => "Meeting notes can be written once a live session has ended. Nothing was sent.",
            (Self::AlreadySent, _) => "Notes were already requested for this meeting. Only a failed validation can be reviewed for one retry. Nothing was sent.",
            (Self::RetryUnavailable, _) => "A retry is available only after a failed validation, at most once per meeting. Nothing was sent.",
            (Self::RetryUnpriced, _) => "A retry cannot be bounded within the $1.00 combined estimate because a request has unknown model pricing. Nothing was sent.",
            (Self::Writing, _) => "Notes for this meeting are already being written. Nothing else was sent.",
            (Self::SpendCap, _) => "At its worst, this request plus any prior notes request could cost more than the $1.00 limit for this meeting's notes. A lower-cost model for meeting notes in Settings may fit. Nothing was sent.",
            (Self::KeyNotSet, CueProvider::Anthropic) => "Add your Anthropic API key in Settings to write meeting notes. Nothing was sent.",
            (Self::KeyNotSet, CueProvider::OpenAi) => "Add your OpenAI API key in Settings to write meeting notes. Nothing was sent.",
            (Self::KeyNotSet, CueProvider::Gemini) => "Add your Gemini API key in Settings to write meeting notes. Nothing was sent.",
            (Self::KeyRejected, CueProvider::Anthropic) => "Anthropic rejected your key. Replace it in Settings. Nothing was sent.",
            (Self::KeyRejected, CueProvider::OpenAi) => "OpenAI rejected your key. Replace it in Settings. Nothing was sent.",
            (Self::KeyRejected, CueProvider::Gemini) => "Gemini rejected your key. Replace it in Settings. Nothing was sent.",
            (Self::KeyUnreadable, CueProvider::Anthropic) => "Your Anthropic key could not be read from the Keychain. Nothing was sent.",
            (Self::KeyUnreadable, CueProvider::OpenAi) => "Your OpenAI key could not be read from the Keychain. Nothing was sent.",
            (Self::KeyUnreadable, CueProvider::Gemini) => "Your Gemini key could not be read from the Keychain. Nothing was sent.",
            (Self::Changed, _) => "What would be sent has changed since you looked (the transcript, your notes or the notes setting). Review it again. Nothing was sent.",
            (Self::Cancelled, _) => "Stopped before anything was sent. Nothing was sent.",
        }
    }
}

/// A reply that failed a check. It is shown as failed, never repaired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Invalid {
    /// Not JSON in the schema's exact shape.
    Unreadable,
    TooMany,
    ItemText,
    Uncited,
    UnknownLine,
    OwnerNotInLines,
    DueNotInLines,
}

impl Invalid {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unreadable => "unreadable",
            Self::TooMany => "tooMany",
            Self::ItemText => "itemText",
            Self::Uncited => "uncited",
            Self::UnknownLine => "unknownLine",
            Self::OwnerNotInLines => "ownerNotInLines",
            Self::DueNotInLines => "dueNotInLines",
        }
    }

    fn reason(self) -> &'static str {
        match self {
            Self::Unreadable => "the reply was not in the expected form",
            Self::TooMany => "a section had more items than allowed",
            Self::ItemText => "an item was empty or too long",
            Self::Uncited => "an item cited no line, or too many",
            Self::UnknownLine => "an item cited a line that was not sent",
            Self::OwnerNotInLines => {
                "an action item gave an owner whose name is not in the lines it cites"
            }
            Self::DueNotInLines => "an action item gave a date that is not in the lines it cites",
        }
    }
}

/// Said when no connection to Anthropic could be made: nothing was sent and
/// the request is still available.
pub const UNSENT_OFFLINE: &str =
    "Anthropic could not be reached, so nothing was sent. Check your internet connection, then choose Write meeting notes again.";

pub fn unsent_offline_for(provider: CueProvider) -> &'static str {
    match provider {
        CueProvider::Anthropic => UNSENT_OFFLINE,
        CueProvider::OpenAi => "OpenAI could not be reached, so nothing was sent. Check your internet connection, then choose Write meeting notes again.",
        CueProvider::Gemini => "Gemini could not be reached, so nothing was sent. Check your internet connection, then choose Write meeting notes again.",
    }
}

/// Why a sent request produced no notes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Cancelled,
    Unreachable,
    SignIn,
    UsageLimit,
    Refused,
    OutputLimit,
    Unavailable,
    Invalid(Invalid),
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Unreachable => "unreachable",
            Self::SignIn => "signIn",
            Self::UsageLimit => "usageLimit",
            Self::Refused => "refused",
            Self::OutputLimit => "outputLimit",
            Self::Unavailable => "unavailable",
            Self::Invalid(invalid) => invalid.code(),
        }
    }

    pub fn message(self) -> String {
        self.message_for(CueProvider::Anthropic)
    }

    pub fn message_for(self, provider: CueProvider) -> String {
        let name = provider.name();
        let after = "No notes were written. Nothing will be sent automatically.";
        match self {
            Self::Cancelled => {
                format!("Cancelled. What was already sent may still be billed. {after}")
            }
            Self::Unreachable => {
                format!("{name} could not be reached or did not finish in time. {after}")
            }
            Self::SignIn => format!("{name} rejected your key. Replace it in Settings. {after}"),
            Self::UsageLimit => {
                format!("Your {name} account is at a usage or rate limit. {after}")
            }
            Self::Refused => format!("The model declined this request. {after}"),
            Self::OutputLimit => format!("The reply was longer than allowed. {after}"),
            Self::Unavailable => {
                format!("The reply did not come back in the expected way. {after}")
            }
            Self::Invalid(invalid) => format!(
                "The notes that came back failed a check ({}), so none are shown. {after}",
                invalid.reason()
            ),
        }
    }
}

/// What will be sent, ready for the confirmation and the request.
#[derive(Clone, Debug)]
pub struct Prepared {
    /// Set by Stop waiting for this request only.
    cancel: Arc<AtomicBool>,
    model: Model,
    target: ResolvedModel,
    lines: Vec<Line>,
    user: String,
    transcript_lines: usize,
    note_lines: Option<usize>,
    duration_ms: u64,
}

/// Multi-provider confirmation facts. Cost estimates are `None` for custom
/// model IDs outside the built-in price table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub transcript_lines: usize,
    pub minutes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_lines: Option<usize>,
    pub kilobytes: usize,
    pub provider: CueProvider,
    pub provider_name: &'static str,
    pub model: String,
    pub custom_model: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub likely_micro_usd: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worst_micro_usd: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spend_cap_micro_usd: Option<u64>,
    pub destination: &'static str,
    pub fingerprint: String,
}

/// The confirmation's facts. Content-free apart from counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub transcript_lines: usize,
    /// Minutes from the session's start to its last line, rounded up.
    pub minutes: u64,
    /// Lines of the person's notes that would be sent; absent when not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_lines: Option<usize>,
    /// What would be sent, in kilobytes, rounded up.
    pub kilobytes: usize,
    pub model: &'static str,
    pub likely_micro_usd: u64,
    pub worst_micro_usd: u64,
    pub spend_cap_micro_usd: u64,
    pub destination: &'static str,
    /// Identifies exactly what would be sent: a confirmation names it, and a
    /// request whose input differs is refused.
    pub fingerprint: String,
}

/// Session time as the export writes it.
pub fn clock(ms: u64) -> String {
    let s = ms / 1_000;
    if s >= 3_600 {
        format!("{}:{:02}:{:02}", s / 3_600, s / 60 % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

fn flat(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Builds the request's input from the session's transcript and, only when
/// the person chose to include them, their notes. Renamed remote speaker
/// labels are included when present; the session name, focus lines, imported
/// notes and cues are never included.
pub fn prepare(
    model: Model,
    transcript: &[Segment],
    notes: Option<&str>,
) -> Result<Prepared, Refusal> {
    let target = ResolvedModel {
        provider: CueProvider::Anthropic,
        id: model.id.to_string(),
        price: Some(model.price),
        thinking: None,
        custom: false,
    };
    prepare_inner(model, target, transcript, notes, &BTreeMap::new())
}

pub fn prepare_for(
    target: ResolvedModel,
    transcript: &[Segment],
    notes: Option<&str>,
) -> Result<Prepared, Refusal> {
    prepare_for_with_speakers(target, transcript, notes, &BTreeMap::new())
}

pub fn prepare_for_with_speakers(
    target: ResolvedModel,
    transcript: &[Segment],
    notes: Option<&str>,
    speaker_names: &BTreeMap<u32, String>,
) -> Result<Prepared, Refusal> {
    let fallback = anthropic_api::model(DEFAULT_MODEL).expect("default model");
    prepare_inner(fallback, target, transcript, notes, speaker_names)
}

fn prepare_inner(
    model: Model,
    target: ResolvedModel,
    transcript: &[Segment],
    notes: Option<&str>,
    speaker_names: &BTreeMap<u32, String>,
) -> Result<Prepared, Refusal> {
    let spoken: Vec<&Segment> = transcript
        .iter()
        .filter(|line| !line.text.trim().is_empty())
        .collect();
    if spoken.is_empty() {
        return Err(Refusal::Empty);
    }
    let bytes: usize = spoken.iter().map(|line| line.text.len()).sum();
    if spoken.len() > MAX_TRANSCRIPT_LINES || bytes > MAX_TRANSCRIPT_BYTES {
        return Err(Refusal::TooLong);
    }
    let has_speakers =
        !speaker_names.is_empty() || spoken.iter().any(|line| line.speaker_id.is_some());
    let mut lines = Vec::new();
    let mut user = String::from(if has_speakers {
        "Transcript lines, with times from the start of the session and speaker labels where known.\n"
    } else {
        "Transcript lines, with times from the start of the session. Speakers are not identified.\n"
    });
    for (index, line) in spoken.iter().enumerate() {
        let id = format!("L{}", index + 1);
        let text = flat(&line.text);
        let at = clock(line.at_ms);
        let (speaker_prefix, owner_speaker) = if has_speakers {
            if let Some(sid) = line.speaker_id {
                if let Some(custom) = speaker_names
                    .get(&sid)
                    .map(|name| flat(name))
                    .filter(|name| !name.is_empty())
                {
                    (Some(custom.clone()), Some(custom))
                } else {
                    (Some(crate::engine::default_speaker_label(sid)), None)
                }
            } else if line.speaker == crate::engine::YOU || line.speaker == crate::engine::THEM {
                (Some(line.speaker.clone()), None)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };
        if let Some(label) = speaker_prefix {
            user.push_str(&format!("{id} [{at}] {label}: {text}\n"));
        } else {
            user.push_str(&format!("{id} [{at}] {text}\n"));
        }
        lines.push(Line {
            id,
            label: format!("transcript {at}"),
            text,
            owner_speaker,
        });
    }
    let transcript_lines = lines.len();
    let note_lines = match notes {
        Some(notes) => {
            let written: Vec<(usize, String)> = notes
                .lines()
                .enumerate()
                .map(|(index, text)| (index + 1, flat(text)))
                .filter(|(_, text)| !text.is_empty())
                .collect();
            if written.is_empty() {
                user.push_str("\nThe person's notes are empty.\n");
            } else {
                user.push_str("\nThe person's own notes, by line number:\n");
            }
            for (number, text) in &written {
                let id = format!("N{number}");
                user.push_str(&format!("{id} {text}\n"));
                lines.push(Line {
                    id,
                    label: format!("your notes line {number}"),
                    text: text.clone(),
                    owner_speaker: None,
                });
            }
            Some(written.len())
        }
        None => {
            user.push_str("\nThe person's notes are not included.\n");
            None
        }
    };
    let duration_ms = spoken.last().map(|line| line.at_ms).unwrap_or(0);
    Ok(Prepared {
        cancel: Arc::default(),
        model,
        target,
        lines,
        user,
        transcript_lines,
        note_lines,
        duration_ms,
    })
}

impl Prepared {
    pub fn target(&self) -> &ResolvedModel {
        &self.target
    }

    pub fn body(&self) -> Value {
        match self.target.provider {
            CueProvider::Anthropic => json!({
                "model": self.target.id,
                "max_tokens": MAX_TOKENS,
                "system": system_prompt(),
                "messages": [{"role": "user", "content": self.user}],
                "output_config": {
                    "effort": EFFORT,
                    "format": {"type": "json_schema", "schema": provider_schema(self.target.provider)},
                },
                "stream": true,
            }),
            CueProvider::OpenAi => crate::openai_api::notes_body(
                &self.target.id,
                system_prompt(),
                &self.user,
                &provider_schema(self.target.provider),
                MAX_TOKENS,
            ),
            CueProvider::Gemini => crate::gemini_api::notes_body(
                system_prompt(),
                &self.user,
                &provider_schema(self.target.provider),
                MAX_TOKENS,
            ),
        }
    }

    fn sent_bytes(&self) -> usize {
        system_prompt().len() + self.user.len() + schema().to_string().len()
    }

    /// An estimated worst case: one token per byte of everything sent (text
    /// rarely uses more) plus 1,500 tokens for the structured-output prompt,
    /// at the input price (nothing is cached), plus the whole output bound.
    pub fn worst_micro_usd(&self) -> u64 {
        self.worst_micro_usd_opt().unwrap_or(0)
    }

    pub fn worst_micro_usd_opt(&self) -> Option<u64> {
        let [input, _, _, output] = self.target.price?;
        let tokens = self.sent_bytes() as f64 + 1_500.0;
        Some((tokens * input + MAX_TOKENS as f64 * output).ceil() as u64)
    }

    /// A digest of the provider, model, prompt, schema and input.
    pub fn fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        let payload = format!("{}:{}", self.target.provider.id(), self.body());
        let digest = Sha256::digest(payload.as_bytes());
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// This request's own Stop waiting flag.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// A likelier figure: about four bytes per token and a few thousand
    /// tokens of thinking and reply. Still an estimate, not a bill.
    pub fn likely_micro_usd(&self) -> u64 {
        self.likely_micro_usd_opt().unwrap_or(0)
    }

    pub fn likely_micro_usd_opt(&self) -> Option<u64> {
        let [input, _, _, output] = self.target.price?;
        let tokens = self.sent_bytes().div_ceil(4) as f64 + 1_500.0;
        Some((tokens * input + LIKELY_OUTPUT_TOKENS * output).ceil() as u64)
    }

    pub fn plan(&self) -> Plan {
        Plan {
            transcript_lines: self.transcript_lines,
            minutes: self.duration_ms.div_ceil(60_000).max(1),
            note_lines: self.note_lines,
            kilobytes: self.user.len().div_ceil(1_000),
            model: self.model.id,
            likely_micro_usd: self.likely_micro_usd(),
            worst_micro_usd: self.worst_micro_usd(),
            spend_cap_micro_usd: SPEND_CAP_MICRO_USD,
            destination: DESTINATION,
            fingerprint: self.fingerprint(),
        }
    }

    pub fn plan_view(&self) -> PlanView {
        PlanView {
            transcript_lines: self.transcript_lines,
            minutes: self.duration_ms.div_ceil(60_000).max(1),
            note_lines: self.note_lines,
            kilobytes: self.user.len().div_ceil(1_000),
            provider: self.target.provider,
            provider_name: self.target.provider.name(),
            model: self.target.id.clone(),
            custom_model: self.target.custom,
            likely_micro_usd: self.likely_micro_usd_opt(),
            worst_micro_usd: self.worst_micro_usd_opt(),
            spend_cap_micro_usd: (!self.target.custom).then_some(SPEND_CAP_MICRO_USD),
            destination: self.target.provider.notes_destination(),
            fingerprint: self.fingerprint(),
        }
    }

    /// Refuses a request whose worst case passes the per-meeting cap (when pricing is known).
    pub fn check_cap(&self) -> Result<(), Refusal> {
        if let Some(worst) = self.worst_micro_usd_opt() {
            if worst > SPEND_CAP_MICRO_USD {
                return Err(Refusal::SpendCap);
            }
        }
        Ok(())
    }
}

/// One checked item, with the lines it cites, for the person to check.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    pub section: &'static str,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    pub sources: Vec<Line>,
}

/// Notes that passed every check: editable Markdown and the items behind it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub markdown: String,
    pub items: Vec<CheckItem>,
    /// This request's cost as the API reported it, in micro-dollars; absent
    /// when it is not known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spent_micro_usd: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplyShape {
    summary: Vec<ItemShape>,
    decisions: Vec<ItemShape>,
    actions: Vec<ActionShape>,
    open_questions: Vec<ItemShape>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemShape {
    text: String,
    lines: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionShape {
    text: String,
    owner: Option<String>,
    due: Option<String>,
    lines: Vec<String>,
}

/// Words for matching: NFC, lower case, apostrophes of every kind dropped
/// inside words, and every other non-alphanumeric character a separator.
fn words(text: &str) -> Vec<String> {
    let text = icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(text);
    let mut out = Vec::new();
    let mut word = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            word.push(c);
        } else if !matches!(
            c,
            '\'' | '\u{2018}' | '\u{2019}' | '\u{02BC}' | '`' | '\u{00B4}'
        ) && !word.is_empty()
        {
            out.push(std::mem::take(&mut word));
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// Words that never identify an owner on their own: pronouns and stand-ins
/// in the languages the fixture covers.
const NOT_A_NAME: &[&str] = &[
    "i",
    "me",
    "my",
    "we",
    "us",
    "our",
    "you",
    "your",
    "he",
    "him",
    "she",
    "her",
    "they",
    "them",
    "it",
    "someone",
    "somebody",
    "anyone",
    "anybody",
    "everyone",
    "everybody",
    "nobody",
    "all",
    "both",
    "team",
    "the",
    "a",
    "an",
    "one",
    "yo",
    "tú",
    "tu",
    "él",
    "el",
    "ella",
    "nosotros",
    "nosotras",
    "ellos",
    "ellas",
    "usted",
    "ustedes",
    "alguien",
    "todos",
    "todas",
    "equipo",
];

fn contains_words(haystack: &str, value: &[String]) -> bool {
    let words = words(haystack);
    words.windows(value.len()).any(|window| window == value)
}

/// The value's words as a run of whole words in one of the cited lines.
fn stated_in(value: &[String], lines: &[Line]) -> bool {
    lines.iter().any(|line| contains_words(&line.text, value))
}

/// Accepts an owner only when it is a name-like run of whole words that one
/// of the cited lines contains (or its renamed speaker label when set): at
/// least two letters, not only pronouns or stand-ins, not a bare number.
fn owner_stated(owner: &str, lines: &[Line]) -> bool {
    let value = words(owner);
    let letters = value
        .iter()
        .flat_map(|word| word.chars())
        .filter(|c| c.is_alphabetic())
        .count();
    letters >= 2
        && value.iter().any(|word| {
            word.chars().any(char::is_alphabetic) && !NOT_A_NAME.contains(&word.as_str())
        })
        && lines.iter().any(|line| {
            contains_words(&line.text, &value)
                || line
                    .owner_speaker
                    .as_deref()
                    .is_some_and(|speaker| contains_words(speaker, &value))
        })
}

/// Accepts a due date only when it is at least two characters of whole
/// words that one of the cited lines contains.
fn due_stated(due: &str, lines: &[Line]) -> bool {
    let value = words(due);
    value.iter().map(|word| word.chars().count()).sum::<usize>() >= 2 && stated_in(&value, lines)
}

/// Model text as inert Markdown: links of any kind removed, and the
/// characters that open HTML, autolinks, links, images or code escaped. Only model
/// output passes through this; the person's own edits are theirs.
pub fn neutral(text: &str) -> String {
    let text = flat(text)
        .split(' ')
        .map(|token| {
            let lower = token.to_lowercase();
            if lower.contains("://")
                || lower.contains("www.")
                || lower.contains("data:")
                || lower.contains("mailto:")
                || lower.contains("javascript:")
            {
                "(link removed)"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '<' | '>' | '[' | ']' | '`') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Checks a reply against the schema and the lines that were sent, and
/// renders it. Any failure fails the whole reply.
pub fn validate(text: &str, prepared: &Prepared) -> Result<(String, Vec<CheckItem>), Invalid> {
    let value: Value = serde_json::from_str(text).map_err(|_| Invalid::Unreadable)?;
    // Every action names its owner and due date, even as null.
    let complete = value["actions"].as_array().is_none_or(|actions| {
        actions.iter().all(|action| {
            action
                .as_object()
                .is_some_and(|action| action.contains_key("owner") && action.contains_key("due"))
        })
    });
    if !complete {
        return Err(Invalid::Unreadable);
    }
    let reply: ReplyShape = serde_json::from_value(value).map_err(|_| Invalid::Unreadable)?;
    if reply.summary.len() > MAX_SUMMARY_ITEMS
        || [
            reply.decisions.len(),
            reply.actions.len(),
            reply.open_questions.len(),
        ]
        .iter()
        .any(|count| *count > MAX_SECTION_ITEMS)
    {
        return Err(Invalid::TooMany);
    }
    let cited = |ids: &[String]| -> Result<Vec<Line>, Invalid> {
        if ids.is_empty() || ids.len() > MAX_LINES_PER_ITEM {
            return Err(Invalid::Uncited);
        }
        let mut found: Vec<Line> = Vec::new();
        for id in ids {
            let line = prepared
                .lines
                .iter()
                .find(|line| &line.id == id)
                .ok_or(Invalid::UnknownLine)?;
            if !found.iter().any(|seen| seen.id == line.id) {
                found.push(line.clone());
            }
        }
        // In the order they were sent: transcript first, then notes.
        found.sort_by_key(|line| prepared.lines.iter().position(|l| l.id == line.id));
        Ok(found)
    };
    let text_ok = |text: &str| {
        let text = text.trim();
        !text.is_empty() && text.chars().count() <= MAX_ITEM_CHARS
    };
    // An owner or date is accepted only when its words are in a line the
    // item cites. That shows the words were said, not that they are right.
    let stated = |value: &Option<String>,
                  lines: &[Line],
                  check: fn(&str, &[Line]) -> bool,
                  invalid: Invalid| match value {
        None => Ok(None),
        Some(value) if value.chars().count() <= MAX_NAME_CHARS && check(value, lines) => {
            Ok(Some(flat(value)))
        }
        Some(_) => Err(invalid),
    };
    let plain = |section: &'static str, list: Vec<ItemShape>| -> Result<Vec<CheckItem>, Invalid> {
        list.into_iter()
            .map(|item| {
                if !text_ok(&item.text) {
                    return Err(Invalid::ItemText);
                }
                Ok(CheckItem {
                    section,
                    text: flat(&item.text),
                    owner: None,
                    due: None,
                    sources: cited(&item.lines)?,
                })
            })
            .collect()
    };
    let mut items = plain("summary", reply.summary)?;
    items.extend(plain("decisions", reply.decisions)?);
    for action in reply.actions {
        if !text_ok(&action.text) {
            return Err(Invalid::ItemText);
        }
        let sources = cited(&action.lines)?;
        let owner = stated(
            &action.owner,
            &sources,
            owner_stated,
            Invalid::OwnerNotInLines,
        )?;
        let due = stated(&action.due, &sources, due_stated, Invalid::DueNotInLines)?;
        items.push(CheckItem {
            section: "actions",
            text: flat(&action.text),
            owner,
            due,
            sources,
        });
    }
    items.extend(plain("openQuestions", reply.open_questions)?);
    Ok((render(&items), items))
}

fn citation(sources: &[Line]) -> String {
    let times: Vec<&str> = sources
        .iter()
        .filter_map(|line| line.label.strip_prefix("transcript "))
        .collect();
    let notes: Vec<&str> = sources
        .iter()
        .filter_map(|line| line.label.strip_prefix("your notes line "))
        .collect();
    let mut parts = Vec::new();
    if !notes.is_empty() {
        parts.push(format!("your notes line {}", notes.join(", ")));
    }
    if !times.is_empty() {
        parts.push(format!("transcript {}", times.join(", ")));
    }
    format!("({})", parts.join("; "))
}

/// The Markdown the person edits and may keep. Each item ends with the
/// transcript times (as the kept transcript lists them) or note lines it
/// came from; an action says "not stated" for an owner or date its lines do
/// not give.
pub fn render(items: &[CheckItem]) -> String {
    let mut out = String::from(
        "## Meeting notes\n\nWritten by a model from this meeting's transcript. Each item ends with the lines it came from; check them before relying on it.\n",
    );
    for (section, heading) in [
        ("summary", "Summary"),
        ("decisions", "Decisions"),
        ("actions", "Action items"),
        ("openQuestions", "Open questions"),
    ] {
        out.push_str(&format!("\n### {heading}\n\n"));
        let mut any = false;
        for item in items.iter().filter(|item| item.section == section) {
            any = true;
            out.push_str(&format!("- {}", neutral(&item.text)));
            if section == "actions" {
                out.push_str(&format!(
                    " Owner: {}. Due: {}.",
                    item.owner
                        .as_deref()
                        .map(neutral)
                        .as_deref()
                        .unwrap_or("not stated"),
                    item.due
                        .as_deref()
                        .map(neutral)
                        .as_deref()
                        .unwrap_or("not stated")
                ));
            }
            out.push_str(&format!(" {}\n", citation(&item.sources)));
        }
        if !any {
            out.push_str("None stated.\n");
        }
    }
    out
}

/// What one write came to: the notes or why there are none, the cost when
/// known, and whether anything was sent at all.
#[derive(Debug)]
pub struct Written {
    pub result: Result<Draft, Failure>,
    pub spent_micro_usd: Option<u64>,
    pub sent: bool,
}

/// Sends the one request and checks the reply, unless Stop waiting was
/// chosen first, in which case nothing is sent.
pub fn write<T: Transport>(
    transport: &mut T,
    key: Secret,
    prepared: &Prepared,
    on_rejected: impl FnOnce(),
) -> Written {
    let cancel = prepared.cancel_flag();
    write_with(transport, key, prepared, on_rejected, &|| {
        cancel.load(Ordering::Acquire)
    })
}

/// Sends the one request to the provider named in `prepared.target()` over
/// the real HTTPS transport.
pub fn write_network(key: Secret, prepared: &Prepared, on_rejected: impl FnOnce()) -> Written {
    let cancel = prepared.cancel_flag();
    let cancelled = || cancel.load(Ordering::Acquire);
    match prepared.target.provider {
        CueProvider::Anthropic => {
            let mut net = anthropic_api::Network;
            write_provider(
                prepared,
                key,
                on_rejected,
                &cancelled,
                |k, body| net.post(k, body, DEADLINE),
                |reply_body| {
                    let (outcome, usage, complete) = anthropic_api::read_bounded_stream_for_id(
                        reply_body,
                        &prepared.target.id,
                        true,
                        MAX_TEXT_BYTES,
                        &cancelled,
                    );
                    let cost = complete.then(|| {
                        prepared.target.price.map(|p| {
                            llm_provider::token_cost_micro_usd(
                                p,
                                usage.input,
                                usage.cache_write,
                                usage.cache_read,
                                usage.output,
                            )
                        })
                    });
                    (outcome, cost.flatten())
                },
            )
        }
        CueProvider::OpenAi => {
            let mut net = crate::openai_api::Network;
            write_provider(
                prepared,
                key,
                on_rejected,
                &cancelled,
                |k, body| {
                    crate::openai_api::Transport::post(&mut net, k, body, DEADLINE)
                        .map(|r| anthropic_api::Reply {
                            status: r.status,
                            body: r.body,
                        })
                        .map_err(|e| match e {
                            llm_provider::NoReply::Unsent => NoReply::Unsent,
                            llm_provider::NoReply::Lost => NoReply::Lost,
                        })
                },
                |reply_body| {
                    let (outcome, usage, complete) = crate::openai_api::read_bounded_stream(
                        reply_body,
                        &prepared.target.id,
                        MAX_TEXT_BYTES,
                        &cancelled,
                    );
                    let cost = complete
                        .then(|| prepared.target.price.map(|p| usage.cost_micro_usd(p)))
                        .flatten();
                    (map_outcome(outcome), cost)
                },
            )
        }
        CueProvider::Gemini => {
            let mut net = crate::gemini_api::Network;
            write_provider(
                prepared,
                key,
                on_rejected,
                &cancelled,
                |k, body| {
                    crate::gemini_api::Transport::post(
                        &mut net,
                        &prepared.target.id,
                        k,
                        body,
                        DEADLINE,
                    )
                    .map(|r| anthropic_api::Reply {
                        status: r.status,
                        body: r.body,
                    })
                    .map_err(|e| match e {
                        llm_provider::NoReply::Unsent => NoReply::Unsent,
                        llm_provider::NoReply::Lost => NoReply::Lost,
                    })
                },
                |reply_body| {
                    let (outcome, usage, complete) = crate::gemini_api::read_bounded_stream(
                        reply_body,
                        &prepared.target.id,
                        MAX_TEXT_BYTES,
                        &cancelled,
                    );
                    let cost = complete
                        .then(|| prepared.target.price.map(|p| usage.cost_micro_usd(p)))
                        .flatten();
                    (map_outcome(outcome), cost)
                },
            )
        }
    }
}

fn map_outcome(outcome: llm_provider::Outcome) -> Outcome {
    match outcome {
        llm_provider::Outcome::Decision(t) => Outcome::Decision(t),
        llm_provider::Outcome::Cancelled => Outcome::Cancelled,
        llm_provider::Outcome::Refusal => Outcome::Refusal,
        llm_provider::Outcome::OutputLimit => Outcome::OutputLimit,
        llm_provider::Outcome::ConfigurationMismatch => Outcome::ConfigurationMismatch,
        llm_provider::Outcome::Protocol => Outcome::Protocol,
        llm_provider::Outcome::Provider => Outcome::Provider,
    }
}

fn write_with<T: Transport>(
    transport: &mut T,
    key: Secret,
    prepared: &Prepared,
    on_rejected: impl FnOnce(),
    cancelled: &dyn Fn() -> bool,
) -> Written {
    write_provider(
        prepared,
        key,
        on_rejected,
        cancelled,
        |k, body| transport.post(k, body, DEADLINE),
        |reply_body| {
            let (outcome, usage, complete) = anthropic_api::read_bounded_stream(
                reply_body,
                prepared.model,
                MAX_TEXT_BYTES,
                cancelled,
            );
            let spent = complete.then(|| usage.cost_micro_usd(prepared.model));
            (outcome, spent)
        },
    )
}

pub(crate) fn write_provider(
    prepared: &Prepared,
    key: Secret,
    on_rejected: impl FnOnce(),
    cancelled: &dyn Fn() -> bool,
    post: impl FnOnce(&Secret, &[u8]) -> Result<anthropic_api::Reply, NoReply>,
    parse_stream: impl FnOnce(Box<dyn std::io::Read + Send>) -> (Outcome, Option<u64>),
) -> Written {
    let unsent = |failure| Written {
        result: Err(failure),
        spent_micro_usd: Some(0),
        sent: false,
    };
    let body = prepared.body().to_string();
    if body.len() > MAX_REQUEST_BYTES {
        // Unreachable within the transcript and notes bounds.
        return unsent(Failure::Unavailable);
    }
    // Stop waiting may have been chosen while the key was being read.
    if cancelled() {
        return unsent(Failure::Cancelled);
    }
    let reply = post(&key, body.as_bytes());
    drop(key);
    // Offline, or no connection could be made: nothing left the Mac, so the
    // meeting's one request is still there to send.
    if reply.as_ref().err() == Some(&NoReply::Unsent) {
        return unsent(Failure::Unreachable);
    }
    // From here something reached, or may have reached, the provider.
    let failed = |failure, spent| Written {
        result: Err(failure),
        spent_micro_usd: spent,
        sent: true,
    };
    let reply = match reply {
        Ok(reply) => reply,
        Err(_) => {
            let failure = if cancelled() {
                Failure::Cancelled
            } else {
                Failure::Unreachable
            };
            return failed(failure, None);
        }
    };
    // A held refusal is no longer an authentication observation once this
    // explicitly reviewed attempt has been withdrawn. Credential revisions
    // provide an additional, independent guard against replacement.
    if cancelled() {
        return failed(Failure::Cancelled, None);
    }
    match reply.status {
        200 => {}
        401 | 403 => {
            on_rejected();
            return failed(Failure::SignIn, Some(0));
        }
        400 if prepared.target.provider == CueProvider::Gemini
            && crate::gemini_api::is_invalid_api_key_400(reply.body) =>
        {
            on_rejected();
            return failed(Failure::SignIn, Some(0));
        }
        // Whether a refused or failed request is billed is not reported.
        429 => return failed(Failure::UsageLimit, None),
        _ => return failed(Failure::Unreachable, None),
    }
    let (outcome, spent) = parse_stream(reply.body);
    let spent = if prepared.target.custom { None } else { spent };
    let result = match outcome {
        Outcome::Decision(text) => match validate(&text, prepared) {
            Ok((markdown, items)) => Ok(Draft {
                markdown,
                items,
                spent_micro_usd: spent,
            }),
            Err(invalid) => Err(Failure::Invalid(invalid)),
        },
        Outcome::Cancelled => Err(Failure::Cancelled),
        Outcome::Refusal => Err(Failure::Refused),
        Outcome::OutputLimit => Err(Failure::OutputLimit),
        Outcome::ConfigurationMismatch | Outcome::Protocol => Err(Failure::Unavailable),
        Outcome::Provider => Err(Failure::Unreachable),
    };
    Written {
        result,
        spent_micro_usd: spent,
        sent: true,
    }
}

/// Reads the key for the request, or says why nothing can be sent.
pub fn key(read: Result<Secret, KeyError>, rejected: bool) -> Result<Secret, Refusal> {
    if rejected {
        return Err(Refusal::KeyRejected);
    }
    match read {
        Ok(key) => Ok(key),
        Err(KeyError::NotSet(_)) => Err(Refusal::KeyNotSet),
        Err(_) => Err(Refusal::KeyUnreadable),
    }
}

/// Where this meeting's notes stand, as the notebook sees it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Nothing requested for this session.
    #[default]
    None,
    Writing,
    /// Checked notes are waiting for the person to keep or discard them.
    Draft,
    Failed,
    Kept,
    Discarded,
}

/// The engine's record of this session's notes. Memory only; a new session
/// starts with an empty record.
#[derive(Clone, Debug, Default)]
pub struct Record {
    draft: Option<Draft>,
    failure: Option<String>,
    kept: Option<String>,
    /// Reported cost of this session's notes request, once sent; `None`
    /// when it is not known or when using a custom model ID.
    spent_micro_usd: Option<u64>,
    provider_name: Option<&'static str>,
    custom_model: bool,
    /// Stop waiting for the request in flight, if one is.
    in_flight: Option<Arc<AtomicBool>>,
    sent_attempts: u8,
    validation_failed: bool,
    // Reserve the full estimate even when actual usage is missing or smaller.
    reserved_micro_usd: u64,
    unpriced_sent: bool,
    pending: Option<(Option<u64>, Option<&'static str>, bool)>,
    generation: u64,
}

/// The most text a kept set of notes may hold after editing.
pub const MAX_KEPT_CHARS: usize = 40_000;

impl Record {
    pub fn draft(&self) -> Option<&Draft> {
        self.draft.as_ref()
    }

    pub fn failure(&self) -> Option<&str> {
        self.failure.as_deref()
    }

    pub fn kept(&self) -> Option<&str> {
        self.kept.as_deref()
    }

    pub fn spent_micro_usd(&self) -> Option<u64> {
        self.spent_micro_usd
    }

    pub fn provider_name(&self) -> &'static str {
        self.provider_name.unwrap_or("Anthropic")
    }

    pub fn custom_model(&self) -> bool {
        self.custom_model
    }

    /// Records the request now in flight, so Stop waiting reaches it.
    pub fn begin(&mut self, prepared: &Prepared) {
        self.generation = self.generation.saturating_add(1);
        self.pending = Some((
            prepared.worst_micro_usd_opt(),
            self.provider_name,
            self.custom_model,
        ));
        self.provider_name = Some(prepared.target.provider.name());
        self.custom_model = prepared.target.custom;
        self.in_flight = Some(prepared.cancel_flag());
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn retry_available(&self) -> bool {
        self.validation_failed
            && self.sent_attempts == 1
            && self.in_flight.is_none()
            && self.pending.is_none()
    }

    pub fn reserved_micro_usd(&self) -> u64 {
        self.reserved_micro_usd
    }

    pub fn check_retry(&self, prepared: &Prepared) -> Result<(), Refusal> {
        if !self.retry_available() {
            return Err(Refusal::RetryUnavailable);
        }
        let worst = prepared
            .worst_micro_usd_opt()
            .ok_or(Refusal::RetryUnpriced)?;
        if self.unpriced_sent {
            return Err(Refusal::RetryUnpriced);
        }
        if self.reserved_micro_usd.saturating_add(worst) > SPEND_CAP_MICRO_USD {
            return Err(Refusal::SpendCap);
        }
        Ok(())
    }

    /// Nothing left the device: restore the prior failure and provider metadata.
    pub fn abandon(&mut self) -> Phase {
        self.cancel();
        if let Some((_, provider, custom)) = self.pending.take() {
            self.provider_name = provider;
            self.custom_model = custom;
        }
        if self.sent_attempts == 0 {
            Phase::None
        } else {
            Phase::Failed
        }
    }

    /// Stop waiting: the request in flight stops, or is never sent.
    pub fn cancel(&mut self) {
        if let Some(flag) = self.in_flight.take() {
            flag.store(true, Ordering::Release);
        }
    }

    pub fn finish(&mut self, result: Result<Draft, Failure>, spent: Option<u64>) -> Phase {
        let provider = CueProvider::Anthropic;
        self.finish_for(provider, result, spent)
    }

    pub fn finish_for(
        &mut self,
        provider: CueProvider,
        result: Result<Draft, Failure>,
        spent: Option<u64>,
    ) -> Phase {
        self.in_flight = None;
        self.sent_attempts = self.sent_attempts.saturating_add(1);
        if let Some((Some(worst), _, _)) = self.pending.take() {
            self.reserved_micro_usd = self.reserved_micro_usd.saturating_add(worst);
        } else {
            self.unpriced_sent = true;
        }
        self.validation_failed = matches!(result, Err(Failure::Invalid(_)));
        self.failure = None;
        self.draft = None;
        self.spent_micro_usd = if self.custom_model { None } else { spent };
        match result {
            Ok(draft) => {
                self.draft = Some(draft);
                Phase::Draft
            }
            Err(failure) => {
                self.failure = Some(failure.message_for(provider));
                Phase::Failed
            }
        }
    }

    /// Keeps the person's edited text, which the export then includes.
    pub fn keep(&mut self, markdown: &str) -> Result<(), String> {
        if self.draft.is_none() && self.kept.is_none() {
            return Err("There are no meeting notes to keep.".into());
        }
        if markdown.chars().count() > MAX_KEPT_CHARS {
            return Err("The notes are too long to keep. Shorten them and try again.".into());
        }
        self.kept = Some(markdown.trim_end().to_string());
        self.draft = None;
        Ok(())
    }

    pub fn discard(&mut self) {
        self.draft = None;
        self.kept = None;
    }
}

#[cfg(test)]
#[path = "meeting_notes_tests.rs"]
mod tests;
