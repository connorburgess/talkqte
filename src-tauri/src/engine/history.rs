//! What an ended session offers to keep in the meeting history: the same
//! content as an export that keeps the meeting, as data. Never the name
//! setting, focus lines, imported notes, note reminders, the Still open list,
//! a speaker label from the transcription provider, or audio.

use super::{Engine, Segment, Status, THEM, YOU};
use crate::meeting_history::{Content, Cue, Label, Line, Sources};
use serde::{Deserialize, Serialize};

/// What the floating companion's end-of-call card is showing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndPromptState {
    /// "ask" mode: waiting for Keep meeting, Write notes, or Dismiss.
    Ask,
    /// "auto" mode: already saved automatically on session end.
    Saved,
    /// "ask" mode after the person clicked Keep meeting: brief confirmation.
    Kept,
}

/// Metadata shown in the floating companion when a non-empty live session
/// ends. Contains counts and state only; never transcript text, notes,
/// meeting titles, IDs, or application names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndPrompt {
    pub session: u64,
    pub state: EndPromptState,
    pub transcript_lines: usize,
    pub has_notes: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// An action from the floating companion's end-of-call card.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndPromptAction {
    Keep,
    WriteNotes,
    Open,
    Delete,
    Dismiss,
}

/// Milliseconds since 1970 (UTC), by this Mac's clock.
pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

impl Engine {
    /// The live session that just ended, ready to keep; `None` while it
    /// runs, outside live sessions and when nothing was transcribed and no
    /// manual notes were written. The application's name only with
    /// `include_application`.
    pub fn keepable_meeting(&self, include_application: bool) -> Option<Content> {
        if !self.state.live
            || self.state.status != Status::Ended
            || (self.state.transcript.is_empty() && self.state.notes.trim().is_empty())
        {
            return None;
        }
        let declared = self.sources();
        let application = declared.and_then(|sources| sources.application.clone());
        let both = declared.is_some_and(|sources| sources.both_sources());
        let sources = match (both, application.is_some()) {
            (true, _) => Sources::Both,
            (false, true) => Sources::Application,
            (false, false) => Sources::Microphone,
        };
        let echoes = self
            .state
            .sources
            .as_ref()
            .map_or(&[][..], |status| status.echoes.as_slice());
        let mut lines: Vec<(&Segment, Option<bool>)> = self
            .state
            .transcript
            .iter()
            .map(|line| (line, None))
            .chain(echoes.iter().map(|echo| (&echo.line, Some(echo.kept))))
            .collect();
        lines.sort_by_key(|(line, _)| line.at_ms);
        let transcript = lines
            .into_iter()
            .map(|(line, echo)| {
                let (label, echo) = match (both, echo) {
                    (true, Some(false)) => (Some(Label::You), true),
                    (true, _) if line.speaker == YOU => (Some(Label::You), false),
                    (true, _) if line.speaker == THEM => (Some(Label::Them), false),
                    _ => (None, false),
                };
                Line {
                    at_ms: line.at_ms,
                    label,
                    echo,
                    text: line.text.clone(),
                }
            })
            .collect();
        Some(Content {
            started_at_ms: self.started_at_ms,
            duration_ms: self.state.elapsed_ms,
            sources,
            application: application.filter(|_| include_application),
            transcribed_by: self
                .state
                .transcription
                .as_ref()
                .map(|transcription| transcription.provider.clone()),
            transcript,
            notes: self.state.notes.clone(),
            cues: self
                .shown_cues
                .iter()
                .map(|cue| Cue {
                    at_ms: cue.at_ms,
                    kind: cue.kind.clone(),
                    question: cue.question.clone(),
                    evidence: cue.evidence.clone(),
                })
                .collect(),
            meeting_notes: self.meeting_notes.kept().map(str::to_string),
        })
    }

    /// Identifies this session for the history, so a kept meeting is only
    /// ever updated from the session it was kept from.
    pub fn history_session(&self) -> u64 {
        self.generation
    }

    /// The transcript line count and whether manual notes exist for an ended
    /// live session with content to keep; `None` when empty or not ended.
    pub fn end_prompt_counts(&self) -> Option<(usize, bool)> {
        if !self.state.live || self.state.status != Status::Ended {
            return None;
        }
        let transcript_lines = self.state.transcript.len();
        let has_notes = !self.state.notes.trim().is_empty();
        (transcript_lines > 0 || has_notes).then_some((transcript_lines, has_notes))
    }
}

