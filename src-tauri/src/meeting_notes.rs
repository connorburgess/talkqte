//! Meeting notes written by a model, with the person's own Anthropic key,
//! after a live session has ended.
//!
//! This is one explicit request per meeting, never automatic. The notebook
//! first shows a plan: what will be sent (the session's transcript and, only
//! if the person ticks it, their own notes), to whom, and an estimate of size
//! and cost. Nothing is sent until the person confirms. There is no retry, no
//! fallback model and no other service.
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
use crate::provider_keys::{KeyError, Secret};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

const CONTRACT: &str = include_str!("../../scripts/fixtures/meeting-notes.json");

/// The model used for notes unless the person chooses another in Settings.
/// Notes are one request per meeting and are what people keep, so the
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
const MAX_TRANSCRIPT_LINES: usize = 4_000;
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
            Self::KeyNotSet => "keyNotSet",
            Self::KeyRejected => "keyRejected",
            Self::KeyUnreadable => "keyUnreadable",
            Self::Changed => "changed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::Empty => "This session has no transcript to write notes from. Nothing was sent.",
            Self::TooLong => "This meeting's transcript is longer than one request can take (about two hours of talk), so notes cannot be written for it. Nothing was sent.",
            Self::NotEnded => "Meeting notes can be written once a live session has ended. Nothing was sent.",
            Self::AlreadySent => "Notes were already requested for this meeting. Each meeting gets one request. Nothing was sent.",
            Self::Writing => "Notes for this meeting are already being written. Nothing else was sent.",
            Self::SpendCap => "At its worst, this request could cost more than the $1.00 limit for one meeting's notes. A lower-cost model for meeting notes in Settings may fit. Nothing was sent.",
            Self::KeyNotSet => "Add your Anthropic API key in Settings to write meeting notes. Nothing was sent.",
            Self::KeyRejected => "Anthropic rejected your key. Replace it in Settings. Nothing was sent.",
            Self::KeyUnreadable => "Your Anthropic key could not be read from the Keychain. Nothing was sent.",
            Self::Changed => "What would be sent has changed since you looked (the transcript, your notes or the notes setting). Review it again. Nothing was sent.",
            Self::Cancelled => "Stopped before anything was sent. Nothing was sent.",
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
        let after = "No notes were written, and nothing else will be sent for this meeting.";
        match self {
            Self::Cancelled => {
                format!("Cancelled. What was already sent may still be billed. {after}")
            }
            Self::Unreachable => {
                format!("Anthropic could not be reached or did not finish in time. {after}")
            }
            Self::SignIn => format!("Anthropic rejected your key. Replace it in Settings. {after}"),
            Self::UsageLimit => {
                format!("Your Anthropic account is at a usage or rate limit. {after}")
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
    lines: Vec<Line>,
    user: String,
    transcript_lines: usize,
    note_lines: Option<usize>,
    duration_ms: u64,
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
/// the person chose to include them, their notes. Speaker labels, the
/// session name, focus lines, imported notes and cues are never included.
pub fn prepare(
    model: Model,
    transcript: &[Segment],
    notes: Option<&str>,
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
    let mut lines = Vec::new();
    let mut user = String::from(
        "Transcript lines, with times from the start of the session. Speakers are not identified.\n",
    );
    for (index, line) in spoken.iter().enumerate() {
        let id = format!("L{}", index + 1);
        let text = flat(&line.text);
        let at = clock(line.at_ms);
        user.push_str(&format!("{id} [{at}] {text}\n"));
        lines.push(Line {
            id,
            label: format!("transcript {at}"),
            text,
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
        lines,
        user,
        transcript_lines,
        note_lines,
        duration_ms,
    })
}

impl Prepared {
    pub fn body(&self) -> Value {
        json!({
            "model": self.model.id,
            "max_tokens": MAX_TOKENS,
            "system": system_prompt(),
            "messages": [{"role": "user", "content": self.user}],
            "output_config": {
                "effort": EFFORT,
                "format": {"type": "json_schema", "schema": schema()},
            },
            "stream": true,
        })
    }

    fn sent_bytes(&self) -> usize {
        system_prompt().len() + self.user.len() + schema().to_string().len()
    }

    /// An estimated worst case: one token per byte of everything sent (text
    /// rarely uses more) plus 1,500 tokens for the structured-output prompt,
    /// at the input price (nothing is cached), plus the whole output bound.
    pub fn worst_micro_usd(&self) -> u64 {
        let tokens = self.sent_bytes() as f64 + 1_500.0;
        let [input, _, _, output] = self.model.price;
        (tokens * input + MAX_TOKENS as f64 * output).ceil() as u64
    }

    /// A digest of the request body: the model, prompt, schema and input.
    pub fn fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(self.body().to_string().as_bytes());
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// This request's own Stop waiting flag.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// A likelier figure: about four bytes per token and a few thousand
    /// tokens of thinking and reply. Still an estimate, not a bill.
    pub fn likely_micro_usd(&self) -> u64 {
        let tokens = self.sent_bytes().div_ceil(4) as f64 + 1_500.0;
        let [input, _, _, output] = self.model.price;
        (tokens * input + LIKELY_OUTPUT_TOKENS * output).ceil() as u64
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

    /// Refuses a request whose worst case passes the per-meeting cap.
    pub fn check_cap(&self) -> Result<(), Refusal> {
        if self.worst_micro_usd() > SPEND_CAP_MICRO_USD {
            Err(Refusal::SpendCap)
        } else {
            Ok(())
        }
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

/// The value's words as a run of whole words in one of the cited lines.
fn stated_in(value: &[String], lines: &[Line]) -> bool {
    lines.iter().any(|line| {
        let line = words(&line.text);
        line.windows(value.len()).any(|window| window == value)
    })
}

/// Accepts an owner only when it is a name-like run of whole words that one
/// of the cited lines contains: at least two letters, not only pronouns or
/// stand-ins, not a bare number.
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
        && stated_in(&value, lines)
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

fn write_with<T: Transport>(
    transport: &mut T,
    key: Secret,
    prepared: &Prepared,
    on_rejected: impl FnOnce(),
    cancelled: &dyn Fn() -> bool,
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
    let reply = transport.post(&key, body.as_bytes(), DEADLINE);
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
    match reply.status {
        200 => {}
        401 | 403 => {
            on_rejected();
            return failed(Failure::SignIn, Some(0));
        }
        // Whether a refused or failed request is billed is not reported.
        429 => return failed(Failure::UsageLimit, None),
        _ => return failed(Failure::Unreachable, None),
    }
    let (outcome, usage, complete) =
        anthropic_api::read_bounded_stream(reply.body, prepared.model, MAX_TEXT_BYTES, cancelled);
    // Only a complete reply reports its usage; otherwise the cost is unknown.
    let spent = complete.then(|| usage.cost_micro_usd(prepared.model));
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
    /// when it is not known.
    spent_micro_usd: Option<u64>,
    /// Stop waiting for the request in flight, if one is.
    in_flight: Option<Arc<AtomicBool>>,
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

    /// Records the request now in flight, so Stop waiting reaches it.
    pub fn begin(&mut self, prepared: &Prepared) {
        self.in_flight = Some(prepared.cancel_flag());
    }

    /// Stop waiting: the request in flight stops, or is never sent.
    pub fn cancel(&mut self) {
        if let Some(flag) = self.in_flight.take() {
            flag.store(true, Ordering::Release);
        }
    }

    pub fn finish(&mut self, result: Result<Draft, Failure>, spent: Option<u64>) -> Phase {
        self.in_flight = None;
        self.spent_micro_usd = spent;
        match result {
            Ok(draft) => {
                self.draft = Some(draft);
                Phase::Draft
            }
            Err(failure) => {
                self.failure = Some(failure.message());
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
