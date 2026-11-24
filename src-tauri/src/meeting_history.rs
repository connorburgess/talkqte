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

/// Whether this launch is a lab run. The same launch settings as the
/// settings file's guard: the lab launcher always sets the run identifier
/// and the timing log; the others mark a lab launch made by hand. Debug
/// builds only; a release build has no lab runs.
fn lab_run() -> bool {
    #[cfg(debug_assertions)]
    {
        lab_run_in(|name| std::env::var_os(name).is_some())
    }
    #[cfg(not(debug_assertions))]
    false
}

#[cfg_attr(not(debug_assertions), allow(dead_code))]
const LAB_SETTINGS: &[&str] = &[
    "TALKQTE_DEV_LAB_RUN_ID",
    "TALKQTE_TIMING_LOG",
    "TALKQTE_DEV_CUE_BACKEND",
    "TALKQTE_DEV_LAB_DESCRIPTOR",
    "TALKQTE_DEV_LAB_CONTEXT",
    "TALKQTE_DEV_APPLICATION_SOURCE",
    "TALKQTE_DEV_PLAYER_PID",
];

#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn lab_run_in(present: impl Fn(&str) -> bool) -> bool {
    LAB_SETTINGS.iter().any(|name| present(name))
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

/// The meeting's start as `YYYY-MM-DD HH:MM UTC`.
pub fn utc_start(meeting: &Meeting) -> String {
    i64::try_from(meeting.content.started_at_ms)
        .ok()
        .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
        .map_or_else(
            || "an unknown date".into(),
            |when| when.format("%Y-%m-%d %H:%M UTC").to_string(),
        )
}

/// A file name for the export: the meeting's date, never its title.
pub fn export_file_name(meeting: &Meeting) -> String {
    let date = utc_start(meeting);
    match date.get(..10) {
        Some(day) if date.len() > 10 => format!("talkqte-meeting-{day}.md"),
        _ => "talkqte-meeting.md".into(),
    }
}

/// A kept meeting as Markdown, in the same shape as an export that keeps
/// the meeting: the notes, kept meeting notes, cues shown and transcript.
pub fn markdown(meeting: &Meeting) -> String {
    use crate::engine::{THEM, YOU};
    let clock = crate::meeting_notes::clock;
    let flat = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let content = &meeting.content;
    let sources = match (content.sources, content.application.as_deref()) {
        (Sources::Microphone, _) => "the microphone".to_string(),
        (Sources::Application, Some(name)) => format!("{}'s audio", flat(name)),
        (Sources::Application, None) => "one application's audio".to_string(),
        (Sources::Both, Some(name)) => format!("the microphone and {}'s audio", flat(name)),
        (Sources::Both, None) => "the microphone and one application's audio".to_string(),
    };
    let minutes = content.duration_ms.div_ceil(60_000);
    let mut out = format!(
        "# {}\n\nKept in TalkQTE. Started {}, {} min, from {}.\n\n## Notes\n\n{}\n",
        flat(&meeting.title),
        utc_start(meeting),
        minutes,
        sources,
        if content.notes.trim().is_empty() {
            "None."
        } else {
            content.notes.trim_end()
        }
    );
    if let Some(notes) = &content.meeting_notes {
        out.push_str(&format!("\n{}\n", notes.trim_end()));
    }
    out.push_str("\n## Cues shown\n\n");
    if content.cues.is_empty() {
        out.push_str("None.\n");
    }
    for cue in &content.cues {
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
    if let Some(provider) = &content.transcribed_by {
        out.push_str(&format!(
            "Transcribed by {}. Speakers are not identified.\n\n",
            flat(provider)
        ));
    }
    if content.sources == Sources::Both {
        out.push_str(&format!(
            "{YOU} marks a line heard by this Mac's microphone and {THEM} a line from the application's audio. They say where a line was heard, not who said it.\n\n"
        ));
    }
    if content.transcript.is_empty() {
        out.push_str("None.\n");
    }
    for line in &content.transcript {
        let label = match (line.label, line.echo) {
            (Some(Label::You), true) => format!(" {YOU} (likely an echo of {THEM}):"),
            (Some(Label::You), false) => format!(" {YOU}:"),
            (Some(Label::Them), _) => format!(" {THEM}:"),
            (None, _) => String::new(),
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

#[cfg(test)]
#[path = "meeting_history_tests.rs"]
mod tests;
