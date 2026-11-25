use crate::context::ContextItem;
use serde::{Deserialize, Serialize};

mod evaluation;
mod history;
mod sources;
pub use evaluation::{
    CaptureState, ConversationScope, EvaluationIssue, EvaluationOutcome, EvaluationStatus,
    NoteSelection, NoteSummary, ProcessingError, ProcessingLocation, ProcessingReview,
    ProcessingSnapshot, ProcessingTracker, ProcessorConfiguration, ProcessorDisclosure,
    ProcessorSummary, Scope, SourceCapture, SourcePhase, SourceProblem, StartupState, StopTarget,
};
pub use history::{EndPrompt, EndPromptAction, EndPromptState};
pub use sources::{Declared, SessionSources, SourcesStatus, SYSTEM_AUDIO, THEM, YOU};

const CUE_MS: u64 = 18_000;
/// A question asked of the user stays long enough for them to answer.
const ASKED_MS: u64 = 45_000;
/// The same with a model connected, which may also mark it answered: long
/// enough to answer, short enough not to hold the one cue slot for long.
const ASKED_WITH_MODEL_MS: u64 = 20_000;
/// A question type shown within this window is not asked again.
const REPEAT_MS: u64 = 120_000;
const MAX_NOTE_CHARS: usize = 20_000;
const MAX_SEGMENT_CHARS: usize = 1_000;
const MAX_SPEAKER_CHARS: usize = 80;
const MAX_SEGMENT_ID_BYTES: usize = 64;
/// Lines the notebook shows and the cue rules look back over. Every snapshot
/// carries them, so they stay few.
const MAX_TRANSCRIPT_SEGMENTS: usize = 400;
/// Lines of the whole meeting kept for a kept meeting's export and for
/// meeting notes: as many as one notes request can take, about two hours of
/// talk, which the 120-minute audio cap stays within. Past it the oldest go,
/// and both say so rather than leave out the start in silence.
const MAX_MEETING_LINES: usize = 4_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub at_ms: u64,
    pub speaker: String,
    pub text: String,
}

/// Which capture a live line came from. Each has its own recognizer stream,
/// so lines are in order within one origin but not across the two.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineOrigin {
    Microphone,
    Application,
}

/// Why a microphone line was not taken: it repeated the application's
/// sound. Counted in the session's source status.
pub const ECHO_DROPPED: &str = "That line repeated the application's audio.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
/// Scripted lines played on the session clock. The app never supplies any:
/// a live session's lines arrive through `ingest`. The engine's own tests
/// use a script to replay fictional scenarios.
pub struct Script {
    pub title: String,
    pub description: String,
    pub duration_ms: u64,
    pub segments: Vec<Segment>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ready,
    Running,
    Paused,
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Sensitivity {
    Balanced,
    Quiet,
    /// Only questions about the focus lines, questions asked of the user by
    /// name, and reminders of selected notes.
    Focused,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompanionPosition {
    BottomRight,
    TopCenter,
    TopLeft,
    TopRight,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionSize {
    Standard,
    Large,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Response {
    Dismiss,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub id: String,
    pub kind: String,
    pub question: String,
    pub evidence: String,
    /// Complete typed disclosure for an evaluated cue, in citation order.
    /// Phrase-rule cues retain their existing single-source payload.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<crate::cue_evaluator::Source>,
    pub source_id: String,
    pub remaining_ms: u64,
    pub total_ms: u64,
    pub held: bool,
    /// Later conversation that appears to answer this cue. Only a held cue
    /// can carry this: an unheld answered cue is withdrawn instead.
    pub resolved_by: Option<Resolution>,
    /// Set for a context cue: the imported note it quotes.
    pub note: Option<NoteRef>,
    /// True when the line uses words from one of the user's focus lines:
    /// the question then skips the pause after another cue and stays
    /// longer, and in Focused mode it is the only kind that appears.
    pub about_focus: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub source_id: String,
    pub evidence: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<crate::cue_evaluator::Source>,
}

/// The imported note a context cue comes from, so the companion can say so
/// instead of presenting the note as something said in the conversation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRef {
    pub title: String,
    pub source_date: String,
    pub provider: String,
    /// Set when the last update check could not confirm the quoted copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unconfirmed: Option<crate::context::Unconfirmed>,
}

/// The cue kind for a reminder drawn from an imported note.
pub const CONTEXT: &str = "Context";
/// Title words this long or longer identify a note; a line must contain at
/// least two of them to be about that note.
const TERM_MIN_CHARS: usize = 5;
const TERMS_NEEDED: usize = 2;
/// Titles with more terms than this need three matching words, because two
/// common words then co-occur too easily in ordinary speech.
const LONG_TITLE_TERMS: usize = 6;
/// A focus line is short, and there are few of them.
const MAX_FOCUS_CHARS: usize = 80;
pub const MAX_FOCUS_LINES: usize = 5;
/// Note reminders a session shows at most, so ten selected notes cannot
/// become ten interruptions.
pub const MAX_REMINDERS: usize = 3;
/// The cue kind that lists the focus lines a conversation never touched.
pub const STILL_OPEN: &str = "Still open";
/// The cue kind that quotes a spoken date or commitment, word for word.
pub const SAID: &str = "Said";
/// The most characters of a quoted line a Said cue shows.
const SAID_MAX_CHARS: usize = 160;

/// Words that name a time: a weekday, a relative day, a month before a
/// number, or a count of days or weeks.
const TIME_WORDS: &[&str] = &[
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "today",
    "tomorrow",
    "tonight",
    "weekend",
];
/// Words that make a time a commitment rather than a mention: "by Friday",
/// "ready by", "starting Monday", "takes two days".
const COMMITMENT_WORDS: &[&str] = &[
    "by",
    "before",
    "until",
    "starting",
    "start",
    "starts",
    "ready",
    "done",
    "finish",
    "finished",
    "send",
    "sent",
    "deliver",
    "delivered",
    "takes",
    "need",
    "needs",
    "due",
    "deadline",
    "ship",
    "publish",
];
/// Verbs that commit only when someone takes them on ("I'll share it
/// Friday", "we take it back Monday"), not in passing ("back from Paris on
/// Monday", "share the weekend photos").
const LOOSE_COMMITMENT_WORDS: &[&str] = &["from", "take", "back", "review", "share", "post"];
/// What comes before a loose verb when it is a commitment.
const COMMITTERS: &[&str] = &[
    "i'll", "we'll", "you'll", "they'll", "she'll", "he'll", "i", "we", "will", "can", "to",
];
const MONTH_WORDS: &[&str] = &[
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];
const COUNT_WORDS: &[&str] = &[
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "couple", "few",
];

/// Words that may sit between a count and its unit: "two working days".
const DAY_KINDS: &[&str] = &["full", "whole", "working", "business", "calendar"];

/// Sentences of a line, split at a full stop, question mark, exclamation
/// mark, or semicolon followed by a space or the end: "10.30" and "Mr."
/// stay whole.
fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes: Vec<(usize, char)> = text.char_indices().collect();
    for (i, &(at, c)) in bytes.iter().enumerate() {
        if matches!(c, '.' | '?' | '!' | ';')
            && bytes
                .get(i + 1)
                .is_none_or(|&(_, next)| next.is_whitespace())
        {
            let end = at + c.len_utf8();
            out.push(text[start..end].trim());
            start = end;
        }
    }
    out.push(text[start..].trim());
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

/// A number, with or without an ordinal ending: "14", "14th", "3rd".
fn is_number(word: &str) -> bool {
    let digits = word
        .strip_suffix("st")
        .or_else(|| word.strip_suffix("nd"))
        .or_else(|| word.strip_suffix("rd"))
        .or_else(|| word.strip_suffix("th"))
        .unwrap_or(word);
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

/// The first sentence of a line that commits to a time: a time word and a
/// commitment word together, not a question, not hedged. Returned word
/// for word, because the exact words are the point ("ready by Friday" is
/// not "starting Friday").
fn said_line(text: &str) -> Option<String> {
    sentences(text)
        .into_iter()
        .filter(|sentence| !sentence.ends_with('?'))
        .find(|sentence| {
            let words: Vec<String> = sentence
                .split(|c: char| !c.is_alphanumeric() && c != '\'')
                .filter(|w| !w.is_empty())
                .map(|w| w.to_lowercase())
                .collect();
            let has = |list: &[&str]| words.iter().any(|w| list.contains(&w.as_str()));
            let month_date = words
                .windows(2)
                .any(|pair| MONTH_WORDS.contains(&pair[0].as_str()) && is_number(&pair[1]));
            // "may" is a month only with a date after it; otherwise a hedge.
            let hedged_may = words
                .iter()
                .enumerate()
                .any(|(i, w)| w == "may" && !words.get(i + 1).is_some_and(|n| is_number(n)));
            let next_period = words.windows(2).any(|pair| {
                matches!(pair[0].as_str(), "next" | "this")
                    && matches!(
                        pair[1].as_str(),
                        "week"
                            | "month"
                            | "morning"
                            | "afternoon"
                            | "evening"
                            | "monday"
                            | "tuesday"
                            | "wednesday"
                            | "thursday"
                            | "friday"
                    )
            });
            // "two days", and "two working days" or "two full working days":
            // up to two of a few words that say which days are counted.
            let count_of_days = words.iter().enumerate().any(|(i, word)| {
                (COUNT_WORDS.contains(&word.as_str()) || is_number(word)) && {
                    let kinds = words[i + 1..]
                        .iter()
                        .take(2)
                        .take_while(|w| DAY_KINDS.contains(&w.as_str()))
                        .count();
                    words.get(i + 1 + kinds).is_some_and(|unit| {
                        matches!(unit.as_str(), "day" | "days" | "week" | "weeks" | "hours")
                    })
                }
            });
            let end_of = words.windows(3).any(|w| {
                w[0] == "end"
                    && w[1] == "of"
                    && matches!(w[2].as_str(), "week" | "month" | "day" | "year" | "the")
            });
            let timed = has(TIME_WORDS) || month_date || next_period || count_of_days || end_of;
            let is_time = |w: &str| TIME_WORDS.contains(&w) || MONTH_WORDS.contains(&w);
            let loose_commitment = words.iter().enumerate().any(|(i, w)| {
                LOOSE_COMMITMENT_WORDS.contains(&w.as_str())
                    && (i > 0 && COMMITTERS.contains(&words[i - 1].as_str())
                        || words.get(i + 1).is_some_and(|n| is_time(n)))
            });
            let question = words
                .first()
                .is_some_and(|first| QUESTION_OPENERS.contains(&first.as_str()));
            timed
                && (has(COMMITMENT_WORDS) || loose_commitment)
                && !has(&HEDGES)
                && !hedged_may
                && !question
        })
        .map(|sentence| {
            let cut: String = sentence.chars().take(SAID_MAX_CHARS).collect();
            if cut.chars().count() < sentence.chars().count() {
                format!("{cut}…")
            } else {
                cut
            }
        })
}
/// How people say a meeting is ending.
const WRAP_UP: &[&str] = &[
    "before we finish",
    "before we wrap",
    "to wrap up",
    "wrapping up",
    "wrap this up",
    "anything else",
    "last thing",
    "before we go",
    "before we close",
    "running out of time",
    "out of time",
    "final thing",
];

/// Whether a line sounds like the end of the meeting: a sentence that opens
/// with one of the phrases, after at most a short lead-in ("OK, so") or a
/// name ("Robin, anything else?"). "Anything else in the shed?" mid-sentence
/// does not count.
fn wraps_up(text: &str) -> bool {
    text.split(['.', '?', '!', ';']).any(|sentence| {
        let mut rest = sentence.trim().to_lowercase();
        // Up to two lead-in words or a vocative, each ending in a comma or
        // being one of a few interjections.
        for _ in 0..2 {
            let Some((head, tail)) = rest.split_once(' ') else {
                break;
            };
            let head = head.trim_end_matches(',');
            let lead_in = ["ok", "okay", "so", "right", "well", "alright", "and", "now"]
                .contains(&head)
                || (rest.split_once(' ').is_some_and(|(h, _)| h.ends_with(','))
                    && head.chars().all(char::is_alphabetic));
            if lead_in {
                rest = tail.trim_start().to_string();
            } else {
                break;
            }
        }
        WRAP_UP.iter().any(|phrase| rest.starts_with(phrase))
    })
}
/// Common meeting and function words that never identify a note.
const NOTE_STOP_WORDS: &[&str] = &[
    "about",
    "after",
    "again",
    "agenda",
    "ahead",
    "catch",
    "check",
    "could",
    "daily",
    "discussion",
    "every",
    "first",
    "going",
    "meeting",
    "minutes",
    "monthly",
    "month",
    "notes",
    "other",
    "people",
    "planning",
    "quick",
    "really",
    "review",
    "should",
    "standup",
    "still",
    "sync",
    "team",
    "their",
    "there",
    "these",
    "thing",
    "things",
    "think",
    "those",
    "today",
    "update",
    "weekly",
    "where",
    "which",
    "while",
    "would",
    "yesterday",
    "tomorrow",
];

/// An imported note prepared for matching.
#[derive(Clone, Debug, PartialEq, Eq)]
struct NoteTerms {
    key: String,
    item: ContextItem,
    unconfirmed: Option<crate::context::Unconfirmed>,
    terms: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub title: String,
    pub description: String,
    pub status: Status,
    pub elapsed_ms: u64,
    pub duration_ms: u64,
    pub transcript: Vec<Segment>,
    pub cue: Option<Cue>,
    pub notes: String,
    pub sensitivity: Sensitivity,
    pub overlay_enabled: bool,
    pub companion_position: CompanionPosition,
    pub question_size: QuestionSize,
    /// True for a live session fed by transcription.
    pub live: bool,
    /// True when the live session was started automatically when a call began.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub auto_started: bool,
    /// Live cue suppression only; capture, transcription and the clock continue.
    pub cues_paused: bool,
    /// The person's name, used to notice questions asked of them. Kept in
    /// the settings file (`settings.rs`); never sent to the companion.
    pub user_name: Option<String>,
    /// What matters in this meeting, as short lines the user typed, for this
    /// session only: questions about them come through sooner, Focused mode
    /// shows nothing else, and the ones never touched are listed once near
    /// the end. Never saved; the companion sees a line only inside that
    /// Still open list.
    pub focus: Vec<String>,
    /// The provider this live session's audio goes to after its review is
    /// approved, and the fixed code that ended it, if it ended. Every live
    /// session has one, since a launch without cloud transcription cannot
    /// start a session; absent outside live sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription: Option<CloudTranscription>,
    /// The capture sources this live session was started with, and how
    /// they are doing. Absent outside live sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<SourcesStatus>,
    /// The person chose to include this session's transcript and the cues
    /// shown in the Markdown export. Off for every new session; nothing is
    /// written unless the person reviews the export and saves it.
    pub keep_meeting: bool,
    /// Where this session's model-written meeting notes stand. Nothing is
    /// sent for them unless the person confirms, once, after the session.
    pub meeting_notes: crate::meeting_notes::Phase,
}

/// A cue that appeared in this session, for the export when the person
/// chooses to keep the meeting. Memory only, cleared by the next session.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ShownCue {
    at_ms: u64,
    kind: String,
    question: String,
    evidence: String,
}

/// The most cues one session's record keeps.
const MAX_SHOWN_CUES: usize = 1_000;

/// Where a live session's audio is transcribed, when that is not this device.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTranscription {
    pub provider: String,
    /// A fixed failure code, `withdrawn` when the review was turned off
    /// after audio began to be sent. Nothing falls back to another path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped: Option<String>,
    /// Some audio was not sent because the connection fell behind.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dropped_audio: bool,
    /// Replacement streams opened after connection failures, and the
    /// session time (ms) of speech lost with the failed streams.
    #[serde(skip_serializing_if = "is_zero")]
    pub reconnects: u32,
    #[serde(skip_serializing_if = "is_zero")]
    pub lost_ms: u64,
    /// Whole minutes of the meeting left before this session's transcription
    /// budget runs out, once at most [`LOW_TRANSCRIPTION_MINUTES`] remain.
    /// With both sources heard, each minute of the meeting spends two.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes_left: Option<u64>,
}

/// What a session has grown to; see [`Engine::growth`].
#[cfg(test)]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Growth {
    pub transcript: usize,
    pub meeting: usize,
    pub meeting_cut: bool,
    pub echoes: usize,
    pub echo_recent: usize,
    pub shown_cues: usize,
    pub asked_lines: usize,
    pub dismissed_sources: usize,
    pub last_shown: usize,
    pub snapshot_bytes: usize,
}

/// From how many minutes left the notebook says the cap is near.
pub const LOW_TRANSCRIPTION_MINUTES: u64 = 10;

fn is_zero<T: Default + PartialEq>(value: &T) -> bool {
    *value == T::default()
}

// The floating window never receives the notebook or full transcript.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueSnapshot {
    pub revision: u64,
    pub status: Status,
    pub live: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub auto_started: bool,
    pub cues_paused: bool,
    pub cue: Option<Cue>,
    pub overlay_enabled: bool,
    pub companion_position: CompanionPosition,
    pub question_size: QuestionSize,
    /// So the companion can offer the Focused switch and show its state.
    pub sensitivity: Sensitivity,
    /// The running live session is fed by a selected application alone, with
    /// no microphone. Development builds only; absent otherwise.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub source_session: bool,
    /// A call seems to be starting: the offer to start a session, when the
    /// person has turned that prompt on. Metadata only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_prompt: Option<crate::call_prompt::Prompt>,
    /// A previously active call went inactive while a live session is running:
    /// asks the person whether to stop & save or keep recording. Metadata only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_end_prompt: Option<crate::call_prompt::CallEndPrompt>,
    /// An ended non-empty live session prompt: counts and keep status only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_prompt: Option<EndPrompt>,
    /// Whether conversation lines may leave the device for a model, and
    /// whether a request is being sent. Absent without a model connection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelLink>,
    /// Why sending stopped, when `model` is `stopped`: the same codes as the
    /// notebook's processing issue.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_issue: Option<evaluation::Issue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub model_lab: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription: Option<CloudTranscription>,
}

/// The companion's indicator for a model connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelLink {
    /// The connection is on; lines are sent after new speech.
    On,
    /// A request is on its way now.
    Sending,
    /// A failure stopped sending; `model_issue` says why.
    Stopped,
}

pub struct Engine {
    identity: std::sync::Arc<()>,
    script: Script,
    pub state: Snapshot,
    generation: u64,
    evaluation_revision: u64,
    evaluation: Option<evaluation::State>,
    /// Stop has begun; transcript ingestion may finish, but processing cannot
    /// be approved or resumed. This does not assert that capture is released.
    live_stopping: bool,
    evaluated_cue: Option<(String, Vec<crate::cue_evaluator::Source>)>,
    /// Cues this session showed, oldest first, for an export that keeps the
    /// meeting. Never sent anywhere.
    shown_cues: Vec<ShownCue>,
    /// When this session started, milliseconds since 1970 (UTC), for a
    /// meeting the person keeps.
    started_at_ms: u64,
    last_recorded_cue: Option<String>,
    /// This session's model-written meeting notes, if the person asked.
    meeting_notes: crate::meeting_notes::Record,
    next_segment: usize,
    cue_deadline: u64,
    cooldown_until: u64,
    /// The time of the last line accepted from each origin, indexed by
    /// `LineOrigin`. Scripted lines count as the microphone's.
    line_floor: [u64; 2],
    /// Recent application lines, so a microphone line that repeats them
    /// through the speakers can be dropped.
    echo: sources::EchoGuard,
    /// Every line of this session, beyond the few the notebook shows, for
    /// the export of a kept meeting and for meeting notes. In memory only.
    meeting: Vec<Segment>,
    /// Earlier lines of this session went past [`MAX_MEETING_LINES`].
    meeting_cut: bool,
    /// Lines that asked the user a question by name this session. A model
    /// cue citing one would repeat the "Asked you" cue, so it is not shown.
    asked_lines: Vec<String>,
    /// Until when a model's `show` waits after the last cue ended: the full
    /// cooldown after the user dismissed it, a short pause otherwise.
    model_pause_until: u64,
    /// Lines cited by cues the user dismissed this session. A question to
    /// the user by name from one of them gets no second cue past the pause.
    dismissed_sources: Vec<String>,
    /// The last reason a model's `show` was dropped, for tests.
    #[cfg(test)]
    last_dropped: Option<&'static str>,
    /// Ignore delayed transcription from before the most recent cue resume.
    cues_after_ms: Option<u64>,
    /// The user's name for this app session, used to recognize questions
    /// addressed to them. Never stored or sent anywhere.
    /// When each question type was last shown in this session.
    last_shown: Vec<(String, u64)>,
    /// Words of each focus line that identify it, as for a note title.
    focus_terms: Vec<Vec<String>>,
    /// Which focus lines the conversation has touched this session.
    focus_touched: Vec<bool>,
    /// Note reminders shown this session, against `MAX_REMINDERS`.
    reminders_shown: usize,
    /// Whether the once-per-session list of untouched focus lines was shown.
    still_open_shown: bool,
    /// Imported notes prepared for matching, and the keys already shown.
    notes: Vec<NoteTerms>,
    processing_context_digest: [u8; 32],
    shown_notes: Vec<String>,
    /// The revision each shown note had when it reminded, and the keys of
    /// kept notes currently held back from reminders.
    reminded_revisions: Vec<(String, u64)>,
    withheld_notes: Vec<String>,
    /// A cue type created since the last publish, with its previous time.
    unshown: Option<(String, Option<u64>)>,
}

impl Default for Engine {
    /// No session: nothing runs and nothing is scripted until a live session
    /// replaces this engine.
    fn default() -> Self {
        Self::from_script(Script {
            title: String::new(),
            description: String::new(),
            duration_ms: 0,
            segments: vec![],
        })
    }
}

impl Engine {
    /// A session with no scripted lines, for transcript input through
    /// `ingest`. It runs until ended.
    pub fn live() -> Self {
        Self::from_script(Script {
            title: "Live session".into(),
            description: "Transcript lines from this session's transcription.".into(),
            duration_ms: u64::MAX,
            segments: vec![],
        })
    }

    /// The fictional scenario the engine's tests replay. Never in the app.
    #[cfg(test)]
    pub(crate) fn fictional() -> Self {
        Self::from_script(
            serde_json::from_str(include_str!("engine/fictional_scenario.json"))
                .expect("the fictional test scenario is valid"),
        )
    }

    fn from_script(script: Script) -> Self {
        Self {
            identity: std::sync::Arc::new(()),
            state: Snapshot {
                revision: 0,
                title: script.title.clone(),
                description: script.description.clone(),
                status: Status::Ready,
                elapsed_ms: 0,
                duration_ms: script.duration_ms,
                transcript: vec![],
                cue: None,
                notes: String::new(),
                sensitivity: Sensitivity::Balanced,
                overlay_enabled: true,
                companion_position: CompanionPosition::BottomRight,
                question_size: QuestionSize::Standard,
                live: script.segments.is_empty() && script.duration_ms == u64::MAX,
                auto_started: false,
                cues_paused: false,
                user_name: None,
                focus: vec![],
                transcription: None,
                sources: None,
                keep_meeting: false,
                meeting_notes: crate::meeting_notes::Phase::None,
            },
            script,
            generation: 0,
            evaluation_revision: 0,
            evaluation: None,
            live_stopping: false,
            evaluated_cue: None,
            shown_cues: vec![],
            started_at_ms: 0,
            last_recorded_cue: None,
            meeting_notes: Default::default(),
            next_segment: 0,
            cue_deadline: 0,
            cooldown_until: 0,
            line_floor: [0; 2],
            echo: sources::EchoGuard::default(),
            meeting: Default::default(),
            meeting_cut: false,
            asked_lines: vec![],
            model_pause_until: 0,
            dismissed_sources: vec![],
            #[cfg(test)]
            last_dropped: None,
            cues_after_ms: None,
            last_shown: vec![],
            focus_terms: vec![],
            focus_touched: vec![],
            reminders_shown: 0,
            still_open_shown: false,
            notes: vec![],
            processing_context_digest: evaluation::context_fingerprint(&[]),
            shown_notes: vec![],
            reminded_revisions: vec![],
            withheld_notes: vec![],
            unshown: None,
        }
    }

    pub fn cue_snapshot(&self) -> CueSnapshot {
        CueSnapshot {
            revision: self.state.revision,
            status: self.state.status,
            live: self.state.live,
            auto_started: self.state.auto_started,
            cues_paused: self.state.cues_paused,
            cue: self.state.cue.clone(),
            overlay_enabled: self.state.overlay_enabled,
            companion_position: self.state.companion_position,
            question_size: self.state.question_size,
            sensitivity: self.state.sensitivity,
            source_session: false,
            call_prompt: None,
            call_end_prompt: None,
            end_prompt: None,
            model: match self.evaluation_status() {
                Some(EvaluationStatus::Unavailable(_)) if self.state.live => {
                    Some(ModelLink::Stopped)
                }
                _ if self.has_processing_permission() => Some(
                    if self.evaluation_status() == Some(EvaluationStatus::Pending) {
                        ModelLink::Sending
                    } else {
                        ModelLink::On
                    },
                ),
                _ => None,
            },
            model_issue: self.processing_issue(),
            model_provider: self.model_provider(),
            model_lab: self.is_lab_evaluator(),
            transcription: self.state.transcription.clone(),
        }
    }

    fn changed(&mut self) {
        // Publishing the state shows any cue created since the last change.
        self.unshown = None;
        self.state.revision += 1;
        // Each published cue is considered for the session's record once.
        // Reminders quoting an imported note and the Still open list of focus
        // lines are left out, so a kept meeting holds no imported-note
        // content or focus line; a model cue's lines are kept as transcript
        // text only, without the speaker label or time its evidence shows.
        if let Some(cue) = &self.state.cue {
            if self.last_recorded_cue.as_deref() != Some(cue.id.as_str()) {
                self.last_recorded_cue = Some(cue.id.clone());
                if self.shown_cues.len() < MAX_SHOWN_CUES
                    && cue.note.is_none()
                    && cue.kind != CONTEXT
                    && cue.kind != STILL_OPEN
                {
                    let evidence = if cue.sources.is_empty() {
                        cue.evidence.clone()
                    } else {
                        cue.sources
                            .iter()
                            .filter(|source| {
                                matches!(
                                    source.provenance,
                                    crate::cue_evaluator::Provenance::Transcript { .. }
                                )
                            })
                            .map(|source| source.text.as_str())
                            .collect::<Vec<_>>()
                            .join(" / ")
                    };
                    self.shown_cues.push(ShownCue {
                        at_ms: self.state.elapsed_ms,
                        kind: cue.kind.clone(),
                        question: cue.question.clone(),
                        evidence,
                    });
                }
            }
        }
    }

    pub fn start(&mut self) -> Result<(), String> {
        if matches!(self.state.status, Status::Running | Status::Paused) {
            return Err("End the current session before starting another.".into());
        }
        self.revoke_processing();
        self.live_stopping = false;
        self.invalidate_evaluation();
        self.evaluated_cue = None;
        // Keeping the meeting is chosen per session, never carried over.
        self.state.keep_meeting = false;
        self.shown_cues.clear();
        self.started_at_ms = history::now_ms();
        // Meeting notes belong to the session they were written for; a
        // request still in flight for the last one stops, and its result
        // is dropped.
        self.meeting_notes.cancel();
        self.meeting_notes = Default::default();
        self.state.meeting_notes = crate::meeting_notes::Phase::None;
        self.last_recorded_cue = None;
        self.generation += 1;
        self.state.auto_started = false;
        self.state.cues_paused = false;
        self.cues_after_ms = None;
        self.last_shown.clear();
        self.shown_notes.clear();
        self.reminded_revisions.clear();
        self.focus_touched = vec![false; self.state.focus.len()];
        self.reminders_shown = 0;
        self.still_open_shown = false;
        self.next_segment = 0;
        self.cooldown_until = 0;
        self.line_floor = [0; 2];
        self.echo.clear();
        self.meeting.clear();
        self.meeting_cut = false;
        self.asked_lines.clear();
        self.model_pause_until = 0;
        self.dismissed_sources.clear();
        self.state.elapsed_ms = 0;
        self.state.transcript.clear();
        self.state.cue = None;
        self.state.transcription = (self.state.live && crate::transcription::cloud::selected())
            .then(|| CloudTranscription {
                provider: crate::transcription::cloud::active_provider_name().into(),
                stopped: None,
                dropped_audio: false,
                reconnects: 0,
                lost_ms: 0,
                minutes_left: None,
            });
        self.state.sources = self
            .state
            .live
            .then(|| SourcesStatus::new(SessionSources::microphone()));
        self.state.status = Status::Running;
        self.changed();
        Ok(())
    }

