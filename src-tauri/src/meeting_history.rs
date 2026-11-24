//! Kept meetings: the meetings a person chose to keep in TalkQTE after they
//! ended, so they can find, read, export or delete them later.
//!
//! Nothing is kept unless the person keeps that meeting. A kept meeting
//! holds its title, date, duration, the sources used, the transcript (with
//! You/Them labels and echo marks where the session had both sources), the
//! person's notes, the cues shown and, if the person kept them, the meeting
//! notes. It never holds audio, a provider key, the person's name setting,
//! focus lines, imported notes, note reminders, the Still open list or a
//! speaker label from the transcription provider; the application's name only
//! when the person chose to include it.
//!
//! On disk, under the app's Application Support directory:
//!
//! ```text
//! meetings/                 owner-only (0700)
//!   index.json              the list: id, title, date, duration, sources
//!   <id>/meeting.json       one kept meeting
//! ```
//!
//! Every file is owner-only (0600) and replaced atomically (a temporary file
//! in the same directory, flushed, then renamed). Each file carries a format
//! version. A file from a newer version is never overwritten: the history is
//! then read-only and says so; only Delete all meetings removes it. Every
//! file is size-bounded and checked field by field on read; a meeting that
//! fails is not shown and is counted as unreadable. The files are not
//! encrypted beyond what the Mac's own disk encryption provides.
//!
//! A lab or development run with lab settings neither reads nor writes kept
//! meetings: a person's meetings must never enter a lab's evidence, and a lab
//! must never add to a person's history.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

/// The folder under Application Support.
pub const DIR: &str = "meetings";
const INDEX: &str = "index.json";
const MEETING: &str = "meeting.json";
/// The files' format. A file without it is not read; one with a higher
/// version is left exactly as it is.
pub const VERSION: u64 = 1;

/// The most meetings kept at once. Keeping another past this asks the
/// person to delete one first; nothing is dropped on its own.
pub const MAX_MEETINGS: usize = 1_000;
const MAX_INDEX_BYTES: u64 = 1024 * 1024;
const MAX_MEETING_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_TITLE_CHARS: usize = 200;
const MAX_LINES: usize = 50_000;
const MAX_LINE_CHARS: usize = 8_000;
/// The notebook's own limit on the person's notes.
pub const MAX_NOTES_CHARS: usize = 20_000;
const MAX_CUES: usize = 1_000;
const MAX_CUE_FIELD_CHARS: usize = 2_000;
const MAX_APPLICATION_CHARS: usize = 60;
const MAX_PROVIDER_CHARS: usize = 40;
const MAX_QUERY_CHARS: usize = 200;

/// Which capture a meeting used.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sources {
    Microphone,
    Application,
    Both,
}

/// Where a transcript line was heard, in a meeting with both sources: not
/// who said it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Label {
    You,
    Them,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<Label>,
    /// Suppressed during the meeting as a likely echo of the application's
    /// sound, and neither removed nor kept as the person's own.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub echo: bool,
    pub text: String,
}

/// A cue the meeting showed from its conversation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub at_ms: u64,
    pub kind: String,
    pub question: String,
    #[serde(default)]
    pub evidence: String,
}

/// What an ended session offers to keep, built by the engine with the same
/// exclusions as the export.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    /// When the session started, milliseconds since 1970 (UTC).
    pub started_at_ms: u64,
    pub duration_ms: u64,
    pub sources: Sources,
    /// The application's name, only when the person chose to keep it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    /// The cloud service that transcribed it, if one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcribed_by: Option<String>,
    pub transcript: Vec<Line>,
    pub notes: String,
    pub cues: Vec<Cue>,
    /// Model-written meeting notes, as the person kept and edited them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meeting_notes: Option<String>,
}

/// One kept meeting as stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub title: String,
    /// Increases on every change: rename or update.
    pub revision: u64,
    #[serde(flatten)]
    pub content: Content,
}

/// One entry in the list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub started_at_ms: u64,
    pub duration_ms: u64,
    pub sources: Sources,
    /// Whether the meeting holds kept meeting notes.
    #[serde(default)]
    pub has_meeting_notes: bool,
}

impl Meeting {
    pub fn summary(&self) -> Summary {
        Summary {
            id: self.id.clone(),
            title: self.title.clone(),
            revision: self.revision,
            started_at_ms: self.content.started_at_ms,
            duration_ms: self.content.duration_ms,
            sources: self.content.sources,
            has_meeting_notes: self.content.meeting_notes.is_some(),
        }
    }