#[cfg(test)]
mod tests {
    use super::super::sources::{Declared, EchoLine};
    use super::super::*;
    use crate::meeting_history::{Label, Sources};

    fn ended(sources: Option<SessionSources>, lines: &[(&str, &str)]) -> Engine {
        let mut e = Engine::live();
        e.start().unwrap();
        if let Some(sources) = sources {
            e.state.sources = Some(SourcesStatus::new(sources));
        }
        for (index, (speaker, text)) in lines.iter().enumerate() {
            e.state.transcript.push(Segment {
                id: format!("t-{index}"),
                at_ms: 1_000 * (index as u64 + 1),
                speaker: (*speaker).into(),
                text: (*text).into(),
            });
        }
        e.state.elapsed_ms = 90_000;
        e.state.notes = "Ask about the fictional greenhouse rota.".into();
        e.end();
        e
    }

    #[test]
    fn nothing_is_offered_before_the_session_ends_or_when_completely_empty() {
        let mut e = Engine::live();
        e.start().unwrap();
        e.state.transcript.push(Segment {
            id: "t".into(),
            at_ms: 1,
            speaker: "Speaker".into(),
            text: "The blue tin.".into(),
        });
        assert!(e.keepable_meeting(false).is_none(), "still running");
        assert!(e.end_prompt_counts().is_none(), "still running");
        let mut empty = ended(None, &[]);
        // Manual notes alone can still be kept.
        assert!(empty.keepable_meeting(false).is_some());
        assert_eq!(empty.end_prompt_counts(), Some((0, true)));
        empty.state.notes = "   ".into();
        assert!(empty.keepable_meeting(false).is_none());
        assert_eq!(empty.end_prompt_counts(), None);
    }

    #[test]
    fn a_microphone_meeting_keeps_text_notes_and_no_provider_speaker_labels() {
        let e = ended(None, &[("Speaker 2", "The keys are in the blue tin.")]);
        let kept = e.keepable_meeting(true).unwrap();
        assert_eq!(kept.sources, Sources::Microphone);
        assert_eq!(kept.application, None);
        assert_eq!(kept.duration_ms, 90_000);
        assert!(kept.started_at_ms > 0);
        assert_eq!(kept.transcript.len(), 1);
        assert_eq!(
            kept.transcript[0].label, None,
            "provider labels are dropped"
        );
        assert_eq!(kept.transcript[0].text, "The keys are in the blue tin.");
        assert_eq!(kept.notes, "Ask about the fictional greenhouse rota.");
        assert!(kept.cues.is_empty());
        assert_eq!(kept.meeting_notes, None);
    }

    #[test]
    fn both_sources_keep_you_and_them_and_echo_marks_and_the_name_only_when_chosen() {
        let declared = Declared {
            name: "Fictional Call",
            selection: "selection-1",
            bundle_id: None,
        };
        let mut e = ended(
            Some(SessionSources::both(declared)),
            &[
                (YOU, "I can bring the ladder."),
                (THEM, "Thanks, Friday works."),
            ],
        );
        e.state.sources.as_mut().unwrap().echoes.push(EchoLine {
            line: Segment {
                id: "echo".into(),
                at_ms: 1_500,
                speaker: YOU.into(),
                text: "Thanks, Friday works.".into(),
            },
            kept: false,
        });
        let kept = e.keepable_meeting(false).unwrap();
        assert_eq!(kept.sources, Sources::Both);
        assert_eq!(kept.application, None, "the name is left out by default");
        let labels: Vec<_> = kept
            .transcript
            .iter()
            .map(|line| (line.label, line.echo))
            .collect();
        assert_eq!(
            labels,
            vec![
                (Some(Label::You), false),
                (Some(Label::You), true),
                (Some(Label::Them), false)
            ]
        );
        assert_eq!(
            e.keepable_meeting(true).unwrap().application.as_deref(),
            Some("Fictional Call")
        );
    }

    #[test]
    fn a_new_session_resets_what_can_be_kept() {
        let mut e = ended(None, &[("Speaker", "Keys in the tin.")]);
        let before = e.history_session();
        e.start().unwrap();
        assert!(e.keepable_meeting(false).is_none());
        assert_ne!(e.history_session(), before);
    }
}
