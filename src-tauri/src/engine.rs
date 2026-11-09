use serde::{Deserialize, Serialize};

const CUE_MS: u64 = 18_000;
/// A question asked of the user stays long enough for them to answer.
const ASKED_MS: u64 = 45_000;
/// A question type shown within this window is not asked again.
const REPEAT_MS: u64 = 120_000;
const MAX_NOTE_CHARS: usize = 20_000;
const MAX_SEGMENT_CHARS: usize = 1_000;
const MAX_SPEAKER_CHARS: usize = 80;
const MAX_SEGMENT_ID_BYTES: usize = 64;
const MAX_TRANSCRIPT_SEGMENTS: usize = 400;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub at_ms: u64,
    pub speaker: String,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Demo {
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

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Sensitivity {
    Balanced,
    Quiet,
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
    pub source_id: String,
    pub remaining_ms: u64,
    pub total_ms: u64,
    pub held: bool,
    pub expanded: bool,
    /// Later conversation that appears to answer this cue. Only a held cue
    /// can carry this: an unheld answered cue is withdrawn instead.
    pub resolved_by: Option<Resolution>,
    /// Set for a context cue: the imported note it quotes.
    pub note: Option<NoteRef>,
    /// True when the line uses words from the user's meeting goal: the
    /// question then skips the pause after another cue and stays longer.
    pub about_goal: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub source_id: String,
    pub evidence: String,
}

/// The imported note a context cue comes from, so the companion can say so
/// instead of presenting the note as something said in the conversation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRef {
    pub title: String,
    pub source_date: String,
    pub provider: String,
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
/// A meeting goal is one short line.
const MAX_GOAL_CHARS: usize = 80;
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
    title: String,
    source_date: String,
    provider: String,
    excerpt: String,
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
    /// True for a live session fed by transcription rather than the demo.
    pub live: bool,
    /// The person's name for this session only, used to notice questions
    /// asked of them. Never saved, and not sent to the companion.
    pub user_name: Option<String>,
    /// What the user wants from this meeting, for this session only, used to
    /// let questions about it through sooner. Never saved, and not sent to
    /// the companion.
    pub goal: Option<String>,
}

// The floating window never receives the notebook or full transcript.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueSnapshot {
    pub revision: u64,
    pub status: Status,
    pub live: bool,
    pub cue: Option<Cue>,
    pub overlay_enabled: bool,
    pub companion_position: CompanionPosition,
    pub question_size: QuestionSize,
}

pub struct Engine {
    demo: Demo,
    pub state: Snapshot,
    generation: u64,
    next_segment: usize,
    cue_deadline: u64,
    cooldown_until: u64,
    /// Whether this session's transcript includes ingested (non-demo) lines.
    live_input: bool,
    /// The user's name for this app session, used to recognize questions
    /// addressed to them. Never stored or sent anywhere.
    /// When each question type was last shown in this session.
    last_shown: Vec<(String, u64)>,
    /// Words of the meeting goal that identify it, as for a note title.
    goal_terms: Vec<String>,
    /// Imported notes prepared for matching, and the keys already shown.
    notes: Vec<NoteTerms>,
    shown_notes: Vec<String>,
    /// A cue type created since the last publish, with its previous time.
    unshown: Option<(String, Option<u64>)>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::from_demo(
            serde_json::from_str(include_str!("../../src/demo.json"))
                .expect("bundled fictional demo is valid"),
        )
    }
}

impl Engine {
    /// A session with no scripted demo lines, for transcript input through
    /// `ingest`. It runs until ended.
    pub fn live() -> Self {
        Self::from_demo(Demo {
            title: "Live session".into(),
            description: "Transcript lines from a local transcription source.".into(),
            duration_ms: u64::MAX,
            segments: vec![],
        })
    }

    fn from_demo(demo: Demo) -> Self {
        Self {
            state: Snapshot {
                revision: 0,
                title: demo.title.clone(),
                description: demo.description.clone(),
                status: Status::Ready,
                elapsed_ms: 0,
                duration_ms: demo.duration_ms,
                transcript: vec![],
                cue: None,
                notes: String::new(),
                sensitivity: Sensitivity::Balanced,
                overlay_enabled: true,
                companion_position: CompanionPosition::BottomRight,
                question_size: QuestionSize::Standard,
                live: demo.segments.is_empty() && demo.duration_ms == u64::MAX,
                user_name: None,
                goal: None,
            },
            demo,
            generation: 0,
            next_segment: 0,
            cue_deadline: 0,
            cooldown_until: 0,
            live_input: false,
            last_shown: vec![],
            goal_terms: vec![],
            notes: vec![],
            shown_notes: vec![],
            unshown: None,
        }
    }