    /// Whether every word of `query` appears in the title or the text.
    fn matches(&self, words: &[String]) -> bool {
        let haystack = std::iter::once(self.title.as_str())
            .chain(std::iter::once(self.content.notes.as_str()))
            .chain(self.content.meeting_notes.as_deref())
            .chain(
                self.content
                    .transcript
                    .iter()
                    .map(|line| line.text.as_str()),
            )
            .chain(
                self.content
                    .cues
                    .iter()
                    .flat_map(|cue| [cue.question.as_str(), cue.evidence.as_str()]),
            )
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        words
            .iter()
            .all(|word| haystack.iter().any(|text| text.contains(word.as_str())))
    }

    /// The Markdown a person reviews before saving: title, when, sources,
    /// the person's notes, kept meeting notes if any, cues shown and the
    /// transcript. Never anything not kept in the meeting itself.
    pub fn markdown(&self) -> String {
        let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
        let clock = crate::meeting_notes::clock;
        let mut out = format!("# {}\n\n", flat(&self.title));
        let started = i64::try_from(self.content.started_at_ms)
            .ok()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|when| when.format("%Y-%m-%d %H:%M UTC").to_string());
        let source = match (self.content.sources, self.content.application.as_deref()) {
            (Sources::Microphone, _) => "Microphone".to_string(),
            (Sources::Application, Some(app)) => format!("Application ({})", flat(app)),
            (Sources::Application, None) => "Application".to_string(),
            (Sources::Both, Some(app)) => format!("Microphone and {}", flat(app)),
            (Sources::Both, None) => "Microphone and application".to_string(),
        };
        if let Some(started) = started {
            out.push_str(&format!(
                "Started {started} · Length {} · {source}\n",
                clock(self.content.duration_ms)
            ));
        } else {
            out.push_str(&format!(
                "Length {} · {source}\n",
                clock(self.content.duration_ms)
            ));
        }
        out.push_str("\n## Notes\n\n");
        if self.content.notes.trim().is_empty() {
            out.push_str("None.\n");
        } else {
            out.push_str(&self.content.notes);
            if !self.content.notes.ends_with('\n') {
                out.push('\n');
            }
        }
        if let Some(kept) = self.content.meeting_notes.as_deref() {
            out.push('\n');
            out.push_str(kept);
            if !kept.ends_with('\n') {
                out.push('\n');
            }
        }
        out.push_str("\n## Cues shown\n\n");
        if self.content.cues.is_empty() {
            out.push_str("None.\n");
        }
        for cue in &self.content.cues {
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
        if let Some(provider) = self.content.transcribed_by.as_deref() {
            out.push_str(&format!(
                "Transcribed by {}. Speakers are not identified.\n\n",
                flat(provider)
            ));
        }
        if self.content.sources == Sources::Both {
            let from = self
                .content
                .application
                .as_deref()
                .map(flat)
                .unwrap_or_else(|| "the application".to_string());
            out.push_str(&format!(
                "You marks a line heard by this Mac's microphone and Them a line from {from}'s audio. They say where a line was heard, not who said it.\n\n"
            ));
        }
        if self.content.transcript.is_empty() {
            out.push_str("None.\n");
        }
        for line in &self.content.transcript {
            let label = match (self.content.sources, line.echo, line.label) {
                (Sources::Both, true, _) => " You (likely an echo of Them):".to_string(),
                (Sources::Both, false, Some(Label::You)) => " You:".to_string(),
                (Sources::Both, false, Some(Label::Them)) => " Them:".to_string(),
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

    /// What this kept meeting supplies as prior context: only its kept meeting
    /// notes and the person's own notes (never the transcript, cues, or
    /// application name), bounded to `context::MAX_EXCERPT_CHARS`.
    pub fn context_item(&self) -> Option<crate::context::ContextItem> {
        let source_date = i64::try_from(self.content.started_at_ms)
            .ok()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|when| when.format("%Y-%m-%d").to_string())
            .filter(|date| crate::context::valid_date(date))?;
        let meeting_notes = self
            .content
            .meeting_notes
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let notes = Some(self.content.notes.trim()).filter(|text| !text.is_empty());
        let excerpt = match (meeting_notes, notes) {
            (Some(mn), Some(n)) => format!("Meeting notes:\n{mn}\n\nYour notes:\n{n}"),
            (Some(mn), None) => mn.to_string(),
            (None, Some(n)) => n.to_string(),
            (None, None) => return None,
        };
        let excerpt: String = excerpt
            .chars()
            .take(crate::context::MAX_EXCERPT_CHARS)
            .collect();
        Some(crate::context::ContextItem {
            provider: crate::context::Provider::History,
            source_id: self.id.clone(),
            title: self.title.clone(),
            source_date,
            excerpt,
            revision: self.revision,
        })
    }
}

fn preview_of(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = flat.chars();
    let head: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// Kept meetings listed for prior-context selection, carrying only their kept
/// meeting notes and the person's own notes.
pub struct HistorySource {
    items: Vec<crate::context::ContextItem>,
    pub skipped: usize,
}

impl HistorySource {
    pub fn read(store: &Store) -> Result<Self, Error> {
        let listing = store.list(None);
        match listing.availability {
            Availability::On => {}
            Availability::Newer => return Err(Error::Newer),
            Availability::LabRun | Availability::Unavailable => return Err(Error::Off),
        }
        let mut items = Vec::new();
        let mut skipped = 0;
        for summary in listing.meetings {
            if items.len() >= crate::notes_file::MAX_NOTES {
                skipped += 1;
                continue;
            }
            match store
                .open_meeting(&summary.id)
                .ok()
                .and_then(|meeting| meeting.context_item())
            {
                Some(item) => items.push(item),
                None => skipped += 1,
            }
        }
        Ok(Self { items, skipped })
    }

    pub fn summaries(&self) -> Vec<crate::notes_file::NoteSummary> {
        self.items
            .iter()
            .map(|item| crate::notes_file::NoteSummary {
                source_id: item.source_id.clone(),
                title: item.title.clone(),
                source_date: item.source_date.clone(),
                preview: preview_of(&item.excerpt),
            })
            .collect()
    }
}

impl crate::context::NoteSource for HistorySource {
    fn provider(&self) -> crate::context::Provider {
        crate::context::Provider::History
    }

    fn capabilities(&self) -> crate::context::Capabilities {
        crate::context::Capabilities {
            import_notes: true,
            live_input: false,
            writeback: false,
        }
    }

    fn fetch(
        &mut self,
        selection: &[String],
    ) -> Result<Vec<crate::context::ContextItem>, crate::context::SourceError> {
        Ok(self
            .items
            .iter()
            .filter(|item| selection.iter().any(|id| id.trim() == item.source_id))
            .cloned()
            .collect())
    }
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

fn has_controls(text: &str) -> bool {
    text.chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
}

/// A title as the person typed it, or why it cannot be one.
pub fn valid_title(title: &str) -> Result<String, Error> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err(Error::Title);
    }
    if chars(&title) > MAX_TITLE_CHARS || has_controls(&title) {
        return Err(Error::Title);
    }
    Ok(title)
}

/// An identifier this store made: 32 lowercase hex digits. Anything else is
/// refused before it is used in a path.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn new_id() -> Result<String, Error> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Error::Write)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl Content {
    /// Whether everything is within bounds and well formed.
    fn valid(&self) -> bool {
        let line_ok =
            |line: &Line| chars(&line.text) <= MAX_LINE_CHARS && !has_controls(&line.text);
        let cue_ok = |cue: &Cue| {
            [&cue.kind, &cue.question, &cue.evidence]
                .iter()
                .all(|field| chars(field) <= MAX_CUE_FIELD_CHARS && !has_controls(field))
        };
        let application_ok = self.application.as_deref().is_none_or(|name| {
            !name.trim().is_empty()
                && chars(name) <= MAX_APPLICATION_CHARS
                && !has_controls(name)
                && self.sources != Sources::Microphone
        });
        let provider_ok = self
            .transcribed_by
            .as_deref()
            .is_none_or(|name| chars(name) <= MAX_PROVIDER_CHARS && !has_controls(name));
        let labels_ok = self.sources == Sources::Both
            || self
                .transcript
                .iter()
                .all(|line| line.label.is_none() && !line.echo);
        self.transcript.len() <= MAX_LINES
            && self.transcript.iter().all(line_ok)
            && self.cues.len() <= MAX_CUES
            && self.cues.iter().all(cue_ok)
            && chars(&self.notes) <= MAX_NOTES_CHARS
            && self
                .meeting_notes
                .as_deref()
                .is_none_or(|notes| chars(notes) <= crate::meeting_notes::MAX_KEPT_CHARS)
            && application_ok
            && provider_ok
            && labels_ok
    }
}

/// Why a change to the history was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// A lab run, or no Application Support directory.
    Off,
    /// The history was written by a newer TalkQTE and is read-only here.
    Newer,
    Full,
    Title,
    Missing,
    Unreadable,
    Write,
    Invalid,
}

