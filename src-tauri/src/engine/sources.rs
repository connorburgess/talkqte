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
/// The label for an application or system-audio line in a session with both sources.
pub const THEM: &str = "Them";
/// The application label used when macOS captures global system audio alongside the microphone.
pub const SYSTEM_AUDIO: &str = "System audio";

/// Longest application name the session keeps and the review shows.
const MAX_APPLICATION_CHARS: usize = 60;

/// Application lines this close in session time to a microphone line are
/// compared with it. Each stream cuts lines at its own pauses, so a copy of
/// the same words can start a little earlier or later.
pub const ECHO_WINDOW_MS: u64 = 4_000;
/// The longest common run of words, in order, must be at least this share
/// of the longer of the two lines: a copy, not a reply that repeats part of
/// what was said.
const ECHO_SHARE_PERCENT: usize = 85;
/// The shorter line must be at least this share of the longer one.
const ECHO_LENGTH_PERCENT: usize = 70;
/// Shorter microphone lines are never suppressed: "I don't know", "yes I
/// agree" or a repeated figure are too often a reply.
pub const ECHO_MIN_WORDS: usize = 6;
/// Recent application lines kept for comparison.
const ECHO_RECENT_LINES: usize = 16;
/// Suppressed lines a session keeps for the person to review.
const MAX_ECHO_LINES: usize = 200;

/// The capture sources a live session was started with. Fixed at the start:
/// the session's review names exactly these, and an application can feed
/// only a session that declared it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSources {
    pub microphone: bool,
    /// The selected application's name, as listed. For people to read only:
    /// the identity below decides what may attach.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    /// The reviewed selection's identity: unique to one listing of one
    /// running application, never reused. Only that selection may attach.
    #[serde(skip)]
    selection: Option<String>,
    /// The application's bundle identifier, when the listing gave one.
    #[serde(skip)]
    bundle_id: Option<String>,
}

/// The identity of the application a session is started with: the reviewed
/// selection and, when known, its bundle identifier, beside the name shown.
pub struct Declared<'a> {
    pub name: &'a str,
    pub selection: &'a str,
    pub bundle_id: Option<&'a str>,
}

impl<'a> From<&'a crate::application_audio::Application> for Declared<'a> {
    fn from(application: &'a crate::application_audio::Application) -> Self {
        Self {
            name: application.name(),
            selection: application.selection_id(),
            bundle_id: application.traits().map(|traits| traits.bundle_id.as_str()),
        }
    }
}

impl SessionSources {
    pub fn microphone() -> Self {
        Self {
            microphone: true,
            application: None,
            selection: None,
            bundle_id: None,
        }
    }

    fn with(microphone: bool, declared: Declared) -> Self {
        Self {
            microphone,
            application: Some(bounded_name(declared.name)),
            selection: Some(declared.selection.to_owned()),
            bundle_id: declared.bundle_id.map(str::to_owned),
        }
    }

