//! Which capture sources a live session was started with, how its lines are
//! labelled, and the bounded guard against the microphone hearing the
//! application's sound through the speakers.
//!
//! Labels name the source a line came from, never who spoke: in a session
//! with both sources, the microphone's lines are "You" and the application's
//! "Them". A session with one source keeps the plain label it always had.

use super::LineOrigin;
use serde::Serialize;
use std::collections::VecDeque;

/// The label for a microphone line in a session with both sources.
pub const YOU: &str = "You";
/// The label for an application line in a session with both sources.
pub const THEM: &str = "Them";

/// Longest application name the session keeps and the review shows.
const MAX_APPLICATION_CHARS: usize = 60;

/// Application lines this close in session time to a microphone line are
/// compared with it. Each stream cuts lines at its own pauses, so a copy of
/// the same words can start a few seconds earlier or later.
pub const ECHO_WINDOW_MS: u64 = 4_000;
/// Share of a microphone line's words that must occur in nearby application
/// lines for it to count as their echo.
const ECHO_SHARE_PERCENT: usize = 80;
/// Shorter microphone lines are never dropped: "yes" or "okay, thanks" are
/// too common to tell an echo from a reply.
pub const ECHO_MIN_WORDS: usize = 3;
/// Recent application lines kept for comparison.
const ECHO_RECENT_LINES: usize = 16;

/// The capture sources a live session was started with. Fixed at the start:
/// the session's review names exactly these, and an application can feed
/// only a session that declared it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSources {
    pub microphone: bool,
    /// The selected application's name, as listed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
}

impl SessionSources {
    pub fn microphone() -> Self {
        Self {
            microphone: true,
            application: None,
        }
    }

    pub fn application(name: &str) -> Self {
        Self {
            microphone: false,
            application: Some(bounded_name(name)),
        }
    }

    pub fn both(name: &str) -> Self {
        Self {
            microphone: true,
            application: Some(bounded_name(name)),
        }
    }

    /// The microphone and an application, so lines carry source labels and
    /// the echo guard runs.
    pub fn both_sources(&self) -> bool {
        self.microphone && self.application.is_some()
    }
}

impl Default for SessionSources {
    fn default() -> Self {
        Self::microphone()
    }
}

fn bounded_name(name: &str) -> String {
    let name: String = name
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    let name = name.trim();
    if name.is_empty() {
        return "the selected application".into();
    }
    if name.chars().count() <= MAX_APPLICATION_CHARS {
        return name.into();
    }
    let mut short: String = name.chars().take(MAX_APPLICATION_CHARS - 1).collect();
    short.push('…');
    short
}

/// What the notebook shows about a live session's sources. Metadata only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcesStatus {
    #[serde(flatten)]
    pub sources: SessionSources,
    /// The application source began feeding this session.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub application_attached: bool,
    /// Why the application source is not heard any more while the
    /// microphone continues: a fixed code. Only in a session with both.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_ended: Option<String>,
    /// Microphone lines dropped as an echo of the application's sound.
    #[serde(skip_serializing_if = "is_zero")]
    pub echo_dropped: u32,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

impl SourcesStatus {
    pub fn new(sources: SessionSources) -> Self {
        Self {
            sources,
            application_attached: false,
            application_ended: None,
            echo_dropped: 0,
        }
    }
}

/// Recent application lines, as words, for the echo guard.
#[derive(Default)]
pub(super) struct EchoGuard {
    recent: VecDeque<(u64, Vec<String>)>,
}

impl EchoGuard {
    pub(super) fn clear(&mut self) {
        self.recent.clear();
    }

    /// Remember an accepted application line.
    pub(super) fn heard_application(&mut self, at_ms: u64, text: &str) {
        self.recent.push_back((at_ms, words(text)));
        while self.recent.len() > ECHO_RECENT_LINES {
            self.recent.pop_front();
        }
    }

    /// Whether a microphone line repeats application lines already heard
    /// within [`ECHO_WINDOW_MS`] of it. Only an application line that
    /// arrived first can be matched.
    pub(super) fn is_echo(&self, at_ms: u64, text: &str) -> bool {
        let line = words(text);
        if line.len() < ECHO_MIN_WORDS {
            return false;
        }
        let mut nearby: Vec<&str> = self
            .recent
            .iter()
            .filter(|(at, _)| at.abs_diff(at_ms) <= ECHO_WINDOW_MS)
            .flat_map(|(_, words)| words.iter().map(String::as_str))
            .collect();
        if nearby.is_empty() {
            return false;
        }
        // Each nearby word matches at most one word of the line.
        let mut found = 0;
        for word in &line {
            if let Some(index) = nearby.iter().position(|other| other == word) {
                nearby.swap_remove(index);
                found += 1;
            }
        }
        found * 100 >= line.len() * ECHO_SHARE_PERCENT
    }
}