impl Error {
    pub fn message(self) -> &'static str {
        match self {
            Error::Off => "Kept meetings are not available in this launch.",
            Error::Newer => "Your kept meetings were saved by a newer TalkQTE. This version leaves them as they are; update TalkQTE to change them.",
            Error::Full => "You have kept 1,000 meetings. Delete one to keep another.",
            Error::Title => "Give the meeting a title of up to 200 characters.",
            Error::Missing => "That meeting is no longer kept.",
            Error::Unreadable => "That meeting could not be read.",
            Error::Write => "The meeting could not be saved. Nothing was changed.",
            Error::Invalid => "This meeting is too large to keep.",
        }
    }
}

/// Whether the history can be used in this launch, for the notebook to say.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    On,
    /// A lab run: nothing is read or written.
    LabRun,
    /// The app has no Application Support directory to use.
    Unavailable,
    /// Written by a newer TalkQTE: not read or changed, only Delete all.
    Newer,
}

/// The list, newest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub availability: Availability,
    pub meetings: Vec<Summary>,
    /// Kept meetings that could not be read or were saved by a newer
    /// version; not shown, never changed, removed by Delete all.
    pub unreadable: usize,
}

#[derive(Serialize, Deserialize)]
struct IndexFile {
    version: u64,
    meetings: Vec<Summary>,
}