    pub fn application<'a>(declared: impl Into<Declared<'a>>) -> Self {
        Self::with(false, declared.into())
    }

    pub fn both<'a>(declared: impl Into<Declared<'a>>) -> Self {
        Self::with(true, declared.into())
    }

    /// Microphone plus macOS global system audio tap (all apps except TalkQTE).
    pub fn system_audio() -> Self {
        Self {
            microphone: true,
            application: Some(SYSTEM_AUDIO.into()),
            selection: None,
            bundle_id: None,
        }
    }

    /// Whether this session uses the global system audio tap rather than a
    /// named application picker selection.
    pub fn is_system_audio(&self) -> bool {
        self.microphone && self.application.as_deref() == Some(SYSTEM_AUDIO)
    }

    /// Whether `application` is the one this session was started with: the
    /// same reviewed selection, and the same bundle identifier when both are
    /// known. A name alone never matches.
    pub fn declares(&self, application: &crate::application_audio::Application) -> bool {
        let Some(selection) = &self.selection else {
            return false;
        };
        let bundle = application.traits().map(|traits| traits.bundle_id.as_str());
        selection == application.selection_id()
            && match (self.bundle_id.as_deref(), bundle) {
                (Some(declared), Some(bundle)) => declared == bundle,
                (Some(_), None) => false,
                (None, _) => true,
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

/// A fictional declaration for tests: the name and the selection id.
#[cfg(test)]
impl<'a> From<(&'a str, &'a str)> for Declared<'a> {
    fn from((name, selection): (&'a str, &'a str)) -> Self {
        Self {
            name,
            selection,
            bundle_id: None,
        }
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
    /// Microphone lines suppressed as a likely echo of the application's
    /// sound, counted.
    #[serde(skip_serializing_if = "is_zero")]
    pub echo_dropped: u32,
    /// Those lines, still shown in the transcript and kept in the meeting,
    /// marked, until the person removes one or keeps it as theirs. None of
    /// them is sent to a cue model.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub echoes: Vec<EchoLine>,
}

/// A microphone line suppressed as a likely echo.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EchoLine {
    #[serde(flatten)]
    pub line: super::Segment,
    /// The person said it is theirs: shown and kept as an ordinary line.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub kept: bool,
}

impl PartialEq for EchoLine {
    fn eq(&self, other: &Self) -> bool {
        self.kept == other.kept
            && self.line.id == other.line.id
            && self.line.at_ms == other.line.at_ms
            && self.line.text == other.line.text
    }
}
impl Eq for EchoLine {}
impl std::fmt::Debug for EchoLine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EchoLine")
            .field("id", &self.line.id)
            .field("kept", &self.kept)
            .finish_non_exhaustive()
    }
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
            echoes: Vec::new(),
        }
    }

    /// Keep a suppressed line for the person to review; the oldest go first.
    pub(super) fn suppressed(&mut self, line: super::Segment) {
        self.echo_dropped = self.echo_dropped.saturating_add(1);
        self.echoes.push(EchoLine { line, kept: false });
        if self.echoes.len() > MAX_ECHO_LINES {
            self.echoes.remove(0);
        }
    }
}

/// Recent application lines, as words, for the echo guard.
#[derive(Default)]
pub(super) struct EchoGuard {
    recent: VecDeque<(u64, Vec<String>)>,
}

impl EchoGuard {
    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.recent.len()
    }

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

    /// Whether a microphone line is a copy of one application line already
    /// heard within [`ECHO_WINDOW_MS`] of it: the same words in the same
    /// order (longest common subsequence at least 85% of the longer line),
    /// of similar length, at least six words. Lines are compared one at a
    /// time, never pooled. Only an application line that arrived first can
    /// be matched.
    pub(super) fn is_echo(&self, at_ms: u64, text: &str) -> bool {
        let line = words(text);
        if line.len() < ECHO_MIN_WORDS {
            return false;
        }
        self.recent
            .iter()
            .filter(|(at, _)| at.abs_diff(at_ms) <= ECHO_WINDOW_MS)
            .any(|(_, heard)| copies(&line, heard))
    }
}

/// `a` and `b` are the same words in the same order, give or take a few.
fn copies(a: &[String], b: &[String]) -> bool {
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if short.is_empty() || short.len() * 100 < long.len() * ECHO_LENGTH_PERCENT {
        return false;
    }
    common_run(a, b) * 100 >= long.len() * ECHO_SHARE_PERCENT
}