    /// Freezes a scripted scenario's clock. The app has no such control: a
    /// live session is stopped, and its cues are paused separately.
    #[cfg(test)]
    pub(crate) fn pause(&mut self) -> Result<(), String> {
        if self.state.status != Status::Running {
            return Err("Only a running session can be paused.".into());
        }
        self.invalidate_evaluation();
        self.state.status = Status::Paused;
        self.changed();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn resume(&mut self) -> Result<(), String> {
        if self.state.status != Status::Paused {
            return Err("Only a paused session can be resumed.".into());
        }
        self.invalidate_evaluation();
        self.state.status = Status::Running;
        self.changed();
        Ok(())
    }

    pub fn end(&mut self) {
        self.revoke_processing();
        self.live_stopping = false;
        self.invalidate_evaluation();
        self.evaluated_cue = None;
        self.state.status = Status::Ended;
        self.state.cues_paused = false;
        self.cues_after_ms = None;
        self.state.cue = None;
        self.changed();
    }

    /// When a live session ends with no transcript lines and empty manual
    /// notes, return to the idle Ready state so the notebook does not sit on
    /// an empty "Live session ended" view. Preserves any transcription stop
    /// reason so failures remain visible.
    pub fn return_to_ready_if_empty(&mut self) {
        if !self.state.live
            || self.state.status != Status::Ended
            || !self.state.transcript.is_empty()
            || !self.state.notes.trim().is_empty()
        {
            return;
        }
        self.state.live = false;
        self.state.status = Status::Ready;
        self.state.elapsed_ms = 0;
        self.state.duration_ms = 0;
        self.state.title.clear();
        self.state.description.clear();
        self.state.auto_started = false;
        self.state.sources = None;
        self.changed();
    }

    /// Quiet the live companion without implying that capture has stopped.
    /// Resume only permits newly spoken lines, never a transcription backlog.
    pub fn set_live_cues_paused(&mut self, paused: bool) -> Result<(), String> {
        if self.live_stopping {
            return Err("The live session is stopping.".into());
        }
        if !self.state.live || self.state.status != Status::Running {
            return Err("Cue pause is available only during a live session.".into());
        }
        if self.state.cues_paused == paused {
            return Ok(());
        }
        self.invalidate_evaluation();
        self.state.cues_paused = paused;
        self.evaluated_cue = None;
        self.state.cue = None;
        self.unshown = None;
        self.cues_after_ms = Some(self.state.elapsed_ms);
        self.changed();
        Ok(())
    }

    /// Close processing permission before releasing capture and draining queued
    /// transcript. The engine stays Running for ingestion until native cleanup
    /// ends this exact session. A failed cleanup cannot reopen permission.
    pub fn begin_live_stop(&mut self) {
        if self.state.live && self.state.status == Status::Running && !self.live_stopping {
            self.live_stopping = true;
            self.revoke_processing();
            self.changed();
        }
    }

    pub fn is_live_stopping(&self) -> bool {
        self.live_stopping
    }

    /// Finish only the session whose native cleanup completed. An older
    /// cleanup cannot end a replacement session or clear its stopping state.
    pub fn finish_live_stop(&mut self, session: u64) -> bool {
        if self.live_stopping && self.generation == session {
            self.end();
            true
        } else {
            false
        }
    }

    pub fn advance(&mut self, delta_ms: u64) {
        if self.state.status != Status::Running || delta_ms == 0 {
            return;
        }
        self.state.elapsed_ms = self
            .state
            .elapsed_ms
            .saturating_add(delta_ms)
            .min(self.script.duration_ms);
        let now = self.state.elapsed_ms;
        if let Some(cue) = self.state.cue.as_mut() {
            cue.remaining_ms = self.cue_deadline.saturating_sub(now);
            if cue.remaining_ms == 0 && !cue.held {
                // A quote leaves no pause behind it: it asked for nothing.
                let quote = cue.kind == SAID;
                self.state.cue = None;
                self.evaluated_cue = None;
                if !quote {
                    self.cooldown_until = self.cue_deadline + self.cooldown();
                    self.pause_model_after(self.cue_deadline, false);
                }
            }
        }
        while let Some(segment) = self.script.segments.get(self.next_segment) {
            if segment.at_ms > now {
                break;
            }
            let segment = segment.clone();
            self.next_segment += 1;
            self.line_floor[LineOrigin::Microphone as usize] = segment.at_ms;
            self.consume(segment, now);
        }
        if now >= self.script.duration_ms {
            self.revoke_processing();
            self.state.status = Status::Ended;
            // A deliberately opened question stays readable after playback ends.
            // An explicit end or a new session still clears it.
            if !self.state.cue.as_ref().is_some_and(|cue| cue.held) {
                self.state.cue = None;
                self.forget_unshown();
            }
        }
        self.poll_evaluation();
        self.changed();
    }

    /// The session a transcription worker should attach to its segments.
    /// Starting or replaying a session issues a new value, so work begun for
    /// an earlier session is rejected instead of reviving it.
    pub fn session(&self) -> u64 {
        self.generation
    }

    /// Records that `session`'s cloud stream dropped audio it had no room
    /// to send, so the notebook can say so.
    pub fn cloud_transcription_dropped(&mut self, session: u64) {
        if session != self.generation {
            return;
        }
        if let Some(transcription) = self
            .state
            .transcription
            .as_mut()
            .filter(|transcription| !transcription.dropped_audio)
        {
            transcription.dropped_audio = true;
            self.changed();
        }
    }

    /// The sizes of what a session grows, for the sustained-operation check.
    #[cfg(test)]
    pub(crate) fn growth(&self) -> Growth {
        Growth {
            transcript: self.state.transcript.len(),
            meeting: self.meeting.len(),
            meeting_cut: self.meeting_cut,
            echoes: self
                .state
                .sources
                .as_ref()
                .map_or(0, |status| status.echoes.len()),
            echo_recent: self.echo.len(),
            shown_cues: self.shown_cues.len(),
            asked_lines: self.asked_lines.len(),
            dismissed_sources: self.dismissed_sources.len(),
            last_shown: self.last_shown.len(),
            snapshot_bytes: serde_json::to_vec(&self.state).map_or(0, |bytes| bytes.len()),
        }
    }

    /// Records how much of `session`'s transcription budget is left, so the
    /// notebook can say the cap is near before the session ends on it. Only
    /// a change of whole minutes, within the last ten, changes the snapshot.
    pub fn cloud_transcription_left(&mut self, session: u64, left: std::time::Duration) {
        if session != self.generation || self.state.status != Status::Running {
            return;
        }
        // Both sources heard at once spend the budget twice as fast.
        let streams = match self.state.sources.as_ref() {
            Some(status)
                if status.sources.both_sources()
                    && status.application_attached
                    && status.application_ended.is_none() =>
            {
                2
            }
            _ => 1,
        };
        let minutes = (left.as_secs() / streams).div_ceil(60);
        let shown = (minutes <= LOW_TRANSCRIPTION_MINUTES).then_some(minutes);
        if let Some(transcription) = self
            .state
            .transcription
            .as_mut()
            .filter(|transcription| transcription.minutes_left != shown)
        {
            transcription.minutes_left = shown;
            self.changed();
        }
    }

    /// Records that `session`'s cloud stream was replaced after a
    /// connection failure, losing `lost_ms` of speech.
    pub fn cloud_transcription_reconnected(&mut self, session: u64, lost_ms: u64) {
        if session != self.generation {
            return;
        }
        if let Some(transcription) = self.state.transcription.as_mut() {
            transcription.reconnects += 1;
            transcription.lost_ms += lost_ms;
            self.changed();
        }
    }

    /// Records why `session`'s cloud transcription ended. The first code
    /// stays; a later session is not affected.
    pub fn cloud_transcription_stopped(&mut self, session: u64, code: &str) {
        if session != self.generation {
            return;
        }
        if let Some(transcription) = self
            .state
            .transcription
            .as_mut()
            .filter(|transcription| transcription.stopped.is_none())
        {
            transcription.stopped = Some(code.into());
            self.changed();
        }
    }

    /// Declare the capture sources of the running live session. Called once,
    /// right after the start, before any review can be made: the review is
    /// worded from them and an application may feed only a session that
    /// declared it.
    pub fn set_sources(&mut self, sources: SessionSources) {
        if !self.state.live {
            return;
        }
        self.state.sources = Some(SourcesStatus::new(sources));
        self.changed();
    }

    /// The capture sources this session declared; a live session without a
    /// declaration has the microphone alone.
    pub fn sources(&self) -> Option<&SessionSources> {
        self.state.sources.as_ref().map(|status| &status.sources)
    }

    /// The declared application began feeding `session`.
    pub fn application_attached(&mut self, session: u64) {
        if session != self.generation {
            return;
        }
        if let Some(status) = self.state.sources.as_mut() {
            if !status.application_attached {
                status.application_attached = true;
                self.changed();
            }
        }
    }

    /// The application source of `session` stopped, or never started, while
    /// the session runs on with its microphone. `code` is a fixed reason;
    /// the first one stays. Nothing happens in a session without both
    /// sources: one fed by an application alone ends with its source.
    pub fn application_ended(&mut self, session: u64, code: &str) {
        if session != self.generation || self.state.status != Status::Running || self.live_stopping
        {
            return;
        }
        if let Some(status) =
            self.state.sources.as_mut().filter(|status| {
                status.sources.both_sources() && status.application_ended.is_none()
            })
        {
            status.application_ended = Some(code.into());
            self.changed();
        }
    }

    /// A cloud stream for `origin` ended with a failure. In a session with
    /// both sources, the application's stream failing leaves the microphone
    /// running, so it is recorded as the application ending, not as the
    /// session's transcription stopping.
    pub fn source_transcription_stopped(&mut self, session: u64, origin: LineOrigin, code: &str) {
        if origin == LineOrigin::Application
            && self.sources().is_some_and(SessionSources::both_sources)
        {
            self.application_ended(session, code);
        } else {
            self.cloud_transcription_stopped(session, code);
        }
    }

    /// The person's answer about a line suppressed as a likely echo: keep it
    /// as theirs (shown and kept as an ordinary line; still never sent to a
    /// cue model) or remove it from the transcript and the kept meeting.
    pub fn resolve_echo(&mut self, id: &str, keep: bool) -> Result<(), String> {
        let status = self
            .state
            .sources
            .as_mut()
            .ok_or("That line is no longer in this session.")?;
        let index = status
            .echoes
            .iter()
            .position(|echo| echo.line.id == id)
            .ok_or("That line is no longer in this session.")?;
        if keep {
            status.echoes[index].kept = true;
        } else {
            status.echoes.remove(index);
        }
        self.changed();
        Ok(())
    }

    /// `ingest_from` for a line from the microphone.
    pub fn ingest(&mut self, session: u64, segment: Segment) -> Result<(), String> {
        self.ingest_from(session, LineOrigin::Microphone, segment)
    }

    /// Accepts one transcript segment from a live source for the running
    /// session. Invalid, late, or out-of-order input is rejected without
    /// changing state. Order is checked within the line's origin only: the
    /// microphone and an application are recognized on separate streams, so
    /// a line from one may be timed before a line already accepted from the
    /// other. The transcript keeps arrival order. Accepted input follows the
    /// same cue, answer, and stale-cue rules as a scripted line.
    pub fn ingest_from(
        &mut self,
        session: u64,
        origin: LineOrigin,
        segment: Segment,
    ) -> Result<(), String> {
        if session != self.generation {
            return Err("That transcript belongs to an earlier session.".into());
        }
        if self.state.status != Status::Running {
            return Err("Transcript input is accepted only while a session is running.".into());
        }
        let text = segment.text.trim();
        let speaker = segment.speaker.trim();
        if text.is_empty() || text.chars().count() > MAX_SEGMENT_CHARS {
            return Err("A transcript segment needs 1 to 1,000 characters of text.".into());
        }
        if speaker.is_empty() || speaker.chars().count() > MAX_SPEAKER_CHARS {
            return Err(
                "A transcript segment needs a speaker label of up to 80 characters.".into(),
            );
        }
        if segment.id.is_empty()
            || segment.id.len() > MAX_SEGMENT_ID_BYTES
            || !segment
                .id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
        {
            return Err("A transcript segment needs a short ID.".into());
        }
        if self
            .state
            .transcript
            .iter()
            .any(|existing| existing.id == segment.id)
            || self
                .script
                .segments
                .iter()
                .any(|scripted| scripted.id == segment.id)
        {
            return Err("That transcript segment was already received.".into());
        }
        let now = self.state.elapsed_ms;
        if segment.at_ms > now {
            return Err("A transcript segment cannot come from the future.".into());
        }
        if segment.at_ms < self.line_floor[origin as usize] {
            return Err("Transcript segments must arrive in order.".into());
        }
        let both = self.sources().is_some_and(SessionSources::both_sources);
        if both && origin == LineOrigin::Microphone && self.echo.is_echo(segment.at_ms, text) {
            // The microphone most likely heard the application's sound
            // through the speakers. Kept aside, shown marked and kept in the
            // meeting until the person removes it; never sent to a cue model.
            let line = Segment {
                text: text.into(),
                speaker: YOU.into(),
                ..segment
            };
            if let Some(status) = self.state.sources.as_mut() {
                status.suppressed(line);
            }
            self.changed();
            return Err(ECHO_DROPPED.into());
        }
        self.line_floor[origin as usize] = segment.at_ms;
        if both && origin == LineOrigin::Application {
            self.echo.heard_application(segment.at_ms, text);
        }
        let speaker = sources::label(self.sources(), origin).unwrap_or(speaker);
        let segment = Segment {
            text: text.into(),
            speaker: speaker.into(),
            ..segment
        };
        self.consume(segment, now);
        self.changed();
        Ok(())
    }

    fn consume(&mut self, segment: Segment, now: u64) {
        self.speech_changed();
        self.state.transcript.push(segment.clone());
        // Keep memory bounded in a long session; the oldest lines go first.
        if self.state.transcript.len() > MAX_TRANSCRIPT_SEGMENTS {
            let excess = self.state.transcript.len() - MAX_TRANSCRIPT_SEGMENTS;
            self.state.transcript.drain(..excess);
        }
        self.meeting.push(segment.clone());
        if self.meeting.len() > MAX_MEETING_LINES {
            self.meeting.remove(0);
            self.meeting_cut = true;
        }
        self.reconcile_evaluated_sources();
        // Any mention counts as the conversation touching a focus line, even
        // one put to someone else or taken back: it was raised.
        if let Some(touched) = self
            .focus_match(&segment.text)
            .and_then(|index| self.focus_touched.get_mut(index))
        {
            *touched = true;
        }
        if self.state.cues_paused
            || self
                .cues_after_ms
                .is_some_and(|resumed_at| segment.at_ms <= resumed_at)
        {
            return;
        }
        if self.evaluation.is_some() {
            // A question put to the user by name is not left to the model:
            // the same rule raises "Asked you" ahead of any model cue and
            // past the pause. The model still hears the line, but its reply
            // cannot replace, clear or repeat that cue.
            let correction = corrects(&segment.text);
            // The model is still asked while the cue is up, with it as the
            // cue on screen, so it can say the question was answered.
            if self.ask_of_user(&segment, correction, now) {
                if let Some(cue) = self
                    .state
                    .cue
                    .as_ref()
                    .filter(|cue| cue.kind == ASKED && cue.source_id == segment.id)
                {
                    // Its sources: this line, and the line before when the
                    // question was read across both.
                    let mut sources = vec![evaluation::transcript_source(&segment)];
                    if cue.evidence != segment.text {
                        if let Some(previous) = self
                            .state
                            .transcript
                            .len()
                            .checked_sub(2)
                            .and_then(|index| self.state.transcript.get(index))
                        {
                            sources.insert(0, evaluation::transcript_source(previous));
                        }
                    }
                    self.evaluated_cue = Some((cue.id.clone(), sources));
                }
            }
            self.submit_evaluation();
            return;
        }
        // The conversation answered the open cue. Withdraw it before the
        // user spends attention on it, unless they are reading it; then
        // keep the text in place and say it was answered.
        // With two captures a line can arrive after a cue raised from a line
        // spoken later; speech from before the question does not answer it.
        let spoken_before_cue = self.state.cue.as_ref().is_some_and(|cue| {
            self.state
                .transcript
                .iter()
                .any(|line| line.id == cue.source_id && segment.at_ms < line.at_ms)
        });
        if let Some(cue) = self.state.cue.as_mut().filter(|_| !spoken_before_cue) {
            if cue.resolved_by.is_none() && resolves(&cue.kind, &segment.text) {
                if cue.held {
                    cue.resolved_by = Some(Resolution {
                        sources: Vec::new(),
                        source_id: segment.id.clone(),
                        evidence: segment.text.clone(),
                    });
                } else {
                    self.state.cue = None;
                    self.cooldown_until =
                        (segment.at_ms + self.cooldown()).max(self.cooldown_until);
                    self.forget_unshown();
                    // The answer itself is worth the exact words: "ready by
                    // Friday" is not "starting Friday". It shows at once,
                    // in place of the question it answered.
                    self.maybe_said(&segment, now, true);
                }
                // The answer may also be the wrap-up line.
                self.maybe_still_open(&segment.id, &segment.text, segment.at_ms, now);
                return;
            }
        }
        // An explicit move to another topic makes an unread question stale.
        // A question being read stays, and this line may raise a new one.
        let spoken_at = segment.at_ms;
        let mut withdrawn_for_topic = false;
        // Where an explicit correction ends in this line, if it has one.
        let correction = corrects(&segment.text);
        // A direct question is preserved while the user answers, so a topic
        // phrase does not clear it.
        // Putting something off counts as a topic change only when it is
        // the subject of the unread question on screen; otherwise it is an
        // ordinary line and the question and repeat history stay.
        let deferred = self
            .state
            .cue
            .as_ref()
            .is_some_and(|cue| deferred_subject(&segment.text, &cue.evidence));
        if (topic_shift(&segment.text) || deferred)
            && !self
                .state
                .cue
                .as_ref()
                .is_some_and(|cue| cue.held || cue.kind == ASKED)
        {
            // A question type is not a repeat on a new topic. While the user
            // is reading a question, keep the history so a dismissed
            // question cannot come straight back.
            self.last_shown.clear();
            if self.state.cue.take().is_some() {
                self.unshown = None;
                withdrawn_for_topic = true;
            }
        } else if correction.is_some() {
            // A speaker taking back what they just said makes an unread
            // question raised from that line stale. Only a cue from the same
            // speaker's line immediately before, within CORRECTION_MS, counts,
            // because a correction may refer to anything else. A question
            // being read stays, and so does one asked of the user, which the
            // user may still want to answer.
            let previous = self
                .state
                .transcript
                .len()
                .checked_sub(2)
                .and_then(|index| self.state.transcript.get(index));
            let taken_back = self.state.cue.as_ref().is_some_and(|cue| {
                !cue.held
                    && cue.kind != ASKED
                    && previous.is_some_and(|line| {
                        line.id == cue.source_id
                            && line.speaker == segment.speaker
                            && line.at_ms <= segment.at_ms
                            && segment.at_ms - line.at_ms <= CORRECTION_MS
                    })
            });
            if taken_back {
                self.state.cue = None;
                self.forget_unshown();
                withdrawn_for_topic = true;
            }
        }
        // A wrap-up put to the user ("Robin, anything else before we go?")
        // is the moment for the Still open list, before it reads as a
        // question for them.
        self.maybe_still_open(&segment.id, &segment.text, segment.at_ms, now);
        if self
            .state
            .cue
            .as_ref()
            .is_some_and(|cue| cue.kind == STILL_OPEN)
        {
            return;
        }
        if self.ask_of_user(&segment, correction, now) {
            return;
        }
        // Once the user has given their name, a question put to someone else
        // by name is theirs to answer and already says who is meant, so that
        // sentence raises no suggestion. Other sentences in the line still can.
        // Nothing said before a correction in the same line raises a cue.
        let after_correction = &segment.text[correction.unwrap_or(0)..];
        let suggestible = if let Some(name) = self.state.user_name.as_deref() {
            text_not_put_to_others(name, after_correction)
        } else {
            after_correction.to_string()
        };
        // Kept for the reminders below; a fixed question may move the
        // segment's ID and text into its cue first.
        let line_id = segment.id.clone();
        let line_text = segment.text.clone();
        // A line that uses the words of a focus line may raise a question
        // during the pause after another cue, and that question stays as long
        // as one asked of the user; in Focused mode only such lines, and
        // reminders, raise anything. This is a word match on the user's own
        // words, not a judgment that the line is about them.
        let about_focus = self.focus_match(&suggestible).is_some();
        let focused = matches!(self.state.sensitivity, Sensitivity::Focused);
        // Skip stale suggestions after a suspended app catches up. A focus
        // question skips the pause left by an unrelated cue; in Focused mode
        // every question is about the focus, so the pause applies as usual.
        if self.state.cue.is_none()
            && (segment.at_ms >= self.cooldown_until || (about_focus && !focused))
            && now - segment.at_ms < CUE_MS
            && (!focused || about_focus)
        {
            // The same fixed question shortly after it was shown is redundant,
            // whether it was answered, dismissed, or ignored.
            // Open questions repeat per question text, not per kind, so an
            // unrelated question is not hidden by an earlier one.
            let repeat_key = |kind: &str, question: &str| {
                if kind == OPEN {
                    format!("{OPEN}:{}", question.to_lowercase())
                } else {
                    kind.to_string()
                }
            };
            let repeated = |key: &str| {
                self.last_shown
                    .iter()
                    .any(|(shown, at)| shown == key && segment.at_ms < at + REPEAT_MS)
            };
            if let Some((kind, question)) = suggest(&suggestible)
                .into_iter()
                .find(|(kind, question)| !repeated(&repeat_key(kind, question)))
            {
                let key = repeat_key(kind, &question);
                // Remember the previous time in case this cue is withdrawn
                // before the user ever sees it.
                let previous = self
                    .last_shown
                    .iter()
                    .position(|(shown, _)| shown == &key)
                    .map(|index| self.last_shown.remove(index).1);
                self.unshown = Some((key.clone(), previous));
                self.last_shown.push((key, segment.at_ms));
                let total_ms = if about_focus { ASKED_MS } else { CUE_MS };
                self.cue_deadline = segment.at_ms + total_ms;
                self.state.cue = Some(Cue {
                    sources: Vec::new(),
                    id: format!("{}:{}", self.generation, segment.id),
                    kind: kind.into(),
                    question,
                    evidence: segment.text,
                    source_id: segment.id,
                    remaining_ms: self.cue_deadline - now,
                    total_ms,
                    held: false,
                    resolved_by: None,
                    note: None,
                    about_focus,
                });
            }
        }
        // A spoken date or commitment, quoted word for word, after the fixed
        // questions and before the reminders.
        if self.state.cue.is_none() {
            let line = Segment {
                id: line_id.clone(),
                at_ms: spoken_at,
                speaker: String::new(),
                text: suggestible.clone(),
            };
            self.maybe_said(&line, now, false);
        }
        self.maybe_still_open(&line_id, &line_text, spoken_at, now);
        // A line about an imported note reminds the user of it once, with the
        // note as its source: a context reminder, lowest in priority, under
        // the same expiry and pause as a question. This is a phrase match on
        // the note's title, not a judgment that the note is relevant.
        if self.state.cue.is_none()
            && segment.at_ms >= self.cooldown_until
            && now - segment.at_ms < CUE_MS
            && self.reminders_shown < MAX_REMINDERS
        {
            // Only words not taken back, and not put to someone else, count.
            if let Some(note) = self.note_for(&suggestible).cloned() {
                // Shown once per session from creation, whether or not the
                // user got to read it: a reminder is not re-raised later,
                // and a session shows at most `MAX_REMINDERS` of them.
                self.shown_notes.push(note.key.clone());
                self.reminded_revisions
                    .push((note.key.clone(), note.item.revision));
                self.reminders_shown += 1;
                self.unshown = None;
                self.cue_deadline = segment.at_ms + CUE_MS;
                self.state.cue = Some(Cue {
                    sources: Vec::new(),
                    id: format!("{}:{}", self.generation, line_id),
                    kind: CONTEXT.into(),
                    question: note.item.title.clone(),
                    evidence: note.item.excerpt.clone(),
                    source_id: note.key.clone(),
                    remaining_ms: self.cue_deadline - now,
                    total_ms: CUE_MS,
                    held: false,
                    resolved_by: None,
                    note: Some(NoteRef {
                        title: note.item.title,
                        source_date: note.item.source_date,
                        provider: note.item.provider.id().into(),
                        unconfirmed: note.unconfirmed,
                    }),
                    about_focus: false,
                });
            }
        }
        // After a topic change withdrew a question and raised nothing, leave
        // a pause as after any other withdrawal.
        if withdrawn_for_topic && self.state.cue.is_none() {
            self.cooldown_until = self.cooldown_until.max(spoken_at + self.cooldown());
        }
    }

    /// Near the end, once: the focus lines the conversation never touched,
    /// so a meeting that drifted can still come back to them. A phrase match
    /// on how people wrap up; nothing else judges the drift. It waits for a
    /// clear companion and ignores the pause after another cue, in every
    /// timing setting; a later wrap-up line retries until it has shown.
    fn maybe_still_open(&mut self, id: &str, text: &str, at_ms: u64, now: u64) {
        if self.state.cue.is_some()
            || self.still_open_shown
            || now - at_ms >= CUE_MS
            || !wraps_up(text)
        {
            return;
        }
        let open: Vec<&str> = self
            .state
            .focus
            .iter()
            .zip(&self.focus_touched)
            .filter(|(_, touched)| !**touched)
            .map(|(line, _)| line.as_str())
            .collect();
        if open.is_empty() {
            return;
        }
        self.still_open_shown = true;
        self.unshown = None;
        self.cue_deadline = at_ms + ASKED_MS;
        self.state.cue = Some(Cue {
            sources: Vec::new(),
            id: format!("{}:{}", self.generation, id),
            kind: STILL_OPEN.into(),
            question: format!("Not covered: {}", open.join(" · ")),
            evidence: text.to_string(),
            source_id: id.to_string(),
            remaining_ms: self.cue_deadline - now,
            total_ms: ASKED_MS,
            held: false,
            resolved_by: None,
            note: None,
            about_focus: true,
        });
    }

    /// Quotes a spoken date or commitment from this line, if it has one and
    /// nothing is on screen. `answering` skips the pause: the line just
    /// answered a question, and the words that answered it are the point.
    /// In Focused mode only a line about the focus is quoted. The same
    /// words are not quoted again within the repeat window. A quote leaves
    /// no pause when it goes, whether it expired, was dismissed, or was kept.
    fn maybe_said(&mut self, segment: &Segment, now: u64, answering: bool) {
        if self.state.cue.is_some() || now - segment.at_ms >= CUE_MS {
            return;
        }
        if !answering && segment.at_ms < self.cooldown_until {
            return;
        }
        let focused = matches!(self.state.sensitivity, Sensitivity::Focused);
        let about_focus = self.focus_match(&segment.text).is_some();
        if focused && !about_focus {
            return;
        }
        let Some(quote) = said_line(&segment.text) else {
            return;
        };
        let key = format!("{SAID}:{}", quote.to_lowercase());
        if self
            .last_shown
            .iter()
            .any(|(shown, at)| *shown == key && segment.at_ms < at + REPEAT_MS)
        {
            return;
        }
        self.last_shown.push((key.clone(), segment.at_ms));
        self.unshown = Some((key, None));
        self.cue_deadline = segment.at_ms + CUE_MS;
        self.state.cue = Some(Cue {
            sources: Vec::new(),
            id: format!("{}:{}", self.generation, segment.id),
            kind: SAID.into(),
            question: quote,
            evidence: segment.text.clone(),
            source_id: segment.id.clone(),
            remaining_ms: self.cue_deadline - now,
            total_ms: CUE_MS,
            held: false,
            resolved_by: None,
            note: None,
            about_focus,
        });
    }

    /// A cue created and removed before the next publish was never seen, so
    /// it must not count as shown.
    fn forget_unshown(&mut self) {
        if let Some((kind, previous)) = self.unshown.take() {
            self.last_shown.retain(|(shown, _)| *shown != kind);
            if let Some(at) = previous {
                self.last_shown.push((kind, at));
            }
        }
    }

    /// A question asked of the user by name: raises an "Asked you" cue and
    /// returns true when the line asks one, whether or not it could be shown.
    /// Runs in every live session, with or without a model connected.
    fn ask_of_user(&mut self, segment: &Segment, correction: Option<usize>, now: u64) -> bool {
        // A question asked of the user by name takes priority over an unread
        // suggestion, ignores the cooldown, and shows the question itself.
        // Questions for someone else, or for no one in particular, stay quiet.
        // Streamed transcription can end one line on the name and start the
        // next with the question ("Partners doubles it. Maddie," then "how
        // many came to the party?"), so a name left unfinished at the end of
        // the line just before is read together with this one.
        let carried = correction
            .is_none()
            .then(|| {
                self.state
                    .transcript
                    .len()
                    .checked_sub(2)
                    .and_then(|index| self.state.transcript.get(index))
            })
            .flatten()
            // Only the same speaker label, as for a correction: a name at the
            // end of one person's line is not a question asked by the next.
            .filter(|line| {
                line.speaker == segment.speaker
                    && line.at_ms <= segment.at_ms
                    && segment.at_ms - line.at_ms <= NAME_CARRY_MS
            })
            .and_then(|line| {
                let name = self.state.user_name.as_deref()?;
                trailing_address(name, &line.text).map(|lead| (lead, line.id.clone()))
            });
        // The evidence is the text the question was read from, so a question
        // joined across two lines is quoted whole, and shown once.
        let Some((asked, evidence, carried_id)) =
            self.state.user_name.as_deref().and_then(|name| {
                carried
                    .and_then(|(lead, id)| {
                        let joined = format!("{lead} {}", segment.text);
                        asked_of(name, &joined).map(|asked| (asked, joined, Some(id)))
                    })
                    .or_else(|| {
                        asked_of(name, &segment.text[correction.unwrap_or(0)..])
                            .map(|asked| (asked, segment.text.clone(), None))
                    })
            })
        else {
            return false;
        };
        if !self.state.cue.as_ref().is_some_and(|cue| cue.held) && now - segment.at_ms < CUE_MS {
            // Only displayed questions suppress model duplicates. A joined
            // question was read from both lines, so either citation counts.
            if let Some(id) = carried_id {
                self.asked_lines.push(id);
            }
            self.asked_lines.push(segment.id.clone());
            // A suggestion replaced before it was published was never seen.
            if self.state.cue.take().is_some() {
                self.forget_unshown();
            }
            let lifetime = if self.has_processing_permission() {
                ASKED_WITH_MODEL_MS
            } else {
                ASKED_MS
            };
            self.cue_deadline = segment.at_ms + lifetime;
            self.state.cue = Some(Cue {
                sources: Vec::new(),
                id: format!("{}:{}", self.generation, segment.id),
                kind: ASKED.into(),
                question: asked,
                evidence,
                source_id: segment.id.clone(),
                remaining_ms: self.cue_deadline - now,
                total_ms: lifetime,
                held: false,
                resolved_by: None,
                note: None,
                about_focus: false,
            });
        }
        true
    }

    fn cooldown(&self) -> u64 {
        match self.state.sensitivity {
            Sensitivity::Balanced | Sensitivity::Focused => 10_000,
            Sensitivity::Quiet => 30_000,
        }
    }

    /// The pause before a model's next cue, from when the last one ended.
    /// After a dismissal it is the full cooldown: the user said no. After a
    /// cue expired, was resolved or withdrawn, or lost its source, nothing
    /// was rejected, so the pause is short (`AFTER_UNREJECTED_MS`, longer in
    /// Quiet). The phrase rules keep `cooldown_until` unchanged.
    fn pause_model_after(&mut self, ended_at: u64, dismissed: bool) {
        let pause = match (dismissed, self.state.sensitivity) {
            (true, _) => self.cooldown(),
            (false, Sensitivity::Quiet) => AFTER_UNREJECTED_QUIET_MS,
            (false, _) => AFTER_UNREJECTED_MS,
        };
        self.model_pause_until = ended_at.saturating_add(pause);
    }

    pub fn respond(&mut self, id: &str, response: Response) -> Result<(), String> {
        // Dismiss is the only response: an unused suggestion is let go, never
        // kept as a note or an action item.
        let Response::Dismiss = response;
        let quote = self
            .state
            .cue
            .as_ref()
            .filter(|cue| cue.id == id)
            .ok_or("That question has already passed.")?
            .kind
            == SAID;
        self.invalidate_evaluation();
        self.evaluated_cue = None;
        if let Some(cue) = self.state.cue.take() {
            self.dismissed_sources
                .extend(cue.sources.into_iter().map(|source| source.id));
        }
        if !quote {
            self.cooldown_until = self.state.elapsed_ms + self.cooldown();
            self.pause_model_after(self.state.elapsed_ms, true);
        }
        self.changed();
        Ok(())
    }

    /// Holds the cue until it is dismissed. There is no way to release it.
    pub fn inspect_cue(&mut self, id: &str) -> Result<(), String> {
        let cue = self
            .state
            .cue
            .as_mut()
            .filter(|cue| cue.id == id)
            .ok_or("That question has already passed.")?;
        cue.held = true;
        self.changed();
        Ok(())
    }

    pub fn set_companion_position(&mut self, value: CompanionPosition) {
        self.state.companion_position = value;
        self.changed();
    }

    pub fn set_question_size(&mut self, value: QuestionSize) {
        self.state.question_size = value;
        self.changed();
    }

    pub fn update_notes(&mut self, notes: String) -> Result<(), String> {
        if notes.chars().count() > MAX_NOTE_CHARS {
            return Err("Notes can contain up to 20,000 characters.".into());
        }
        self.state.notes = notes;
        self.changed();
        Ok(())
    }

    /// Synchronizes the validated, explicitly selected context store. Preserve
    /// its provider identity and revision, including across engine replacement.
    /// An unchanged import leaves a held cue and pending evaluation alone.
    pub fn set_notes(&mut self, notes: Vec<ContextItem>) {
        self.set_prior_notes(notes.into_iter().map(|item| (item, None)).collect(), vec![]);
    }

    /// As `set_notes`, with the warning a reminder must carry for a copy
    /// the last update check could not confirm, and the kept notes that are
    /// held back from reminders. A displayed reminder keeps its words when
    /// only the warning changes; the warning line itself is updated. A note
    /// that is held back or removed withdraws its reminder as before.
    pub fn set_prior_notes(
        &mut self,
        notes: Vec<(ContextItem, Option<crate::context::Unconfirmed>)>,
        withheld: Vec<ContextItem>,
    ) {
        let withheld: Vec<String> = withheld
            .iter()
            .map(|item| format!("{}:{}", item.provider.id(), item.source_id))
            .collect();
        let notes: Vec<_> = notes
            .into_iter()
            .map(|(item, unconfirmed)| NoteTerms {
                terms: note_terms(&item.title),
                key: format!("{}:{}", item.provider.id(), item.source_id),
                item,
                unconfirmed,
            })
            .collect();
        if self.notes == notes && self.withheld_notes == withheld {
            return;
        }
        self.invalidate_evaluation();
        // A newer revision can invalidate a reminder even when its excerpt
        // stayed the same. Compare the complete original item so a changed
        // date/title cannot leave misleading disclosure either. Clear rather
        // than replacing words under the reader's eyes.
        let obsolete = self.state.cue.as_ref().is_some_and(|cue| {
            cue.note.is_some()
                && !self.notes.iter().any(|old| {
                    old.key == cue.source_id
                        && notes
                            .iter()
                            .any(|new| new.key == old.key && new.item == old.item)
                })
        });
        // A note that reminded, was held back and returns stays shown,
        // unless it returns as a newer revision than the one that reminded.
        for note in &notes {
            if self.withheld_notes.contains(&note.key)
                && self
                    .reminded_revisions
                    .iter()
                    .any(|(key, revision)| *key == note.key && note.item.revision > *revision)
            {
                self.shown_notes.retain(|key| *key != note.key);
                self.reminded_revisions.retain(|(key, _)| *key != note.key);
            }
        }
        self.withheld_notes = withheld;
        self.notes = notes;
        self.processing_context_digest = evaluation::context_fingerprint(&self.notes);
        self.reconcile_processing_permission();
        let keys: Vec<&String> = self.notes.iter().map(|note| &note.key).collect();
        let withheld = &self.withheld_notes;
        self.shown_notes
            .retain(|key| keys.contains(&key) || withheld.contains(key));
        self.reminded_revisions
            .retain(|(key, _)| keys.contains(&key) || withheld.contains(key));
        // Keep a refreshed note marked shown: no automatic replacement or
        // second reminder this session. Removal releases its copied evidence.
        if obsolete || self.reconcile_evaluated_sources() {
            self.forget_unshown();
            self.state.cue = None;
            self.evaluated_cue = None;
            self.cooldown_until = self.state.elapsed_ms + self.cooldown();
            self.pause_model_after(self.state.elapsed_ms, false);
            self.changed();
        } else {
            // Same note, different standing: keep the reminder, even held
            // open, and bring its warning line up to date.
            let warning = self.state.cue.as_ref().and_then(|cue| {
                self.notes
                    .iter()
                    .find(|note| note.key == cue.source_id)
                    .map(|note| note.unconfirmed)
            });
            let shown = self.state.cue.as_mut().and_then(|cue| cue.note.as_mut());
            if let (Some(note), Some(warning)) = (shown, warning) {
                if note.unconfirmed != warning {
                    note.unconfirmed = warning;
                    self.changed();
                }
            }
        }
    }

    /// Carries the focus lines to a replacement engine.
    pub fn copy_focus_from(&mut self, previous: &Engine) {
        self.focus_terms = previous.focus_terms.clone();
        self.state.focus = previous.state.focus.clone();
        self.focus_touched = vec![false; self.state.focus.len()];
    }

    /// Carries imported notes to a replacement engine.
    pub fn copy_notes_from(&mut self, previous: &Engine) {
        self.notes = previous.notes.clone();
        self.processing_context_digest = previous.processing_context_digest;
        self.shown_notes = previous.shown_notes.clone();
        self.reminded_revisions = previous.reminded_revisions.clone();
        self.withheld_notes = previous.withheld_notes.clone();
        self.reconcile_processing_permission();
    }

    /// The first imported note this line is about, by its title words, that
    /// has not been shown this session.
    fn note_for(&self, text: &str) -> Option<&NoteTerms> {
        let words: Vec<String> = text
            .split(|character: char| !character.is_alphanumeric() && character != '\'')
            .filter(|word| !word.is_empty())
            .map(|word| word.to_lowercase())
            .collect();
        self.notes.iter().find(|note| {
            let needed = if note.terms.len() > LONG_TITLE_TERMS {
                TERMS_NEEDED + 1
            } else {
                TERMS_NEEDED
            };
            !self.shown_notes.contains(&note.key)
                && note.terms.len() >= needed
                && note
                    .terms
                    .iter()
                    .filter(|term| words.contains(term))
                    .count()
                    >= needed
        })
    }

    /// The first focus line this text uses enough of the words of, by the
    /// same rule as a note title.
    fn focus_match(&self, text: &str) -> Option<usize> {
        let words: Vec<String> = text
            .split(|character: char| !character.is_alphanumeric() && character != '\'')
            .filter(|word| !word.is_empty())
            .map(|word| word.to_lowercase())
            .collect();
        self.focus_terms.iter().position(|terms| {
            let needed = if terms.len() > LONG_TITLE_TERMS {
                TERMS_NEEDED + 1
            } else {
                TERMS_NEEDED
            };
            terms.len() >= needed
                && terms.iter().filter(|term| words.contains(term)).count() >= needed
        })
    }

    /// Replaces the focus lines: what matters in this meeting, one short
    /// line each, up to `MAX_FOCUS_LINES`. Kept in memory for this app
    /// session only. Each line needs at least two words that can identify
    /// it in conversation (five letters or more, not common meeting words),
    /// or it could never let a question through. Blank lines are dropped.
    pub fn set_focus(&mut self, lines: Vec<String>) -> Result<(), String> {
        let lines: Vec<String> = lines
            .into_iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        if lines.len() > MAX_FOCUS_LINES {
            return Err(format!("Keep the focus to {MAX_FOCUS_LINES} lines."));
        }
        let mut terms = Vec::with_capacity(lines.len());
        for line in &lines {
            if line.chars().count() > MAX_FOCUS_CHARS || line.chars().any(char::is_control) {
                return Err(format!(
                    "Each focus line is up to {MAX_FOCUS_CHARS} characters."
                ));
            }
            let line_terms = note_terms(line);
            if line_terms.len() < TERMS_NEEDED {
                return Err(format!(
                    "“{line}” needs a few specific words, such as “agree the launch plan for the newsletter”."
                ));
            }
            terms.push(line_terms);
        }
        // A line kept through an edit keeps whether the conversation touched it.
        self.focus_touched = lines
            .iter()
            .map(|line| {
                self.state
                    .focus
                    .iter()
                    .position(|old| old == line)
                    .and_then(|index| self.focus_touched.get(index).copied())
                    .unwrap_or(false)
            })
            .collect();
        self.invalidate_evaluation();
        self.focus_terms = terms;
        self.state.focus = lines;
        self.changed();
        Ok(())
    }

    pub fn set_user_name(&mut self, name: Option<String>) -> Result<(), String> {
        let name = name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty());
        if let Some(name) = &name {
            if !valid_user_name(name) {
                return Err(
                    "Use letters, spaces, apostrophes, or hyphens, up to 40 characters.".into(),
                );
            }
        }
        self.invalidate_evaluation();
        self.state.user_name = name;
        self.changed();
        Ok(())
    }