#[derive(Serialize)]
struct MeetingFileOut<'a> {
    version: u64,
    #[serde(flatten)]
    meeting: &'a Meeting,
}

/// Reads at most `limit` bytes of a regular file.
fn read_bounded(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > limit {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

/// A file's format version, if it states one.
fn version_of(value: &Value) -> Option<u64> {
    value.get("version").and_then(Value::as_u64)
}

/// What one meeting file gave.
#[derive(Debug, PartialEq)]
enum Found {
    Meeting(Box<Meeting>),
    Newer,
    Unreadable,
}

fn read_meeting(path: &Path, id: &str) -> Found {
    let Some(bytes) = read_bounded(path, MAX_MEETING_BYTES) else {
        return Found::Unreadable;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Found::Unreadable;
    };
    match version_of(&value) {
        Some(VERSION) => {}
        Some(version) if version > VERSION => return Found::Newer,
        _ => return Found::Unreadable,
    }
    match serde_json::from_value::<Meeting>(value) {
        Ok(meeting)
            if meeting.id == id
                && valid_title(&meeting.title).as_deref() == Ok(meeting.title.as_str())
                && meeting.content.valid() =>
        {
            Found::Meeting(Box::new(meeting))
        }
        _ => Found::Unreadable,
    }
}

#[cfg(unix)]
fn owner_only_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn owner_only_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)
}

/// Replaces `path` with `bytes` atomically, owner-only.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no folder"))?;
    owner_only_dir(directory)?;
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("no file name"))?
        .to_string_lossy();
    let temporary = directory.join(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn render<T: Serialize>(value: &T) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(value).expect("history serializes");
    bytes.push(b'\n');
    bytes
}

/// Whether this launch is a lab run. Uses the settings file's guard so both
/// follow the exact same launch settings. Debug builds only; a release build
/// has no lab runs.
fn lab_run() -> bool {
    crate::settings::lab_run()
}

/// The kept meetings for this launch.
pub struct Store {
    root: Option<PathBuf>,
    availability: Mutex<Availability>,
    /// Serializes every change, so two writes never interleave.
    lock: Mutex<()>,
}

impl Store {
    /// The history in `root` (the `meetings` folder), or none when there is
    /// nowhere to keep it. In a lab run nothing is read or written.
    pub fn open(root: Option<PathBuf>, lab_run: bool) -> Self {
        let (root, availability) = match (lab_run, root) {
            (true, _) => (None, Availability::LabRun),
            (false, None) => (None, Availability::Unavailable),
            (false, Some(root)) => (Some(root), Availability::On),
        };
        Self {
            root,
            availability: Mutex::new(availability),
            lock: Mutex::new(()),
        }
    }

    /// The store for the running app, in its Application Support directory.
    pub fn for_app(app: &tauri::AppHandle) -> Self {
        use tauri::Manager;
        let root = app.path().app_data_dir().ok().map(|dir| dir.join(DIR));
        Self::open(root, lab_run())
    }