/// Lowercase words, letters and digits only, so punctuation and case that
/// the two streams recognise differently do not matter.
fn words(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric() && character != '\'')
        .map(|word| word.trim_matches('\'').to_lowercase())
        .filter(|word| !word.is_empty())
        .collect()
}

/// The label for a line from `origin`, or `None` to keep the given one.
pub(super) fn label(sources: Option<&SessionSources>, origin: LineOrigin) -> Option<&'static str> {
    sources.filter(|sources| sources.both_sources())?;
    Some(match origin {
        LineOrigin::Microphone => YOU,
        LineOrigin::Application => THEM,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_microphone_line_repeating_nearby_application_words_is_an_echo() {
        let mut guard = EchoGuard::default();
        guard.heard_application(10_000, "Can you send the revised budget by Friday?");
        // The speakers' copy, recognised with different case and punctuation.
        assert!(guard.is_echo(10_400, "can you send the revised budget by friday"));
        // Split differently: most of its words are in the application's line.
        assert!(guard.is_echo(11_000, "the revised budget by Friday"));
        // The same words, too far apart in time.
        assert!(!guard.is_echo(14_500, "can you send the revised budget by friday"));
        // A reply that shares a few words is not an echo.
        assert!(!guard.is_echo(11_000, "Yes, I can send the budget on Thursday instead."));
        // Short lines are never dropped.
        assert!(!guard.is_echo(10_200, "by Friday"));
    }

    #[test]
    fn words_count_once_and_only_recent_application_lines_are_kept() {
        let mut guard = EchoGuard::default();
        guard.heard_application(1_000, "budget budget");
        // Two of four words found: not 80%.
        assert!(!guard.is_echo(1_000, "budget budget budget budget"));
        let mut guard = EchoGuard::default();
        guard.heard_application(0, "the fictional harbour project starts in May");
        for at in 1..=ECHO_RECENT_LINES as u64 {
            guard.heard_application(at, "unrelated words here");
        }
        assert!(!guard.is_echo(0, "the fictional harbour project starts in May"));
    }

    #[test]
    fn labels_name_the_source_only_when_a_session_has_both() {
        let both = SessionSources::both("Fictional Call");
        assert_eq!(label(Some(&both), LineOrigin::Microphone), Some(YOU));
        assert_eq!(label(Some(&both), LineOrigin::Application), Some(THEM));
        let microphone = SessionSources::microphone();
        assert_eq!(label(Some(&microphone), LineOrigin::Microphone), None);
        let application = SessionSources::application("Fictional Call");
        assert_eq!(label(Some(&application), LineOrigin::Application), None);
        assert_eq!(label(None, LineOrigin::Application), None);
    }

    #[test]
    fn an_application_stream_failing_beside_the_microphone_leaves_the_session_transcribing() {
        let mut engine = crate::engine::Engine::live();
        engine.start().unwrap();
        engine.set_sources(SessionSources::both("Fictional Call"));
        let session = engine.session();
        engine.source_transcription_stopped(session, LineOrigin::Application, "network");
        let status = engine.state.sources.clone().unwrap();
        assert_eq!(status.application_ended.as_deref(), Some("network"));
        assert!(engine
            .state
            .transcription
            .as_ref()
            .is_none_or(|transcription| transcription.stopped.is_none()));
        // A later failure keeps the first reason.
        engine.application_ended(session, "ended");
        assert_eq!(
            engine.state.sources.unwrap().application_ended.as_deref(),
            Some("network")
        );
        // Alone, the application's failure is the session's.
        let mut alone = crate::engine::Engine::live();
        alone.start().unwrap();
        alone.set_sources(SessionSources::application("Fictional Call"));
        let session = alone.session();
        alone.application_ended(session, "ended");
        assert_eq!(alone.state.sources.unwrap().application_ended, None);
    }

    #[test]
    fn an_application_name_is_bounded_and_never_empty() {
        let long = "A".repeat(200);
        let name = SessionSources::both(&long).application.unwrap();
        assert_eq!(name.chars().count(), MAX_APPLICATION_CHARS);
        assert!(name.ends_with('…'));
        assert_eq!(
            SessionSources::application(" \u{7} ")
                .application
                .as_deref(),
            Some("the selected application")
        );
    }
}