    /// Continues session numbering from `previous`, so a session in this
    /// engine never reuses an ID that late work for the old one still holds.
    pub fn continue_sessions_from(&mut self, previous: &Engine) {
        self.generation = self.generation.max(previous.generation);
        self.reconcile_processing_permission();
    }

    pub fn set_sensitivity(&mut self, value: Sensitivity) {
        self.invalidate_evaluation();
        self.state.sensitivity = value;
        self.changed();
    }

    pub fn set_overlay(&mut self, enabled: bool) {
        self.state.overlay_enabled = enabled;
        self.changed();
    }

    /// Whether to include this session's transcript and the cues shown in
    /// the export. The person's choice for this session only.
    pub fn set_keep_meeting(&mut self, keep: bool) {
        if self.state.keep_meeting != keep {
            self.state.keep_meeting = keep;
            self.changed();
        }
    }

    /// Why no meeting notes request can be sent for this session now, if
    /// one cannot: only after a live session has ended, once per session.
    fn meeting_notes_open(&self) -> Result<(), crate::meeting_notes::Refusal> {
        use crate::meeting_notes::{Phase, Refusal};
        if !self.state.live || self.state.status != Status::Ended {
            return Err(Refusal::NotEnded);
        }
        match self.state.meeting_notes {
            Phase::None => Ok(()),
            Phase::Writing => Err(Refusal::Writing),
            _ => Err(Refusal::AlreadySent),
        }
    }

    fn meeting_notes_input(
        &self,
        include_notes: bool,
    ) -> Result<crate::meeting_notes::Prepared, crate::meeting_notes::Refusal> {
        self.meeting_notes_open()?;
        // Notes that silently miss the start of a meeting are worse than
        // none.
        if self.meeting_cut {
            return Err(crate::meeting_notes::Refusal::TooLong);
        }
        let prepared = crate::meeting_notes::prepare_for(
            crate::meeting_notes::active_target(),
            &self.meeting,
            include_notes.then_some(self.state.notes.as_str()),
        )?;
        prepared.check_cap()?;
        Ok(prepared)
    }

    /// What a notes request would send, for the confirmation. Sends nothing.
    pub fn meeting_notes_plan(
        &self,
        include_notes: bool,
    ) -> Result<crate::meeting_notes::Plan, crate::meeting_notes::Refusal> {
        Ok(self.meeting_notes_input(include_notes)?.plan())
    }

    /// Multi-provider confirmation facts, with honest `None` cost fields for custom model IDs.
    pub fn meeting_notes_plan_view(
        &self,
        include_notes: bool,
    ) -> Result<crate::meeting_notes::PlanView, crate::meeting_notes::Refusal> {
        Ok(self.meeting_notes_input(include_notes)?.plan_view())
    }

    /// Marks this session's one notes request as being written and returns
    /// what to send, only if it is exactly what the confirmed plan
    /// (`fingerprint`) described. Call [`Self::abandon_meeting_notes`] if
    /// nothing is sent.
    pub fn begin_meeting_notes(
        &mut self,
        include_notes: bool,
        fingerprint: &str,
    ) -> Result<crate::meeting_notes::Prepared, crate::meeting_notes::Refusal> {
        let prepared = self.meeting_notes_input(include_notes)?;
        if prepared.fingerprint() != fingerprint {
            return Err(crate::meeting_notes::Refusal::Changed);
        }
        self.meeting_notes.begin(&prepared);
        self.state.meeting_notes = crate::meeting_notes::Phase::Writing;
        self.changed();
        Ok(prepared)
    }

    /// Stop waiting for this session's request in flight.
    pub fn cancel_meeting_notes(&mut self) {
        self.meeting_notes.cancel();
    }

    /// Nothing was sent (the key could not be used, or Stop waiting came
    /// first), so the request is still available.
    pub fn abandon_meeting_notes(&mut self, session: u64) {
        if self.session() == session
            && self.state.meeting_notes == crate::meeting_notes::Phase::Writing
        {
            self.meeting_notes.cancel();
            self.state.meeting_notes = crate::meeting_notes::Phase::None;
            self.changed();
        }
    }

    /// Records the sent request's outcome, unless a new session has begun.
    pub fn finish_meeting_notes(
        &mut self,
        session: u64,
        result: Result<crate::meeting_notes::Draft, crate::meeting_notes::Failure>,
        spent_micro_usd: Option<u64>,
    ) -> bool {
        self.finish_meeting_notes_for(
            session,
            crate::llm_provider::CueProvider::Anthropic,
            result,
            spent_micro_usd,
        )
    }

    pub fn finish_meeting_notes_for(
        &mut self,
        session: u64,
        provider: crate::llm_provider::CueProvider,
        result: Result<crate::meeting_notes::Draft, crate::meeting_notes::Failure>,
        spent_micro_usd: Option<u64>,
    ) -> bool {
        if self.session() != session
            || self.state.meeting_notes != crate::meeting_notes::Phase::Writing
        {
            return false;
        }
        self.state.meeting_notes = self
            .meeting_notes
            .finish_for(provider, result, spent_micro_usd);
        self.changed();
        true
    }

    pub fn meeting_notes(&self) -> &crate::meeting_notes::Record {
        &self.meeting_notes
    }

    /// Keeps the person's edited notes for the export.
    pub fn keep_meeting_notes(&mut self, markdown: &str) -> Result<(), String> {
        self.meeting_notes.keep(markdown)?;
        self.state.meeting_notes = crate::meeting_notes::Phase::Kept;
        self.changed();
        Ok(())
    }

    /// Drops the draft or the kept notes; the request is not offered again.
    pub fn discard_meeting_notes(&mut self) {
        use crate::meeting_notes::Phase;
        if matches!(self.state.meeting_notes, Phase::Draft | Phase::Kept) {
            self.meeting_notes.discard();
            self.state.meeting_notes = Phase::Discarded;
            self.changed();
        }
    }

    /// The export. By default it holds the person's notes and nothing else:
    /// no transcript, cue, name, focus line or imported note. When the person
    /// chose to keep the meeting, it also holds the cues this session showed
    /// from its conversation (not note reminders or the Still open list) and
    /// its transcript, with times from the start of the session and no
    /// speaker labels; a session with both sources labels each line by its
    /// source (You or Them), which is not who spoke. Never the name setting, focus lines, imported notes or
    /// audio; words people said aloud, names included, are in the transcript.
    pub fn markdown(&self) -> String {
        let mut out = format!("# TalkQTE notes\n\n{}\n", self.state.notes);
        // Model-written notes only when the person kept them, as edited.
        if let Some(kept) = self.meeting_notes.kept() {
            out.push_str(&format!("\n{kept}\n"));
        }
        if !self.state.keep_meeting {
            return out;
        }
        let clock = crate::meeting_notes::clock;
        // One line per entry: line breaks inside a line become spaces.
        let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
        out.push_str("\n## Cues shown\n\n");
        if self.shown_cues.is_empty() {
            out.push_str("None.\n");
        }
        for cue in &self.shown_cues {
            out.push_str(&format!(
                "- {} · {}: {}",
                clock(cue.at_ms),
                flat(&cue.kind),
                flat(&cue.question)
            ));
            if !cue.evidence.trim().is_empty() {
                out.push_str(&format!(" (from: \"{}\")", flat(&cue.evidence)));
            }
            out.push('\n');
        }
        out.push_str("\n## Transcript\n\n");
        if let Some(transcription) = &self.state.transcription {
            out.push_str(&format!(
                "Transcribed by {}. Speakers are not identified.\n\n",
                transcription.provider
            ));
        }
        let two = self
            .sources()
            .filter(|sources| sources.both_sources())
            .and_then(|sources| sources.application.as_deref());
        if let Some(application) = two {
            out.push_str(&format!(
                "{YOU} marks a line heard by this Mac's microphone and {THEM} a line from {}'s audio. They say where a line was heard, not who said it.\n\n",
                flat(application)
            ));
        }
        // Lines suppressed as a likely echo stay in the meeting, marked, unless
        // the person removed them; one they kept as theirs is ordinary.
        let echoes = self
            .state
            .sources
            .as_ref()
            .map_or(&[][..], |status| status.echoes.as_slice());
        if self.meeting_cut {
            out.push_str(&format!(
                "The start of this meeting is not included: a meeting keeps its last {MAX_MEETING_LINES} lines.\n\n"
            ));
        }
        let mut lines: Vec<(&Segment, Option<bool>)> = self
            .meeting
            .iter()
            .map(|line| (line, None))
            .chain(echoes.iter().map(|echo| (&echo.line, Some(echo.kept))))
            .collect();
        lines.sort_by_key(|(line, _)| line.at_ms);
        if lines.is_empty() {
            out.push_str("None.\n");
        }
        for (line, echo) in lines {
            let label = match (two, echo) {
                (Some(_), Some(false)) => format!(" {YOU} (likely an echo of {THEM}):"),
                (Some(_), _) if line.speaker == YOU || line.speaker == THEM => {
                    format!(" {}:", line.speaker)
                }
                _ => String::new(),
            };
            out.push_str(&format!(
                "- {}{} {}\n",
                clock(line.at_ms),
                label,
                flat(&line.text)
            ));
        }
        out
    }
}

fn suggest(text: &str) -> Vec<(&'static str, String)> {
    // Match complete words, not fragments such as "cannot" or "monsoon".
    // Keep apostrophes inside words so "can't" never becomes "can".
    let words: Vec<_> = text
        .split(|character: char| {
            !character.is_alphanumeric() && character != '\'' && character != '’'
        })
        .map(|word| word.trim_matches(['\'', '’']))
        .filter(|word| !word.is_empty())
        .collect();
    let is_word = |word: &str, expected: &str| word.eq_ignore_ascii_case(expected);
    // Every matching type, in priority order, so a suppressed repeat of one
    // type does not hide another in the same line.
    let mut found = Vec::new();
    if text.split(['.', '?', '!', ';']).any(|sentence| {
        let sentence_words: Vec<_> = sentence
            .split_whitespace()
            .map(|word| word.trim_matches(|character: char| !character.is_alphanumeric()))
            .collect();
        sentence_words.windows(2).enumerate().any(|(index, pair)| {
            is_word(pair[0], "someone")
                && ["can", "should", "could"]
                    .iter()
                    .any(|verb| is_word(pair[1], verb))
                && !says_what_people_notice(&sentence_words[index + 1..])
        })
    }) {
        found.push(("Owner", "Who will take the first draft?".into()));
    }
    if (0..words.len()).any(|index| is_word(words[index], "soon") && !farewell_soon(&words, index))
    {
        found.push(("Timing", "What date should we aim for?".into()));
    }
    if words
        .iter()
        .position(|word| is_word(word, "either"))
        .is_some_and(|index| words[index + 1..].iter().any(|word| is_word(word, "or")))
    {
        found.push((
            "Decision",
            "How will we choose between those options?".into(),
        ));
    }
    // An open question is raised only when no fixed question matched the
    // line, even a suppressed repeat, so it never re-asks a fixed one.
    if found.is_empty() {
        if let Some(question) = open_question(text) {
            found.push((OPEN, question));
        }
    }
    found
}

/// Whether the words from "can", "should", or "could" onwards, after
/// "someone", make a general remark instead of leaving a task open: "someone
/// can always tell when the bread is fresh", "someone should never have to
/// ask", "someone could see it from the road". That is "always" or "never"
/// next, or after "can" or "could" a verb of noticing. "Tell" counts only
/// before a clause ("tell when", "tell that"), so "someone can tell the
/// caterer" is still a task, and so is "someone could see to the booking".
fn says_what_people_notice(words: &[&str]) -> bool {
    let at = |index: usize| words.get(index).map(|word| word.to_lowercase());
    let next = at(1).unwrap_or_default();
    if matches!(next.as_str(), "always" | "never") {
        return true;
    }
    if at(0).as_deref() == Some("should") {
        return false;
    }
    let after = at(2).unwrap_or_default();
    match next.as_str() {
        "hear" | "notice" | "smell" | "feel" | "spot" => true,
        "see" => after != "to",
        "tell" => matches!(
            after.as_str(),
            "when" | "if" | "that" | "whether" | "by" | "from" | "how" | "what" | "why" | "where"
        ),
        _ => false,
    }
}

/// Whether the "soon" at `index` belongs to a goodbye or a good wish, which
/// sets no deadline: "see you all soon", "talk soon", "speak soon", "catch
/// up soon", "get well soon". "See" must be followed by "you", "y'all", or
/// "everyone" within the four words before "soon".
fn farewell_soon(words: &[&str], index: usize) -> bool {
    let before = |back: usize| {
        index
            .checked_sub(back)
            .map(|at| words[at].to_lowercase().replace('’', "'"))
            .unwrap_or_default()
    };
    if matches!(before(1).as_str(), "talk" | "speak" | "chat")
        || (before(2) == "catch" && before(1) == "up")
        || (before(2) == "get" && before(1) == "well")
    {
        return true;
    }
    (2..=4).any(|back| {
        before(back) == "see" && matches!(before(back - 1).as_str(), "you" | "y'all" | "everyone")
    })
}

/// The distinctive words of a note's title: alphabetic, at least
/// `TERM_MIN_CHARS` long, lowercased, without repeats.
fn note_terms(title: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for word in title
        .split(|character: char| !character.is_alphanumeric() && character != '\'')
        .map(|word| word.to_lowercase())
    {
        if word.chars().count() >= TERM_MIN_CHARS
            && word.chars().all(char::is_alphabetic)
            && !NOTE_STOP_WORDS.contains(&word.as_str())
            && !terms.contains(&word)
        {
            terms.push(word);
        }
    }
    terms
}

/// The cue kind for a question put to the group by a speaker.
pub const OPEN: &str = "Open question";

/// Returns an explicit question put to the group, such as "Does anyone have
/// time this week?" or "Any thoughts on the timeline?": a sentence that ends
/// with a question mark and opens, after a short lead-in, with one of a few
/// group-addressing phrases. Call logistics ("Can anyone hear me?", "Who can
/// see my screen?") are excluded by a short word list, and a question that
/// the same line goes on to answer is not raised. Questions put to one
/// person, questions in other words, and transcripts that drop the question
/// mark are missed. Text over 200 characters is cut with an ellipsis.
fn open_question(text: &str) -> Option<String> {
    const OPENERS: [&[&str]; 11] = [
        &["does", "anyone"],
        &["has", "anyone"],
        &["can", "anyone"],
        &["could", "anyone"],
        &["would", "anyone"],
        &["any", "thoughts"],
        &["any", "objections"],
        &["who", "can"],
        &["who", "could"],
        &["who", "wants"],
        &["who", "will"],
    ];
    const LEAD_INS: [&str; 7] = ["so", "ok", "okay", "alright", "and", "but", "well"];
    // Words that mark the question as about the call itself, not the work.
    const LOGISTICS: [&str; 14] = [
        "hear",
        "echo",
        "audio",
        "mic",
        "microphone",
        "screen",
        "camera",
        "video",
        "mute",
        "muted",
        "call",
        "coffee",
        "connection",
        "lag",
    ];
    let normal = |word: &str| {
        word.replace(['’', '‘'], "'")
            .trim_matches(|character: char| !character.is_alphanumeric() && character != '\'')
            .to_lowercase()
    };
    let mut end = 0;
    for sentence in text.split_inclusive(['.', '?', '!']) {
        end += sentence.len();
        let sentence = sentence.trim();
        if !sentence.ends_with('?') {
            continue;
        }
        let words: Vec<String> = sentence
            .split_whitespace()
            .map(normal)
            .filter(|word| !word.is_empty())
            .collect();
        let start = words
            .iter()
            .take_while(|word| LEAD_INS.contains(&word.as_str()))
            .count();
        let body = &words[start..];
        let opens = OPENERS.iter().any(|opener| {
            body.len() > opener.len()
                && body
                    .iter()
                    .zip(opener.iter())
                    .all(|(word, part)| word == part)
        });
        if !opens || body.iter().any(|word| LOGISTICS.contains(&word.as_str())) {
            continue;
        }
        // The rest of the line may already answer it: "Who can take it? I
        // will." A later question in the same line can still count.
        let rest = &text[end..];
        if ["Owner", "Timing", "Decision"]
            .iter()
            .any(|kind| resolves(kind, rest))
        {
            continue;
        }
        let quoted = sentence.trim_matches(['"', '“', '”', '‘', '’', '\'']);
        let count = quoted.chars().count();
        return Some(if count > 200 {
            let mut cut: String = quoted.chars().take(199).collect();
            cut.push('…');
            cut
        } else {
            quoted.to_string()
        });
    }
    None
}

/// The pause before a model's next cue after one ended without the user
/// dismissing it (expired, resolved, withdrawn), in Balanced and Focused.
const AFTER_UNREJECTED_MS: u64 = 3_000;
/// The same pause in Quiet, whose full cooldown is 30 seconds.
const AFTER_UNREJECTED_QUIET_MS: u64 = 10_000;

/// Letters, combining accents, and name punctuation, with at least one
/// letter, up to 40 characters: what Settings accepts as the user's name.
pub(crate) fn valid_user_name(name: &str) -> bool {
    name.chars().count() <= 40
        && name.chars().any(char::is_alphabetic)
        && name.chars().all(|character| {
            character.is_alphabetic()
                || ('\u{0300}'..='\u{036F}').contains(&character)
                || " '-’".contains(character)
        })
}

/// How long after a line ending on the user's name a following line may
/// carry the question to them.
const NAME_CARRY_MS: u64 = 6_000;

/// The unfinished end of a line, when it ends on the user's name: "Maddie,"
/// in "Partners doubles it. Maddie,". Only text after the line's last
/// sentence end counts, and it must end with the whole name.
fn trailing_address(name: &str, text: &str) -> Option<String> {
    let tail = text
        .rsplit_once(['.', '?', '!'])
        .map_or(text, |(_, tail)| tail)
        .trim();
    let words = |part: &str| -> Vec<String> {
        part.split_whitespace()
            .map(|word| {
                word.trim_matches(|character: char| !character.is_alphanumeric())
                    .to_lowercase()
            })
            .filter(|word| !word.is_empty())
            .collect()
    };
    let (tail_words, name_words) = (words(tail), words(name));
    (!name_words.is_empty() && tail_words.ends_with(&name_words)).then(|| tail.to_string())
}

/// The cue kind for a question addressed to the user by name.
pub const ASKED: &str = "Asked you";

/// Returns the question when a line asks it of `name` directly: the name
/// opens the sentence ("Robin, can you take the draft?") or closes it
/// ("What do you think, Robin?"). A question naming someone else, or no one,
/// returns None, as does a statement.
fn asked_of(name: &str, text: &str) -> Option<String> {
    // Greetings people say before a name ("Hey Robin, ...").
    const LEAD_INS: [&str; 6] = ["hey", "hi", "so", "ok", "okay", "alright"];
    let normal = |word: &str| {
        word.replace(['’', '‘'], "'")
            .trim_matches(|character: char| !character.is_alphanumeric() && character != '\'')
            .to_lowercase()
    };
    let words_of = |part: &str| -> Vec<String> {
        part.split_whitespace()
            .map(normal)
            .filter(|word| !word.is_empty())
            .collect()
    };
    let name = words_of(name);
    text.split_inclusive(['.', '?', '!'])
        .map(str::trim)
        .find(|sentence| {
            // A comma or a dash sets the name off from the question.
            let body = sentence
                .replace(" — ", ", ")
                .replace(" – ", ", ")
                .replace(" - ", ", ");
            let ends_with_mark = body.trim_end().ends_with('?');
            // "What a great job" is an exclamation, not a question.
            let opens_question = |words: &[String]| {
                words
                    .first()
                    .is_some_and(|word| QUESTION_OPENERS.contains(&word.as_str()))
                    && !(words.first().is_some_and(|word| word == "what")
                        && words.get(1).is_some_and(|word| word == "a" || word == "an"))
            };
            // Words that ask something of the person just named: a question
            // word ("how many", "what's"), not "what a", or an opener put to
            // them ("can you", "did your").
            // "Didn't you run the booth?", "Won't you join us?"
            const NEGATIVE_OPENERS: [&str; 12] = [
                "didn't",
                "don't",
                "doesn't",
                "can't",
                "couldn't",
                "won't",
                "wouldn't",
                "shouldn't",
                "aren't",
                "isn't",
                "wasn't",
                "weren't",
            ];
            let asks = |words: &[String]| match words {
                [first, second, ..] if first == "what" && (second == "a" || second == "an") => {
                    false
                }
                [first, ..] if WH_WORDS.contains(&first.as_str()) => true,
                [first, second, ..] => {
                    (QUESTION_OPENERS.contains(&first.as_str())
                        || NEGATIVE_OPENERS.contains(&first.as_str()))
                        && (second == "you" || second == "your")
                }
                _ => false,
            };
            // "Robin, can you take the draft?", "Hey Robin, could you ...",
            // or the name set off by commas later in the sentence ("Partners
            // doubles it, Robin, how many came?"). Later in the sentence, the
            // words after the name must also ask something of them: a "?" alone
            // would also take in "Did you invite Alex, Robin, and Sam?" or
            // "Our treasurer, Robin, will send the figures."
            let parts: Vec<&str> = body.split(',').collect();
            let opens = (0..parts.len().saturating_sub(1)).any(|at| {
                let head = words_of(parts[at]);
                let start = head
                    .iter()
                    .take_while(|word| LEAD_INS.contains(&word.as_str()))
                    .count();
                let rest = words_of(&parts[at + 1..].join(","));
                // "Could you, Robin, field the complaints?": the asking words
                // come just before the name.
                let asked_before = || {
                    let before = words_of(parts[at - 1]);
                    before.len() >= 2 && asks(&before[before.len() - 2..])
                };
                head[start..] == name[..]
                    && if at == 0 {
                        ends_with_mark || opens_question(&rest)
                    } else {
                        // And end with "?": "I spoke to Robin, Maya, who said
                        // it's fine." is a relative clause, not a question.
                        // An opening question can name its object before
                        // an embedded WH clause: "Did you meet the lead,
                        // Maya, who starts Monday?" Prefer quiet for this
                        // ambiguous shape unless "could you" immediately
                        // before the name makes the address explicit.
                        let before = words_of(&parts[..at].join(","));
                        ends_with_mark
                            && (asked_before()
                                || (asks(&rest) && !opens_question(&before) && !asks(&before)))
                    }
            });
            // No comma: "Robin how many came?" or "So Robin, can you…" said
            // without the pause. Only at the start of a question that asks
            // something ("how", "what", …) or asks you to ("can you"), so
            // "Robin can take it?" or "Maybe Robin takes it." do not count.
            let bare = {
                let words = words_of(&body);
                let start = words
                    .iter()
                    .take_while(|word| LEAD_INS.contains(&word.as_str()))
                    .count();
                let after = start + name.len();
                ends_with_mark
                    && words.get(start..after) == Some(&name[..])
                    && asks(words.get(after..).unwrap_or_default())
            };
            // "What do you think, Robin?" or "Can you take it, Robin".
            let closes = body
                .trim_end_matches(['?', '.', '!'])
                .rsplit_once(',')
                .is_some_and(|(rest, tail)| {
                    words_of(tail) == name && (ends_with_mark || opens_question(&words_of(rest)))
                });
            !name.is_empty() && (opens || closes || bare)
        })
        .map(|sentence| {
            sentence
                .trim_matches(['"', '“', '”', '‘', '’', '\''])
                .chars()
                .take(200)
                .collect()
        })
}