/// The length of the longest common subsequence of two word lists. Lines are
/// at most 1,000 characters, so this is a small table.
fn common_run(a: &[String], b: &[String]) -> usize {
    let mut previous = vec![0_usize; b.len() + 1];
    let mut current = vec![0_usize; b.len() + 1];
    for word in a {
        for (index, other) in b.iter().enumerate() {
            current[index + 1] = if word == other {
                previous[index] + 1
            } else {
                current[index].max(previous[index + 1])
            };
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
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
    fn a_close_copy_of_one_nearby_application_line_is_a_likely_echo() {
        let mut guard = EchoGuard::default();
        guard.heard_application(
            10_000,
            "Can you send the revised fictional budget by Friday?",
        );
        // The speakers' copy, recognised with different case and punctuation.
        assert!(guard.is_echo(
            10_400,
            "can you send the revised fictional budget by friday"
        ));
        // One word recognised differently is still a copy.
        assert!(guard.is_echo(
            10_400,
            "Can you send the revised fictional budget on Friday?"
        ));
        // The same words, too far apart in time.
        assert!(!guard.is_echo(
            14_500,
            "can you send the revised fictional budget by friday"
        ));
    }

    #[test]
    fn replies_that_repeat_part_of_what_was_said_are_never_echoes() {
        let mut guard = EchoGuard::default();
        guard.heard_application(1_000, "I don't know, yes I agree, the budget is 4,500.");
        guard.heard_application(
            1_200,
            "The budget is 4,500 for the fictional harbour project.",
        );
        for reply in [
            "I don't know",
            "yes I agree",
            "Yes, the budget is 4,500.",
            // Confirming the figure in full is still the person speaking.
            "So the budget is 4,500 for the harbour.",
            // The same words in another order.
            "For the fictional harbour project the budget is 4,500.",
            // Half of one line plus half of another is never pooled.
            "I don't know, the budget is 4,500 for the harbour project.",
        ] {
            assert!(!guard.is_echo(1_500, reply), "{reply}");
        }
    }

    #[test]
    fn only_recent_application_lines_are_kept_for_comparison() {
        let mut guard = EchoGuard::default();
        guard.heard_application(0, "the fictional harbour project starts in May next year");
        for at in 1..=ECHO_RECENT_LINES as u64 {
            guard.heard_application(at, "unrelated words here");
        }
        assert!(!guard.is_echo(0, "the fictional harbour project starts in May next year"));
    }

    #[test]
    fn labels_name_the_source_only_when_a_session_has_both() {
        let both = SessionSources::both(("Fictional Call", "fictional-call"));
        assert_eq!(label(Some(&both), LineOrigin::Microphone), Some(YOU));
        assert_eq!(label(Some(&both), LineOrigin::Application), Some(THEM));
        let microphone = SessionSources::microphone();
        assert_eq!(label(Some(&microphone), LineOrigin::Microphone), None);
        let application = SessionSources::application(("Fictional Call", "fictional-call"));
        assert_eq!(label(Some(&application), LineOrigin::Application), None);
        assert_eq!(label(None, LineOrigin::Application), None);
    }

    #[test]
    fn an_application_stream_failing_beside_the_microphone_leaves_the_session_transcribing() {
        let mut engine = crate::engine::Engine::live();
        engine.start().unwrap();
        engine.set_sources(SessionSources::both(("Fictional Call", "fictional-call")));
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
        alone.set_sources(SessionSources::application((
            "Fictional Call",
            "fictional-call",
        )));
        let session = alone.session();
        alone.application_ended(session, "ended");
        assert_eq!(alone.state.sources.unwrap().application_ended, None);
    }

    #[test]
    fn only_the_reviewed_selection_with_its_bundle_identifier_is_declared() {
        use crate::application_audio::{listing::Traits, Application};
        let traits = |bundle: &str| Traits {
            bundle_id: bundle.into(),
            regular: true,
            on_screen: true,
        };
        let reviewed = Application::new("s1".into(), "Fictional Call".into())
            .unwrap()
            .with_traits(traits("com.example.fictional-call"));
        let sources = SessionSources::both(&reviewed);
        assert!(sources.declares(&reviewed));
        // The same name or the same listing id is not enough.
        let renamed = Application::new("s2".into(), "Fictional Call".into())
            .unwrap()
            .with_traits(traits("com.example.fictional-call"));
        assert!(!sources.declares(&renamed));
        let other_bundle = Application::new("s1".into(), "Fictional Call".into())
            .unwrap()
            .with_traits(traits("com.example.other"));
        assert!(!sources.declares(&other_bundle));
        let no_bundle = Application::new("s1".into(), "Fictional Call".into()).unwrap();
        assert!(!sources.declares(&no_bundle));
        // A session for the microphone alone declares nothing.
        assert!(!SessionSources::microphone().declares(&reviewed));
    }

    #[test]
    fn an_application_name_is_bounded_and_never_empty() {
        let long = "A".repeat(200);
        let name = SessionSources::both((long.as_str(), "fictional-long"))
            .application
            .unwrap();
        assert_eq!(name.chars().count(), MAX_APPLICATION_CHARS);
        assert!(name.ends_with('…'));
        assert_eq!(
            SessionSources::application((" \u{7} ", "fictional-blank"))
                .application
                .as_deref(),
            Some("the selected application")
        );
    }
}