    pub fn cue_snapshot(&self) -> CueSnapshot {
        CueSnapshot {
            revision: self.state.revision,
            status: self.state.status,
            live: self.state.live,
            cue: self.state.cue.clone(),
            overlay_enabled: self.state.overlay_enabled,
            companion_position: self.state.companion_position,
            question_size: self.state.question_size,
        }
    }

    fn changed(&mut self) {
        // Publishing the state shows any cue created since the last change.
        self.unshown = None;
        self.state.revision += 1;
    }

    pub fn start(&mut self) -> Result<(), String> {
        if matches!(self.state.status, Status::Running | Status::Paused) {
            return Err("End the current demo before replaying it.".into());
        }
        self.generation += 1;
        self.live_input = false;
        self.last_shown.clear();
        self.shown_notes.clear();
        self.next_segment = 0;
        self.cooldown_until = 0;
        self.state.elapsed_ms = 0;
        self.state.transcript.clear();
        self.state.cue = None;
        self.state.status = Status::Running;
        self.changed();
        Ok(())
    }

    pub fn pause(&mut self) -> Result<(), String> {
        if self.state.status != Status::Running {
            return Err("Only a running demo can be paused.".into());
        }
        self.state.status = Status::Paused;
        self.changed();
        Ok(())
    }

    pub fn resume(&mut self) -> Result<(), String> {
        if self.state.status != Status::Paused {
            return Err("Only a paused demo can be resumed.".into());
        }
        self.state.status = Status::Running;
        self.changed();
        Ok(())
    }

    pub fn end(&mut self) {
        self.state.status = Status::Ended;
        self.state.cue = None;
        self.changed();
    }

    pub fn advance(&mut self, delta_ms: u64) {
        if self.state.status != Status::Running || delta_ms == 0 {
            return;
        }
        self.state.elapsed_ms = self
            .state
            .elapsed_ms
            .saturating_add(delta_ms)
            .min(self.demo.duration_ms);
        let now = self.state.elapsed_ms;
        if let Some(cue) = self.state.cue.as_mut() {
            cue.remaining_ms = self.cue_deadline.saturating_sub(now);
            if cue.remaining_ms == 0 && !cue.held {
                self.state.cue = None;
                self.cooldown_until = self.cue_deadline + self.cooldown();
            }
        }
        while let Some(segment) = self.demo.segments.get(self.next_segment) {
            if segment.at_ms > now {
                break;
            }
            let segment = segment.clone();
            self.next_segment += 1;
            self.consume(segment, now);
        }
        if now >= self.demo.duration_ms {
            self.state.status = Status::Ended;
            // A deliberately opened question stays readable after playback ends.
            // Explicit End demo and Replay still clear it.
            if !self.state.cue.as_ref().is_some_and(|cue| cue.held) {
                self.state.cue = None;
                self.forget_unshown();
            }
        }
        self.changed();
    }

    /// The session a transcription worker should attach to its segments.
    /// Starting or replaying a session issues a new value, so work begun for
    /// an earlier session is rejected instead of reviving it.
    pub fn session(&self) -> u64 {
        self.generation
    }

    /// Accepts one transcript segment from a live source for the running
    /// session. Invalid, late, or out-of-order input is rejected without
    /// changing state. Accepted input follows the same cue, answer, and
    /// stale-cue rules as the bundled demo.
    pub fn ingest(&mut self, session: u64, segment: Segment) -> Result<(), String> {
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
                .demo
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
        if self
            .state
            .transcript
            .last()
            .is_some_and(|last| segment.at_ms < last.at_ms)
        {
            return Err("Transcript segments must arrive in order.".into());
        }
        let segment = Segment {
            text: text.into(),
            speaker: speaker.into(),
            ..segment
        };
        self.live_input = true;
        self.consume(segment, now);
        self.changed();
        Ok(())
    }