/// The line without sentences that put a question to another named person:
/// "Alex, can you take the first draft?" or "Who will take it, Alex?". Used
/// only once the user's name is known. A name is one capitalized word set off
/// by a comma; common openers, time words, months, and words for a group that
/// includes the user ("Everyone,") do not count, and neither does any word
/// that could be the user ("Sam" or "Sammy" for "Sam Lee"). This matches on
/// capital letters, so some matches will be wrong ("Budget, someone can…?");
/// missing a name is the safe direction, leaving the line treated as before.
fn text_not_put_to_others(user_name: &str, text: &str) -> String {
    text.split_inclusive(['.', '?', '!'])
        .filter(|sentence| !asked_of_someone(user_name, sentence.trim()))
        .collect()
}

fn asked_of_someone(user_name: &str, sentence: &str) -> bool {
    let user_words: Vec<String> = user_name
        .split_whitespace()
        .map(|word| word.to_lowercase())
        .collect();
    // A first name, surname, or a nickname built on either may be the user.
    let could_be_user = |word: &str| {
        let word = word.to_lowercase();
        user_words
            .iter()
            .any(|own| own.starts_with(&word) || word.starts_with(own.as_str()))
    };
    const NOT_NAMES: &[&str] = &[
        // Openers and fillers.
        "hey",
        "hi",
        "hello",
        "so",
        "ok",
        "okay",
        "alright",
        "well",
        "now",
        "right",
        "yes",
        "yeah",
        "no",
        "and",
        "but",
        "also",
        "then",
        "great",
        "sure",
        "thanks",
        "please",
        "look",
        "listen",
        "actually",
        "sorry",
        "honestly",
        "anyway",
        "anyways",
        "basically",
        "wait",
        "oh",
        "um",
        "uh",
        "hmm",
        "cool",
        "fine",
        "good",
        "perfect",
        "otherwise",
        "besides",
        "plus",
        "still",
        "first",
        "second",
        "finally",
        "really",
        "seriously",
        "personally",
        "realistically",
        "fyi",
        "btw",
        "agreed",
        "true",
        "exactly",
        "i",
        "you",
        // Groups that include the user.
        "everyone",
        "everybody",
        "folks",
        "guys",
        "team",
        "all",
        "people",
        "both",
        // Days.
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "today",
        "tomorrow",
        "tonight",
        "yesterday",
        "later",
        "next",
        "lastly",
        "meanwhile",
        "hopefully",
        "ideally",
        "absolutely",
        "however",
        "obviously",
        "definitely",
        "quick",
        "nice",
        "ah",
        "er",
        "y'all",
    ];
    const MONTHS: &[&str] = &[
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    const LEAD_INS: &[&str] = &["hey", "hi", "hello"];
    let clean = |word: &str| {
        word.trim_matches(|character: char| !character.is_alphanumeric() && character != '\'')
            .to_string()
    };
    // Exactly one capitalized word that is not a common opener, after an
    // optional greeting.
    let names_someone = |part: &str| {
        let words: Vec<String> = part
            .split_whitespace()
            .map(clean)
            .filter(|word| !word.is_empty())
            .collect();
        let start = words
            .iter()
            .take_while(|word| LEAD_INS.contains(&word.to_lowercase().as_str()))
            .count();
        let rest = &words[start..];
        rest.len() == 1
            && rest[0].chars().next().is_some_and(char::is_uppercase)
            && rest[0]
                .chars()
                .all(|character| character.is_alphabetic() || character == '\'')
            && !NOT_NAMES.contains(&rest[0].to_lowercase().as_str())
            && !MONTHS.contains(&rest[0].to_lowercase().as_str())
            && !could_be_user(&rest[0])
    };
    let words_of = |part: &str| -> Vec<String> {
        part.split_whitespace()
            .map(|word| clean(word).to_lowercase())
            .filter(|word| !word.is_empty())
            .collect()
    };
    // "What a relief" is an exclamation, not a question.
    let opens_question = |part: &str| {
        let words = words_of(part);
        words
            .first()
            .is_some_and(|word| QUESTION_OPENERS.contains(&word.as_str()))
            && !(words.first().is_some_and(|word| word == "what")
                && words.get(1).is_some_and(|word| word == "a" || word == "an"))
    };
    let question = sentence.trim_end().ends_with('?');
    let opens = sentence.split_once(',').is_some_and(|(head, rest)| {
        names_someone(head) && !rest.trim().is_empty() && (question || opens_question(rest))
    });
    let closes = question
        && sentence
            .trim_end_matches(['?', '.', '!'])
            .rsplit_once(',')
            .is_some_and(|(rest, tail)| names_someone(tail) && opens_question(rest));
    opens || closes
}

/// Words that make a statement negative; such statements never answer a
/// cue or change the topic.
const NEGATIONS: [&str; 10] = [
    "not", "never", "no", "nobody", "nothing", "none", "neither", "nor", "cannot", "wont",
];

/// Question words that ask for something on their own.
const WH_WORDS: [&str; 13] = [
    "what", "who", "when", "which", "how", "why", "where", "what's", "who's", "when's", "how's",
    "why's", "where's",
];

/// Transcripts often drop "?", so a sentence that opens like a question
/// does not count as an answer or a topic change.
const QUESTION_OPENERS: [&str; 20] = [
    "should", "shall", "can", "could", "will", "would", "do", "does", "did", "is", "are", "was",
    "were", "what", "who", "when", "which", "how", "why", "where",
];

/// Hedged statements do not count as answers.
const HEDGES: [&str; 5] = ["maybe", "perhaps", "might", "probably", "possibly"];

/// Whether a sentence, given as lowercase words, opens by putting its subject
/// off to a later occasion: "Let's leave the cover choice for another
/// meeting", "We'll park that until next week", "Let's come back to that
/// later", "Let's push it to next month", "We'll pick that up at the
/// committee meeting next month". It needs all of these in order: an
/// opening ("let's", "we'll", "we can", "we will"), a putting-off verb,
/// one to four words for what is put off, and where it goes, which must end
/// the sentence. "Let's leave the door open", "Let's table the proposal",
/// and "Let's leave later" lack one of them and do not count; neither does
/// one that keeps something open or sets time aside. A clause joined by
/// "and" that starts with another such verb ("…, and come back to it in
/// September") is read with the same opening. Returns the words for what is
/// put off ("the cover choice", "that"); `deferred_subject` decides whether
/// they are about the question on screen.
fn defers(words: &[String]) -> Option<Vec<String>> {
    const OPENINGS: [&[&str]; 4] = [&["let's"], &["we'll"], &["we", "can"], &["we", "will"]];
    // Verbs that need an occasion after them to mean putting something off,
    // with an optional word that follows what is put off ("pick that up").
    const VERBS: [(&[&str], Option<&str>); 12] = [
        (&["leave"], None),
        (&["park"], None),
        (&["save"], None),
        (&["table"], None),
        (&["defer"], None),
        (&["postpone"], None),
        (&["push"], None),
        (&["move"], None),
        (&["hold", "off", "on"], None),
        (&["put", "off"], None),
        (&["put"], Some("off")),
        (&["pick", "up"], None),
    ];
    // "Pick that up" also means collecting something, so it counts only
    // with an occasion that names a meeting, a time, or "later".
    const PICK: (&[&str], Option<&str>) = (&["pick"], Some("up"));
    // Verbs for returning to something, which may also end in a bare "later".
    const RETURNS: [(&[&str], Option<&str>); 2] =
        [(&["revisit"], None), (&["come", "back", "to"], None)];
    const OCCASIONS: [&[&str]; 13] = [
        &["for", "another", "meeting"],
        &["for", "another", "time"],
        &["for", "another", "day"],
        &["for", "later"],
        &["for", "next", "time"],
        &["for", "next", "week"],
        &["for", "the", "next", "meeting"],
        &["until", "later"],
        &["until", "next", "time"],
        &["until", "next", "week"],
        &["until", "the", "next", "meeting"],
        &["in", "another", "meeting"],
        &["at", "the", "next", "meeting"],
    ];
    // A short phrase after one of these, ending in one of the words below,
    // is an occasion as well: "at the committee meeting next month", "to
    // next week", "in September".
    const OCCASION_STARTS: [&str; 6] = ["at", "for", "in", "until", "till", "to"];
    const OCCASION_ENDS: [&str; 18] = [
        "meeting",
        "later",
        "week",
        "month",
        "time",
        "year",
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    // Waiting for something to happen first: "until we've seen the
    // weather", "until after the fair".
    const CONDITIONS: [&str; 6] = ["we", "we've", "we're", "we'll", "after", "they've"];
    // Without a word in front: "Let's park that next month".
    const BARE: [&[&str]; 4] = [
        &["next", "time"],
        &["next", "week"],
        &["next", "month"],
        &["another", "time"],
    ];
    // Words that make the part between verb and occasion more than the
    // thing put off: a second clause ("… and leave the budget for later"),
    // keeping something open ("leave the vote open until next week"), or
    // setting time aside ("save some time for later").
    const NOT_PUT_OFF: [&str; 16] = [
        "and", "but", "or", "so", "because", "before", "after", "when", "if", "while", "open",
        "time", "minutes", "room", "space", "who",
    ];
    let starts = |words: &[String], phrase: &[&str]| {
        words.len() >= phrase.len() && words.iter().zip(phrase).all(|(word, part)| word == part)
    };
    let is_occasion = |tail: &[String], returning: bool| {
        OCCASIONS.iter().any(|occasion| tail == *occasion)
            || BARE.iter().any(|occasion| tail == *occasion)
            || (returning && tail == ["later"])
            || (tail.len() >= 2
                && tail.len() <= 6
                && OCCASION_STARTS.contains(&tail[0].as_str())
                && OCCASION_ENDS.contains(&tail[tail.len() - 1].as_str()))
            || (tail.len() >= 3
                && matches!(tail[0].as_str(), "until" | "till")
                && CONDITIONS.contains(&tail[1].as_str()))
    };
    let opening = OPENINGS.iter().find(|opening| starts(words, opening))?;
    let after_opening = &words[opening.len()..];
    // The clause after the opening, and any later clause joined by "and"
    // that opens with a putting-off verb of its own.
    let opens_with_verb = |clause: &[String]| {
        VERBS
            .iter()
            .chain(RETURNS.iter())
            .chain(std::iter::once(&PICK))
            .any(|(verb, _)| starts(clause, verb))
    };
    let mut clauses: Vec<&[String]> = vec![];
    let mut from = 0;
    for (index, word) in after_opening.iter().enumerate() {
        if word == "and" && opens_with_verb(&after_opening[index + 1..]) {
            clauses.push(&after_opening[from..index]);
            from = index + 1;
        }
    }
    clauses.push(&after_opening[from..]);
    let put_off = |clause: &[String],
                   verbs: &[(&[&str], Option<&str>)],
                   returning: bool,
                   needs_meeting: bool| {
        verbs.iter().find_map(|(verb, particle)| {
            if !starts(clause, verb) {
                return None;
            }
            (verb.len() + 1..=verb.len() + 4).find_map(|end| {
                let object = clause.get(verb.len()..end)?;
                let tail_start = match particle {
                    Some(particle) => (clause.get(end)? == particle).then_some(end + 1)?,
                    None => end,
                };
                let tail = &clause[tail_start..];
                (is_occasion(tail, returning)
                    && (!needs_meeting
                        || tail
                            .iter()
                            .any(|word| matches!(word.as_str(), "meeting" | "time" | "later")))
                    && !object
                        .iter()
                        .any(|word| NOT_PUT_OFF.contains(&word.as_str())))
                .then(|| object.to_vec())
            })
        })
    };
    clauses.iter().find_map(|clause| {
        put_off(clause, &VERBS, false, false)
            .or_else(|| put_off(clause, &RETURNS, true, false))
            .or_else(|| put_off(clause, &[PICK], false, true))
    })
}

/// Whether a sentence declines to discuss what was just said: "Let's not
/// get into that tonight", "Let's not go into it now". Only "that", "it",
/// or "this", optionally followed by a word for now, so "Let's not get into
/// the budget" and "Let's not get into trouble" do not count. A negation
/// rules out every other deferral; this phrase is the one exception.
fn declines_to_discuss(text: &str) -> bool {
    const LEAD_INS: [&str; 7] = ["ok", "okay", "alright", "right", "so", "well", "anyway"];
    const NOW: [&[&str]; 7] = [
        &[],
        &["now"],
        &["right", "now"],
        &["today"],
        &["tonight"],
        &["here"],
        &["yet"],
    ];
    text.split_inclusive(['.', '?', '!', ';'])
        .filter(|sentence| !sentence.trim_end().ends_with('?'))
        .any(|sentence| {
            let words: Vec<String> = sentence
                .split_whitespace()
                .map(|word| {
                    word.replace(['’', '‘'], "'")
                        .trim_matches(|character: char| {
                            !character.is_alphanumeric() && character != '\''
                        })
                        .to_lowercase()
                })
                .filter(|word| !word.is_empty())
                .collect();
            let start = words
                .iter()
                .take_while(|word| LEAD_INS.contains(&word.as_str()))
                .count();
            let words = &words[start..];
            words.len() >= 5
                && words[0] == "let's"
                && words[1] == "not"
                && matches!(words[2].as_str(), "get" | "go")
                && words[3] == "into"
                && matches!(words[4].as_str(), "that" | "it" | "this")
                && NOW.iter().any(|now| words[5..] == **now)
        })
}

/// The statements of a line as lowercase words, without the short words
/// people say first ("OK", "so", "anyway"). Sentences that end with or open
/// like a question, or contain a negation or hedge, are left out.
fn plain_statements(text: &str) -> Vec<Vec<String>> {
    // Short words people say before changing topic.
    const LEAD_INS: [&str; 7] = ["ok", "okay", "alright", "right", "so", "great", "anyway"];
    text.split_inclusive(['.', '?', '!', ';'])
        .filter(|sentence| !sentence.trim_end().ends_with('?'))
        .filter_map(|sentence| {
            let words: Vec<String> = sentence
                .split_whitespace()
                .map(|word| {
                    word.replace(['’', '‘'], "'")
                        .trim_matches(|character: char| {
                            !character.is_alphanumeric() && character != '\''
                        })
                        .to_lowercase()
                })
                .filter(|word| !word.is_empty())
                .collect();
            let start = words
                .iter()
                .take_while(|word| LEAD_INS.contains(&word.as_str()))
                .count();
            let words = words[start..].to_vec();
            let excluded = words
                .first()
                .is_none_or(|first| QUESTION_OPENERS.contains(&first.as_str()))
                || words.iter().any(|word| {
                    NEGATIONS.contains(&word.as_str())
                        || word.ends_with("n't")
                        || HEDGES.contains(&word.as_str())
                });
            (!excluded).then_some(words)
        })
        .collect()
}

/// Whether a line puts off the subject of a question raised from `source`:
/// a sentence that `defers` something, where what is put off is "that",
/// "it", or "this", or shares a distinctive word (five letters or more, not
/// a common meeting word) with the source line. "Let's leave the poster
/// design for another meeting" says nothing about a question raised from
/// "Someone should write the welcome letter", so that question stays. This
/// is a word match: a short or differently worded subject ("the rota",
/// "the covers" for "cover") is missed, which leaves the question in place.
fn deferred_subject(text: &str, source: &str) -> bool {
    // Words about the conversation itself, which say nothing about a subject.
    const GENERIC: [&str; 8] = [
        "someone", "somebody", "anyone", "everyone", "question", "matter", "whole", "entire",
    ];
    let source_terms: Vec<String> = note_terms(source)
        .into_iter()
        .filter(|term| !GENERIC.contains(&term.as_str()))
        .collect();
    declines_to_discuss(text)
        || plain_statements(text).iter().any(|words| {
            defers(words).is_some_and(|object| {
                object.iter().any(|word| {
                    matches!(word.as_str(), "that" | "it" | "this") || source_terms.contains(word)
                })
            })
        })
}

/// An explicit statement, at the start of a sentence, that the conversation
/// is moving to another topic: "Moving on, ...", "OK, next item.", "Let's
/// move on to ...", "On another note, ...". Phrases inside a sentence
/// ("Before we move on, ...", "The trucks are moving on Tuesday") do not
/// count, nor do questions, negations, or hedges. Putting the question's
/// own subject off to a later occasion is handled by `deferred_subject`.
fn topic_shift(text: &str) -> bool {
    const OPENINGS: [&[&str]; 9] = [
        &["moving", "on"],
        &["let's", "move", "on"],
        &["next", "item"],
        &["next", "topic"],
        &["on", "another", "note"],
        &["on", "a", "different", "note"],
        &["switching", "topics"],
        &["changing", "topics"],
        &["new", "topic"],
    ];
    plain_statements(text).iter().any(|words| {
        // Moving to the next slide or page continues the same topic.
        let presentation = words.windows(2).any(|pair| {
            pair[0] == "next" && matches!(pair[1].as_str(), "slide" | "page" | "screen")
        });
        !presentation
            && OPENINGS.iter().any(|opening| {
                words.starts_with(&opening.iter().map(|w| w.to_string()).collect::<Vec<_>>())
            })
    })
}

/// How soon after a line a correction can take it back.
const CORRECTION_MS: u64 = 10_000;

/// Finds an explicit correction that opens a statement and stands as its own
/// clause: "Sorry, I misspoke.", "Scratch that, …", "Correction: …",
/// "Never mind — …". Returns the byte offset just after the correction phrase
/// and its punctuation, so what follows can still be heard. A bare
/// "Actually", a question, or a phrase that runs on into the sentence
/// ("Never mind the cost", "Correction fluid") does not count.
fn corrects(text: &str) -> Option<usize> {
    const PHRASES: [&[&str]; 6] = [
        &["i", "misspoke"],
        &["scratch", "that"],
        &["correction"],
        &["i", "take", "that", "back"],
        &["never", "mind"],
        &["let", "me", "correct", "that"],
    ];
    // Words said before a correction.
    const LEAD_INS: [&str; 6] = ["sorry", "oh", "wait", "actually", "no", "um"];
    const DASHES: [&str; 3] = ["—", "–", "-"];
    let mut sentence_start = 0;
    for sentence in text.split_inclusive(['.', '?', '!', ';']) {
        let offset = sentence_start;
        sentence_start += sentence.len();
        if sentence.trim_end().ends_with('?') {
            continue;
        }
        // Tokens with their byte ranges; a lone dash is punctuation, not a word.
        let mut tokens: Vec<(usize, usize, &str)> = vec![];
        let mut cursor = 0;
        for token in sentence.split_whitespace() {
            let at = cursor + sentence[cursor..].find(token).unwrap_or(0);
            cursor = at + token.len();
            tokens.push((at, cursor, token));
        }
        let normal = |token: &str| {
            token
                .replace(['’', '‘'], "'")
                .trim_matches(|character: char| !character.is_alphanumeric() && character != '\'')
                .to_lowercase()
        };
        let words: Vec<(usize, String)> = tokens
            .iter()
            .enumerate()
            .map(|(index, (_, _, token))| (index, normal(token)))
            .filter(|(_, word)| !word.is_empty())
            .collect();
        let start = words
            .iter()
            .take_while(|(_, word)| LEAD_INS.contains(&word.as_str()))
            .count();
        for phrase in PHRASES {
            let last = start + phrase.len() - 1;
            if words.len() <= last
                || !words[start..=last]
                    .iter()
                    .zip(phrase.iter())
                    .all(|((_, word), part)| word == part)
            {
                continue;
            }
            let token = words[last].0;
            let raw = tokens[token].2.trim_end_matches(['"', '”', '’']);
            let next_is_dash = tokens
                .get(token + 1)
                .is_some_and(|(_, _, next)| DASHES.contains(next));
            let closes = if phrase == ["correction"] {
                raw.ends_with([':', ','])
            } else {
                token + 1 == tokens.len()
                    || next_is_dash
                    || raw.ends_with([',', '.', ':', ';', '!', '—'])
            };
            if closes {
                let end = if next_is_dash {
                    tokens[token + 1].1
                } else {
                    tokens[token].1
                };
                return Some(offset + end);
            }
        }
    }
    None
}

/// Conservative signs that later conversation answered an open cue.
/// A missed answer only leaves a question up until it expires; a false match
/// pulls away a useful one. So anything that reads as a question, a hedge, or
/// a negation never counts, and only "I" or a capitalized name can be an owner.
fn resolves(kind: &str, text: &str) -> bool {
    // An open question is answered by any recognized owner, date, or choice.
    // Only the narrow volunteer verbs count for it: "I'll send it" answers
    // "Who will send it?", but an open question about anything should not
    // vanish because someone said they would send an unrelated thing.
    if kind == OPEN {
        return resolves_with("Owner", text, &CORE_TASKS)
            || ["Timing", "Decision"]
                .iter()
                .any(|fixed| resolves(fixed, text));
    }
    resolves_with(kind, text, &TASKS)
}

/// Short words a volunteer may say before "Leave it with me".
const VOLUNTEER_LEAD_INS: [&str; 13] = [
    "oh", "ok", "okay", "right", "yes", "yeah", "sure", "fine", "look", "well", "so", "just",
    "honestly",
];

/// The verbs a volunteer uses to take a task on: "I'll take it".
const CORE_TASKS: [&str; 6] = ["take", "draft", "write", "handle", "own", "lead"];
/// Those, plus verbs for sending, sorting, and booking: "I'll send it",
/// "Maya can sort that". Not "do", "check", or "look", which say as much
/// about calendars and availability as about ownership.
const TASKS: [&str; 9] = [
    "take", "draft", "write", "handle", "own", "lead", "send", "sort", "book",
];

fn resolves_with(kind: &str, text: &str, tasks: &[&str]) -> bool {
    const WEEKDAYS: [&str; 7] = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ];
    const MONTHS: [&str; 12] = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    // Transcripts often drop "?", so a sentence that opens like a question
    // or is hedged does not count either.
    // Capitalized words that do not name a person.
    const NOT_OWNERS: [&str; 29] = [
        "it",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "tomorrow",
        "today",
        "either",
        "both",
        "one",
        "everything",
        "that",
        "this",
        "we",
        "they",
        "you",
        "he",
        "she",
        "what",
        "which",
        "who",
        "someone",
        "somebody",
        "anyone",
        "everybody",
        "everyone",
    ];
    text.split_inclusive(['.', '?', '!', ';'])
        .filter(|sentence| !sentence.trim_end().ends_with('?'))
        .any(|sentence| {
            // (lowercase word, written with a capital letter)
            let mut words: Vec<(String, bool)> = Vec::new();
            for raw in sentence.split_whitespace() {
                let raw = raw
                    .replace(['’', '‘'], "'")
                    .trim_matches(|character: char| {
                        !character.is_alphanumeric() && character != '\''
                    })
                    .trim_matches('\'')
                    .to_string();
                let capital = raw.chars().next().is_some_and(char::is_uppercase);
                let word = raw.to_lowercase();
                // "I'll take" reads as "I will take".
                match word.strip_suffix("'ll") {
                    Some(subject) if !subject.is_empty() => {
                        words.push((subject.into(), capital));
                        words.push(("will".into(), false));
                    }
                    _ if !word.is_empty() => words.push((word, capital)),
                    _ => {}
                }
            }
            if words.is_empty()
                || QUESTION_OPENERS.contains(&words[0].0.as_str())
                || words.iter().any(|(word, _)| {
                    NEGATIONS.contains(&word.as_str())
                        || word.ends_with("n't")
                        || HEDGES.contains(&word.as_str())
                })
            {
                return false;
            }
            let at = |index: usize| {
                words
                    .get(index)
                    .map(|(word, _)| word.as_str())
                    .unwrap_or("")
            };
            // Where the sentence starts after short words such as "Oh" or
            // "Just".
            let opens = words
                .iter()
                .take_while(|(word, _)| VOLUNTEER_LEAD_INS.contains(&word.as_str()))
                .count();
            // "Leave that with me", "Leave the compost with me": the speaker
            // takes it on without a task verb. It must open the sentence,
            // with one to four words between "leave" and "with me", so
            // "Leave with me after the meeting" and "They left it with me"
            // do not count, and nor does "Leave it with Maya", which hands
            // the task to someone who has not said yes.
            let leave_it_with_me = at(opens) == "leave"
                && (opens + 2..=opens + 5).any(|with| at(with) == "with" && at(with + 1) == "me");
            (0..words.len()).any(|index| match kind {
                "Owner" => {
                    let (subject, capital) = &words[index];
                    (index == opens && leave_it_with_me)
                        || (matches!(at(index + 1), "will" | "can")
                            && tasks.contains(&at(index + 2))
                            && (subject == "i"
                                || (*capital
                                    && subject.chars().all(char::is_alphabetic)
                                    && !NOT_OWNERS.contains(&subject.as_str()))))
                }
                "Timing" => {
                    at(index) == "tomorrow"
                        || (matches!(at(index), "by" | "before" | "until")
                            && (WEEKDAYS.contains(&at(index + 1))
                                || MONTHS.contains(&at(index + 1))))
                }
                "Decision" => {
                    // "Let's go with the sign", not "I'll go with you".
                    (at(index) == "go"
                        && at(index + 1) == "with"
                        && !matches!(at(index + 2), "you" | "me" | "us" | "them" | "him" | "her"))
                        || at(index) == "decided"
                        || at(index) == "chose"
                }
                _ => false,
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cloud_transcription_stop_is_kept_once_for_its_own_session_only() {
        let mut engine = Engine::live();
        engine.start().unwrap();
        // Test builds never select cloud transcription from the environment.
        assert_eq!(engine.state.transcription, None);
        engine.state.transcription = Some(CloudTranscription {
            provider: "Deepgram".into(),
            stopped: None,
            dropped_audio: false,
            reconnects: 0,
            lost_ms: 0,
            minutes_left: None,
        });
        let session = engine.session();
        engine.cloud_transcription_stopped(session + 1, "network");
        assert_eq!(engine.state.transcription.as_ref().unwrap().stopped, None);
        let revision = engine.state.revision;
        engine.cloud_transcription_stopped(session, "withdrawn");
        engine.cloud_transcription_stopped(session, "network");
        let shown = serde_json::to_value(engine.cue_snapshot()).unwrap();
        assert_eq!(shown["transcription"]["provider"], "Deepgram");
        assert_eq!(shown["transcription"]["stopped"], "withdrawn");
        // A reconnect is counted with the speech it lost; a later session's
        // is ignored.
        engine.cloud_transcription_reconnected(session + 1, 900);
        engine.cloud_transcription_reconnected(session, 2_400);
        let shown = serde_json::to_value(engine.cue_snapshot()).unwrap();
        assert_eq!(shown["transcription"]["reconnects"], 1);
        assert_eq!(shown["transcription"]["lostMs"], 2_400);
        assert_eq!(engine.state.revision, revision + 2);
    }

    fn with_cue() -> Engine {
        let mut engine = Engine::fictional();
        engine.start().unwrap();
        engine.advance(8_000);
        engine
    }

    fn play_statement(text: &str) -> Engine {
        let mut engine = Engine::fictional();
        engine.script.segments = vec![Segment {
            id: "example".into(),
            at_ms: 1_000,
            speaker: "Robin".into(),
            text: text.into(),
        }];
        engine.start().unwrap();
        engine.advance(1_000);
        engine
    }

    fn play(lines: &[(u64, &str)]) -> Engine {
        let mut engine = Engine::fictional();
        // Custom scenarios own their length, independently of the fixture.
        engine.script.duration_ms = lines.last().map_or(600_000, |(at, _)| at + 600_000);
        engine.script.segments = lines
            .iter()
            .enumerate()
            .map(|(index, (at_ms, text))| Segment {
                id: format!("t{}", index + 1),
                at_ms: *at_ms,
                speaker: if index % 2 == 0 { "Robin" } else { "Alex" }.into(),
                text: (*text).into(),
            })
            .collect();
        engine.start().unwrap();
        engine
    }

    fn live(id: &str, at_ms: u64, text: &str) -> Segment {
        Segment {
            id: id.into(),
            at_ms,
            speaker: "Speaker 1".into(),
            text: text.into(),
        }
    }

    fn live_session() -> Engine {
        let mut engine = play(&[]);
        engine.script.duration_ms = 600_000;
        engine.advance(10_000);
        engine
    }

    #[test]
    fn live_cue_pause_clears_even_a_held_cue_without_freezing_input() {
        for held in [false, true] {
            let mut e = Engine::live();
            e.start().unwrap();
            e.advance(1_000);
            let session = e.session();
            e.ingest(
                session,
                live("first", 1_000, "Someone should send the checklist."),
            )
            .unwrap();
            let cue_id = e.state.cue.as_ref().unwrap().id.clone();
            if held {
                e.inspect_cue(&cue_id).unwrap();
            }
            e.state.notes = "A manually written note.".into();
            e.set_focus(vec!["Settle the volunteer schedule".into()])
                .unwrap();
            e.set_user_name(Some("Robin".into())).unwrap();
            e.set_live_cues_paused(true).unwrap();
            assert_eq!(e.state.status, Status::Running);
            assert_eq!(e.session(), session);
            assert!(e.state.cues_paused && e.cue_snapshot().cues_paused);
            assert!(e.state.cue.is_none() && e.cue_snapshot().cue.is_none());
            assert!(e.inspect_cue(&cue_id).is_err());
            for (i, text) in [
                "Someone could send it soon.",
                "Robin, who will check the garden?",
                "I will send the checklist by Friday.",
                "The volunteer schedule is settled.",
            ]
            .iter()
            .enumerate()
            {
                e.advance(1_000);
                e.ingest(
                    session,
                    live(&format!("during-{i}"), e.state.elapsed_ms, text),
                )
                .unwrap();
                assert!(e.state.cue.is_none());
            }
            assert_eq!(e.state.elapsed_ms, 5_000);
            assert_eq!(e.state.transcript.len(), 5);
            assert_eq!(e.focus_touched, [true]);
            assert_eq!(e.state.notes, "A manually written note.");
        }
    }

    #[test]
    fn a_line_spoken_before_a_cue_from_the_other_capture_neither_answers_nor_retracts_it() {
        for words in ["I will send the checklist.", "Sorry, scratch that."] {
            // The microphone's line is recognized after the application's
            // cue line; only when it was also spoken after does it count.
            for (spoken_at, withdraws) in [(8_000, false), (9_500, true)] {
                let mut e = Engine::live();
                e.start().unwrap();
                e.advance(10_000);
                e.ingest_from(
                    e.session(),
                    LineOrigin::Application,
                    live("a1", 9_000, "Someone should send the checklist."),
                )
                .unwrap();
                assert_eq!(e.state.cue.as_ref().unwrap().source_id, "a1");
                e.ingest(e.session(), live("m1", spoken_at, words)).unwrap();
                assert_eq!(
                    e.state
                        .cue
                        .as_ref()
                        .is_some_and(|cue| cue.source_id == "a1"),
                    !withdraws,
                    "{words} at {spoken_at}"
                );
            }
        }
    }

    #[test]
    fn on_lines_in_other_languages_only_a_question_put_to_the_user_by_name_raises_a_cue() {
        // Multilingual transcription can deliver these. The fixed phrase
        // questions (owner, timing, choice, a date said) match English words
        // only, so these lines raise nothing, though their English versions
        // would.
        let quiet = |text: &str| {
            let mut e = Engine::live();
            e.set_user_name(Some("Jordan".into())).unwrap();
            e.start().unwrap();
            e.advance(5_000);
            e.ingest(e.session(), live("l", 5_000, text)).unwrap();
            e.state.cue.as_ref().map(|cue| cue.kind.clone())
        };
        for text in [
            "Alguien puede llevar la lista pronto.",
            "Il faut choisir: ou ceci ou cela.",
            "Jemand sollte den Entwurf bald schicken.",
        ] {
            assert_eq!(quiet(text), None, "{text}");
        }
        assert!(quiet("Someone can take the list soon.").is_some());
        // A question that opens with the user's name and ends with a question
        // mark is put to them in any language: that is the Asked you rule's
        // own signal, and the cue quotes the line as said.
        for text in [
            "Jordan, ¿puedes enviar el borrador pronto?",
            "Jordan, kannst du den Entwurf bis Freitag schicken?",
        ] {
            assert_eq!(quiet(text).as_deref(), Some(ASKED), "{text}");
        }
    }

    #[test]
    fn live_cue_resume_skips_delayed_speech_and_waits_for_new_input() {
        let mut e = Engine::live();
        e.start().unwrap();
        e.advance(1_000);
        e.set_live_cues_paused(true).unwrap();
        e.advance(3_000);
        e.set_live_cues_paused(false).unwrap();
        e.advance(1_000);
        // A repeated command must not move the resume boundary forward.
        e.set_live_cues_paused(false).unwrap();
        for (id, at) in [("delayed", 3_000), ("boundary", 4_000)] {
            e.ingest(e.session(), live(id, at, "Someone should send it soon."))
                .unwrap();
            assert!(e.state.cue.is_none());
        }
        assert_eq!(e.state.transcript.len(), 2);
        e.ingest(
            e.session(),
            live("new", 4_500, "Someone should send the checklist."),
        )
        .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().source_id, "new");
        assert!(!e.cue_snapshot().cues_paused);
    }

    #[test]
    fn cue_pause_cannot_restart_a_stopped_session_or_pause_a_scripted_one() {
        let mut e = Engine::fictional();
        e.start().unwrap();
        let revision = e.state.revision;
        assert!(e.set_live_cues_paused(true).is_err());
        assert_eq!(e.state.revision, revision);
        let mut e = Engine::live();
        assert!(e.set_live_cues_paused(true).is_err());
        e.start().unwrap();
        e.set_live_cues_paused(true).unwrap();
        let old = e.session();
        e.end();
        assert!(!e.state.cues_paused);
        assert!(e.set_live_cues_paused(false).is_err());
        assert!(e
            .ingest(old, live("late", 0, "Someone should send it."))
            .is_err());
        e.start().unwrap();
        assert!(!e.state.cues_paused);
        e.ingest(e.session(), live("fresh", 0, "Someone should send it."))
            .unwrap();
        assert!(e.state.cue.is_some());
    }

    #[test]
    fn a_live_session_has_no_scripted_lines_and_does_not_end_on_its_own() {
        let mut e = Engine::live();
        e.start().unwrap();
        e.advance(10 * 60 * 60 * 1_000);
        assert_eq!(e.state.status, Status::Running);
        assert!(e.state.transcript.is_empty());
        e.ingest(e.session(), live("s1", 1_000, "Someone can take it."))
            .unwrap();
        assert!(e.state.cue.is_none(), "a line from hours ago is too late");
        e.ingest(
            e.session(),
            live("w1", e.state.elapsed_ms, "Someone can take it."),
        )
        .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().source_id, "w1");
    }

    #[test]
    fn live_transcript_raises_and_withdraws_a_sourced_question() {
        let mut e = live_session();
        let session = e.session();
        e.ingest(
            session,
            live("w1", 9_000, "  Someone can take the first draft. "),
        )
        .unwrap();
        let cue = e.state.cue.as_ref().expect("a sourced question");
        assert_eq!(cue.id, format!("{session}:w1"));
        assert_eq!(cue.source_id, "w1");
        assert_eq!(cue.evidence, "Someone can take the first draft.");
        assert_eq!(cue.remaining_ms, 17_000);
        e.advance(2_000);
        e.ingest(session, live("w2", 11_500, "Jordan will take it."))
            .unwrap();
        assert!(e.state.cue.is_none());
        let ids: Vec<_> = e.state.transcript.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["w1", "w2"]);
    }

    #[test]
    fn late_transcription_cannot_revive_an_ended_or_replaced_session() {
        let mut e = live_session();
        let old = e.session();
        e.end();
        let before = e.state.revision;
        assert!(e
            .ingest(old, live("w1", 9_000, "Someone can take it."))
            .is_err());
        e.start().unwrap();
        e.script.duration_ms = 600_000;
        e.advance(10_000);
        // Work started for the earlier session still carries its old ID.
        assert!(e
            .ingest(old, live("w1", 9_000, "Someone can take it."))
            .is_err());
        assert!(e.state.transcript.is_empty() && e.state.cue.is_none());
        assert_ne!(e.session(), old);
        assert!(e.state.revision > before); // only the restart changed state
    }

    #[test]
    fn paused_or_stopped_sessions_reject_transcript_input() {
        let mut e = Engine::fictional();
        assert!(e.ingest(e.session(), live("w1", 0, "Hello.")).is_err());
        let mut e = live_session();
        e.pause().unwrap();
        assert!(e
            .ingest(e.session(), live("w1", 9_000, "Someone can take it."))
            .is_err());
        assert!(e.state.transcript.is_empty() && e.state.cue.is_none());
        e.resume().unwrap();
        e.ingest(e.session(), live("w1", 9_000, "Hello.")).unwrap();
    }

    #[test]
    fn malformed_future_duplicate_or_reordered_segments_leave_state_unchanged() {
        let mut e = live_session();
        let session = e.session();
        e.ingest(session, live("w1", 5_000, "Hello.")).unwrap();
        let revision = e.state.revision;
        let long = "a".repeat(1_001);
        let mut no_speaker = live("w4", 6_000, "Hello.");
        no_speaker.speaker = " ".into();
        for bad in [
            live("w2", 6_000, "   "),
            live("w2", 6_000, &long),
            live("w2", 10_001, "From the future."),
            live("w1", 6_000, "Same ID again."),
            live("w3", 4_000, "Earlier than the last line."),
            live("", 6_000, "No ID."),
            live("w/../x", 6_000, "Unsafe ID."),
            no_speaker,
        ] {
            assert!(
                e.ingest(session, bad.clone()).is_err(),
                "Accepted {:?}",
                bad.id
            );
        }
        assert_eq!(e.state.revision, revision);
        assert_eq!(e.state.transcript.len(), 1);
        e.ingest(session, live("w5", 5_000, &"a".repeat(1_000)))
            .unwrap();
    }

    #[test]
    fn a_segment_transcribed_too_late_enters_the_transcript_without_a_question() {
        let mut e = live_session();
        e.advance(30_000);
        e.ingest(
            e.session(),
            live("w1", 21_000, "Someone can take the first draft."),
        )
        .unwrap();
        assert!(e.state.cue.is_none());
        assert_eq!(e.state.transcript.len(), 1);
    }

    #[test]
    fn a_reused_live_id_in_a_later_session_raises_a_new_question() {
        let mut e = live_session();
        e.ingest(
            e.session(),
            live("w1", 9_000, "Someone can take the first draft."),
        )
        .unwrap();
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.end();
        e.start().unwrap();
        e.advance(10_000);
        e.ingest(e.session(), live("w1", 9_000, "We should finish soon."))
            .unwrap();
        let second = e.state.cue.as_ref().unwrap().id.clone();
        assert_ne!(second, first);
        e.respond(&second, Response::Dismiss).unwrap();
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn only_dismiss_is_a_valid_response() {
        assert!(serde_json::from_str::<Response>("\"dismiss\"").is_ok());
        assert!(serde_json::from_str::<Response>("\"save\"").is_err());
    }

    #[test]
    fn live_ids_cannot_reuse_a_scripted_id() {
        let mut e = Engine::fictional();
        e.start().unwrap();
        e.advance(2_000);
        assert!(e.ingest(e.session(), live("s5", 2_000, "Hello.")).is_err());
        e.ingest(e.session(), live("w1", 2_000, "Hello.")).unwrap();
    }

    #[test]
    fn the_export_holds_notes_and_never_a_transcript_line() {
        let mut e = Engine::default();
        e.update_notes("Fictional note: ask about the welcome guide.".into())
            .unwrap();
        assert_eq!(
            e.markdown(),
            "# TalkQTE notes\n\nFictional note: ask about the welcome guide.\n"
        );
        // Even where a session has lines, the export text carries none.
        let mut e = live_session();
        e.update_notes("Fictional note.".into()).unwrap();
        e.ingest(e.session(), live("w1", 9_000, "Hello.")).unwrap();
        assert_eq!(e.markdown(), "# TalkQTE notes\n\nFictional note.\n");
    }

    #[test]
    fn with_no_session_nothing_is_scripted_and_nothing_plays() {
        let mut e = Engine::default();
        assert_eq!(e.state.status, Status::Ready);
        assert!(!e.state.live);
        assert!(e.state.title.is_empty() && e.state.description.is_empty());
        assert!(e.script.segments.is_empty());
        e.advance(60_000);
        assert_eq!(e.state.elapsed_ms, 0);
        assert!(e.state.transcript.is_empty() && e.state.cue.is_none());
    }

    #[test]
    fn a_long_session_keeps_only_the_most_recent_transcript() {
        let mut e = live_session();
        for index in 0..450 {
            e.ingest(e.session(), live(&format!("w{index}"), 9_000, "Noted."))
                .unwrap();
        }
        assert_eq!(e.state.transcript.len(), 400);
        assert_eq!(e.state.transcript[0].id, "w50");
    }

    #[test]
    fn a_volunteer_answers_the_owner_question_with_more_than_take() {
        for answer in [
            "I'll send it. This is Maya.",
            "Maya can sort that.",
            "I'll book the hall tonight.",
            "I can sort it.",
        ] {
            let mut e = play(&[
                (1_000, "Someone should send the checklist."),
                (3_000, answer),
            ]);
            e.advance(1_000);
            assert_eq!(e.state.cue.as_ref().unwrap().kind, "Owner", "{answer}");
            e.advance(2_000);
            assert!(e.state.cue.is_none(), "not withdrawn by: {answer}");
        }
        for not_an_answer in [
            "I can't send it this week.",
            "We can send that later.",
            "You can book the gate.",
            "Maybe I'll send it.",
            // Idioms and availability are not ownership.
            "Monday will do.",
            "Either will do.",
            "I'll check my calendar.",
            "I'll do my best.",
            "I'll look into whether we need it.",
        ] {
            let mut e = play(&[
                (1_000, "Someone should send the checklist."),
                (3_000, not_an_answer),
            ]);
            e.advance(3_000);
            assert_eq!(
                e.state.cue.as_ref().map(|cue| cue.kind.as_str()),
                Some("Owner"),
                "withdrawn by: {not_an_answer}"
            );
        }
    }

    #[test]
    fn leave_it_with_me_answers_an_owner_question() {
        for answer in [
            "Leave that with me.",
            "Leave the compost with me, I'll get it ordered today.",
            "Oh, just leave it with me.",
            "Yes, leave the checklist with me and Maya.",
            "Leave that one with me. I can do it Sunday morning.",
        ] {
            let mut e = play(&[
                (1_000, "Someone should send the checklist."),
                (3_000, answer),
            ]);
            e.advance(1_000);
            assert_eq!(e.state.cue.as_ref().unwrap().kind, "Owner", "{answer}");
            e.advance(2_000);
            assert!(e.state.cue.is_none(), "not withdrawn by: {answer}");
            assert!(e.state.notes.is_empty(), "nothing is kept: {answer}");
        }
        for not_an_answer in [
            // Questions, with or without a question mark, negations, hedges.
            "Can I leave it with you?",
            "Leave it with me?",
            "Should we leave it with me",
            "Don't leave it with me, I'm away.",
            "Maybe leave it with me.",
            // Handed to someone who has not said yes, or to the group.
            "Leave it with Maya.",
            "Leave it with us.",
            // Not opening the sentence, departing, or in the past.
            "They left it with me last year.",
            "Leave with me after the meeting.",
            "We could leave the boxes in the hall with me watching them.",
            "If it helps, leave it with me.",
        ] {
            let mut e = play(&[
                (1_000, "Someone should send the checklist."),
                (3_000, not_an_answer),
            ]);
            e.advance(3_000);
            assert_eq!(
                e.state.cue.as_ref().map(|cue| cue.kind.as_str()),
                Some("Owner"),
                "withdrawn by: {not_an_answer}"
            );
        }
        // Only an owner question: a date or a choice is not answered by it.
        for (trigger, kind) in [
            ("We need the draft soon.", "Timing"),
            ("We could use either the hall or the shed.", "Decision"),
        ] {
            let mut e = play(&[(1_000, trigger), (3_000, "Leave that with me.")]);
            e.advance(3_000);
            assert_eq!(e.state.cue.as_ref().unwrap().kind, kind, "{trigger}");
        }
    }

    #[test]
    fn leave_it_with_me_follows_the_answer_lifecycle() {
        // Answered before the question was ever shown: it is never shown.
        let mut e = play(&[
            (1_000, "Someone can take the minutes."),
            (2_000, "Leave it with me."),
        ]);
        e.advance(3_000);
        assert!(e.state.cue.is_none());
        assert!(e.cue_snapshot().cue.is_none());
        // Answered in the same line as a question put to the group: no
        // open question is raised.
        let e = play_statement("Who can take the minutes? Leave it with me.");
        assert!(e.state.cue.is_none());
        // A question being read stays and shows the answer.
        let mut e = play(&[
            (1_000, "Someone can take the minutes."),
            (4_000, "Leave it with me."),
        ]);
        e.advance(1_000);
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.inspect_cue(&id).unwrap();
        e.advance(3_000);
        let cue = e.state.cue.as_ref().unwrap();
        assert_eq!(cue.id, id);
        assert_eq!(
            cue.resolved_by.as_ref().unwrap().evidence,
            "Leave it with me."
        );
        // A question asked of the user by name is not answered by someone
        // else volunteering; it waits for the user.
        let mut e = named_session();
        e.ingest(
            e.session(),
            live("w1", 1_000, "Sam, can someone take the minutes?"),
        )
        .unwrap();
        e.ingest(e.session(), live("w2", 3_000, "Leave it with me."))
            .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, ASKED);
        // After a topic change withdrew the question, a later "leave it
        // with me" has nothing to answer and raises nothing.
        let mut e = play(&[
            (1_000, "Someone can take the minutes."),
            (4_000, "Moving on to the budget."),
            (6_000, "Leave it with me."),
        ]);
        e.advance(6_000);
        assert!(e.state.cue.is_none());
        // Once answered, the same question is not raised again within two
        // minutes.
        let mut e = play(&[
            (1_000, "Someone can take the minutes."),
            (4_000, "Leave it with me."),
            (30_000, "Someone can take the minutes."),
        ]);
        e.advance(1_000);
        assert!(e.state.cue.is_some());
        e.advance(29_000);
        assert!(e.state.cue.is_none(), "repeated within two minutes");
    }

    #[test]
    fn an_open_question_is_not_withdrawn_by_an_unrelated_volunteer() {
        let mut e = play(&[
            (1_000, "Does anyone have time to review the draft?"),
            (3_000, "I'll send the invite to Maya."),
            (5_000, "I'll take it."),
        ]);
        e.advance(3_000);
        assert_eq!(
            e.state.cue.as_ref().map(|cue| cue.kind.as_str()),
            Some(OPEN)
        );
        e.advance(2_000);
        assert!(e.state.cue.is_none(), "taking it does answer");
    }

    #[test]
    fn a_later_answer_withdraws_the_open_question() {
        for (prompt, answer) in [
            (
                "Someone can take the first draft.",
                "Jordan will take the first draft.",
            ),
            (
                "Someone can take the first draft.",
                "Sure, I’ll draft it tonight.",
            ),
            ("Someone can take the first draft.", "OK, I‘ll take it."),
            ("We should finish soon.", "Let's have it ready by Friday."),
            ("We should finish soon.", "I can bring it tomorrow."),
            (
                "We could either print it or put a sign by the gate.",
                "Let's go with the sign.",
            ),
            (
                "We could either print it or put a sign by the gate.",
                "We decided to print it.",
            ),
        ] {
            let mut e = play(&[(1_000, prompt), (4_000, answer)]);
            e.advance(1_000);
            assert!(e.state.cue.is_some(), "No question for: {prompt}");
            e.advance(3_000);
            // The question is gone; an answer that names a time is quoted instead.
            assert!(
                e.state.cue.as_ref().is_none_or(|cue| cue.kind == SAID),
                "Still asking after: {answer}"
            );
            assert_eq!(e.state.transcript.len(), 2);
            // The answered question cannot be acted on afterwards.
            assert!(e.respond("1:t1", Response::Dismiss).is_err());
        }
    }

    #[test]
    fn questions_negations_and_unrelated_statements_do_not_count_as_answers() {
        for (prompt, reply) in [
            (
                "Someone can take the first draft.",
                "Who will take the first draft?",
            ),
            (
                "Someone can take the first draft.",
                "I can't take the first draft.",
            ),
            (
                "Someone can take the first draft.",
                "It will take a week to write.",
            ),
            (
                "Someone can take the first draft.",
                "We will take it to the meeting.",
            ),
            ("We should finish soon.", "Can we finish by Friday?"),
            ("We should finish soon.", "It won't be ready by Friday."),
            ("We should finish soon.", "The seedlings arrive in spring."),
            (
                "We could either print it or use a sign.",
                "We haven't decided yet.",
            ),
            (
                "We could either print it or use a sign.",
                "I'll go with you to the gate.",
            ),
            (
                "We could either print it or use a sign.",
                "Let's go with the sign?",
            ),
            // Found in review: negations, non-person owners, unmarked questions.
            ("We should finish soon.", "We cannot finish by Friday."),
            ("We should finish soon.", "We wont make it by Friday."),
            ("We should finish soon.", "No way we finish by Friday."),
            ("We should finish soon.", "By Friday is not realistic."),
            ("We should finish soon.", "Tomorrow doesn't work for me."),
            (
                "We should finish soon.",
                "Can we do it by Friday, or is that too tight.",
            ),
            ("We should finish soon.", "I talked to Sam on Monday."),
            (
                "We could either print it or use a sign.",
                "Nobody decided anything yet.",
            ),
            (
                "We could either print it or use a sign.",
                "Nothing was decided.",
            ),
            (
                "We could either print it or use a sign.",
                "Should we go with the sign.",
            ),
            (
                "Someone can take the first draft.",
                "The draft will take a week.",
            ),
            (
                "Someone can take the first draft.",
                "No one will take the first draft.",
            ),
            (
                "Someone can take the first draft.",
                "None of us can take it.",
            ),
            (
                "Someone can take the first draft.",
                "What will take longest is the layout.",
            ),
            (
                "Someone can take the first draft.",
                "Somebody else will draft it.",
            ),
            (
                "Someone can take the first draft.",
                "Everybody can write a section.",
            ),
            (
                "Someone can take the first draft.",
                "Maybe Jordan can take it.",
            ),
            // A different issue's answer leaves this one open.
            (
                "We should finish soon.",
                "Jordan will take the first draft.",
            ),
        ] {
            let mut e = play(&[(1_000, prompt), (4_000, reply)]);
            e.advance(4_000);
            assert!(e.state.cue.is_some(), "Withdrawn after: {reply}");
        }
    }

    #[test]
    fn the_fictional_scenario_withdraws_its_timing_question_once_a_date_is_set() {
        let mut e = Engine::fictional();
        e.start().unwrap();
        e.advance(37_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Timing");
        e.advance(14_000); // s5 sets a date at 51 s, before the 55 s expiry.
                           // The question goes; the words that answered it are quoted instead.
        let said = e.state.cue.as_ref().expect("the quoted answer");
        assert_eq!(said.kind, SAID);
        assert_eq!(
            said.question,
            "Let's have it ready by Friday and try it with a few new visitors first."
        );
        assert_eq!(said.source_id, "s5");
    }

    #[test]
    fn the_same_question_is_not_asked_again_soon_after_it_was_shown() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (40_000, "Someone can take the second draft."),
            (60_000, "We should finish soon."),
            (125_000, "Someone can take the layout."),
        ]);
        e.script.duration_ms = 200_000;
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.advance(39_000);
        assert!(
            e.state.cue.is_none(),
            "same owner question within two minutes"
        );
        e.advance(20_000);
        assert_eq!(
            e.state.cue.as_ref().unwrap().kind,
            "Timing",
            "other types unaffected"
        );
        e.advance(65_000);
        let cue = e.state.cue.as_ref().expect("asked again after the window");
        assert_eq!((cue.kind.as_str(), cue.source_id.as_str()), ("Owner", "t4"));
    }

    #[test]
    fn a_suppressed_repeat_does_not_extend_the_window() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (100_000, "Someone can take the second draft."),
            (122_000, "Someone can take the layout."),
        ]);
        e.script.duration_ms = 200_000;
        e.advance(122_000);
        assert_eq!(e.state.cue.as_ref().unwrap().source_id, "t3");
    }

    #[test]
    fn a_question_answered_before_it_was_ever_shown_does_not_block_the_next() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (2_000, "Jordan will take it."),
            (30_000, "Someone can take the layout."),
        ]);
        e.advance(3_000); // One late tick: raised and answered, never shown.
        assert!(e.state.cue.is_none());
        e.advance(27_000);
        assert_eq!(e.state.cue.as_ref().unwrap().source_id, "t3");
    }

    #[test]
    fn a_suppressed_type_does_not_hide_another_type_in_the_same_line() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (40_000, "Someone can do it soon."),
        ]);
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.advance(39_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Timing");
    }

    #[test]
    fn replay_forgets_which_questions_were_shown() {
        let mut e = Engine::fictional();
        e.start().unwrap();
        e.advance(8_000);
        assert!(e.state.cue.is_some());
        e.end();
        e.start().unwrap();
        e.advance(8_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Owner");
    }

    #[test]
    fn an_explicit_topic_change_withdraws_an_unread_question() {
        for change in [
            "Moving on to the budget.",
            "OK, next item.",
            "Let's move on to the opening hours.",
            "On another note, the gate is fixed.",
            "Alright, new topic: the newsletter.",
        ] {
            let mut e = play(&[
                (1_000, "Someone can take the first draft."),
                (4_000, change),
            ]);
            e.advance(1_000);
            assert!(e.state.cue.is_some());
            e.advance(3_000);
            assert!(e.state.cue.is_none(), "still shown after: {change}");
        }
    }

    #[test]
    fn putting_the_subject_off_to_a_later_occasion_withdraws_an_unread_question() {
        for change in [
            // "That", "it", or "this" stands for what was just said.
            "OK, let's park that for next time.",
            "We'll save this for the next meeting.",
            "We can postpone it until later.",
            "Let’s come back to that later.",
            // Or what is put off shares a word with the question's line.
            "So we'll revisit the draft next time.",
            "Let's leave the Draft question for another meeting. Now, the budget.",
        ] {
            let mut e = play(&[
                (1_000, "Someone can take the first draft."),
                (4_000, change),
            ]);
            e.advance(1_000);
            assert!(e.state.cue.is_some());
            e.advance(3_000);
            assert!(e.state.cue.is_none(), "still shown after: {change}");
            assert!(e.state.notes.is_empty(), "nothing is kept: {change}");
        }
    }

    #[test]
    fn deferrals_in_other_words_withdraw_an_unread_question() {
        for change in [
            "We'll pick that up at the committee meeting next month. On to the raffle.",
            "Let's park that until we've seen what the weather does, and come back to it in September.",
            "Let's not get into that tonight. It's on the agenda for March.",
            "OK, let's not go into it now.",
            "Let's push it to next week.",
            "We'll move that to the next meeting.",
            "Let's hold off on the draft until after the fair.",
            "Let's put that off till next month.",
            "We can put off the draft until the new year meeting.",
            "Let's park that next month.",
        ] {
            let mut e = play(&[
                (1_000, "Someone can take the first draft."),
                (4_000, change),
            ]);
            e.advance(1_000);
            assert!(e.state.cue.is_some());
            e.advance(3_000);
            assert!(
                e.state.cue.as_ref().is_none_or(|cue| cue.kind == SAID),
                "still asked after: {change}"
            );
            assert!(e.state.notes.is_empty(), "nothing is kept: {change}");
        }
    }

    #[test]
    fn wordings_that_only_resemble_a_deferral_leave_the_question() {
        for line in [
            // Collecting something, not putting it off.
            "We'll pick it up at the shop next week.",
            "Let's pick up the chairs at nine.",
            // Moving or pushing a thing, not a time.
            "Let's move the chairs to the back room.",
            "Let's push the tables to the wall.",
            // Not discussing something other than what was just said.
            "Let's not get into the budget tonight.",
            "Let's not get into trouble with the council.",
            "We won't get into that tonight.",
            // Questions, hedges, and other negations.
            "Should we push it to next week?",
            "Can we pick that up at the next meeting.",
            "Maybe we'll push it to next week.",
            "Let's not push it to next week.",
            // Another subject, put off in the new wording.
            "Let's push the poster design to next month.",
            // Waiting on a condition but keeping something open.
            "Let's leave the vote open until we've heard from everyone.",
            // Put to someone by name: the opening is not recognized.
            "Alex, let's push it to next week.",
        ] {
            let mut e = play(&[(1_000, "Someone can take the first draft."), (4_000, line)]);
            e.advance(4_000);
            assert_eq!(
                e.state.cue.as_ref().map(|cue| cue.kind.as_str()),
                Some("Owner"),
                "withdrawn after: {line}"
            );
        }
        // A question being read, or one asked of the user, stays.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "Let's not get into that tonight."),
        ]);
        e.advance(1_000);
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.inspect_cue(&id).unwrap();
        e.advance(3_000);
        assert_eq!(e.state.cue.as_ref().unwrap().id, id);
        let mut e = named_session();
        e.ingest(
            e.session(),
            live("w1", 1_000, "Sam, can you take the first draft?"),
        )
        .unwrap();
        e.ingest(
            e.session(),
            live("w2", 3_000, "Let's push it to next week."),
        )
        .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, ASKED);
        // An answer in the same breath still resolves rather than defers.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "I'll take it, and let's push the rest to next week."),
        ]);
        e.advance(1_000);
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.inspect_cue(&id).unwrap();
        e.advance(3_000);
        assert!(e.state.cue.as_ref().unwrap().resolved_by.is_some());
        // With no question on screen, a deferral changes nothing: a question
        // dismissed a moment ago is not asked again.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (12_000, "Let's not get into that tonight."),
            (30_000, "Someone can take the first draft."),
        ]);
        e.advance(1_000);
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&id, Response::Dismiss).unwrap();
        e.advance(29_000);
        assert!(e.state.cue.is_none(), "repeated within two minutes");
    }

    #[test]
    fn putting_off_something_else_leaves_the_question_and_its_history() {
        for line in [
            // Another subject entirely.
            "Let's leave the poster design for another meeting.",
            "We'll save the rota for the next meeting.",
            "We can postpone the signage question until later.",
            // Words shared only with the fixed question, not the line.
            "Let's leave the first item for later.",
            // A different form of the word is missed, which keeps the question.
            "Let's leave the drafts for later.",
            // Words about the conversation are not a subject.
            "Let's leave someone else's question for later.",
        ] {
            let mut e = play(&[(1_000, "Someone can take the first draft."), (4_000, line)]);
            e.advance(4_000);
            assert!(e.state.cue.is_some(), "withdrawn after: {line}");
        }
        // With no question on screen, putting something off is an ordinary
        // line: a question dismissed a moment ago is not asked again.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (12_000, "Let's leave that for another meeting."),
            (30_000, "Someone can take the first draft."),
        ]);
        e.advance(1_000);
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&id, Response::Dismiss).unwrap();
        e.advance(29_000);
        assert!(e.state.cue.is_none(), "repeated within two minutes");
        // An explicit topic change still starts the history afresh.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (12_000, "Moving on to the newsletter."),
            (30_000, "Someone can take the first draft."),
        ]);
        e.advance(1_000);
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&id, Response::Dismiss).unwrap();
        e.advance(29_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Owner");
    }

    #[test]
    fn lines_that_only_resemble_putting_something_off_leave_the_question() {
        for line in [
            // No later occasion, nothing put off, or no opening.
            "Let's leave the door open.",
            "Let's table the proposal.",
            "Let's leave later.",
            "Let's come back to the first draft.",
            "Let's park the van at the gate.",
            // A second clause, keeping something open, or setting time aside.
            "Let's come back to the first draft and leave the budget for later.",
            "Let's leave the survey open for another day.",
            "Let's leave the vote open until next week.",
            "Let's leave ten minutes for later questions.",
            "Let's save some time for later.",
            "Let's revisit who takes the draft before next week.",
            "Let's leave the long list of every single cover option for another meeting.",
            "The cover choice was left for another meeting last year.",
            "Before we leave that for later, someone needs to own the draft.",
            // Questions, with or without a question mark.
            "Should we leave that for another meeting?",
            "Can we park that until next week.",
            "Let's leave that for another meeting?",
            // Negations and hedges.
            "Let's not leave that for another meeting.",
            "We can't leave the draft for later.",
            "Maybe we'll park that until next week.",
            "We'll probably revisit that later.",
            // Put to someone by name: the opening is not recognized, so the
            // question stays rather than guessing.
            "Alex, let's leave that for another meeting.",
        ] {
            let mut e = play(&[(1_000, "Someone can take the first draft."), (4_000, line)]);
            e.advance(4_000);
            assert!(e.state.cue.is_some(), "withdrawn after: {line}");
        }
    }

    #[test]
    fn putting_something_off_follows_the_topic_change_lifecycle() {
        let deferral = "Let's leave that for another meeting.";
        // A question being read stays in place.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, deferral),
        ]);
        e.advance(1_000);
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.inspect_cue(&id).unwrap();
        e.advance(3_000);
        assert_eq!(e.state.cue.as_ref().unwrap().id, id);
        // So does a question asked of the user by name.
        let mut e = play(&[
            (1_000, "Robin, can you take the first draft?"),
            (4_000, deferral),
        ]);
        e.set_user_name(Some("Robin".into())).unwrap();
        e.advance(4_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, ASKED);
        // A pause follows the withdrawal, so the next line raises nothing.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, deferral),
            (6_000, "We could use either the hall or the shed."),
        ]);
        e.advance(6_000);
        assert!(e.state.cue.is_none());
        // On the new topic the same type of question may be asked again,
        // and a repeat of it within two minutes is still skipped.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, deferral),
            (20_000, "Someone can take the newsletter."),
            (50_000, "Someone can take the newsletter."),
        ]);
        e.advance(20_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Owner");
        e.advance(30_000);
        assert!(e.state.cue.is_none(), "repeated within two minutes");
        // A deferral that names when is itself a spoken date: the stale
        // question goes and the line is quoted word for word.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "OK, let's park that until next week."),
        ]);
        e.advance(4_000);
        let cue = e.state.cue.as_ref().unwrap();
        assert_eq!(cue.kind, SAID);
        assert_eq!(cue.question, "OK, let's park that until next week.");
        // An answer is still an answer: it resolves rather than withdraws.
        let mut e = play(&[
            (1_000, "We could use either a blue or green cover."),
            (4_000, "Let's go with the blue cover."),
        ]);
        e.advance(1_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Decision");
        assert!(resolves("Decision", "Let's go with the blue cover."));
        assert!(!topic_shift("Let's go with the blue cover."));
        e.advance(3_000);
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn questions_negations_and_ordinary_lines_are_not_topic_changes() {
        for line in [
            // Questions, with or without a question mark.
            "Should we move on to the budget?",
            "OK, can we move on to the budget.",
            "So should we move on to the budget",
            "Will we move on to the budget.",
            // Negations and hedges.
            "We're not moving on yet.",
            "We cannot move on to the budget yet.",
            "Nobody is moving on until the draft has an owner.",
            "Maybe moving on would help.",
            // The phrase inside an ordinary sentence.
            "I'm switching to decaf.",
            "The trucks are moving on Tuesday morning.",
            "Before we move on to the budget, someone needs to own the draft.",
            "We'll move on to the budget after we pick an owner.",
            "The next item on the list is the budget, and someone needs to own it.",
            "Let's talk about who takes the first draft.",
            "The next step is printing.",
            "Moving on to the next slide, the draft needs an owner.",
            "Let's move on to the next page.",
        ] {
            let mut e = play(&[(1_000, "Someone can take the first draft."), (4_000, line)]);
            e.advance(4_000);
            assert!(e.state.cue.is_some(), "withdrawn after: {line}");
        }
    }

    #[test]
    fn remarks_about_what_people_notice_and_goodbyes_raise_no_question() {
        for line in [
            "Someone can always tell when the bread is fresh. It was lovely last week.",
            "Someone can never find the stapler in here.",
            "Someone should never have to ask twice.",
            "Someone could always tell he was joking.",
            "Someone can tell when the paint is still wet.",
            "Someone could hear it from the car park.",
            "Someone can see the banner from the road.",
            "Someone could smell the bonfire all afternoon.",
            "Lovely. We'll see you all soon, thanks for coming.",
            "See you soon!",
            "See everyone soon.",
            "See you both again soon.",
            "Talk soon.",
            "Speak soon, and thanks again.",
            "Let’s catch up soon.",
            "Get well soon, Maya.",
        ] {
            let e = play_statement(line);
            assert!(e.state.cue.is_none(), "raised by: {line}");
        }
    }

    #[test]
    fn open_tasks_and_vague_deadlines_near_those_phrases_still_raise_a_question() {
        for (line, kind) in [
            ("Someone can take the first draft.", "Owner"),
            ("Someone can tell the caterer about the change.", "Owner"),
            ("Someone could see to the hall booking.", "Owner"),
            ("Someone should hear back from the printer first.", "Owner"),
            (
                "Someone can always tell, but someone should fix it.",
                "Owner",
            ),
            ("We need the draft soon.", "Timing"),
            ("The printer wants the files soon.", "Timing"),
            (
                "See you soon, and the report needs to go out soon.",
                "Timing",
            ),
            ("I'll see the printer and it should come soon.", "Timing"),
            ("We should talk about it soon.", "Timing"),
        ] {
            let e = play_statement(line);
            let cue = e
                .state
                .cue
                .as_ref()
                .unwrap_or_else(|| panic!("nothing raised by: {line}"));
            assert_eq!(cue.kind, kind, "{line}");
        }
    }

    #[test]
    fn a_remark_or_goodbye_leaves_other_cue_decisions_alone() {
        // A question on screen stays through a remark and a goodbye, and an
        // answer still withdraws it.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (3_000, "Someone can always tell when it's rushed."),
            (5_000, "Talk soon."),
            (7_000, "I'll take it."),
        ]);
        e.advance(1_000);
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.advance(4_000);
        assert_eq!(e.state.cue.as_ref().unwrap().id, id);
        e.advance(2_000);
        assert!(e.state.cue.is_none());
        // A topic change still withdraws, and the goodbye after it adds
        // nothing; neither reaches the notes.
        let mut e = play(&[
            (1_000, "We need the draft soon."),
            (4_000, "Moving on to the budget."),
            (20_000, "See you all soon."),
        ]);
        e.advance(1_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Timing");
        e.advance(19_000);
        assert!(e.state.cue.is_none());
        assert!(e.state.notes.is_empty());
        // A question asked of the user is still shown; one put to someone
        // else by name, or a repeat within two minutes, still is not.
        let mut e = named_session();
        e.ingest(e.session(), live("w1", 1_000, "Sam, will we see you soon?"))
            .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, ASKED);
        let mut e = named_session();
        e.ingest(
            e.session(),
            live("w1", 1_000, "Alex, can someone take the draft soon?"),
        )
        .unwrap();
        assert!(e.state.cue.is_none());
        let mut e = play(&[
            (1_000, "We need the draft soon."),
            (25_000, "We really need it soon."),
        ]);
        e.advance(1_000);
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&id, Response::Dismiss).unwrap();
        e.advance(24_000);
        assert!(e.state.cue.is_none(), "repeated within two minutes");
    }

    #[test]
    fn someone_should_or_could_also_leaves_the_owner_open() {
        for line in [
            "Someone should look at the compost bins soon.",
            "Someone could send the checklist.",
        ] {
            let e = play_statement(line);
            assert_eq!(
                e.state.cue.as_ref().map(|cue| cue.kind.as_str()),
                Some("Owner"),
                "{line}"
            );
        }
        let e = play_statement("Someone sent the checklist.");
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn a_new_topic_can_ask_the_same_type_of_question_again() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "Moving on, someone can book the hall."),
        ]);
        e.advance(1_000); // The first question is shown.
        assert_eq!(e.state.cue.as_ref().unwrap().source_id, "t1");
        e.advance(3_000);
        let cue = e.state.cue.as_ref().expect("a question for the new topic");
        assert_eq!((cue.kind.as_str(), cue.source_id.as_str()), ("Owner", "t2"));
    }

    #[test]
    fn a_topic_change_with_no_question_open_leaves_no_pause() {
        let mut e = play(&[(1_000, "Moving on."), (2_000, "Someone can book the hall.")]);
        e.advance(2_000);
        assert_eq!(e.state.cue.as_ref().unwrap().source_id, "t2");
    }

    #[test]
    fn a_topic_change_while_reading_keeps_the_repeat_history() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "Moving on."),
            (20_000, "Someone can book the hall."),
        ]);
        e.advance(1_000);
        e.inspect_cue("1:t1").unwrap();
        e.advance(3_000);
        e.respond("1:t1", Response::Dismiss).unwrap();
        e.advance(16_000);
        assert!(
            e.state.cue.is_none(),
            "the dismissed question type does not return at once"
        );
    }

    #[test]
    fn a_topic_change_that_raises_nothing_leaves_a_pause() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "Moving on."),
            (5_000, "We should send the invites soon."),
            (16_000, "Someone can book the hall."),
        ]);
        e.advance(5_000);
        assert!(e.state.cue.is_none(), "cooldown after the change");
        e.advance(11_000);
        assert_eq!(e.state.cue.as_ref().unwrap().source_id, "t4");
    }

    #[test]
    fn a_question_being_read_survives_a_topic_change() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "Moving on."),
        ]);
        e.advance(1_000);
        e.inspect_cue("1:t1").unwrap();
        e.advance(3_000);
        assert_eq!(e.state.cue.as_ref().unwrap().id, "1:t1");
    }

    #[test]
    fn the_line_that_changes_topic_can_raise_its_own_question() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "Moving on, we should send the invites soon."),
        ]);
        e.advance(4_000);
        let cue = e.state.cue.as_ref().unwrap();
        assert_eq!(
            (cue.kind.as_str(), cue.source_id.as_str()),
            ("Timing", "t2")
        );
    }

    #[test]
    fn a_question_asked_of_the_user_by_name_is_shown_and_takes_priority() {
        for line in [
            "Robin, can you take the first draft?",
            "What do you think, Robin?",
            "robin, could you check the gate code.",
            "Hey Robin, can you take the first draft?",
            "Robin — can you take the first draft?",
            "Can you take the first draft, Robin",
            "“Robin, can you take the first draft?”",
        ] {
            let mut e = play(&[(1_000, "Someone can take the first draft."), (4_000, line)]);
            e.set_user_name(Some(" Robin ".into())).unwrap();
            e.advance(1_000);
            assert_eq!(e.state.cue.as_ref().unwrap().kind, "Owner");
            e.advance(3_000);
            let cue = e.state.cue.as_ref().expect("the direct question");
            assert_eq!(
                (cue.kind.as_str(), cue.source_id.as_str()),
                (ASKED, "t2"),
                "{line}"
            );
            assert!(
                !cue.question.starts_with('“') && !cue.question.ends_with('”'),
                "{line}"
            );
        }
    }

    #[test]
    fn questions_for_someone_else_or_no_one_stay_quiet() {
        for line in [
            "Alex, can you take the first draft?",
            "Can anyone check the gate code?",
            "What do you think?",
            "Robin will take the first draft.",
            "I asked Robin, can you believe it.",
            "Robinson, can you check the gate?",
            // Statements that contain question words are not questions.
            "Robin, the draft is done.",
            "Robin, this is the final version.",
            "Robin, what a great job.",
            "That is great work, Robin.",
        ] {
            let mut e = play(&[(1_000, line)]);
            e.set_user_name(Some("Robin".into())).unwrap();
            e.advance(1_000);
            assert!(
                e.state.cue.as_ref().is_none_or(|cue| cue.kind != ASKED),
                "asked after: {line}"
            );
        }
    }

    #[test]
    fn without_a_name_no_question_is_treated_as_addressed() {
        let mut e = play(&[(1_000, "Robin, can you take the first draft?")]);
        e.advance(1_000);
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn a_direct_question_ignores_the_cooldown_but_not_a_question_being_read() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (3_000, "Robin, can you take it?"),
        ]);
        e.set_user_name(Some("Robin".into())).unwrap();
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.inspect_cue(&first).unwrap();
        e.advance(2_000);
        assert_eq!(
            e.state.cue.as_ref().unwrap().id,
            first,
            "the read question stays"
        );

        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (3_000, "Robin, can you take it?"),
        ]);
        e.set_user_name(Some("Robin".into())).unwrap();
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap(); // starts a cooldown
        e.advance(2_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, ASKED);
    }

    #[test]
    fn a_question_about_a_focus_line_skips_the_pause_and_stays_longer() {
        let lines = [
            (1_000, "Someone can take the first draft."),
            (3_000, "We still need to settle the volunteer schedule for the garden either this week or next."),
        ];
        let mut e = play(&lines);
        e.set_focus(vec!["Settle the volunteer schedule".into()])
            .unwrap();
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap(); // starts a 10 s pause
        e.advance(2_000);
        let cue = e.state.cue.as_ref().expect("the focus question");
        assert_eq!(
            (cue.kind.as_str(), cue.source_id.as_str()),
            ("Decision", "t2")
        );
        assert!(cue.about_focus);
        assert_eq!(cue.total_ms, 45_000);
        e.advance(40_000);
        assert!(
            e.state.cue.is_some(),
            "stays as long as a question asked of the user"
        );
        e.advance(6_000); // 49 s: past the 48 s deadline
        assert!(e.state.cue.is_none());

        // The same line without a focus waits out the pause like any other.
        let mut e = play(&lines);
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.advance(2_000);
        assert!(e.state.cue.is_none());

        // A line that shares one focus word is not about it.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (
                3_000,
                "The schedule for the fence is either Monday or Tuesday.",
            ),
        ]);
        e.set_focus(vec!["Settle the volunteer schedule".into()])
            .unwrap();
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.advance(2_000);
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn focus_lines_need_identifying_words_and_there_are_at_most_five() {
        let mut e = Engine::fictional();
        assert!(e.set_focus(vec!["Decide".into()]).is_err(), "one word");
        assert!(
            e.set_focus(vec!["Sync on the team update".into()]).is_err(),
            "only common meeting words"
        );
        assert!(e.set_focus(vec!["a".repeat(81)]).is_err(), "too long");
        assert!(e.set_focus(vec!["line one\tline two".into()]).is_err());
        assert!(e
            .set_focus(
                (0..6)
                    .map(|i| format!("settle volunteer schedule {i}"))
                    .collect()
            )
            .is_err());
        assert!(e.state.focus.is_empty());
        let error = e
            .set_focus(vec!["Agree the launch plan".into(), "Sync".into()])
            .unwrap_err();
        assert!(error.contains("“Sync”"), "names the line: {error}");
        e.set_focus(vec![
            "  Agree the launch plan for the newsletter  ".into(),
            "".into(),
            "Decide who owns the compost bins".into(),
        ])
        .unwrap();
        assert_eq!(
            e.state.focus,
            [
                "Agree the launch plan for the newsletter",
                "Decide who owns the compost bins"
            ]
        );
        e.set_focus(vec!["   ".into()]).unwrap();
        assert!(e.state.focus.is_empty());
    }

    #[test]
    fn a_long_focus_line_needs_three_of_its_words_and_the_focus_survives_a_new_engine() {
        let lines = [
            (1_000, "Someone can take the first draft."),
            (3_000, "The volunteer schedule is either Monday or Tuesday."),
        ];
        let line = "Settle the volunteer schedule, budget, signage, compost and newsletter";
        let mut e = play(&lines);
        e.set_focus(vec![line.into()]).unwrap();
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.advance(2_000);
        assert!(e.state.cue.is_none(), "two of seven words is not about it");

        let mut next = Engine::fictional();
        next.copy_focus_from(&e);
        assert_eq!(next.state.focus, [line]);
        next.script.segments = vec![Segment {
            id: "t1".into(),
            at_ms: 1_000,
            speaker: "Robin".into(),
            text: "The volunteer schedule and the budget are either Monday or Tuesday.".into(),
        }];
        next.start().unwrap();
        next.set_sensitivity(Sensitivity::Quiet);
        next.cooldown_until = 20_000;
        next.advance(1_000);
        let cue = next
            .state
            .cue
            .as_ref()
            .expect("three words, during a Quiet pause");
        assert!(cue.about_focus);
    }

    // Stress tests of the focus idea on fictional conversations.

    #[test]
    fn focused_mode_shows_only_what_matters_but_still_hears_the_user_by_name() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (
                14_000,
                "We should decide soon, either the sign or the leaflet.",
            ),
            (27_000, "Robin, can you take the leaflet?"),
            (
                90_000,
                "We should settle the volunteer schedule either Monday or Tuesday.",
            ),
        ]);
        e.set_focus(vec!["Settle the volunteer schedule".into()])
            .unwrap();
        e.set_user_name(Some("Robin".into())).unwrap();
        e.set_sensitivity(Sensitivity::Focused);
        e.advance(1_000);
        assert!(
            e.state.cue.is_none(),
            "an owner question off the focus stays quiet"
        );
        e.advance(13_000);
        assert!(
            e.state.cue.is_none(),
            "timing and decision questions off the focus stay quiet"
        );
        e.advance(13_000);
        assert_eq!(
            e.state.cue.as_ref().map(|c| c.kind.as_str()),
            Some(ASKED),
            "a question put to the user by name still arrives"
        );
        e.advance(48_000);
        assert!(
            e.state.cue.is_none(),
            "the asked question has passed and Focused keeps the usual pause"
        );
        e.advance(15_000);
        let cue = e.state.cue.as_ref().expect("the focus question");
        assert_eq!(cue.kind, "Decision");
        assert!(cue.about_focus);
    }

    #[test]
    fn a_derailed_meeting_stays_quiet_and_gets_one_still_open_list_when_it_wraps_up() {
        let mut lines: Vec<(u64, &str)> = vec![
            (1_000, "Someone can take the first draft of the newsletter."),
            (12_000, "Did anyone see the match last night?"),
            (23_000, "Someone can bring snacks soon."),
            (34_000, "We could go either to the park or the river."),
            (45_000, "Does anyone have a recommendation for a plumber?"),
            (56_000, "Someone should look at the compost bins soon."),
            (67_000, "Anyway, that was a long tangent."),
        ];
        lines.push((78_000, "Before we finish, anything else?"));
        lines.push((90_000, "To wrap up then, thanks everyone."));
        let mut e = play(&lines);
        e.set_focus(vec![
            "Agree the launch plan for the newsletter".into(),
            "Decide who owns the compost bins".into(),
        ])
        .unwrap();
        e.set_sensitivity(Sensitivity::Focused);
        for _ in 0..7 {
            e.advance(11_000);
            assert!(
                e.state.cue.is_none(),
                "quiet through the tangent at {} ms",
                e.state.elapsed_ms
            );
        }
        e.advance(1_000); // 78 s: the wrap-up line
        let cue = e.state.cue.as_ref().expect("the still-open list");
        assert_eq!(cue.kind, STILL_OPEN);
        assert_eq!(
            cue.question,
            "Not covered: Agree the launch plan for the newsletter · Decide who owns the compost bins"
        );
        assert_eq!(cue.total_ms, 45_000);
        assert!(cue.about_focus);
        let id = cue.id.clone();
        e.respond(&id, Response::Dismiss).unwrap();
        e.advance(12_000); // 90 s: a second wrap-up line raises nothing
        assert!(e.state.cue.is_none());

        // A focus line the conversation did touch is not listed, and the
        // list appears in Balanced mode as well.
        let mut e = play(&[
            (
                1_000,
                "The launch plan for the newsletter is either May or June.",
            ),
            // The 45 s focus question has passed; the list waits for a clear companion.
            (60_000, "Last thing before we go: parking."),
        ]);
        e.set_focus(vec![
            "Agree the launch plan for the newsletter".into(),
            "Decide who owns the compost bins".into(),
        ])
        .unwrap();
        e.advance(1_000);
        assert!(e
            .state
            .cue
            .as_ref()
            .is_some_and(|c| c.about_focus && c.kind == "Decision"));
        e.advance(59_000);
        assert_eq!(
            e.state.cue.as_ref().map(|c| c.question.as_str()),
            Some("Not covered: Decide who owns the compost bins")
        );

        // Nothing to list means no nudge; and no focus means no nudge.
        let mut e = play(&[(1_000, "Before we finish, anything else?")]);
        e.advance(1_000);
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn a_focus_line_put_to_someone_else_still_counts_as_touched_and_edits_keep_touched() {
        let mut e = play(&[
            (1_000, "Sam, can you settle the volunteer schedule?"),
            (20_000, "Robin, anything else before we finish?"),
        ]);
        e.set_user_name(Some("Robin".into())).unwrap();
        e.set_focus(vec![
            "Settle the volunteer schedule".into(),
            "Decide who owns the compost bins".into(),
        ])
        .unwrap();
        e.advance(1_000);
        assert!(e.state.cue.is_none(), "a question for Sam raises nothing");
        // Editing the list keeps what was touched; a new line starts untouched.
        e.set_focus(vec![
            "Agree the newsletter launch".into(),
            "Settle the volunteer schedule".into(),
        ])
        .unwrap();
        e.advance(19_000);
        assert_eq!(
            e.state.cue.as_ref().map(|c| c.question.as_str()),
            Some("Not covered: Agree the newsletter launch"),
            "the wrap-up came in a line addressed to the user"
        );
        for line in [
            "Before we finish, anything else?",
            "OK, so, to wrap up: thanks.",
            "Robin, anything else before we go?",
            "Right. Last thing before we close.",
        ] {
            assert!(wraps_up(line), "{line}");
        }
        for line in [
            "Is there anything else in the shed?",
            "We are running out of time on the fence, not the meeting.",
            "I'll wrap this up tonight and send it.",
        ] {
            assert!(!wraps_up(line), "{line}");
        }
    }

    #[test]
    fn a_session_shows_at_most_three_note_reminders() {
        let mut e = play(&[
            (1_000, "The garden welcome guide needs a map."),
            (15_000, "The volunteer schedule has a gap on Wednesday."),
            (29_000, "The compost budget request is still open."),
            (43_000, "The signage proposal is ready."),
            (57_000, "The newsletter launch plan slipped a week."),
        ]);
        e.set_notes(
            [
                ("n1", "Garden welcome guide"),
                ("n2", "Volunteer schedule"),
                ("n3", "Compost budget request"),
                ("n4", "Signage proposal"),
                ("n5", "Newsletter launch plan"),
            ]
            .iter()
            .map(|(key, title)| ContextItem {
                provider: crate::context::Provider::File,
                source_id: key.to_string(),
                title: title.to_string(),
                source_date: "2026-11-01".into(),
                excerpt: format!("About the {}.", title.to_lowercase()),
                revision: 1,
            })
            .collect(),
        );
        let mut shown = 0;
        for step in 0..5 {
            e.advance(if step == 0 { 1_000 } else { 14_000 });
            if let Some(cue) = e.state.cue.clone() {
                assert_eq!(cue.kind, CONTEXT);
                shown += 1;
                e.respond(&cue.id, Response::Dismiss).unwrap();
            }
        }
        assert_eq!(
            shown, MAX_REMINDERS,
            "the fourth and fifth notes are not shown"
        );
    }

    #[test]
    fn a_spoken_date_or_commitment_is_quoted_word_for_word() {
        for line in [
            "We'll have the draft ready by Friday.",
            "Legal takes two days, so send it before Thursday.",
            "I can start on Monday and finish by the end of the month.",
            "The review is due on March 14.",
            "Let's deliver it next week.",
            "We should send the deck by Friday.",
            "Legal needs it back by March 3rd.",
            "I'll share the slides Friday.",
            "I'll send it today at 10.30.",
            "Legal needs two full working days after the draft is ready.",
            "The printer takes three business days.",
            "We need 5 working days before the fair.",
        ] {
            let e = play_statement(line);
            let cue = e
                .state
                .cue
                .as_ref()
                .unwrap_or_else(|| panic!("quoted: {line}"));
            assert_eq!(cue.kind, SAID, "{line}");
            assert_eq!(cue.question, line, "word for word");
        }
        for line in [
            "Friday was lovely.",
            "Can you do it by Friday?",
            "Maybe by Friday, who knows.",
            "We should finish soon.",
            "The two days we spent there were fun.",
            "Can you send it by Friday",
            "I was back from Paris on Monday.",
            "Take the Friday slot off the agenda.",
            "Share the weekend photos when you can.",
            "We may ship it in two days.",
            "Send it by Friday. Scratch that, Monday.",
            "Does legal need two full working days?",
            "Legal might need three business days.",
            "Does legal need two working days",
            "We had two full working groups ready.",
            "It takes two full lovely sunny days.",
        ] {
            let e = play_statement(line);
            assert!(
                e.state.cue.as_ref().is_none_or(|cue| cue.kind != SAID),
                "not quoted: {line}"
            );
        }
        // A long line is cut, and the same words are not quoted twice in a row.
        let long = format!("We will send it by Friday {}.", "and so on ".repeat(30));
        let e = play_statement(&long);
        assert!(e.state.cue.as_ref().unwrap().question.ends_with('…'));
        let mut e = play(&[
            (1_000, "We'll have it ready by Friday."),
            (25_000, "We'll have it ready by Friday."),
        ]);
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.advance(24_000);
        assert!(e.state.cue.is_none(), "repeated within two minutes");
    }

    #[test]
    fn a_quoted_line_is_a_cue_for_the_moment_and_never_reaches_the_notes() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (65_000, "Legal takes two days, so send it by Thursday."),
        ]);
        e.update_notes("Ask about parking".into()).unwrap();
        e.advance(65_000);
        let said = e.state.cue.as_ref().expect("the quote");
        assert_eq!(said.kind, SAID);
        assert_eq!(
            said.question,
            "Legal takes two days, so send it by Thursday."
        );
        let id = said.id.clone();
        // Held, dismissed or left to expire, the quote changes no notes.
        e.inspect_cue(&id).unwrap();
        e.respond(&id, Response::Dismiss).unwrap();
        assert!(e.state.cue.is_none());
        assert_eq!(e.state.notes, "Ask about parking");
        // In Focused mode only a line about the focus is quoted.
        let mut e = play(&[(1_000, "We'll have the signage ready by Friday.")]);
        e.set_focus(vec!["Agree the newsletter launch".into()])
            .unwrap();
        e.set_sensitivity(Sensitivity::Focused);
        e.advance(1_000);
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn a_name_that_is_also_a_question_word_does_not_turn_statements_into_questions() {
        let mut e = play(&[
            (1_000, "Will, the draft is done."),
            (2_000, "Will, can you check it?"),
        ]);
        e.set_user_name(Some("Will".into())).unwrap();
        e.advance(1_000);
        assert!(e.state.cue.is_none());
        e.advance(1_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, ASKED);
    }

    #[test]
    fn a_suggestion_replaced_before_it_was_shown_does_not_count_as_shown() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (1_500, "Robin, can you take it?"),
            (60_000, "Someone can book the hall."),
        ]);
        e.set_user_name(Some("Robin".into())).unwrap();
        e.advance(2_000); // One catch-up tick: the suggestion never reaches the user.
        assert_eq!(e.state.cue.as_ref().unwrap().kind, ASKED);
        e.advance(58_000);
        assert_eq!(e.state.cue.as_ref().unwrap().source_id, "t3");
    }

    #[test]
    fn a_direct_question_stays_while_the_user_answers() {
        let mut e = play(&[
            (1_000, "Robin, can you take the first draft?"),
            (6_000, "Moving on to the budget."),
            (10_000, "Someone can book the hall."),
            (30_000, "We should finish soon."),
        ]);
        e.set_user_name(Some("Robin".into())).unwrap();
        e.advance(1_000);
        e.advance(29_000);
        let cue = e.state.cue.as_ref().expect("still shown after 29 seconds");
        assert_eq!((cue.kind.as_str(), cue.source_id.as_str()), (ASKED, "t1"));
        assert_eq!(cue.total_ms, 45_000);
        e.advance(16_000);
        assert!(e.state.cue.is_none(), "expires after 45 seconds");
    }

    #[test]
    fn only_a_newer_direct_question_replaces_one_and_dismissal_still_works() {
        let mut e = play(&[
            (1_000, "Robin, can you take the first draft?"),
            (5_000, "What do you think about the budget, Robin?"),
        ]);
        e.set_user_name(Some("Robin".into())).unwrap();
        e.advance(5_000);
        let cue = e.state.cue.as_ref().unwrap();
        assert_eq!(cue.source_id, "t2");
        let id = cue.id.clone();
        e.respond(&id, Response::Dismiss).unwrap();
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn invalid_names_are_rejected_and_an_empty_name_clears() {
        let mut e = Engine::fictional();
        assert!(e.set_user_name(Some("Robin<script>".into())).is_err());
        assert!(e.set_user_name(Some("x".repeat(41))).is_err());
        assert!(
            e.set_user_name(Some("- -".into())).is_err(),
            "needs a letter"
        );
        e.set_user_name(Some("Mary-Kate O'Neil".into())).unwrap();
        e.set_user_name(Some("Rene\u{0301}e".into())).unwrap();
        e.set_user_name(Some("   ".into())).unwrap();
        assert!(e.state.user_name.is_none());
    }

    /// Runs the current phrase rules on the shared fictional suite that the
    /// cue lab also uses, and prints each case's action beside its label.
    /// The recorded baseline makes any change in rule behavior visible.
    #[test]
    fn rules_baseline_on_the_shared_fictional_suite() {
        let suite: serde_json::Value =
            serde_json::from_str(include_str!("../../scripts/fixtures/cue-lab.json")).unwrap();
        let mut results = vec![];
        for case in suite.as_array().unwrap() {
            let mut e = Engine::live();
            e.start().unwrap();
            let events = case["events"].as_array().unwrap();
            let existing = !case["existingCue"].is_null();
            let mut action = "quiet";
            for (index, event) in events.iter().enumerate() {
                let at = 1_000 + index as u64 * 2_000;
                e.advance(at - e.state.elapsed_ms);
                let text = event["text"].as_str().unwrap();
                let before = e.state.cue.clone();
                e.ingest(e.session(), live(event["id"].as_str().unwrap(), at, text))
                    .unwrap();
                if let (Some(cue), None) = (&before, &e.state.cue) {
                    action = if resolves(&cue.kind, text) {
                        "resolved"
                    } else {
                        "withdraw"
                    };
                }
            }
            if !existing && e.state.cue.is_some() {
                action = "show";
            }
            // For a case that starts with a visible cue, the rules can only
            // take part if the first line raised one.
            if existing && action == "quiet" && e.state.cue.is_none() {
                action = "no cue raised";
            }
            let expected = case["expected"]["action"].as_str().unwrap();
            eprintln!(
                "{:24} rules={action:14} expected={expected}",
                case["id"].as_str().unwrap()
            );
            results.push((case["id"].as_str().unwrap().to_string(), action));
        }
        // Recorded 9 November 2026 and updated the same day when the owner
        // rule gained "someone should" and "someone could", and again when
        // volunteers could say "send", "do", "sort", "book", "check", or
        // "look" as well as "take". Update it
        // deliberately when the rules change, and record the new comparison
        // in docs/cue-intelligence.md.
        let baseline = [
            ("missing-owner", "show"),
            ("already-answered", "resolved"),
            ("visible-cue-resolved", "no cue raised"),
            ("asked-but-unanswered", "quiet"),
            // 13 November 2026: "Let's leave … for another meeting" now
            // counts as a topic change.
            ("topic-moved-on", "withdraw"),
            ("uncertain-speaker", "no cue raised"),
            // 13 November 2026: a count such as "two full working days" is
            // now a time, so the first line is quoted as a Said cue. The
            // action matches the label; the rules still do not connect that
            // line to the later "Can we commit to Friday?".
            ("context-reminder", "show"),
            ("transcript-instruction", "quiet"),
            // Labels added 9 November 2026; run once each in the Claude lab
            // the same day (all three matched).
            ("context-corrected", "quiet"),
            ("paraphrased-use", "resolved"),
            ("repeated-trigger", "quiet"),
        ];
        let baseline: Vec<(String, &str)> = baseline
            .iter()
            .map(|(id, action)| (id.to_string(), *action))
            .collect();
        assert_eq!(results, baseline);
        let matched = suite
            .as_array()
            .unwrap()
            .iter()
            .zip(&results)
            .filter(|(case, (_, action))| case["expected"]["action"] == *action)
            .count();
        assert_eq!(matched, 7, "of 11; 5 before 13 November 2026");
    }

    /// The same suite from each fixture's own starting state, as the cue lab
    /// sees it: where a case lists a visible cue, that cue is put in place
    /// after its source line instead of waiting for the rules to raise one.
    /// This measures suppression and resolution separately from detection.
    /// The cue's rule type is chosen here from the fixture's wording, which
    /// the rules themselves never do.
    #[test]
    fn rules_from_each_fixtures_own_starting_cue() {
        let suite: serde_json::Value =
            serde_json::from_str(include_str!("../../scripts/fixtures/cue-lab.json")).unwrap();
        let mut results = vec![];
        let mut matched = 0;
        for case in suite.as_array().unwrap() {
            let mut e = Engine::live();
            e.start().unwrap();
            let existing = &case["existingCue"];
            let seed = (!existing.is_null()).then(|| {
                let text = existing["text"].as_str().unwrap();
                let kind = if text.starts_with("Who will") {
                    "Owner"
                } else if text.starts_with("How will we choose") {
                    "Decision"
                } else if text.starts_with("What new date") {
                    "Timing"
                } else {
                    panic!("no rule type for: {text}")
                };
                (kind, text, existing["sourceIds"][0].as_str().unwrap())
            });
            let mut seeded: Option<String> = None;
            let mut action = "quiet";
            for (index, event) in case["events"].as_array().unwrap().iter().enumerate() {
                let at = 1_000 + index as u64 * 2_000;
                e.advance(at - e.state.elapsed_ms);
                let id = event["id"].as_str().unwrap();
                let text = event["text"].as_str().unwrap();
                let before = e.state.cue.clone();
                e.ingest(e.session(), live(id, at, text)).unwrap();
                if let (Some(cue), None) = (&before, &e.state.cue) {
                    action = if resolves(&cue.kind, text) {
                        "resolved"
                    } else {
                        "withdraw"
                    };
                }
                if let Some((kind, question, source)) = seed.filter(|(_, _, source)| *source == id)
                {
                    let cue_id = format!("{}:{id}:fixture", e.generation);
                    e.cue_deadline = at + CUE_MS;
                    e.unshown = None;
                    e.last_shown.retain(|(shown, _)| shown != kind);
                    e.last_shown.push((kind.into(), at));
                    e.state.cue = Some(Cue {
                        sources: Vec::new(),
                        id: cue_id.clone(),
                        kind: kind.into(),
                        question: question.into(),
                        evidence: text.into(),
                        source_id: source.into(),
                        remaining_ms: CUE_MS,
                        total_ms: CUE_MS,
                        held: false,
                        resolved_by: None,
                        note: None,
                        about_focus: false,
                    });
                    seeded = Some(cue_id);
                }
            }
            match (&seeded, &e.state.cue) {
                // The visible cue is still the one the case started with.
                (Some(id), Some(cue)) => assert_eq!(&cue.id, id, "a second cue replaced it"),
                (None, Some(_)) => action = "show",
                _ => {}
            }
            let expected = case["expected"]["action"].as_str().unwrap();
            let id = case["id"].as_str().unwrap();
            eprintln!("{id:24} rules={action:10} expected={expected}");
            matched += usize::from(action == expected);
            results.push((id.to_string(), action));
            // Nothing from an unused cue reaches the notes.
            assert!(e.state.notes.is_empty(), "{id}");
            if let Some((_, question, _)) = seed {
                assert!(!e.markdown().contains(question), "{id}");
            }
        }
        // Recorded 13 November 2026 in docs/cue-intelligence.md.
        let recorded = [
            ("missing-owner", "show"),
            ("already-answered", "resolved"),
            ("visible-cue-resolved", "resolved"),
            ("asked-but-unanswered", "quiet"),
            ("topic-moved-on", "withdraw"),
            ("uncertain-speaker", "quiet"),
            ("context-reminder", "show"),
            ("transcript-instruction", "quiet"),
            ("context-corrected", "quiet"),
            ("paraphrased-use", "resolved"),
            ("repeated-trigger", "quiet"),
        ];
        let recorded: Vec<(String, &str)> = recorded
            .iter()
            .map(|(id, action)| (id.to_string(), *action))
            .collect();
        assert_eq!(results, recorded);
        assert_eq!(matched, 9);
    }

    /// Replays fixture cases in the held-out format through a live engine
    /// and returns each case's action: lines two seconds apart with one
    /// speaker label, the fixture's cue on screen after its source line
    /// where a case lists one (with the rule type the fixture names), and
    /// the session name where a case gives one. A cue that disappears counts
    /// as resolved when the line that removed it reads as an answer, and as
    /// withdrawn otherwise. Nothing from any case may reach the notes.
    fn replay_fixture_cases(cases: &[serde_json::Value]) -> Vec<(String, &'static str)> {
        let mut results = vec![];
        for case in cases {
            let mut e = Engine::live();
            e.start().unwrap();
            if let Some(name) = case["userName"].as_str() {
                e.set_user_name(Some(name.into())).unwrap();
            }
            let existing = &case["existingCue"];
            let seed = (!existing.is_null()).then(|| {
                (
                    existing["ruleType"].as_str().unwrap(),
                    existing["text"].as_str().unwrap(),
                    existing["sourceIds"][0].as_str().unwrap(),
                )
            });
            let mut seeded: Option<String> = None;
            let mut action = "quiet";
            for (index, event) in case["events"].as_array().unwrap().iter().enumerate() {
                let at = 1_000 + index as u64 * 2_000;
                e.advance(at - e.state.elapsed_ms);
                let id = event["id"].as_str().unwrap();
                let text = event["text"].as_str().unwrap();
                let before = e.state.cue.clone();
                e.ingest(e.session(), live(id, at, text)).unwrap();
                if let (Some(cue), None) = (&before, &e.state.cue) {
                    action = if resolves(&cue.kind, text) {
                        "resolved"
                    } else {
                        "withdraw"
                    };
                }
                if let Some((kind, question, source)) = seed.filter(|(_, _, source)| *source == id)
                {
                    let cue_id = format!("{}:{id}:fixture", e.generation);
                    e.cue_deadline = at + CUE_MS;
                    e.unshown = None;
                    e.last_shown.retain(|(shown, _)| shown != kind);
                    e.last_shown.push((kind.into(), at));
                    e.state.cue = Some(Cue {
                        sources: Vec::new(),
                        id: cue_id.clone(),
                        kind: kind.into(),
                        question: question.into(),
                        evidence: text.into(),
                        source_id: source.into(),
                        remaining_ms: CUE_MS,
                        total_ms: CUE_MS,
                        held: false,
                        resolved_by: None,
                        note: None,
                        about_focus: false,
                    });
                    seeded = Some(cue_id);
                }
            }
            match (&seeded, &e.state.cue) {
                (Some(id), Some(cue)) if &cue.id != id => action = "second cue",
                (None, Some(_)) => action = "show",
                _ => {}
            }
            let expected = case["expected"]["action"].as_str().unwrap();
            let id = case["id"].as_str().unwrap();
            let kind = e.state.cue.as_ref().map_or("", |cue| cue.kind.as_str());
            eprintln!("{id:36} rules={action:10} expected={expected:9} {kind}");
            results.push((id.to_string(), action));
            assert!(e.state.notes.is_empty(), "{id}");
        }
        results
    }

    /// How many replayed actions match the fixture's labels.
    fn matched_labels(cases: &[serde_json::Value], results: &[(String, &str)]) -> usize {
        cases
            .iter()
            .zip(results)
            .filter(|(case, (_, action))| case["expected"]["action"] == *action)
            .count()
    }

    /// Runs the phrase rules on held-out fictional cases whose labels were
    /// written and committed before the rules were run on them
    /// (`scripts/fixtures/cue-rules-held-out.json`). The labels are the
    /// rules lane's and await the owner's review. Each case starts from its
    /// own cue where it lists one, with the rule type the fixture names, and
    /// uses the session name where it gives one.
    #[test]
    fn rules_on_the_held_out_fictional_cases() {
        let suite: serde_json::Value = serde_json::from_str(include_str!(
            "../../scripts/fixtures/cue-rules-held-out.json"
        ))
        .unwrap();
        let cases = suite["cases"].as_array().unwrap();
        let results = replay_fixture_cases(cases);
        let matched = matched_labels(cases, &results);
        // Recorded 13 November 2026 in docs/cue-intelligence.md. Update it
        // deliberately when the rules change; never edit a label to match.
        let recorded = [
            ("deferral-next-month", "withdraw"),
            ("deferral-look-alike", "quiet"),
            ("deferral-of-something-else", "quiet"),
            ("correction-cancelled", "withdraw"),
            ("correction-of-something-else", "quiet"),
            ("correction-without-a-phrase", "quiet"),
            ("answered-at-once", "quiet"),
            ("answered-in-the-same-line", "show"),
            ("answered-in-other-words", "resolved"),
            ("asked-of-someone-else", "quiet"),
            ("handed-to-someone-else", "quiet"),
            ("asked-of-the-user", "show"),
            ("asked-of-the-user-without-a-comma", "quiet"),
            ("you-could-be-either", "quiet"),
            ("name-mentioned-not-addressed", "quiet"),
            ("repeat-in-other-words", "quiet"),
            ("repeat-of-a-group-question", "show"),
            ("topic-change-in-other-words", "quiet"),
            ("topic-change-look-alike", "quiet"),
            ("plain-idiom", "quiet"),
            ("plain-goodbye", "quiet"),
            ("plain-approval", "quiet"),
            ("missing-owner-in-other-words", "quiet"),
        ];
        let recorded: Vec<(String, &str)> = recorded
            .iter()
            .map(|(id, action)| (id.to_string(), *action))
            .collect();
        assert_eq!(results, recorded);
        assert_eq!((matched, cases.len()), (18, 23));
        // Doing nothing at all would match every case labeled quiet.
        let quiet = cases
            .iter()
            .filter(|case| case["expected"]["action"] == "quiet")
            .count();
        assert_eq!(quiet, 14);
    }

    /// Runs the phrase rules on independent fictional cases
    /// (`scripts/fixtures/cue-rules-independent.json`), written by a lane
    /// that had not read the engine's rules, without running them. That
    /// author had read the browser preview's stand-in (`src/lib/preview.ts`)
    /// and the opening held-out cases; the fixture records this. The labels
    /// await the owner's review. Replayed exactly as the held-out cases.
    #[test]
    fn rules_on_the_independent_fictional_cases() {
        let suite: serde_json::Value = serde_json::from_str(include_str!(
            "../../scripts/fixtures/cue-rules-independent.json"
        ))
        .unwrap();
        let cases = suite["cases"].as_array().unwrap();
        let results = replay_fixture_cases(cases);
        let matched = matched_labels(cases, &results);
        // Recorded 14 November 2026 in docs/cue-intelligence.md, before any
        // rule was changed for these cases. Update it deliberately when the
        // rules change; never edit a label to match.
        let recorded = [
            ("storeroom-chairs", "show"),
            ("server-cupboard", "quiet"),
            ("tombola-owner-lost", "quiet"),
            ("gate-shift-taken", "quiet"),
            ("compost-bins-later", "resolved"),
            ("permit-form-sometime", "show"),
            ("floor-plan-when-free", "quiet"),
            ("stall-list-thursday", "quiet"),
            ("seed-order-twentieth", "quiet"),
            ("cake-stall-tables", "show"),
            ("lift-name-at-end", "show"),
            ("posters-praise", "quiet"),
            ("as-maren-said", "quiet"),
            ("urn-for-idris", "quiet"),
            ("desks-via-hana", "quiet"),
            ("anyone-seen-gazebo", "show"),
            ("you-grab-the-float", "quiet"),
            ("caretaker-keys-again", "quiet"),
            ("risk-form-again", "quiet"),
            ("bouncy-castle-to-parking", "withdraw"),
            ("carpet-tiles-same-subject", "quiet"),
            ("skip-or-trailer-settled", "resolved"),
            ("work-party-parked", "withdraw"),
            ("shed-colour-not-tonight", "withdraw"),
            ("floor-not-moving", "quiet"),
            ("minibus-already-booked", "quiet"),
            ("tomato-glut", "quiet"),
            ("lead-and-urn-covered", "quiet"),
            ("thanks-and-tea", "quiet"),
            ("rhetorical-cake-stall", "quiet"),
            ("t-shirts-arrived", "quiet"),
            ("hall-already-swept", "quiet"),
            ("skip-date-on-sheet", "quiet"),
            ("new-office-windows", "quiet"),
        ];
        let recorded: Vec<(String, &str)> = recorded
            .iter()
            .map(|(id, action)| (id.to_string(), *action))
            .collect();
        assert_eq!(results, recorded);
        assert_eq!((matched, cases.len()), (25, 34));
        // Doing nothing at all would match every case labeled quiet.
        let quiet = cases
            .iter()
            .filter(|case| case["expected"]["action"] == "quiet")
            .count();
        assert_eq!(quiet, 17);
    }

    #[test]
    fn a_question_answered_while_catching_up_is_never_shown() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (2_000, "Jordan will take it."),
        ]);
        // One late tick delivers both lines, as after a stalled timer.
        e.advance(3_000);
        assert!(e.state.cue.is_none());
        assert!(e.cue_snapshot().cue.is_none());
        assert_eq!(e.state.transcript.len(), 2);
    }

    #[test]
    fn a_question_being_read_stays_put_and_shows_the_answer() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "Jordan will take the first draft."),
            (6_000, "Let's finish soon."),
        ]);
        e.advance(1_000);
        e.inspect_cue("1:t1").unwrap();
        e.advance(3_000);
        let cue = e.state.cue.as_ref().expect("held text is not pulled away");
        assert_eq!(cue.question, "Who will take the first draft?");
        assert_eq!(
            cue.resolved_by,
            Some(Resolution {
                sources: Vec::new(),
                source_id: "t2".into(),
                evidence: "Jordan will take the first draft.".into(),
            })
        );
        let payload = serde_json::to_value(e.cue_snapshot()).unwrap();
        assert_eq!(payload["cue"]["resolvedBy"]["sourceId"], "t2");
        // Reading a resolved cue does not let new cues compete with it.
        e.advance(2_000);
        assert_eq!(e.state.cue.as_ref().unwrap().id, "1:t1");
        e.respond("1:t1", Response::Dismiss).unwrap();
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn an_answer_leaves_space_before_the_next_question() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "Jordan will take the first draft."),
            (8_000, "We should finish soon."),
            (20_000, "We could either print it or use a sign."),
        ]);
        e.advance(8_000);
        assert!(e.state.cue.is_none(), "Cooldown follows the answer");
        e.advance(12_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Decision");
        assert!(e.state.cue.as_ref().unwrap().resolved_by.is_none());
    }

    #[test]
    fn unrelated_word_fragments_and_negative_statements_stay_quiet() {
        for text in [
            "The guide explains how monsoons affect the garden.",
            "Someone cannot take the first draft this week.",
            "Someone can't take the first draft this week.",
            "Someone can’t take the first draft this week.",
            "Someone canvassed the garden volunteers yesterday.",
            "Ask someone. Can the guide include a map?",
            "Eitherway is the name of a fictional group, or so I was told.",
        ] {
            let engine = play_statement(text);
            assert!(engine.state.cue.is_none(), "Unexpected prompt: {text}");
            assert_eq!(engine.state.transcript[0].text, text);
        }
    }

    #[test]
    fn complete_keywords_keep_their_questions_with_case_and_punctuation() {
        for (text, kind) in [
            ("SOMEONE can take the first draft.", "Owner"),
            ("We should finish 'soon'.", "Timing"),
            ("We should finish ‘soon’.", "Timing"),
            (
                "We should finish SOON—before the visitors arrive.",
                "Timing",
            ),
            (
                "We can either print it OR put a link by the gate.",
                "Decision",
            ),
        ] {
            let engine = play_statement(text);
            let cue = engine.state.cue.as_ref().expect("a useful candidate");
            assert_eq!(cue.kind, kind);
            assert_eq!(cue.evidence, text);
        }
    }

    #[test]
    fn notes_survive_expiry_and_replay_and_a_passed_question_cannot_be_answered() {
        let mut e = with_cue();
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&id, Response::Dismiss).unwrap();
        e.update_notes("Ask about a large-print version.".into())
            .unwrap();
        e.advance(100_000);
        e.start().unwrap();
        e.advance(8_000);
        let new_id = e.state.cue.as_ref().unwrap().id.clone();
        assert_ne!(new_id, id);
        assert!(e.respond(&id, Response::Dismiss).is_err());
        e.respond(&new_id, Response::Dismiss).unwrap();
        assert!(e.markdown().contains("Ask about a large-print version."));
        assert!(!e.markdown().contains("Saved questions"));
    }

    #[test]
    fn pause_freezes_transcript_and_deadline() {
        let mut e = with_cue();
        e.pause().unwrap();
        e.advance(60_000);
        assert_eq!(e.state.elapsed_ms, 8_000);
        assert_eq!(e.state.cue.as_ref().unwrap().remaining_ms, 18_000);
        e.resume().unwrap();
        e.advance(18_000);
        assert!(e.state.cue.is_none());
        assert!(e.respond("1:s2", Response::Dismiss).is_err());
    }

    #[test]
    fn an_expired_quote_leaves_no_pause_before_the_next_question() {
        let mut e = play(&[
            (10_000, "Let's have it ready by Friday."),
            (28_000, "We could either print a guide or use a sign."),
        ]);
        e.advance(10_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, SAID);
        e.advance(18_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Decision");
    }

    #[test]
    fn quiet_mode_leaves_space_after_expiry() {
        let mut e = play(&[
            (8_000, "Someone can take the first draft."),
            (37_000, "We should have it ready soon."),
            (69_000, "We could either print a guide or use a sign."),
        ]);
        e.advance(8_000);
        e.set_sensitivity(Sensitivity::Quiet);
        e.advance(18_000);
        e.advance(14_000);
        assert!(e.state.cue.is_none());
        e.advance(29_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Decision");
    }

    #[test]
    fn inspecting_keeps_the_same_question_while_the_transcript_continues() {
        let mut e = with_cue();
        e.inspect_cue("1:s2").unwrap();
        e.advance(70_000);
        let cue = e.state.cue.as_ref().unwrap();
        assert_eq!(cue.id, "1:s2");
        assert!(cue.held);
        assert_eq!(cue.remaining_ms, 0);
        assert_eq!(e.state.transcript.len(), 7);
        // Holding it again changes nothing and cannot release it.
        e.inspect_cue("1:s2").unwrap();
        e.advance(1_000);
        assert!(e.state.cue.as_ref().unwrap().held);
        e.respond("1:s2", Response::Dismiss).unwrap();
        e.advance(1_000);
        assert!(e.state.cue.is_none()); // No backlog of skipped questions.
        assert!(e.inspect_cue("1:s2").is_err());
    }

    #[test]
    fn reading_survives_playback_end_but_explicit_end_and_replay_clear_it() {
        let mut e = with_cue();
        e.inspect_cue("1:s2").unwrap();
        e.advance(u64::MAX);
        assert_eq!(e.state.status, Status::Ended);
        assert!(e.state.cue.is_some());
        e.respond("1:s2", Response::Dismiss).unwrap();
        e.start().unwrap();
        e.advance(8_000);
        assert!(e.inspect_cue("1:s2").is_err());
        assert!(!e.state.cue.as_ref().unwrap().held);
        e.inspect_cue("2:s2").unwrap();
        e.end();
        assert!(e.state.cue.is_none());
        e.start().unwrap();
        e.advance(8_000);
        e.inspect_cue("3:s2").unwrap();
        e.advance(u64::MAX);
        e.start().unwrap();
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn paused_questions_remain_actionable_and_expired_ids_cannot_be_held() {
        let mut e = with_cue();
        e.pause().unwrap();
        e.inspect_cue("1:s2").unwrap();
        e.respond("1:s2", Response::Dismiss).unwrap();
        assert_eq!(e.state.status, Status::Paused);
        e.resume().unwrap();
        e.advance(32_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Timing");
        assert!(e.inspect_cue("1:s2").is_err());
        assert!(!e.state.cue.as_ref().unwrap().held);
    }

    #[test]
    fn appearance_is_shared_with_companion_and_retained_across_a_replay() {
        let mut e = Engine::fictional();
        assert_eq!(e.state.companion_position, CompanionPosition::BottomRight);
        assert_eq!(e.state.question_size, QuestionSize::Standard);
        e.set_companion_position(CompanionPosition::TopCenter);
        e.set_question_size(QuestionSize::Large);
        e.start().unwrap();
        e.end();
        e.start().unwrap();
        let snapshot = e.cue_snapshot();
        assert_eq!(snapshot.companion_position, CompanionPosition::TopCenter);
        assert_eq!(snapshot.question_size, QuestionSize::Large);
    }

    #[test]
    fn dismiss_does_not_allow_a_double_response() {
        let mut e = with_cue();
        e.respond("1:s2", Response::Dismiss).unwrap();
        assert!(e.respond("1:s2", Response::Dismiss).is_err());
    }

    #[test]
    fn waking_after_a_scripted_session_ends_does_not_show_stale_prompts() {
        let mut e = Engine::fictional();
        e.start().unwrap();
        e.advance(u64::MAX);
        assert!(e.state.cue.is_none());
        assert_eq!(e.state.status, Status::Ended);
        assert_eq!(e.state.transcript.len(), 7);
    }

    #[test]
    fn rejected_notes_leave_previous_content_intact() {
        let mut e = Engine::fictional();
        e.update_notes("Keep this.".into()).unwrap();
        assert!(e.update_notes("x".repeat(20_001)).is_err());
        assert_eq!(e.state.notes, "Keep this.");
    }

    #[test]
    fn overlay_payload_excludes_notes_transcript_and_name() {
        let mut e = with_cue();
        e.set_user_name(Some("Robin".into())).unwrap();
        let payload = serde_json::to_value(e.cue_snapshot()).unwrap();
        assert!(payload.get("notes").is_none());
        assert!(payload.get("transcript").is_none());
        assert!(payload.get("userName").is_none());
        assert!(payload["cue"]["question"].is_string());
    }

    #[test]
    fn a_replacement_engine_never_reuses_an_earlier_session_id() {
        let mut scripted = Engine::fictional();
        scripted.start().unwrap();
        let old = scripted.session();
        let mut next = Engine::live();
        next.continue_sessions_from(&scripted);
        next.start().unwrap();
        next.advance(2_000);
        assert_ne!(next.session(), old);
        assert!(next.ingest(old, live("w1", 1_000, "Late line.")).is_err());
        next.ingest(next.session(), live("w1", 1_000, "Current line."))
            .unwrap();
    }

    fn named_session() -> Engine {
        let mut e = live_session();
        e.set_user_name(Some("Sam".into())).unwrap();
        e.advance(2_000);
        e
    }

    #[test]
    fn a_question_put_to_someone_else_by_name_raises_no_suggestion() {
        for line in [
            "Alex, can you take the first draft?",
            "Hey Jordan, could someone take the first draft?",
            "Can someone take the first draft, Alex?",
        ] {
            let mut e = named_session();
            e.ingest(e.session(), live("w1", 1_000, line)).unwrap();
            assert!(e.state.cue.is_none(), "{line}");
        }
    }

    #[test]
    fn a_count_of_working_days_follows_the_addressee_and_repeat_rules() {
        // Put to someone else by name, or to an uncertain addressee as a
        // question: nothing is quoted.
        for line in [
            "Alex, does legal need two full working days?",
            "Does legal need two full working days, Alex?",
            "Does anyone know if legal needs two full working days",
        ] {
            let mut e = named_session();
            e.ingest(e.session(), live("w1", 1_000, line)).unwrap();
            assert!(
                e.state.cue.as_ref().is_none_or(|cue| cue.kind != SAID),
                "{line}"
            );
        }
        // Asked of the user, the question itself is shown, not a quote.
        let mut e = named_session();
        let asked = "Sam, does legal need two full working days?";
        e.ingest(e.session(), live("w1", 1_000, asked)).unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, ASKED);
        // Said once, then dismissed: the same words are not quoted again
        // within two minutes, and nothing was kept in the notes.
        let line = "Legal needs two full working days after the draft is ready.";
        let mut e = play(&[(1_000, line), (25_000, line)]);
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.advance(24_000);
        assert!(e.state.cue.is_none(), "repeated within two minutes");
        assert!(e.state.notes.is_empty());
        // After a topic change the pause applies as after any withdrawal.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (4_000, "Moving on to the budget."),
            (6_000, line),
        ]);
        e.advance(6_000);
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn only_the_sentence_put_to_someone_else_is_quiet() {
        let mut e = named_session();
        let line = "Alex, can you send the deck? Someone can take the first draft.";
        e.ingest(e.session(), live("w1", 1_000, line)).unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Owner");
    }

    #[test]
    fn openers_days_groups_and_phrases_are_not_names() {
        for line in [
            "Someone can take the first draft.",
            "Everyone, someone can take the first draft?",
            "So, someone can take the first draft?",
            "Honestly, can we get it done soon?",
            "Monday, someone can take the first draft?",
            "On Monday, someone can take the first draft?",
            "In March, either we hire or we cut scope?",
            "People, someone can take the first draft?",
            "Could we ship it soon — Thursday?",
            "Alex, what a relief it will be done soon.",
            "Tomorrow, someone can take the first draft?",
            "Hopefully, we can get it done soon?",
            "Y'all, someone can take the first draft?",
        ] {
            let mut e = named_session();
            e.ingest(e.session(), live("w1", 1_000, line)).unwrap();
            assert!(e.state.cue.is_some(), "{line}");
        }
    }

    #[test]
    fn part_of_the_users_name_or_a_nickname_is_never_someone_else() {
        for line in [
            "Sam, can we get it done soon?",
            "Sammy, can we get it done soon?",
            "Lee, can we get it done soon?",
        ] {
            let mut e = live_session();
            e.set_user_name(Some("Sam Lee".into())).unwrap();
            e.advance(2_000);
            e.ingest(e.session(), live("w1", 1_000, line)).unwrap();
            assert!(e.state.cue.is_some(), "{line}");
        }
    }

    #[test]
    fn without_the_users_name_a_named_question_is_treated_as_before() {
        let mut e = live_session();
        e.advance(2_000);
        e.ingest(
            e.session(),
            live("w1", 1_000, "Alex, someone can take the first draft?"),
        )
        .unwrap();
        assert!(e.state.cue.is_some());
    }

    #[test]
    fn a_question_to_the_user_still_becomes_asked_you() {
        let mut e = live_session();
        e.set_user_name(Some("Sam".into())).unwrap();
        e.advance(2_000);
        e.ingest(
            e.session(),
            live("w1", 1_000, "Sam, can you take the first draft?"),
        )
        .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, ASKED);
    }

    /// A session named `user`, fed fictional streamed lines `(at_ms, text)`
    /// as a cloud transcriber delivers them: one speaker label, with lines
    /// split wherever the stream finalized.
    fn streamed(user: &str, lines: &[(u64, &str)]) -> Engine {
        let mut e = live_session();
        e.set_user_name(Some(user.into())).unwrap();
        for (n, (at, text)) in lines.iter().enumerate() {
            let now = e.state.elapsed_ms;
            e.advance((at + 1_000).saturating_sub(now));
            e.ingest(e.session(), live(&format!("s{n}"), *at, text))
                .unwrap();
        }
        e
    }

    #[test]
    fn a_question_split_across_two_streamed_lines_after_the_name_is_asked_of_the_user() {
        // As in lab RunB10: the stream ended one line on the name and started
        // the next with the question, under one speaker label.
        let e = streamed(
            "Maddie",
            &[
                (
                    39_609,
                    "A guest list, partners, or just members. We need to pick.",
                ),
                (45_579, "Partners doubles it. Maddie,"),
                (
                    47_429,
                    "how many came to the Springstar party? Sorry, Cass on the keyboard.",
                ),
            ],
        );
        let cue = e.state.cue.as_ref().expect("asked of the user");
        assert_eq!(cue.kind, ASKED);
        assert_eq!(
            cue.question,
            "Maddie, how many came to the Springstar party?"
        );
        // The same name without the comma, or a name far earlier, as well.
        let bare = streamed(
            "Maddie",
            &[
                (45_579, "Partners doubles it. Maddie"),
                (47_429, "how many came to the Springstar party?"),
            ],
        );
        assert_eq!(bare.state.cue.as_ref().unwrap().kind, ASKED);
        let too_late = streamed(
            "Maddie",
            &[
                (45_579, "Partners doubles it. Maddie,"),
                (52_000, "how many came to the Springstar party?"),
            ],
        );
        assert!(too_late
            .state
            .cue
            .as_ref()
            .is_none_or(|cue| cue.kind != ASKED));
    }

    #[test]
    fn a_question_to_the_user_by_name_mid_sentence_or_without_a_comma_is_asked() {
        for line in [
            "So Maddie, how many came to the Springstar party?",
            "Partners doubles it, Maddie, how many came to the party?",
            "Maddie how many came to the Springstar party?",
            "Okay so Maddie can you check the guest list?",
        ] {
            let e = streamed("Maddie", &[(10_000, line)]);
            assert_eq!(
                e.state.cue.as_ref().map(|cue| cue.kind.as_str()),
                Some(ASKED),
                "{line}"
            );
        }
    }

    #[test]
    fn a_name_set_off_mid_sentence_counts_only_when_what_follows_asks_them() {
        for quiet in [
            "Our treasurer, Maya, will send the figures.",
            "The new lead, Maya, is joining us next week.",
            "I spoke to Robin, Maya, who said it's fine.",
            "Did you invite Alex, Maya, and Sam?",
            "Did you meet the new lead, Maya, who starts Monday?",
            "Did you ask our treasurer, Maya, what she needs?",
            "Didn't you meet the new lead, Maya, who starts Monday?",
            "Maya what a party?",
        ] {
            let e = streamed("Maya", &[(10_000, quiet)]);
            assert!(
                e.state.cue.as_ref().is_none_or(|cue| cue.kind != ASKED),
                "{quiet}"
            );
        }
        for asked in [
            "The budget is fine, Maya, what's left on the list?",
            "The schedule changed, Maya, who will cover Monday?",
            "Maya, who starts Monday?",
            "Maya, what does the treasurer need?",
            "Could you, Maya, field the complaints?",
            "Maya what's the plan for Saturday?",
            "The van is booked, Maya, can you drive it?",
            "If it locks anyone out, could you, Maya, field the complaints?",
        ] {
            let e = streamed("Maya", &[(10_000, asked)]);
            assert_eq!(
                e.state.cue.as_ref().map(|cue| cue.kind.as_str()),
                Some(ASKED),
                "{asked}"
            );
        }
    }

    #[test]
    fn a_name_ending_one_speakers_line_is_not_joined_to_the_next_speakers_question() {
        let mut e = live_session();
        e.set_user_name(Some("Maddie".into())).unwrap();
        e.advance(12_000);
        let mut first = live("s1", 10_000, "That one is for Maddie,");
        first.speaker = "Speaker 1".into();
        e.ingest(e.session(), first).unwrap();
        let mut second = live("s2", 11_000, "how many came to the party?");
        second.speaker = "Speaker 2".into();
        e.ingest(e.session(), second).unwrap();
        assert!(e.state.cue.as_ref().is_none_or(|cue| cue.kind != ASKED));
    }

    #[test]
    fn a_question_joined_across_two_lines_is_quoted_whole_so_the_card_shows_it_once() {
        let e = streamed(
            "Maddie",
            &[
                (45_579, "Partners doubles it. Maddie,"),
                (47_429, "how many came to the Springstar party?"),
            ],
        );
        let cue = e.state.cue.as_ref().unwrap();
        assert_eq!(
            cue.question,
            "Maddie, how many came to the Springstar party?"
        );
        // The card quotes the line around the question; the question itself
        // must be found in it, or it would appear twice.
        assert!(cue.evidence.contains(&cue.question), "{}", cue.evidence);
        assert_eq!(cue.source_id, "s1");
    }

    #[test]
    fn the_users_name_merely_mentioned_is_not_a_question_to_them() {
        for lines in [
            // From RunB10.
            &[
                (100_219, "I'm away Friday."),
                (101_589, "Maybe Maddie takes it."),
            ][..],
            &[(10_000, "Maddie can take it?")],
            &[(10_000, "I think we should ask Maddie how many came?")],
            // A line ending on the name, then a statement, not a question.
            &[
                (10_000, "That's for Maddie"),
                (11_000, "the van is booked for Saturday."),
            ],
            // A misspelling is not matched: names are too easily confused.
            &[(10_000, "Maddy, how many came to the party?")],
        ] {
            let e = streamed("Maddie", lines);
            assert!(
                e.state.cue.as_ref().is_none_or(|cue| cue.kind != ASKED),
                "{lines:?}"
            );
        }
    }

    fn after(first: &str, second: &str, second_speaker: &str, gap_ms: u64) -> Engine {
        let mut e = live_session();
        e.ingest(e.session(), live("w1", 9_000, first)).unwrap();
        e.advance(gap_ms);
        let mut line = live("w2", 9_000 + gap_ms, second);
        line.speaker = second_speaker.into();
        e.ingest(e.session(), line).unwrap();
        e
    }

    #[test]
    fn an_explicit_correction_withdraws_the_question_from_the_line_just_taken_back() {
        for correction in [
            "Sorry, I misspoke. The review isn't moving.",
            "Scratch that, the review stays put.",
            "Correction: the review stays where it is.",
            "Never mind.",
        ] {
            let e = after("The review is moving soon.", correction, "Speaker 1", 2_000);
            assert!(e.state.cue.is_none(), "{correction}");
        }
    }

    #[test]
    fn a_correction_of_something_else_leaves_the_question() {
        // Another speaker, or too long after the line, or a phrase that runs on.
        for (line, speaker, gap) in [
            ("Scratch that, the room is booked.", "Speaker 2", 2_000),
            ("Scratch that.", "Speaker 1", 12_000),
            ("Actually, that sounds great.", "Speaker 1", 2_000),
            ("Did I misspeak earlier?", "Speaker 1", 2_000),
            ("Correction fluid is on the shelf.", "Speaker 1", 2_000),
            ("No, never mind the cost, it is fine.", "Speaker 1", 2_000),
            (
                "I was wrong about the vendor last week.",
                "Speaker 1",
                2_000,
            ),
        ] {
            let e = after("The review is moving soon.", line, speaker, gap);
            assert!(e.state.cue.is_some(), "{line}");
        }
    }

    #[test]
    fn what_follows_a_correction_can_still_raise_a_question() {
        let mut e = live_session();
        e.ingest(
            e.session(),
            live("w1", 9_000, "Scratch that, someone can take it."),
        )
        .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Owner");
        assert_eq!(
            corrects("Never mind — Alex has it."),
            Some("Never mind —".len())
        );
        assert_eq!(corrects("Um — never mind."), Some("Um — never mind.".len()));
    }

    #[test]
    fn a_question_to_the_user_taken_back_in_the_same_line_is_not_asked() {
        let mut e = live_session();
        e.set_user_name(Some("Sam".into())).unwrap();
        let line = "Sam, can you take the draft? Never mind, Alex has it.";
        e.ingest(e.session(), live("w1", 9_000, line)).unwrap();
        assert!(e.state.cue.as_ref().is_none_or(|cue| cue.kind != ASKED));
    }

    #[test]
    fn live_transcripts_cannot_tell_who_corrected() {
        // Whisper labels every line "Speaker", so any correction right after
        // the line counts; this documents that limit.
        let mut e = live_session();
        let mut first = live("w1", 9_000, "The review is moving soon.");
        first.speaker = "Speaker".into();
        e.ingest(e.session(), first).unwrap();
        e.advance(2_000);
        let mut second = live("w2", 11_000, "Never mind.");
        second.speaker = "Speaker".into();
        e.ingest(e.session(), second).unwrap();
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn words_taken_back_in_the_same_line_raise_no_question() {
        let mut e = live_session();
        let line = "The review is moving soon. Scratch that, it is staying put.";
        e.ingest(e.session(), live("w1", 9_000, line)).unwrap();
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn a_correction_leaves_a_question_being_read_or_asked_of_the_user() {
        let mut e = live_session();
        e.ingest(e.session(), live("w1", 9_000, "The review is moving soon."))
            .unwrap();
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.inspect_cue(&id).unwrap();
        e.advance(2_000);
        e.ingest(e.session(), live("w2", 11_000, "Scratch that."))
            .unwrap();
        assert!(e.state.cue.as_ref().is_some_and(|cue| cue.held));

        let mut e = live_session();
        e.set_user_name(Some("Sam".into())).unwrap();
        e.ingest(
            e.session(),
            live("w1", 9_000, "Sam, can you take the draft?"),
        )
        .unwrap();
        e.advance(2_000);
        e.ingest(e.session(), live("w2", 11_000, "Never mind."))
            .unwrap();
        // Kept on purpose: the user may still want to answer.
        assert_eq!(e.state.cue.as_ref().unwrap().kind, ASKED);
    }

    #[test]
    fn an_explicit_question_put_to_the_group_becomes_an_open_question_cue() {
        for line in [
            "Does anyone have time to review the draft this week?",
            "So, any thoughts on the timeline?",
            "Who can take the welcome guide?",
            "Would anyone object to moving the review?",
        ] {
            let mut e = live_session();
            e.ingest(e.session(), live("w1", 9_000, line)).unwrap();
            let cue = e.state.cue.as_ref().unwrap_or_else(|| panic!("{line}"));
            assert_eq!(cue.kind, OPEN, "{line}");
            assert_eq!(cue.question, line.trim(), "{line}");
        }
    }

    #[test]
    fn statements_other_questions_and_named_questions_are_not_open_questions() {
        for line in [
            "Anyone can send the file later.",
            "Does anyone have time this week",
            "Is the review still on Friday?",
            "Alex, can you take the welcome guide?",
            "What do you think, Sam?",
            // Call logistics, not the work.
            "Can anyone hear me?",
            "Does anyone mind if I share my screen?",
            "Who's on the call?",
            "Would anyone like a coffee?",
            // Answered in the same line.
            "Who can take the welcome guide? I'll take it.",
        ] {
            let mut e = live_session();
            e.set_user_name(Some("Sam".into())).unwrap();
            e.ingest(e.session(), live("w1", 9_000, line)).unwrap();
            assert!(
                e.state.cue.as_ref().is_none_or(|cue| cue.kind != OPEN),
                "{line}"
            );
        }
    }

    #[test]
    fn an_open_question_is_withdrawn_by_an_answer_and_not_re_raised_but_another_may_follow() {
        let mut e = live_session();
        e.ingest(
            e.session(),
            live("w1", 9_000, "Who can take the welcome guide?"),
        )
        .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, OPEN);
        e.advance(2_000);
        e.ingest(e.session(), live("w2", 11_000, "Maya will take it."))
            .unwrap();
        assert!(e.state.cue.is_none(), "answered by a named owner");
        // Past the pause, the same question is a repeat; a different one is not.
        e.advance(12_000);
        e.ingest(
            e.session(),
            live("w3", 23_000, "Who can take the welcome guide?"),
        )
        .unwrap();
        assert!(e.state.cue.is_none(), "same question within two minutes");
        e.advance(2_000);
        e.ingest(
            e.session(),
            live("w4", 25_000, "Any objections to moving the review?"),
        )
        .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, OPEN);
    }

    #[test]
    fn a_suppressed_fixed_question_does_not_come_back_as_an_open_question() {
        let mut e = live_session();
        e.ingest(e.session(), live("w1", 9_000, "Someone can take notes."))
            .unwrap();
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&id, Response::Dismiss).unwrap();
        e.advance(12_000);
        e.ingest(
            e.session(),
            live("w2", 21_000, "Someone can take notes, who can take it?"),
        )
        .unwrap();
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn a_self_answered_question_does_not_hide_a_later_one_in_the_same_line() {
        let line = "Who can take notes? I'll take it. Any objections to Friday?";
        assert_eq!(
            open_question(line).as_deref(),
            Some("Any objections to Friday?")
        );
    }

    #[test]
    fn a_long_open_question_is_cut_with_an_ellipsis() {
        let long = format!("Does anyone {}?", "really ".repeat(40));
        let question = open_question(&long).unwrap();
        assert_eq!(question.chars().count(), 200);
        assert!(question.ends_with('…'));
    }

    #[test]
    fn a_fixed_question_wins_over_an_open_question_in_the_same_line() {
        let mut e = live_session();
        e.ingest(
            e.session(),
            live("w1", 9_000, "Someone can take it. Who can take it?"),
        )
        .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Owner");
    }

    fn with_notes() -> Engine {
        let mut e = live_session();
        e.set_notes(vec![
            ContextItem {
                provider: crate::context::Provider::File,
                source_id: "n1".into(),
                title: "Garden welcome guide".into(),
                source_date: "2026-10-28".into(),
                excerpt: "Draft a one-page guide with a map of the tool shed.".into(),
                revision: 1,
            },
            ContextItem {
                provider: crate::context::Provider::File,
                source_id: "n2".into(),
                title: "Sign".into(),
                source_date: "2026-11-05".into(),
                excerpt: "Too short a title to match.".into(),
                revision: 1,
            },
        ]);
        e
    }

    #[test]
    fn a_kept_meeting_leaves_out_note_reminders_and_the_still_open_list() {
        // A reminder quoting an imported note.
        let mut e = with_notes();
        e.ingest(
            e.session(),
            live(
                "w1",
                9_000,
                "Let's get the welcome guide sorted before the garden day.",
            ),
        )
        .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, CONTEXT);
        e.set_keep_meeting(true);
        let kept = e.markdown();
        assert!(kept.contains("## Cues shown\n\nNone.\n"), "{kept}");
        assert!(kept.contains("before the garden day."));
        for excluded in ["Garden welcome guide", "tool shed", "Context"] {
            assert!(!kept.contains(excluded), "{excluded} in {kept}");
        }

        // The Still open list of focus lines at the wrap-up, as the
        // derailed-meeting check raises it.
        let mut e = play(&[
            (1_000, "Someone can take the first draft of the newsletter."),
            (12_000, "Did anyone see the match last night?"),
            (23_000, "Someone can bring snacks soon."),
            (34_000, "We could go either to the park or the river."),
            (45_000, "Does anyone have a recommendation for a plumber?"),
            (56_000, "Someone should look at the compost bins soon."),
            (67_000, "Anyway, that was a long tangent."),
            (78_000, "Before we finish, anything else?"),
            (90_000, "To wrap up then, thanks everyone."),
        ]);
        e.set_focus(vec!["Agree the launch plan for the newsletter".into()])
            .unwrap();
        e.set_sensitivity(Sensitivity::Focused);
        e.advance(78_000);
        assert_eq!(e.state.cue.as_ref().expect("still open").kind, STILL_OPEN);
        let shown: Vec<_> = e.shown_cues.iter().map(|c| c.kind.clone()).collect();
        assert!(!shown.iter().any(|kind| kind == STILL_OPEN));
        e.set_keep_meeting(true);
        let kept = e.markdown();
        assert!(!kept.contains("Agree the launch plan"), "{kept}");
        assert!(!kept.contains(STILL_OPEN), "{kept}");
    }

    #[test]
    fn a_line_about_an_imported_note_raises_a_context_cue_with_the_note_as_source() {
        let mut e = with_notes();
        e.ingest(
            e.session(),
            live(
                "w1",
                9_000,
                "Let's get the welcome guide sorted before the garden day.",
            ),
        )
        .unwrap();
        let cue = e.state.cue.as_ref().unwrap();
        assert_eq!(cue.kind, CONTEXT);
        assert_eq!(cue.question, "Garden welcome guide");
        assert!(cue.evidence.contains("tool shed"));
        assert_eq!(cue.note.as_ref().unwrap().source_date, "2026-10-28");
        assert_eq!(cue.source_id, "file:n1");
    }

    #[test]
    fn newer_note_import_clears_old_reminders_without_replacing_or_repeating_them() {
        use crate::context::{ContextStore, Provider};
        for provider in [Provider::File, Provider::Granola] {
            for held in [false, true] {
                for change in ["revision", "excerpt", "title", "date"] {
                    let original = ContextItem {
                        provider,
                        source_id: "welcome".into(),
                        title: "Garden welcome guide".into(),
                        source_date: "2026-10-28".into(),
                        excerpt: "Use the tool shed map.".into(),
                        revision: 1,
                    };
                    let mut store = ContextStore::default();
                    let selection = vec![original.source_id.clone()];
                    assert_eq!(
                        store
                            .merge(provider, &selection, vec![original.clone()])
                            .added,
                        1
                    );
                    let mut e = live_session();
                    e.update_notes("A manual notebook line.".into()).unwrap();
                    e.set_notes(store.items().to_vec());
                    e.ingest(e.session(), live("w1", 9_000, "Review the welcome guide."))
                        .unwrap();
                    let id = e.state.cue.as_ref().unwrap().id.clone();
                    if held {
                        e.inspect_cue(&id).unwrap();
                        e.pause().unwrap();
                    }
                    let mut updated = original.clone();
                    updated.revision = 2;
                    match change {
                        "excerpt" => updated.excerpt = "Use the greenhouse map instead.".into(),
                        "title" => updated.title = "Updated garden welcome guide".into(),
                        "date" => updated.source_date = "2026-11-02".into(),
                        _ => (),
                    }
                    assert_eq!(
                        store
                            .merge(provider, &selection, vec![updated.clone()])
                            .updated,
                        1
                    );
                    let before = e.state.revision;
                    e.set_notes(store.items().to_vec());
                    assert!(e.state.revision > before, "publish retirement: {change}");
                    assert!(e.state.cue.is_none(), "obsolete {change}, held={held}");
                    assert!(e.cue_snapshot().cue.is_none());
                    assert!(e.inspect_cue(&id).is_err());
                    assert!(!serde_json::to_string(&e.state)
                        .unwrap()
                        .contains("tool shed"));
                    assert!(!e.markdown().contains("greenhouse"));
                    assert_eq!(e.state.notes, "A manual notebook line.");
                    if held {
                        e.resume().unwrap();
                    }
                    e.advance(30_000);
                    e.ingest(
                        e.session(),
                        live("w2", e.state.elapsed_ms, "Review the welcome guide."),
                    )
                    .unwrap();
                    assert!(
                        e.state.cue.is_none(),
                        "refresh must not re-arm the reminder"
                    );
                    // A later session can use the refreshed source, including
                    // when the runtime replaces the engine for live capture.
                    let mut replacement = Engine::live();
                    replacement.copy_notes_from(&e);
                    replacement.start().unwrap();
                    replacement.advance(1_000);
                    replacement
                        .ingest(
                            replacement.session(),
                            live("new", 1_000, "Review the welcome guide."),
                        )
                        .unwrap();
                    let cue = replacement.state.cue.as_ref().unwrap();
                    assert_eq!(cue.question, updated.title);
                    assert_eq!(cue.evidence, updated.excerpt);
                    assert_eq!(cue.note.as_ref().unwrap().source_date, updated.source_date);
                    assert_eq!(cue.note.as_ref().unwrap().provider, provider.id());
                    // A revision-only update must also survive engine copying.
                    updated.revision = 3;
                    store.merge(provider, &selection, vec![updated]);
                    replacement.set_notes(store.items().to_vec());
                    assert!(replacement.state.cue.is_none());
                }
            }
        }
    }

    #[test]
    fn repeated_older_and_unrelated_imports_preserve_the_held_reminder() {
        use crate::context::{ContextStore, Provider};
        let mut e = with_notes();
        let original = e.notes[0].item.clone();
        let mut store = ContextStore::default();
        let selection = vec![original.source_id.clone()];
        store.merge(Provider::File, &selection, vec![original.clone()]);
        e.set_notes(store.items().to_vec());
        e.ingest(e.session(), live("w1", 9_000, "Review the welcome guide."))
            .unwrap();
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.inspect_cue(&id).unwrap();
        let before = serde_json::to_string(&e.cue_snapshot()).unwrap();
        for revision in [1, 0] {
            let mut duplicate = original.clone();
            duplicate.revision = revision;
            duplicate.excerpt = "An old or repeated response must not replace the note.".into();
            assert_eq!(
                store
                    .merge(Provider::File, &selection, vec![duplicate])
                    .unchanged,
                1
            );
            e.set_notes(store.items().to_vec());
            assert_eq!(serde_json::to_string(&e.cue_snapshot()).unwrap(), before);
        }
        // Equal source IDs from different providers are separate notes.
        let mut other = original;
        other.provider = Provider::Granola;
        for revision in [2, 3] {
            other.revision = revision;
            other.excerpt = format!("Unrelated provider revision {revision}.");
            store.merge(Provider::Granola, &selection, vec![other.clone()]);
            e.set_notes(store.items().to_vec());
            assert_eq!(serde_json::to_string(&e.cue_snapshot()).unwrap(), before);
        }
        store.remove(Provider::Granola, &other.source_id);
        e.set_notes(store.items().to_vec());
        assert_eq!(serde_json::to_string(&e.cue_snapshot()).unwrap(), before);
        // A transcript question is unaffected by changes to imported notes.
        e.respond(&id, Response::Dismiss).unwrap();
        e.advance(20_000);
        e.ingest(
            e.session(),
            live("w2", e.state.elapsed_ms, "Someone can take the draft."),
        )
        .unwrap();
        let id = e.state.cue.as_ref().unwrap().id.clone();
        let mut refreshed = store.items()[0].clone();
        refreshed.revision += 1;
        store.merge(Provider::File, &selection, vec![refreshed]);
        e.set_notes(store.items().to_vec());
        assert_eq!(e.state.cue.as_ref().unwrap().id, id);
    }

    #[test]
    fn removing_an_imported_note_clears_its_held_cue_without_exporting_the_excerpt() {
        for held in [false, true] {
            let mut e = with_notes();
            e.update_notes("A manual notebook line.".into()).unwrap();
            e.ingest(e.session(), live("w1", 9_000, "Review the welcome guide."))
                .unwrap();
            let cue = e.state.cue.as_ref().unwrap();
            assert!(cue.evidence.contains("tool shed"));
            let id = cue.id.clone();
            if held {
                e.inspect_cue(&id).unwrap();
            }
            assert!(!e.markdown().contains("tool shed"));
            assert!(!e.markdown().contains("file:n1"));
            let before = e.state.revision;
            // Remove the displayed note while another imported note remains.
            e.set_notes(vec![ContextItem {
                provider: crate::context::Provider::File,
                source_id: "n2".into(),
                title: "Sign".into(),
                source_date: "2026-11-05".into(),
                excerpt: "An unrelated imported excerpt.".into(),
                revision: 1,
            }]);
            assert!(
                e.state.revision > before,
                "removal must publish a new cue state"
            );
            assert!(e.state.cue.is_none());
            assert!(e.cue_snapshot().cue.is_none());
            assert!(!serde_json::to_string(&e.state)
                .unwrap()
                .contains("tool shed"));
            assert!(!e.markdown().contains("imported excerpt"));
            assert!(e.markdown().contains("A manual notebook line."));
            assert!(e.inspect_cue(&id).is_err());
        }
        let mut e = with_notes();
        e.ingest(
            e.session(),
            live("w1", 9_000, "Someone can take the welcome guide."),
        )
        .unwrap();
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.set_notes(vec![]);
        assert_eq!(
            e.state.cue.as_ref().unwrap().id,
            id,
            "an unrelated question stays"
        );
    }

    #[test]
    fn one_title_word_or_a_short_title_is_not_enough_and_a_note_is_shown_once() {
        let mut e = with_notes();
        e.ingest(e.session(), live("w1", 9_000, "The guide is late."))
            .unwrap();
        assert!(e.state.cue.is_none(), "one term");
        e.ingest(e.session(), live("w2", 9_500, "Sign it today."))
            .unwrap();
        assert!(e.state.cue.is_none(), "short title has no terms");
        e.ingest(
            e.session(),
            live("w3", 10_000, "The welcome guide needs a map."),
        )
        .unwrap();
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&id, Response::Dismiss).unwrap();
        e.advance(20_000);
        e.ingest(
            e.session(),
            live("w4", 30_000, "Back to the welcome guide and the map."),
        )
        .unwrap();
        assert!(e.state.cue.is_none(), "already shown this session");
    }

    #[test]
    fn a_fixed_question_wins_over_a_context_cue_and_removed_notes_stop_matching() {
        let mut e = with_notes();
        e.ingest(
            e.session(),
            live("w1", 9_000, "Someone can take the welcome guide."),
        )
        .unwrap();
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Owner");
        let mut e = with_notes();
        e.set_notes(vec![]);
        e.ingest(
            e.session(),
            live("w1", 9_000, "The welcome guide for the garden."),
        )
        .unwrap();
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn common_words_long_titles_excerpts_and_retracted_words_do_not_match() {
        let mut e = live_session();
        e.set_notes(vec![
            ContextItem {
                provider: crate::context::Provider::File,
                source_id: "a".into(),
                title: "Weekly planning meeting notes".into(),
                source_date: "2026-11-01".into(),
                excerpt: "Agenda items.".into(),
                revision: 1,
            },
            ContextItem {
                provider: crate::context::Provider::File,
                source_id: "b".into(),
                title: "Orchard volunteer handover plan for spring planting season and watering schedule".into(),
                source_date: "2026-11-02".into(),
                excerpt: "Seedling trays go to the north shed.".into(),
                revision: 1,
            },
            ContextItem {
                provider: crate::context::Provider::File,
                source_id: "c".into(),
                title: "Jardín opening".into(),
                source_date: "2026-11-03".into(),
                excerpt: "Menu draft.".into(),
                revision: 1,
            },
        ]);
        e.ingest(
            e.session(),
            live("w1", 9_000, "We should start planning the meeting."),
        )
        .unwrap();
        assert!(e.state.cue.is_none(), "stop words never identify a note");
        e.ingest(
            e.session(),
            live("w2", 9_200, "The seedling trays and the north shed again."),
        )
        .unwrap();
        assert!(
            e.state.cue.is_none(),
            "excerpt words do not match, only the title"
        );
        e.ingest(
            e.session(),
            live("w3", 9_400, "The orchard handover is next week."),
        )
        .unwrap();
        assert!(
            e.state.cue.is_none(),
            "two of a long title's eight words are not enough"
        );
        e.ingest(
            e.session(),
            live(
                "w4",
                9_600,
                "The orchard handover and the watering schedule.",
            ),
        )
        .unwrap();
        assert_eq!(
            e.state.cue.as_ref().unwrap().question,
            "Orchard volunteer handover plan for spring planting season and watering schedule"
        );
        let id = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&id, Response::Dismiss).unwrap();
        e.advance(20_000);
        e.ingest(
            e.session(),
            live(
                "w5",
                30_000,
                "The jardín opening is on. Scratch that, it is off.",
            ),
        )
        .unwrap();
        assert!(e.state.cue.is_none(), "words taken back do not match");
        e.advance(2_000);
        e.ingest(e.session(), live("w6", 31_000, "Now, the jardín opening."))
            .unwrap();
        assert_eq!(
            e.state.cue.as_ref().unwrap().question,
            "Jardín opening",
            "accented words count"
        );
    }

    #[test]
    fn notes_carry_to_a_replacement_engine_and_a_new_session_may_show_them_again() {
        let mut e = with_notes();
        e.ingest(
            e.session(),
            live("w1", 9_000, "The welcome guide for the garden."),
        )
        .unwrap();
        assert!(e.state.cue.is_some());
        let mut next = Engine::live();
        next.copy_notes_from(&e);
        next.start().unwrap();
        next.advance(10_000);
        next.ingest(
            next.session(),
            live("w1", 9_000, "The welcome guide for the garden."),
        )
        .unwrap();
        assert_eq!(
            next.state.cue.as_ref().map(|cue| cue.kind.as_str()),
            Some(CONTEXT),
            "a new session starts with no note shown yet"
        );
    }

    #[test]
    fn empty_ended_live_session_returns_to_ready_while_non_empty_stays_ended() {
        let mut empty = Engine::live();
        empty.start().unwrap();
        empty.advance(12_000);
        empty.update_notes("   \n".into()).unwrap();
        empty.end();
        empty.return_to_ready_if_empty();
        assert!(!empty.state.live);
        assert_eq!(empty.state.status, Status::Ready);
        assert_eq!(empty.state.elapsed_ms, 0);

        let mut with_notes = Engine::live();
        with_notes.start().unwrap();
        with_notes.advance(12_000);
        with_notes
            .update_notes("Fictional gate key note.".into())
            .unwrap();
        with_notes.end();
        with_notes.return_to_ready_if_empty();
        assert!(with_notes.state.live);
        assert_eq!(with_notes.state.status, Status::Ended);

        let mut with_line = Engine::live();
        with_line.start().unwrap();
        with_line.advance(5_000);
        with_line
            .ingest(
                with_line.session(),
                live("s1", 2_000, "Let us meet Thursday."),
            )
            .unwrap();
        with_line.end();
        with_line.return_to_ready_if_empty();
        assert!(with_line.state.live);
        assert_eq!(with_line.state.status, Status::Ended);
    }
}

// Compile the inert facade where native activation is unavailable. Activated
// builds run its root-module tests once, without duplicate socket fixtures.
#[cfg(all(
    test,
    unix,
    not(all(
        debug_assertions,
        target_os = "macos",
        feature = "native-audio-spike",
        feature = "lab-evaluator"
    ))
))]
#[path = "lab_evaluator.rs"]
mod lab_evaluator_offline;