    pub fn availability(&self) -> Availability {
        self.availability
            .lock()
            .map(|value| *value)
            .unwrap_or(Availability::Unavailable)
    }

    fn set_availability(&self, value: Availability) {
        if let Ok(mut current) = self.availability.lock() {
            *current = value;
        }
    }

    fn index_path(root: &Path) -> PathBuf {
        root.join(INDEX)
    }

    fn meeting_path(root: &Path, id: &str) -> PathBuf {
        root.join(id).join(MEETING)
    }

    /// The index's entries, or `Newer`/`Unreadable`. A missing index is an
    /// empty history.
    fn read_index(&self, root: &Path) -> Result<Vec<Summary>, Availability> {
        let path = Self::index_path(root);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = read_bounded(&path, MAX_INDEX_BYTES).ok_or(Availability::Unavailable)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| Availability::Unavailable)?;
        match version_of(&value) {
            Some(VERSION) => {}
            Some(version) if version > VERSION => return Err(Availability::Newer),
            _ => return Err(Availability::Unavailable),
        }
        let index: IndexFile =
            serde_json::from_value(value).map_err(|_| Availability::Unavailable)?;
        let mut seen = std::collections::HashSet::new();
        Ok(index
            .meetings
            .into_iter()
            .filter(|entry| valid_id(&entry.id) && seen.insert(entry.id.clone()))
            .filter(|entry| valid_title(&entry.title).as_deref() == Ok(entry.title.as_str()))
            .take(MAX_MEETINGS)
            .collect())
    }

    /// The root and current entries for a change, refusing a newer history.
    fn writable(&self) -> Result<(PathBuf, Vec<Summary>), Error> {
        let root = self.root.clone().ok_or(Error::Off)?;
        match self.read_index(&root) {
            Ok(entries) => {
                self.set_availability(Availability::On);
                Ok((root, entries))
            }
            Err(Availability::Newer) => {
                self.set_availability(Availability::Newer);
                Err(Error::Newer)
            }
            // A damaged index is never silently replaced: its meetings are
            // still on disk. Delete all clears it.
            Err(_) => Err(Error::Unreadable),
        }
    }

    fn write_index(root: &Path, entries: &[Summary]) -> Result<(), Error> {
        let mut entries = entries.to_vec();
        entries.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms).then(a.id.cmp(&b.id)));
        write_atomic(
            &Self::index_path(root),
            &render(&IndexFile {
                version: VERSION,
                meetings: entries,
            }),
        )
        .map_err(|_| Error::Write)
    }

    fn write_meeting(root: &Path, meeting: &Meeting) -> Result<(), Error> {
        let bytes = render(&MeetingFileOut {
            version: VERSION,
            meeting,
        });
        if bytes.len() as u64 > MAX_MEETING_BYTES {
            return Err(Error::Invalid);
        }
        write_atomic(&Self::meeting_path(root, &meeting.id), &bytes).map_err(|_| Error::Write)
    }

    /// The kept meetings, newest first, matching `query` (every word, in the
    /// title or the text, ignoring case) when one is given.
    pub fn list(&self, query: Option<&str>) -> Listing {
        let _guard = self.lock.lock();
        let availability = self.availability();
        let Some(root) = self.root.clone() else {
            return Listing {
                availability,
                meetings: vec![],
                unreadable: 0,
            };
        };
        let entries = match self.read_index(&root) {
            Ok(entries) => {
                self.set_availability(Availability::On);
                entries
            }
            Err(availability) => {
                if availability == Availability::Newer {
                    self.set_availability(Availability::Newer);
                }
                return Listing {
                    availability: self.availability(),
                    meetings: vec![],
                    unreadable: usize::from(availability != Availability::Newer),
                };
            }
        };
        let words: Vec<String> = query
            .map(|query| query.chars().take(MAX_QUERY_CHARS).collect::<String>())
            .unwrap_or_default()
            .to_lowercase()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let mut meetings = Vec::new();
        let mut unreadable = 0;
        for entry in entries {
            match read_meeting(&Self::meeting_path(&root, &entry.id), &entry.id) {
                Found::Meeting(meeting) => {
                    if words.is_empty() || meeting.matches(&words) {
                        meetings.push(meeting.summary());
                    }
                }
                Found::Newer | Found::Unreadable => unreadable += 1,
            }
        }
        meetings.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms).then(a.id.cmp(&b.id)));
        Listing {
            availability: Availability::On,
            meetings,
            unreadable,
        }
    }

    /// One kept meeting, read in full.
    pub fn open_meeting(&self, id: &str) -> Result<Meeting, Error> {
        if !valid_id(id) {
            return Err(Error::Missing);
        }
        let _guard = self.lock.lock();
        let root = self.root.clone().ok_or(Error::Off)?;
        match self.read_index(&root) {
            Ok(entries) if entries.iter().any(|entry| entry.id == id) => {}
            Ok(_) => return Err(Error::Missing),
            Err(Availability::Newer) => return Err(Error::Newer),
            Err(_) => return Err(Error::Unreadable),
        }
        match read_meeting(&Self::meeting_path(&root, id), id) {
            Found::Meeting(meeting) => Ok(*meeting),
            Found::Newer => Err(Error::Newer),
            Found::Unreadable => Err(Error::Unreadable),
        }
    }

    /// Keeps a new meeting. The meeting's file is written before the index,
    /// so a failure part-way leaves the list as it was.
    pub fn keep(&self, title: &str, content: Content) -> Result<Summary, Error> {
        let title = valid_title(title)?;
        if !content.valid() {
            return Err(Error::Invalid);
        }
        let _guard = self.lock.lock();
        let (root, mut entries) = self.writable()?;
        if entries.len() >= MAX_MEETINGS {
            return Err(Error::Full);
        }
        let meeting = Meeting {
            id: new_id()?,
            title,
            revision: 1,
            content,
        };
        Self::write_meeting(&root, &meeting)?;
        entries.push(meeting.summary());
        if let Err(error) = Self::write_index(&root, &entries) {
            let _ = fs::remove_dir_all(root.join(&meeting.id));
            return Err(error);
        }
        Ok(meeting.summary())
    }

    fn change(
        &self,
        id: &str,
        apply: impl FnOnce(&mut Meeting) -> Result<(), Error>,
    ) -> Result<Summary, Error> {
        if !valid_id(id) {
            return Err(Error::Missing);
        }
        let _guard = self.lock.lock();
        let (root, mut entries) = self.writable()?;
        let Some(position) = entries.iter().position(|entry| entry.id == id) else {
            return Err(Error::Missing);
        };
        let mut meeting = match read_meeting(&Self::meeting_path(&root, id), id) {
            Found::Meeting(meeting) => *meeting,
            Found::Newer => return Err(Error::Newer),
            Found::Unreadable => return Err(Error::Unreadable),
        };
        apply(&mut meeting)?;
        if !meeting.content.valid() {
            return Err(Error::Invalid);
        }
        meeting.revision += 1;
        Self::write_meeting(&root, &meeting)?;
        entries[position] = meeting.summary();
        Self::write_index(&root, &entries)?;
        Ok(meeting.summary())
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<Summary, Error> {
        let title = valid_title(title)?;
        self.change(id, |meeting| {
            meeting.title = title;
            Ok(())
        })
    }

    /// Replaces a kept meeting's content with a newer copy of the same
    /// session, keeping its title.
    pub fn update(&self, id: &str, content: Content) -> Result<Summary, Error> {
        self.change(id, |meeting| {
            meeting.content = content;
            Ok(())
        })
    }

    /// Deletes one kept meeting for good: its folder is removed, then the
    /// list. A folder that cannot be removed leaves the meeting listed.
    pub fn delete(&self, id: &str) -> Result<(), Error> {
        if !valid_id(id) {
            return Err(Error::Missing);
        }
        let _guard = self.lock.lock();
        let (root, mut entries) = self.writable()?;
        let Some(position) = entries.iter().position(|entry| entry.id == id) else {
            return Err(Error::Missing);
        };
        let folder = root.join(id);
        if folder.exists() {
            fs::remove_dir_all(&folder).map_err(|_| Error::Write)?;
        }
        entries.remove(position);
        Self::write_index(&root, &entries)
    }

    /// Deletes every kept meeting, including any that could not be read or
    /// were saved by a newer version, by removing the whole folder. Returns
    /// how many listed meetings there were.
    pub fn delete_all(&self) -> Result<usize, Error> {
        let _guard = self.lock.lock();
        let root = self.root.clone().ok_or(Error::Off)?;
        let count = self.read_index(&root).map_or(0, |entries| entries.len());
        if root.exists() {
            fs::remove_dir_all(&root).map_err(|_| Error::Write)?;
        }
        self.set_availability(Availability::On);
        Ok(count)
    }
}

#[cfg(test)]
#[path = "meeting_history_tests.rs"]
mod tests;