    fn consume(&mut self, segment: Segment, now: u64) {
        self.state.transcript.push(segment.clone());
        // Keep memory bounded in a long session; the oldest lines go first.
        if self.state.transcript.len() > MAX_TRANSCRIPT_SEGMENTS {
            let excess = self.state.transcript.len() - MAX_TRANSCRIPT_SEGMENTS;
            self.state.transcript.drain(..excess);
        }
        // The conversation answered the open cue. Withdraw it before the
        // user spends attention on it, unless they are reading it; then
        // keep the text in place and say it was answered.
        if let Some(cue) = self.state.cue.as_mut() {
            if cue.resolved_by.is_none() && resolves(&cue.kind, &segment.text) {
                if cue.held {
                    cue.resolved_by = Some(Resolution {
                        source_id: segment.id.clone(),
                        evidence: segment.text.clone(),
                    });
                } else {
                    self.state.cue = None;
                    self.cooldown_until = segment.at_ms + self.cooldown();
                    self.forget_unshown();
                }
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
        if topic_shift(&segment.text)
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
                            && segment.at_ms.saturating_sub(line.at_ms) <= CORRECTION_MS
                    })
            });
            if taken_back {
                self.state.cue = None;
                self.forget_unshown();
                withdrawn_for_topic = true;
            }
        }
        // A question asked of the user by name takes priority over an unread
        // suggestion, ignores the cooldown, and shows the question itself.
        // Questions for someone else, or for no one in particular, stay quiet.
        if let Some(asked) = self
            .state
            .user_name
            .as_deref()
            .and_then(|name| asked_of(name, &segment.text[correction.unwrap_or(0)..]))
        {
            if !self.state.cue.as_ref().is_some_and(|cue| cue.held) && now - segment.at_ms < CUE_MS
            {
                // A suggestion replaced before it was published was never seen.
                if self.state.cue.take().is_some() {
                    self.forget_unshown();
                }
                self.cue_deadline = segment.at_ms + ASKED_MS;
                self.state.cue = Some(Cue {
                    id: format!("{}:{}", self.generation, segment.id),
                    kind: ASKED.into(),
                    question: asked,
                    evidence: segment.text,
                    source_id: segment.id,
                    remaining_ms: self.cue_deadline - now,
                    total_ms: ASKED_MS,
                    held: false,
                    expanded: false,
                    resolved_by: None,
                    note: None,
                    about_goal: false,
                });
            }
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
        // Kept for the context reminder below; a fixed question may move the
        // segment's ID into its cue first.
        let line_id = segment.id.clone();
        // A line that uses the words of the meeting goal may raise a question
        // during the pause after another cue, and that question stays as long
        // as one asked of the user. This is a word match on the goal, not a
        // judgment that the line is about it.
        let about_goal = self.about_goal(&suggestible);
        // Skip stale suggestions after a suspended app catches up.
        if self.state.cue.is_none()
            && (segment.at_ms >= self.cooldown_until || about_goal)
            && now - segment.at_ms < CUE_MS
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
                let total_ms = if about_goal { ASKED_MS } else { CUE_MS };
                self.cue_deadline = segment.at_ms + total_ms;
                self.state.cue = Some(Cue {
                    id: format!("{}:{}", self.generation, segment.id),
                    kind: kind.into(),
                    question,
                    evidence: segment.text,
                    source_id: segment.id,
                    remaining_ms: self.cue_deadline - now,
                    total_ms,
                    held: false,
                    expanded: false,
                    resolved_by: None,
                    note: None,
                    about_goal,
                });
            }
        }
        // A line about an imported note reminds the user of it once, with the
        // note as its source: a context reminder, lowest in priority, under
        // the same expiry and pause as a question. This is a phrase match on
        // the note's title, not a judgment that the note is relevant.
        if self.state.cue.is_none()
            && segment.at_ms >= self.cooldown_until
            && now - segment.at_ms < CUE_MS
        {
            // Only words not taken back, and not put to someone else, count.
            if let Some(note) = self.note_for(&suggestible).cloned() {
                // Shown once per session from creation, whether or not the
                // user got to read it: a reminder is not re-raised later.
                self.shown_notes.push(note.key.clone());
                self.unshown = None;
                self.cue_deadline = segment.at_ms + CUE_MS;
                self.state.cue = Some(Cue {
                    id: format!("{}:{}", self.generation, line_id),
                    kind: CONTEXT.into(),
                    question: note.title.clone(),
                    evidence: note.excerpt.clone(),
                    source_id: note.key.clone(),
                    remaining_ms: self.cue_deadline - now,
                    total_ms: CUE_MS,
                    held: false,
                    expanded: false,
                    resolved_by: None,
                    note: Some(NoteRef {
                        title: note.title,
                        source_date: note.source_date,
                        provider: note.provider,
                    }),
                    about_goal: false,
                });
            }
        }
        // After a topic change withdrew a question and raised nothing, leave
        // a pause as after any other withdrawal.
        if withdrawn_for_topic && self.state.cue.is_none() {
            self.cooldown_until = self.cooldown_until.max(spoken_at + self.cooldown());
        }
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

    fn cooldown(&self) -> u64 {
        match self.state.sensitivity {
            Sensitivity::Balanced => 10_000,
            Sensitivity::Quiet => 30_000,
        }
    }

    pub fn respond(&mut self, id: &str, response: Response) -> Result<(), String> {
        // Dismiss is the only response: an unused suggestion is let go, never
        // kept as a note or an action item.
        let Response::Dismiss = response;
        self.state
            .cue
            .as_ref()
            .filter(|cue| cue.id == id)
            .ok_or("That question has already passed.")?;
        self.state.cue = None;
        self.cooldown_until = self.state.elapsed_ms + self.cooldown();
        self.changed();
        Ok(())
    }

    pub fn inspect_cue(&mut self, id: &str, expanded: bool) -> Result<(), String> {
        let cue = self
            .state
            .cue
            .as_mut()
            .filter(|cue| cue.id == id)
            .ok_or("That question has already passed.")?;
        cue.expanded = expanded;
        // Collapsing context must not remove the question under the user's eyes.
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

    /// Sets or clears the name used to recognize questions addressed to the
    /// user. Kept in memory for this app session only.
    /// Replaces the imported notes a context cue may quote: `(key, title,
    /// date, provider, excerpt)` per note. A note already shown this session
    /// stays shown.
    pub fn set_notes(&mut self, notes: Vec<(String, String, String, String, String)>) {
        self.notes = notes
            .into_iter()
            .map(|(key, title, source_date, provider, excerpt)| NoteTerms {
                terms: note_terms(&title),
                key,
                title,
                source_date,
                provider,
                excerpt,
            })
            .collect();
        let keys: Vec<&String> = self.notes.iter().map(|note| &note.key).collect();
        self.shown_notes.retain(|key| keys.contains(&key));
    }

    /// Carries the meeting goal to a replacement engine.
    pub fn copy_goal_from(&mut self, previous: &Engine) {
        self.goal_terms = previous.goal_terms.clone();
        self.state.goal = previous.state.goal.clone();
    }

    /// Carries imported notes to a replacement engine.
    pub fn copy_notes_from(&mut self, previous: &Engine) {
        self.notes = previous.notes.clone();
        self.shown_notes = previous.shown_notes.clone();
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

    /// Whether this line uses enough of the goal's words to be about it, by
    /// the same rule as a note title.
    fn about_goal(&self, text: &str) -> bool {
        let needed = if self.goal_terms.len() > LONG_TITLE_TERMS {
            TERMS_NEEDED + 1
        } else {
            TERMS_NEEDED
        };
        self.goal_terms.len() >= needed && {
            let words: Vec<String> = text
                .split(|character: char| !character.is_alphanumeric() && character != '\'')
                .filter(|word| !word.is_empty())
                .map(|word| word.to_lowercase())
                .collect();
            self.goal_terms
                .iter()
                .filter(|term| words.contains(term))
                .count()
                >= needed
        }
    }

    /// Sets or clears the meeting goal. Kept in memory for this app session
    /// only. A goal needs at least two words that can identify it in
    /// conversation (five letters or more, not common meeting words), or it
    /// could never let a question through.
    pub fn set_goal(&mut self, goal: Option<String>) -> Result<(), String> {
        let goal = goal
            .map(|goal| goal.trim().to_string())
            .filter(|goal| !goal.is_empty());
        let terms = match &goal {
            Some(goal) => {
                if goal.chars().count() > MAX_GOAL_CHARS || goal.chars().any(char::is_control) {
                    return Err("A meeting goal is one line of up to 80 characters.".into());
                }
                let terms = note_terms(goal);
                if terms.len() < TERMS_NEEDED {
                    return Err(
                        "Describe the goal in a few specific words, such as “agree the launch plan for the newsletter”."
                            .into(),
                    );
                }
                terms
            }
            None => vec![],
        };
        self.goal_terms = terms;
        self.state.goal = goal;
        self.changed();
        Ok(())
    }

    pub fn set_user_name(&mut self, name: Option<String>) -> Result<(), String> {
        let name = name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty());
        if let Some(name) = &name {
            // Letters, combining accents, and name punctuation, with at least
            // one letter.
            let valid = name.chars().count() <= 40
                && name.chars().any(char::is_alphabetic)
                && name.chars().all(|character| {
                    character.is_alphabetic()
                        || ('\u{0300}'..='\u{036F}').contains(&character)
                        || " '-’".contains(character)
                });
            if !valid {
                return Err(
                    "Use letters, spaces, apostrophes, or hyphens, up to 40 characters.".into(),
                );
            }
        }
        self.state.user_name = name;
        self.changed();
        Ok(())
    }

    /// Continues session numbering from `previous`, so a session in this
    /// engine never reuses an ID that late work for the old one still holds.
    pub fn continue_sessions_from(&mut self, previous: &Engine) {
        self.generation = self.generation.max(previous.generation);
    }

    pub fn set_sensitivity(&mut self, value: Sensitivity) {
        self.state.sensitivity = value;
        self.changed();
    }

    pub fn set_overlay(&mut self, enabled: bool) {
        self.state.overlay_enabled = enabled;
        self.changed();
    }

    pub fn markdown(&self) -> String {
        // Never label supplied transcript lines as fictional demo content.
        let source = if self.live_input {
            "Transcript includes lines from a transcription source, not only the fictional demo."
        } else {
            "Fictional demo transcript; not derived from microphone audio."
        };
        let mut out = format!(
            "# {}\n\n{source}\n\n## Notes\n\n{}\n",
            self.state.title, self.state.notes
        );
        out.push_str(if self.live_input {
            "\n## Transcript\n\n"
        } else {
            "\n## Demo transcript\n\n"
        });
        for segment in &self.state.transcript {
            out.push_str(&format!("**{}:** {}\n\n", segment.speaker, segment.text));
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
        sentence_words
            .windows(2)
            .any(|pair| is_word(pair[0], "someone") && is_word(pair[1], "can"))
    }) {
        found.push(("Owner", "Who will take the first draft?".into()));
    }
    if words.iter().any(|word| is_word(word, "soon")) {
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
            // "Robin, can you take the draft?" or "Hey Robin, could you ...".
            let opens = body.split_once(',').is_some_and(|(head, rest)| {
                let head = words_of(head);
                let start = head
                    .iter()
                    .take_while(|word| LEAD_INS.contains(&word.as_str()))
                    .count();
                head[start..] == name[..] && (ends_with_mark || opens_question(&words_of(rest)))
            });
            // "What do you think, Robin?" or "Can you take it, Robin".
            let closes = body
                .trim_end_matches(['?', '.', '!'])
                .rsplit_once(',')
                .is_some_and(|(rest, tail)| {
                    words_of(tail) == name && (ends_with_mark || opens_question(&words_of(rest)))
                });
            !name.is_empty() && (opens || closes)
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

/// Transcripts often drop "?", so a sentence that opens like a question
/// does not count as an answer or a topic change.
const QUESTION_OPENERS: [&str; 20] = [
    "should", "shall", "can", "could", "will", "would", "do", "does", "did", "is", "are", "was",
    "were", "what", "who", "when", "which", "how", "why", "where",
];

/// Hedged statements do not count as answers.
const HEDGES: [&str; 5] = ["maybe", "perhaps", "might", "probably", "possibly"];

/// An explicit statement, at the start of a sentence, that the conversation
/// is moving to another topic: "Moving on, ...", "OK, next item.", "Let's
/// move on to ...", "On another note, ...". Phrases inside a sentence
/// ("Before we move on, ...", "The trucks are moving on Tuesday") do not
/// count, nor do questions, negations, or hedges.
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
    // Short words people say before changing topic.
    const LEAD_INS: [&str; 7] = ["ok", "okay", "alright", "right", "so", "great", "anyway"];
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
            let excluded = words
                .first()
                .is_none_or(|first| QUESTION_OPENERS.contains(&first.as_str()))
                || words.iter().any(|word| {
                    NEGATIONS.contains(&word.as_str())
                        || word.ends_with("n't")
                        || HEDGES.contains(&word.as_str())
                });
            // Moving to the next slide or page continues the same topic.
            let presentation = words.windows(2).any(|pair| {
                pair[0] == "next" && matches!(pair[1].as_str(), "slide" | "page" | "screen")
            });
            !excluded
                && !presentation
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
    if kind == OPEN {
        return ["Owner", "Timing", "Decision"]
            .iter()
            .any(|fixed| resolves(fixed, text));
    }
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
    const TASKS: [&str; 6] = ["take", "draft", "write", "handle", "own", "lead"];
    // Transcripts often drop "?", so a sentence that opens like a question
    // or is hedged does not count either.
    // Capitalized words that do not name a person.
    const NOT_OWNERS: [&str; 16] = [
        "it",
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
            (0..words.len()).any(|index| match kind {
                "Owner" => {
                    let (subject, capital) = &words[index];
                    matches!(at(index + 1), "will" | "can")
                        && TASKS.contains(&at(index + 2))
                        && (subject == "i"
                            || (*capital
                                && subject.chars().all(char::is_alphabetic)
                                && !NOT_OWNERS.contains(&subject.as_str())))
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

    fn with_cue() -> Engine {
        let mut engine = Engine::default();
        engine.start().unwrap();
        engine.advance(5_000);
        engine
    }

    fn play_statement(text: &str) -> Engine {
        let mut engine = Engine::default();
        engine.demo.segments = vec![Segment {
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
        let mut engine = Engine::default();
        engine.demo.segments = lines
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
        engine.demo.duration_ms = 600_000;
        engine.advance(10_000);
        engine
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
        e.demo.duration_ms = 600_000;
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
        let mut e = Engine::default();
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
    fn live_ids_cannot_reuse_a_scripted_demo_id() {
        let mut e = Engine::default();
        e.start().unwrap();
        e.advance(2_000);
        assert!(e.ingest(e.session(), live("s5", 2_000, "Hello.")).is_err());
        e.ingest(e.session(), live("w1", 2_000, "Hello.")).unwrap();
    }

    #[test]
    fn export_stops_calling_supplied_lines_fictional() {
        let mut e = live_session();
        assert!(e.markdown().contains("Fictional demo transcript"));
        e.ingest(e.session(), live("w1", 9_000, "Hello.")).unwrap();
        let markdown = e.markdown();
        assert!(!markdown.contains("Fictional demo transcript"));
        assert!(markdown.contains("## Transcript\n\n**Speaker 1:** Hello."));
        e.end();
        e.start().unwrap();
        assert!(e.markdown().contains("## Demo transcript"));
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
            assert!(e.state.cue.is_none(), "Still asking after: {answer}");
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
    fn the_bundled_demo_withdraws_its_timing_question_once_a_date_is_set() {
        let mut e = Engine::default();
        e.start().unwrap();
        e.advance(37_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Timing");
        e.advance(14_000); // s5 sets a date at 51 s, before the 55 s expiry.
        assert!(e.state.cue.is_none());
        e.advance(18_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Decision");
    }

    #[test]
    fn the_same_question_is_not_asked_again_soon_after_it_was_shown() {
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (40_000, "Someone can take the second draft."),
            (60_000, "We should finish soon."),
            (125_000, "Someone can take the layout."),
        ]);
        e.demo.duration_ms = 200_000;
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
        e.demo.duration_ms = 200_000;
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
        let mut e = Engine::default();
        e.start().unwrap();
        e.advance(5_000);
        assert!(e.state.cue.is_some());
        e.end();
        e.start().unwrap();
        e.advance(5_000);
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
        e.inspect_cue("1:t1", true).unwrap();
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
        e.inspect_cue("1:t1", true).unwrap();
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
        e.inspect_cue(&first, true).unwrap();
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
    fn a_question_about_the_meeting_goal_skips_the_pause_and_stays_longer() {
        let lines = [
            (1_000, "Someone can take the first draft."),
            (3_000, "We still need to settle the volunteer schedule for the garden either this week or next."),
        ];
        let mut e = play(&lines);
        e.set_goal(Some("Settle the volunteer schedule".into()))
            .unwrap();
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap(); // starts a 10 s pause
        e.advance(2_000);
        let cue = e.state.cue.as_ref().expect("the goal question");
        assert_eq!(
            (cue.kind.as_str(), cue.source_id.as_str()),
            ("Decision", "t2")
        );
        assert!(cue.about_goal);
        assert_eq!(cue.total_ms, 45_000);
        e.advance(40_000);
        assert!(
            e.state.cue.is_some(),
            "stays as long as a question asked of the user"
        );
        e.advance(6_000); // 49 s: past the 48 s deadline
        assert!(e.state.cue.is_none());

        // The same line without a goal waits out the pause like any other.
        let mut e = play(&lines);
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.advance(2_000);
        assert!(e.state.cue.is_none());

        // A line that shares one goal word is not about the goal.
        let mut e = play(&[
            (1_000, "Someone can take the first draft."),
            (
                3_000,
                "The schedule for the fence is either Monday or Tuesday.",
            ),
        ]);
        e.set_goal(Some("Settle the volunteer schedule".into()))
            .unwrap();
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.advance(2_000);
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn a_goal_needs_words_that_can_identify_it() {
        let mut e = Engine::default();
        assert!(e.set_goal(Some("Decide".into())).is_err(), "one word");
        assert!(
            e.set_goal(Some("Sync on the team update".into())).is_err(),
            "only common meeting words"
        );
        assert!(e.set_goal(Some("a".repeat(81))).is_err(), "too long");
        assert!(e.set_goal(Some("line one\nline two".into())).is_err());
        assert!(e.state.goal.is_none());
        e.set_goal(Some("  Agree the launch plan for the newsletter  ".into()))
            .unwrap();
        assert_eq!(
            e.state.goal.as_deref(),
            Some("Agree the launch plan for the newsletter")
        );
        e.set_goal(Some("   ".into())).unwrap();
        assert!(e.state.goal.is_none());
        let eighty = "settle volunteer schedule ".repeat(3) + "ga";
        assert_eq!(eighty.chars().count(), 80);
        e.set_goal(Some(eighty.clone())).unwrap();
        assert_eq!(e.state.goal.as_deref(), Some(eighty.as_str()));
    }

    #[test]
    fn a_long_goal_needs_three_of_its_words_and_the_goal_survives_a_new_engine() {
        let lines = [
            (1_000, "Someone can take the first draft."),
            (3_000, "The volunteer schedule is either Monday or Tuesday."),
        ];
        let goal = "Settle the volunteer schedule, budget, signage, compost and newsletter";
        let mut e = play(&lines);
        e.set_goal(Some(goal.into())).unwrap();
        e.advance(1_000);
        let first = e.state.cue.as_ref().unwrap().id.clone();
        e.respond(&first, Response::Dismiss).unwrap();
        e.advance(2_000);
        assert!(e.state.cue.is_none(), "two of seven words is not about it");

        let mut next = Engine::default();
        next.copy_goal_from(&e);
        assert_eq!(next.state.goal.as_deref(), Some(goal));
        next.demo.segments = vec![Segment {
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
        assert!(cue.about_goal);
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
        let mut e = Engine::default();
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
        // Recorded 9 November 2026. Update it deliberately when the rules
        // change, and record the new comparison in docs/cue-intelligence.md.
        let baseline = [
            ("missing-owner", "quiet"),
            ("already-answered", "quiet"),
            ("visible-cue-resolved", "no cue raised"),
            ("asked-but-unanswered", "no cue raised"),
            ("topic-moved-on", "quiet"),
            ("uncertain-speaker", "no cue raised"),
            ("context-reminder", "quiet"),
            ("transcript-instruction", "quiet"),
            // Labels added 9 November 2026; not yet run in the Claude lab.
            ("context-corrected", "quiet"),
            ("paraphrased-use", "no cue raised"),
            ("repeated-trigger", "no cue raised"),
        ];
        let baseline: Vec<(String, &str)> = baseline
            .iter()
            .map(|(id, action)| (id.to_string(), *action))
            .collect();
        assert_eq!(results, baseline);
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
        e.inspect_cue("1:t1", true).unwrap();
        e.advance(3_000);
        let cue = e.state.cue.as_ref().expect("held text is not pulled away");
        assert_eq!(cue.question, "Who will take the first draft?");
        assert_eq!(
            cue.resolved_by,
            Some(Resolution {
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
        e.advance(5_000);
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
        assert_eq!(e.state.elapsed_ms, 5_000);
        assert_eq!(e.state.cue.as_ref().unwrap().remaining_ms, 18_000);
        e.resume().unwrap();
        e.advance(18_000);
        assert!(e.state.cue.is_none());
        assert!(e.respond("1:s2", Response::Dismiss).is_err());
    }

    #[test]
    fn quiet_mode_leaves_space_after_expiry() {
        let mut e = with_cue();
        e.set_sensitivity(Sensitivity::Quiet);
        e.advance(18_000);
        e.advance(14_000);
        assert!(e.state.cue.is_none());
        e.advance(32_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Decision");
    }

    #[test]
    fn inspecting_keeps_the_same_question_while_the_transcript_continues() {
        let mut e = with_cue();
        e.inspect_cue("1:s2", true).unwrap();
        e.advance(70_000);
        let cue = e.state.cue.as_ref().unwrap();
        assert_eq!(cue.id, "1:s2");
        assert!(cue.expanded && cue.held);
        assert_eq!(cue.remaining_ms, 0);
        assert_eq!(e.state.transcript.len(), 6);
        // Collapsing cannot expire the content the user just opened.
        e.inspect_cue("1:s2", false).unwrap();
        assert!(!e.state.cue.as_ref().unwrap().expanded);
        e.advance(1_000);
        assert!(e.state.cue.as_ref().unwrap().held);
        e.respond("1:s2", Response::Dismiss).unwrap();
        e.advance(1_000);
        assert!(e.state.cue.is_none()); // No backlog of skipped questions.
        assert!(e.inspect_cue("1:s2", true).is_err());
    }

    #[test]
    fn reading_survives_playback_end_but_explicit_end_and_replay_clear_it() {
        let mut e = with_cue();
        e.inspect_cue("1:s2", true).unwrap();
        e.advance(u64::MAX);
        assert_eq!(e.state.status, Status::Ended);
        assert!(e.state.cue.is_some());
        e.respond("1:s2", Response::Dismiss).unwrap();
        e.start().unwrap();
        e.advance(5_000);
        assert!(e.inspect_cue("1:s2", true).is_err());
        assert!(!e.state.cue.as_ref().unwrap().held);
        e.inspect_cue("2:s2", true).unwrap();
        e.end();
        assert!(e.state.cue.is_none());
        e.start().unwrap();
        e.advance(5_000);
        e.inspect_cue("3:s2", true).unwrap();
        e.advance(u64::MAX);
        e.start().unwrap();
        assert!(e.state.cue.is_none());
    }

    #[test]
    fn paused_questions_remain_actionable_and_expired_ids_cannot_be_held() {
        let mut e = with_cue();
        e.pause().unwrap();
        e.inspect_cue("1:s2", true).unwrap();
        e.respond("1:s2", Response::Dismiss).unwrap();
        assert_eq!(e.state.status, Status::Paused);
        e.resume().unwrap();
        e.advance(32_000);
        assert_eq!(e.state.cue.as_ref().unwrap().kind, "Timing");
        assert!(e.inspect_cue("1:s2", false).is_err());
        assert!(!e.state.cue.as_ref().unwrap().held);
    }

    #[test]
    fn appearance_is_shared_with_companion_and_retained_across_demo_replay() {
        let mut e = Engine::default();
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
    fn waking_after_demo_ends_does_not_show_stale_prompts() {
        let mut e = Engine::default();
        e.start().unwrap();
        e.advance(u64::MAX);
        assert!(e.state.cue.is_none());
        assert_eq!(e.state.status, Status::Ended);
        assert_eq!(e.state.transcript.len(), 7);
    }

    #[test]
    fn rejected_notes_leave_previous_content_intact() {
        let mut e = Engine::default();
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
        let mut demo = Engine::default();
        demo.start().unwrap();
        let old = demo.session();
        let mut next = Engine::live();
        next.continue_sessions_from(&demo);
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
        e.inspect_cue(&id, true).unwrap();
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

    /// Pins the demo to the bundled fictional script: the default session
    /// is that script, playing it yields only its lines, and it never counts
    /// as live input. That the script is compiled in (`include_str!`) and
    /// that the app keeps no meeting store are properties of the code, not
    /// something this test can observe.
    #[test]
    fn the_demo_is_the_bundled_fictional_script_and_reads_nothing_else() {
        let bundled: Demo = serde_json::from_str(include_str!("../../src/demo.json")).unwrap();
        let e = Engine::default();
        assert_eq!(e.state.title, bundled.title);
        assert_eq!(e.demo.segments.len(), bundled.segments.len());
        assert!(e.demo.segments.len() >= 5, "a real script, not a stub");
        assert!(!e.live_input);
        // Playing it through produces only lines from that script.
        let mut e = e;
        e.start().unwrap();
        e.advance(u64::MAX);
        assert_eq!(e.state.transcript.len(), bundled.segments.len());
        let scripted: Vec<&str> = bundled.segments.iter().map(|s| s.text.as_str()).collect();
        assert!(e
            .state
            .transcript
            .iter()
            .all(|line| scripted.contains(&line.text.as_str())));
        assert!(!e.live_input);
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
            (
                "file:n1".into(),
                "Garden welcome guide".into(),
                "2026-10-28".into(),
                "file".into(),
                "Draft a one-page guide with a map of the tool shed.".into(),
            ),
            (
                "file:n2".into(),
                "Sign".into(),
                "2026-11-05".into(),
                "file".into(),
                "Too short a title to match.".into(),
            ),
        ]);
        e
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
            (
                "file:a".into(),
                "Weekly planning meeting notes".into(),
                "2026-11-01".into(),
                "file".into(),
                "Agenda items.".into(),
            ),
            (
                "file:b".into(),
                "Orchard volunteer handover plan for spring planting season and watering schedule"
                    .into(),
                "2026-11-02".into(),
                "file".into(),
                "Seedling trays go to the north shed.".into(),
            ),
            (
                "file:c".into(),
                "Jardín opening".into(),
                "2026-11-03".into(),
                "file".into(),
                "Menu draft.".into(),
            ),
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
}
