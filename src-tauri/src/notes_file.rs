//! Prior notes from a file the user chooses: a TalkQTE JSON document of
//! notes with an ID, a date, and text, or one Markdown or plain-text note,
//! such as a summary exported from another note-taker. This is the first
//! note source behind the context contract; it needs no account or network.
//! The file is read once into memory, and only the notes the user then
//! selects are kept.
//!
//! A Markdown or plain-text file is one note. Its title is a `title:` in
//! front matter or a level-one heading on its first line (Markdown only), or
//! else the file name. Its date comes only from a `date:` in Markdown front
//! matter or a `Date:` line near the top, before any other heading, written
//! YYYY-MM-DD; otherwise the person enters the date in the chooser. Nothing
//! guesses a date, and the text is kept as written.

use crate::context::{valid_date, Capabilities, ContextItem, NoteSource, Provider, SourceError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

/// The largest notes file read, so a wrong pick cannot fill memory.
pub const MAX_FILE_BYTES: u64 = 1 << 20;
/// The most notes listed from one file.
pub const MAX_NOTES: usize = 200;
/// Characters of each note shown while choosing.
const PREVIEW_CHARS: usize = 120;
/// Non-blank lines at the top of a Markdown or plain-text note searched for
/// a `Date:` line.
const DATE_LINE_SEARCH: usize = 10;
/// The extensions the file chooser offers and `FileSource::read` accepts.
pub const EXTENSIONS: [&str; 4] = ["json", "md", "markdown", "txt"];

const UNREADABLE: &str = "The file could not be read.";
const TOO_LARGE: &str = "That file is larger than 1 MB. Choose a smaller notes file.";
const NOT_TEXT: &str = "That file is not plain text. Export the notes as Markdown or plain text.";
const NO_TEXT: &str = "The file has no note text.";
const UNSUPPORTED: &str = "TalkQTE reads notes from a Markdown (.md) or plain-text (.txt) file, or a TalkQTE JSON notes file. Export or save the notes in one of those formats.";
const TRANSCRIPT: &str = "That is a transcript or captions file. TalkQTE brings in notes and summaries, not transcripts. Export the summary as Markdown or plain text instead.";

/// How a picked file is read, decided by its extension alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    Json,
    Markdown,
    Text,
}

impl FileKind {
    fn of(path: &Path) -> Result<Self, &'static str> {
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase);
        match extension.as_deref() {
            Some("json") => Ok(FileKind::Json),
            Some("md" | "markdown") => Ok(FileKind::Markdown),
            Some("txt") => Ok(FileKind::Text),
            Some("srt" | "vtt") => Err(TRANSCRIPT),
            _ => Err(UNSUPPORTED),
        }
    }
}

/// What a Markdown or plain-text note takes from its file besides the text.
pub struct Document<'a> {
    pub kind: FileKind,
    /// The file name without its extension: the title when no heading gives one.
    pub name: &'a str,
    /// Stays the same when the same file is chosen again.
    pub source_id: String,
    /// Increases when the file is saved again.
    pub revision: u64,
}

#[derive(Deserialize)]
struct NotesFile {
    notes: Vec<NoteEntry>,
}

#[derive(Deserialize)]
struct NoteEntry {
    id: String,
    #[serde(default)]
    title: String,
    date: String,
    text: String,
    #[serde(default = "first_revision")]
    revision: u64,
}

fn first_revision() -> u64 {
    1
}

/// One note as listed for selection: enough to choose by, not the text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub source_id: String,
    pub title: String,
    pub source_date: String,
    pub preview: String,
}

/// The notes read from one file, served through the context contract.
#[derive(Debug)]
pub struct FileSource {
    notes: Vec<ContextItem>,
    /// Notes in the file beyond `MAX_NOTES`, or with an ID already listed.
    pub skipped: usize,
    kind: FileKind,
}

impl FileSource {
    /// Reads and parses a notes file. Errors are short messages for the
    /// person who picked the file; they never include the file's text.
    pub fn read(path: &Path) -> Result<Self, String> {
        let kind = FileKind::of(path)?;
        let metadata = std::fs::metadata(path).map_err(|_| UNREADABLE)?;
        if metadata.len() > MAX_FILE_BYTES {
            return Err(TOO_LARGE.into());
        }
        // Read at most one byte past the limit, in case the file grew.
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .and_then(|file| file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes))
            .map_err(|_| UNREADABLE)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(TOO_LARGE.into());
        }
        // A renamed PDF or Word file is binary, and rarely valid UTF-8.
        if kind != FileKind::Json && bytes.contains(&0) {
            return Err(NOT_TEXT.into());
        }
        let text = String::from_utf8(bytes).map_err(|_| UNREADABLE)?;
        if kind == FileKind::Json {
            return Self::parse(&text);
        }
        let name = path
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let revision = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(1, |since| {
                u64::try_from(since.as_millis()).unwrap_or(u64::MAX).max(1)
            });
        Self::parse_document(
            &text,
            Document {
                kind,
                name: &name,
                source_id: document_id(path),
                revision,
            },
        )
    }

    /// Reads one Markdown or plain-text note. See the module notes for how
    /// its title and date are found.
    pub fn parse_document(text: &str, document: Document) -> Result<Self, String> {
        if text.contains('\0') {
            return Err(NOT_TEXT.into());
        }
        let text = text
            .strip_prefix('\u{FEFF}')
            .unwrap_or(text)
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        let mut lines: Vec<&str> = text.split('\n').collect();
        let mut title = None;
        let mut date = None;
        if document.kind == FileKind::Markdown {
            if let Some((fields, rest)) = front_matter(&lines) {
                title = fields
                    .get("title")
                    .cloned()
                    .filter(|title| !title.is_empty());
                date = fields.get("date").and_then(|value| iso_date(value));
                lines.drain(..rest);
            }
            if let Some(first) = lines.iter().position(|line| !line.trim().is_empty()) {
                if let Some(heading) = level_one_heading(lines[first]).filter(|_| title.is_none()) {
                    title = Some(heading);
                    lines.remove(first);
                }
            }
        }
        if date.is_none() {
            // Only the top of the note: a dated item under a later heading
            // is about something else. A heading on the first line is the
            // title, even when front matter named the note.
            date = lines
                .iter()
                .filter(|line| !line.trim().is_empty())
                .take(DATE_LINE_SEARCH)
                .enumerate()
                .take_while(|(index, line)| {
                    !is_heading(line) || (*index == 0 && level_one_heading(line).is_some())
                })
                .find_map(|(_, line)| date_line(line));
        }
        let body = lines.join("\n").trim().to_string();
        if body.is_empty() {
            return Err(NO_TEXT.into());
        }
        Ok(Self {
            notes: vec![ContextItem {
                provider: Provider::File,
                source_id: document.source_id,
                title: title.unwrap_or_else(|| document.name.trim().to_string()),
                source_date: date.unwrap_or_default(),
                excerpt: body,
                revision: document.revision,
            }],
            skipped: 0,
            kind: document.kind,
        })
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let file: NotesFile = serde_json::from_str(text).map_err(|_| {
            "That is not a TalkQTE notes file. It needs a \"notes\" list with an id, date, and text for each note."
        })?;
        if file.notes.is_empty() {
            return Err("The file has no notes.".into());
        }
        let total = file.notes.len();
        let mut seen: Vec<String> = Vec::new();
        let notes: Vec<ContextItem> = file
            .notes
            .into_iter()
            .filter(|note| {
                // One entry per ID: the first wins, so a file cannot list a
                // note twice and have both tick together.
                let id = note.id.trim().to_string();
                if seen.contains(&id) {
                    false
                } else {
                    seen.push(id);
                    true
                }
            })
            .take(MAX_NOTES)
            .map(|note| ContextItem {
                provider: Provider::File,
                source_id: note.id,
                title: note.title,
                source_date: note.date,
                excerpt: note.text,
                revision: note.revision,
            })
            .collect();
        let skipped = total - notes.len();
        Ok(Self {
            notes,
            skipped,
            kind: FileKind::Json,
        })
    }

    /// The notes to choose from, in file order.
    pub fn summaries(&self) -> Vec<NoteSummary> {
        self.notes
            .iter()
            .map(|note| NoteSummary {
                source_id: note.source_id.trim().to_string(),
                title: if note.title.trim().is_empty() {
                    "Untitled note".into()
                } else {
                    note.title.trim().to_string()
                },
                source_date: note.source_date.clone(),
                preview: {
                    let trimmed = note.excerpt.trim();
                    let short: String = trimmed.chars().take(PREVIEW_CHARS).collect();
                    if trimmed.chars().count() > PREVIEW_CHARS {
                        format!("{short}…")
                    } else {
                        short
                    }
                },
            })
            .collect()
    }
}

/// The same for every pick of the same file in this session, and different
/// for another file even with the same name. The path itself is not kept:
/// the identifier is a hash of it under a key made once per session.
fn document_id(path: &Path) -> String {
    use std::hash::BuildHasher;
    static KEY: std::sync::OnceLock<std::collections::hash_map::RandomState> =
        std::sync::OnceLock::new();
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    format!(
        "file-{:016x}",
        KEY.get_or_init(Default::default).hash_one(&path)
    )
}

/// A `key: value` line whose key is a single word, as front matter writes it.
fn front_matter_field(line: &str) -> bool {
    line.split_once(':').is_some_and(|(key, value)| {
        !key.is_empty()
            && key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            && (value.is_empty() || value.starts_with([' ', '\t']))
    })
}

/// Simple `key: value` lines between a `---` first line and the next `---`
/// or `...` line, with the number of lines they take. Nested values are
/// ignored. Without a closing line, without a single-word `key:` line, or
/// with a line that is neither a field, an indented value, a list item nor a
/// comment, there is no front matter, and the lines stay note text.
fn front_matter(lines: &[&str]) -> Option<(HashMap<String, String>, usize)> {
    if lines.first()?.trim_end() != "---" {
        return None;
    }
    let end = lines
        .iter()
        .skip(1)
        .position(|line| matches!(line.trim_end(), "---" | "..."))?
        + 1;
    // Two horizontal rules around a paragraph are not front matter.
    let inside = &lines[1..end];
    let metadata = inside.iter().any(|line| front_matter_field(line))
        && inside.iter().all(|line| {
            line.trim().is_empty()
                || line.starts_with([' ', '\t', '#'])
                || line.starts_with("- ")
                || front_matter_field(line)
        });
    if !metadata {
        return None;
    }
    let fields = inside
        .iter()
        .filter(|line| front_matter_field(line))
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| {
            let value = value.trim();
            let unquoted = [('"', '"'), ('\'', '\'')]
                .iter()
                .find_map(|(open, close)| value.strip_prefix(*open)?.strip_suffix(*close))
                .unwrap_or(value);
            (key.trim().to_ascii_lowercase(), unquoted.trim().to_string())
        })
        .collect();
    Some((fields, end + 1))
}

/// The text of an ATX level-one heading (`# Title`), without closing hashes.
fn level_one_heading(line: &str) -> Option<String> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    let rest = line.trim_start_matches(' ').strip_prefix('#')?;
    if indent > 3 || !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    let text = rest.trim();
    let text = match text.trim_end_matches('#') {
        stripped if stripped.is_empty() || stripped.ends_with([' ', '\t']) => stripped,
        _ => text,
    };
    Some(text.trim().to_string()).filter(|text| !text.is_empty())
}

/// An ATX heading of any level (`#` to `######`).
fn is_heading(line: &str) -> bool {
    let trimmed = line.trim_start_matches(' ');
    let hashes = trimmed.len() - trimmed.trim_start_matches('#').len();
    line.len() - trimmed.len() <= 3
        && (1..=6).contains(&hashes)
        && trimmed[hashes..]
            .chars()
            .next()
            .is_none_or(|c| c == ' ' || c == '\t')
}

/// A real YYYY-MM-DD date at the start of `value`, alone or followed by a
/// time or other words; never a range or a longer number.
fn iso_date(value: &str) -> Option<String> {
    let value = value.trim();
    let date = value.get(..10)?;
    let next = value[10..].chars().next();
    (valid_date(date) && !next.is_some_and(|c| c.is_ascii_digit() || c == '-'))
        .then(|| date.to_string())
}

/// The date of a `Date: YYYY-MM-DD` or `Meeting date: YYYY-MM-DD` line,
/// also as a list item or in bold, as some exports write it.
fn date_line(line: &str) -> Option<String> {
    let plain: String = line.chars().filter(|c| !matches!(c, '*' | '_')).collect();
    let mut rest = plain.trim_start();
    while let Some(after) = ["- ", "+ ", "> "]
        .iter()
        .find_map(|marker| rest.strip_prefix(marker))
    {
        rest = after.trim_start();
    }
    let lower = rest.to_ascii_lowercase();
    let label = ["meeting date", "date"]
        .iter()
        .find(|label| lower.starts_with(*label))?;
    let value = rest[label.len()..].trim_start().strip_prefix(':')?;
    iso_date(value)
}

impl NoteSource for FileSource {
    fn provider(&self) -> Provider {
        Provider::File
    }

    fn asks_for_dates(&self) -> bool {
        self.kind != FileKind::Json
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            import_notes: true,
            ..Capabilities::default()
        }
    }

    /// Returns only the selected notes. A file cannot expire, be revoked, or
    /// rate-limit, so this never fails once the file is read.
    fn fetch(&mut self, selection: &[String]) -> Result<Vec<ContextItem>, SourceError> {
        Ok(self
            .notes
            .iter()
            .filter(|note| {
                selection
                    .iter()
                    .any(|id| id.trim() == note.source_id.trim())
            })
            .cloned()
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{fetch_selection, ContextStore};
    use crate::context_import::PendingImport;

    const EXAMPLE: &str = r#"{"notes":[
        {"id":"n1","title":"Garden welcome guide","date":"2026-10-28","text":"Draft a one-page guide. Robin suggested a map of the tool shed."},
        {"id":"n2","date":"2026-11-02","text":"Visitors asked where to find watering cans."},
        {"id":"n3","title":"No date","date":"","text":"Should be rejected by the store."}
    ]}"#;

    #[test]
    fn a_notes_file_lists_its_notes_and_serves_the_selection() {
        let mut source = FileSource::parse(EXAMPLE).unwrap();
        let listed = source.summaries();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].title, "Garden welcome guide");
        assert_eq!(listed[1].title, "Untitled note");
        assert!(listed[0].preview.starts_with("Draft a one-page guide."));
        let ids = vec!["n2".to_string(), "n3".to_string()];
        let fetched = fetch_selection(&mut source, &ids, &|| false, &mut |_| true).unwrap();
        assert_eq!(fetched.len(), 2);
        let mut store = ContextStore::default();
        let outcome = store.merge(Provider::File, &ids, fetched);
        assert_eq!(
            (outcome.added, outcome.rejected),
            (1, 1),
            "the dateless note is rejected"
        );
        assert_eq!(store.items()[0].source_id, "n2");
        assert_eq!(store.items()[0].provider, Provider::File);
    }

    #[test]
    fn unselected_notes_are_not_imported() {
        let mut source = FileSource::parse(EXAMPLE).unwrap();
        let fetched =
            fetch_selection(&mut source, &["n1".to_string()], &|| false, &mut |_| true).unwrap();
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].source_id, "n1");
    }

    #[test]
    fn wrong_or_empty_files_are_refused_with_a_plain_message() {
        assert!(FileSource::parse("not json")
            .unwrap_err()
            .contains("notes file"));
        assert!(FileSource::parse(r#"{"notes":[]}"#)
            .unwrap_err()
            .contains("no notes"));
        assert!(FileSource::parse(r#"{"notes":[{"id":"x"}]}"#).is_err());
    }

    #[test]
    fn a_long_note_is_previewed_short_and_the_list_is_capped() {
        let many: Vec<String> = (0..MAX_NOTES + 5)
            .map(|i| {
                format!(
                    r#"{{"id":"n{i}","date":"2026-01-01","text":"{}"}}"#,
                    "x".repeat(300)
                )
            })
            .collect();
        let text = format!(r#"{{"notes":[{}]}}"#, many.join(","));
        let source = FileSource::parse(&text).unwrap();
        let listed = source.summaries();
        assert_eq!(listed.len(), MAX_NOTES);
        assert_eq!(source.skipped, 5);
        assert_eq!(listed[0].preview.chars().count(), PREVIEW_CHARS + 1);
        assert!(listed[0].preview.ends_with('…'));
    }

    #[test]
    fn importing_the_same_file_again_keeps_each_note_once_and_a_newer_revision_replaces() {
        let ids = vec!["n1".to_string(), "n2".to_string()];
        let mut store = ContextStore::default();
        let mut source = FileSource::parse(EXAMPLE).unwrap();
        let first = fetch_selection(&mut source, &ids, &|| false, &mut |_| true).unwrap();
        let outcome = store.merge(Provider::File, &ids, first);
        assert_eq!(outcome.added, 2);
        // The same file again: nothing is duplicated or changed.
        let mut again = FileSource::parse(EXAMPLE).unwrap();
        let second = fetch_selection(&mut again, &ids, &|| false, &mut |_| true).unwrap();
        let outcome = store.merge(Provider::File, &ids, second);
        assert_eq!((outcome.added, outcome.unchanged), (0, 2));
        assert_eq!(store.items().len(), 2);
        // A newer revision of one note replaces it; an older one is ignored.
        let newer = EXAMPLE.replace(
            r#"{"id":"n1","title":"Garden welcome guide","date":"2026-10-28","text":"Draft a one-page guide. Robin suggested a map of the tool shed.""#,
            r#"{"id":"n1","title":"Garden welcome guide","date":"2026-10-28","revision":2,"text":"Draft a one-page guide with a map of the tool shed.""#,
        );
        let mut newer = FileSource::parse(&newer).unwrap();
        let third = fetch_selection(&mut newer, &ids, &|| false, &mut |_| true).unwrap();
        let outcome = store.merge(Provider::File, &ids, third);
        assert_eq!((outcome.updated, outcome.unchanged), (1, 1));
        let n1 = store.items().iter().find(|i| i.source_id == "n1").unwrap();
        assert_eq!(n1.revision, 2);
        assert!(n1.excerpt.contains("with a map"));
        assert_eq!(n1.source_date, "2026-10-28", "the source reference stays");
        let mut older = FileSource::parse(EXAMPLE).unwrap();
        let fourth = fetch_selection(&mut older, &ids, &|| false, &mut |_| true).unwrap();
        let outcome = store.merge(Provider::File, &ids, fourth);
        assert_eq!(
            outcome.unchanged, 2,
            "an older revision never rolls a note back"
        );
    }

    #[test]
    fn a_repeated_id_in_one_file_is_listed_once() {
        let text = r#"{"notes":[
            {"id":"n1","date":"2026-01-01","text":"first"},
            {"id":" n1 ","date":"2026-01-02","text":"second"}
        ]}"#;
        let source = FileSource::parse(text).unwrap();
        assert_eq!(source.summaries().len(), 1);
        assert_eq!(source.skipped, 1);
        assert!(source.summaries()[0].preview.starts_with("first"));
    }

    #[test]
    fn an_oversized_file_is_refused_before_it_is_read() {
        let path = std::env::temp_dir().join(format!("talkqte-notes-{}.json", std::process::id()));
        std::fs::write(&path, vec![b' '; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let result = FileSource::read(&path);
        let _ = std::fs::remove_file(&path);
        assert!(result.unwrap_err().contains("larger than 1 MB"));
    }

    /// A fictional summary as another note-taker might export it.
    const SUMMARY: &str = "---\ntitle: Garden committee check-in\ndate: \"2026-10-21\"\ntags: [garden]\n---\n# Committee notes\n\n## Overview\nThe fictional committee chose a one-page welcome guide.\n\n## Action items\n- Robin drafts the guide by Friday.\n";

    fn document(kind: FileKind, text: &str) -> Result<FileSource, String> {
        FileSource::parse_document(
            text,
            Document {
                kind,
                name: "Tool shed rota",
                source_id: "file-fictional".into(),
                revision: 1,
            },
        )
    }

    fn only_note(source: FileSource) -> ContextItem {
        assert_eq!((source.notes.len(), source.skipped), (1, 0));
        source.notes.into_iter().next().unwrap()
    }

    /// A folder of its own for one test's fictional files.
    fn folder(test: &str) -> std::path::PathBuf {
        let folder =
            std::env::temp_dir().join(format!("talkqte-note-files-{}-{test}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn a_markdown_file_is_one_note_with_its_front_matter_title_and_date() {
        let mut source = document(FileKind::Markdown, SUMMARY).unwrap();
        let listed = source.summaries();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "Garden committee check-in");
        assert_eq!(listed[0].source_date, "2026-10-21");
        assert!(listed[0].preview.starts_with("# Committee notes"));
        let ids = vec![listed[0].source_id.clone()];
        let fetched = fetch_selection(&mut source, &ids, &|| false, &mut |_| true).unwrap();
        let mut store = ContextStore::default();
        assert_eq!(store.merge(Provider::File, &ids, fetched).added, 1);
        let note = &store.items()[0];
        assert_eq!(note.provider, Provider::File);
        // Front matter is metadata, not note text; the rest is kept as written.
        assert!(!note.excerpt.contains("tags:"));
        assert!(note
            .excerpt
            .contains("## Action items\n- Robin drafts the guide by Friday."));
    }

    #[test]
    fn a_first_line_heading_is_the_title_and_the_file_name_is_the_fallback() {
        let note = only_note(
            document(FileKind::Markdown, "\n# Garden plan ##\nSeedlings first.").unwrap(),
        );
        assert_eq!(note.title, "Garden plan");
        assert_eq!(
            note.excerpt, "Seedlings first.",
            "the heading becomes the title, not text"
        );
        // Only a level-one heading on the first line names the note.
        for text in [
            "## Overview\nSeedlings first.",
            "Seedlings first.\n# Later heading",
            "#hashtag on the first line",
            "    # indented code",
        ] {
            let note = only_note(document(FileKind::Markdown, text).unwrap());
            assert_eq!(note.title, "Tool shed rota", "{text}");
            assert_eq!(note.excerpt, text.trim());
        }
        assert_eq!(
            only_note(document(FileKind::Markdown, "# C#\nNotes.").unwrap()).title,
            "C#"
        );
        // Front matter needs a closing line; otherwise it is ordinary text.
        let open = "---\ntitle: Not front matter\n# Not a first-line heading";
        let note = only_note(document(FileKind::Markdown, open).unwrap());
        assert_eq!(note.title, "Tool shed rota");
        assert_eq!(note.excerpt, open);
        // Horizontal rules around a paragraph keep the paragraph as text.
        let rules = "---\nA fictional introduction.\n---\nNotes.";
        assert_eq!(
            only_note(document(FileKind::Markdown, rules).unwrap()).excerpt,
            rules
        );
        // Only single-word `key:` lines make front matter; anything else
        // between two rules stays note text.
        for text in [
            "---\n## Action items\n- Robin: draft the guide by Friday\n---\nThe committee met.",
            "---\nRobin said: ready\n---\nNotes.",
        ] {
            assert_eq!(
                only_note(document(FileKind::Markdown, text).unwrap()).excerpt,
                text
            );
        }
        // A front matter title wins, and the heading then stays in the text.
        let both = "---\ntitle: From front matter\n---\n# From the heading\nNotes.";
        let note = only_note(document(FileKind::Markdown, both).unwrap());
        assert_eq!(note.title, "From front matter");
        assert!(note.excerpt.starts_with("# From the heading"));
    }

    #[test]
    fn plain_text_is_titled_by_its_file_name_and_dated_by_a_date_line() {
        let text = "\u{FEFF}# Not a heading in plain text\r\nDate: 2026-11-04\r\nRobin has the shed key on Tuesdays.\r\n";
        let note = only_note(document(FileKind::Text, text).unwrap());
        assert_eq!(note.title, "Tool shed rota");
        assert_eq!(note.source_date, "2026-11-04");
        assert_eq!(
            note.excerpt,
            "# Not a heading in plain text\nDate: 2026-11-04\nRobin has the shed key on Tuesdays."
        );
        // Front matter is a Markdown convention; plain text keeps it as text.
        let text = "---\ntitle: Not a title\n---\nKey.";
        let note = only_note(document(FileKind::Text, text).unwrap());
        assert_eq!(
            (note.title.as_str(), note.excerpt.as_str()),
            ("Tool shed rota", text)
        );
    }

    #[test]
    fn only_a_labeled_unambiguous_date_near_the_top_is_read() {
        let date_of =
            |text: &str| only_note(document(FileKind::Markdown, text).unwrap()).source_date;
        for text in [
            "Date: 2026-10-21\nNotes.",
            "**Date:** 2026-10-21 (Tuesday)\nNotes.",
            "- Meeting date: 2026-10-21\nNotes.",
            "> _date_: 2026-10-21.\nNotes.",
            "---\ndate: 2026-10-21T09:30:00Z\n---\nNotes.",
            "\u{FEFF}---\ndate: 2026-10-21\n---\nNotes.",
            "# Garden plan\nDate: 2026-10-21\nNotes.",
            "---\ntitle: Named in front matter\n---\n# Heading\nDate: 2026-10-21\nNotes.",
        ] {
            assert_eq!(date_of(text), "2026-10-21", "{text}");
        }
        for text in [
            "Date: 21/10/2026\nNotes.",
            "Date: 10/21/2026\nNotes.",
            "Date: October 21, 2026\nNotes.",
            "Date: 2026-02-30\nNotes.",
            "Date: 2026-10-21-2026-10-23\nNotes.",
            "Date: 2026-10-210\nNotes.",
            "Dates for the open day: 2026-12-01\nNotes.",
            "Date of the next meeting: 2026-12-01\nNotes.",
            "Due: 2026-11-05\nNotes.",
            "The fictional plan is due 2026-11-05.",
            "---\ndate: next Tuesday\n---\nNotes.",
            // A dated item under a later heading is about something else.
            "# Open day planning\n## Decisions\n- Venue: the community garden\n- Date: 2026-12-05",
            "Notes.\n## Later\nDate: 2026-12-05",
        ] {
            assert_eq!(date_of(text), "", "{text}");
        }
        // A labeled date deep in the notes is about something else.
        let late = format!("{}Date: 2026-12-01", "A line.\n".repeat(DATE_LINE_SEARCH));
        assert_eq!(date_of(&late), "");
    }

    /// Fetches every note of `source` through the chooser's import
    /// attempt, as the import command does, with the dates entered for it.
    fn fetch_entered(source: FileSource, dates: &[(&str, &str)]) -> Vec<ContextItem> {
        let ids: Vec<String> = source
            .summaries()
            .into_iter()
            .map(|note| note.source_id)
            .collect();
        let dates = dates
            .iter()
            .map(|(id, date)| (id.to_string(), date.to_string()))
            .collect();
        PendingImport::new(Box::new(source))
            .start()
            .unwrap()
            .fetch_with_dates(&ids, &dates)
            .unwrap()
    }

    #[test]
    fn a_date_the_person_enters_fills_only_a_markdown_or_text_note_without_one() {
        let undated =
            || document(FileKind::Markdown, "# Gate sign\nA sign might cost less.").unwrap();
        assert!(undated().asks_for_dates());
        // Nothing entered, an entry for another note, or one that is not a
        // real date fills nothing.
        let unfilled: [&[(&str, &str)]; 4] = [
            &[],
            &[("another-note", "2026-10-21")],
            &[("file-fictional", "2026-02-30")],
            &[("file-fictional", "21/10/2026")],
        ];
        for entered in unfilled {
            assert_eq!(
                fetch_entered(undated(), entered)[0].source_date,
                "",
                "{entered:?}"
            );
        }
        let filled = fetch_entered(undated(), &[("file-fictional", " 2026-10-21 ")]);
        assert_eq!(filled[0].source_date, "2026-10-21");
        let ids = vec!["file-fictional".to_string()];
        let mut store = ContextStore::default();
        let skipped = store.merge(Provider::File, &ids, fetch_entered(undated(), &[]));
        assert_eq!(
            (skipped.added, skipped.rejected),
            (0, 1),
            "no date, not imported"
        );
        assert_eq!(store.merge(Provider::File, &ids, filled).added, 1);
        assert_eq!(store.items()[0].source_date, "2026-10-21");
        // A date from the file is never replaced.
        let dated = document(FileKind::Markdown, SUMMARY).unwrap();
        let kept = fetch_entered(dated, &[("file-fictional", "2026-01-01")]);
        assert_eq!(kept[0].source_date, "2026-10-21");
        // A JSON notes file states its dates; a note without one is skipped,
        // as before, even if a date arrives for it.
        let json = || {
            FileSource::parse(r#"{"notes":[{"id":"n3","date":"","text":"Gate sign."}]}"#).unwrap()
        };
        assert!(!json().asks_for_dates());
        assert_eq!(
            fetch_entered(json(), &[("n3", "2026-10-21")])[0].source_date,
            ""
        );
    }

    #[test]
    fn a_long_note_keeps_the_existing_excerpt_title_and_preview_limits() {
        let text = format!(
            "# {}\n{}",
            "Long title ".repeat(40),
            "Seedlings. ".repeat(600)
        );
        let source = document(FileKind::Markdown, &text).unwrap();
        assert!(source.summaries()[0].preview.ends_with('…'));
        assert_eq!(
            source.summaries()[0].preview.chars().count(),
            PREVIEW_CHARS + 1
        );
        let ids = vec!["file-fictional".to_string()];
        let fetched = fetch_entered(source, &[("file-fictional", "2026-10-21")]);
        let mut store = ContextStore::default();
        store.merge(Provider::File, &ids, fetched);
        let note = &store.items()[0];
        assert_eq!(
            note.excerpt.chars().count(),
            crate::context::MAX_EXCERPT_CHARS
        );
        assert_eq!(note.title.chars().count(), crate::context::MAX_TITLE_CHARS);
    }

    #[test]
    fn unsupported_oversized_empty_or_binary_files_are_refused_with_a_plain_message() {
        let folder = folder("refused");
        let read = |name: &str, bytes: &[u8]| {
            let path = folder.join(name);
            std::fs::write(&path, bytes).unwrap();
            FileSource::read(&path).map(|source| source.notes.len())
        };
        let refused = |message: &str| -> Result<usize, String> { Err(message.to_string()) };
        for name in [
            "summary.docx",
            "summary.pdf",
            "summary.html",
            "summary.rtf",
            "summary",
        ] {
            assert_eq!(read(name, b"Notes."), refused(UNSUPPORTED), "{name}");
        }
        for name in ["call.srt", "call.VTT"] {
            let captions = b"1\n00:00:01,000 --> 00:00:02,000\nHello.";
            assert_eq!(read(name, captions), refused(TRANSCRIPT), "{name}");
        }
        let oversized = vec![b'a'; (MAX_FILE_BYTES + 1) as usize];
        assert_eq!(read("big.md", &oversized), refused(TOO_LARGE));
        assert_eq!(
            read("title-only.md", b"# Just a title\n\n"),
            refused(NO_TEXT)
        );
        assert_eq!(read("blank.txt", b"  \n\n"), refused(NO_TEXT));
        // Renamed PDF and Word files: binary, and not valid UTF-8 either.
        let pdf = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj\nstream\n\x78\x9c\x00\x01";
        assert_eq!(read("renamed.txt", pdf), refused(NOT_TEXT));
        assert_eq!(
            read("renamed.md", b"PK\x03\x04\x14\x00\x06\x00"),
            refused(NOT_TEXT)
        );
        assert_eq!(read("latin1.txt", b"caf\xe9 notes"), refused(UNREADABLE));
        assert_eq!(read("UPPER.MD", b"Notes.").unwrap(), 1);
        assert_eq!(read("long.markdown", b"Notes.").unwrap(), 1);
        // Only a Markdown or plain-text file asks for a missing date.
        std::fs::write(
            folder.join("notes.json"),
            r#"{"notes":[{"id":"n1","date":"","text":"x"}]}"#,
        )
        .unwrap();
        assert!(!FileSource::read(&folder.join("notes.json"))
            .unwrap()
            .asks_for_dates());
        assert!(FileSource::read(&folder.join("UPPER.MD"))
            .unwrap()
            .asks_for_dates());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn choosing_the_same_file_again_keeps_one_copy_and_a_saved_change_replaces_it() {
        let folder = folder("repeat");
        let path = folder.join("Garden committee.md");
        std::fs::write(&path, SUMMARY).unwrap();
        let import = |store: &mut ContextStore, path: &Path| {
            let mut source = FileSource::read(path).unwrap();
            let ids: Vec<String> = source
                .summaries()
                .into_iter()
                .map(|note| note.source_id)
                .collect();
            let fetched = fetch_selection(&mut source, &ids, &|| false, &mut |_| true).unwrap();
            store.merge(Provider::File, &ids, fetched)
        };
        let mut store = ContextStore::default();
        assert_eq!(import(&mut store, &path).added, 1);
        assert_eq!(import(&mut store, &path).unchanged, 1);
        // The same file, saved later with a change, replaces its copy.
        std::fs::write(&path, SUMMARY.replace("by Friday", "by Thursday")).unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert_eq!(import(&mut store, &path).updated, 1);
        assert!(store.items()[0].excerpt.contains("by Thursday"));
        // Another file with the same name is a different note.
        std::fs::create_dir_all(folder.join("other")).unwrap();
        let namesake = folder.join("other").join("Garden committee.md");
        std::fs::write(&namesake, SUMMARY).unwrap();
        assert_eq!(import(&mut store, &namesake).added, 1);
        assert_eq!(store.items().len(), 2);
        let _ = std::fs::remove_dir_all(&folder);
    }

    /// Run by the test below in a process whose home and temporary folders
    /// are one empty folder.
    #[test]
    #[ignore = "run through test_isolation"]
    fn isolated_note_file_import() {
        let path = std::path::PathBuf::from(std::env::var("TALKQTE_TEST_NOTE_FILE").unwrap());
        let before = std::fs::read(&path).unwrap();
        let mut source = FileSource::read(&path).unwrap();
        let ids: Vec<String> = source
            .summaries()
            .into_iter()
            .map(|note| note.source_id)
            .collect();
        let fetched = fetch_selection(&mut source, &ids, &|| false, &mut |_| true).unwrap();
        let mut store = ContextStore::default();
        assert_eq!(store.merge(Provider::File, &ids, fetched).added, 1);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "the chosen file is unchanged"
        );
    }

    #[test]
    fn reading_a_note_file_writes_no_file_and_prints_nothing() {
        let folder = folder("isolated");
        let path = folder.join("Garden committee.md");
        std::fs::write(&path, SUMMARY).unwrap();
        let crate::test_isolation::Isolated { left, printed } = crate::test_isolation::run(
            "notes_file::tests::isolated_note_file_import",
            &[("TALKQTE_TEST_NOTE_FILE", path.to_str().unwrap())],
            &[],
        );
        let _ = std::fs::remove_dir_all(&folder);
        assert!(left.is_empty(), "reading the file left files: {left:?}");
        for private in ["Garden committee", "welcome guide", "Robin"] {
            assert!(!printed.contains(private), "printed {private}: {printed}");
        }
    }
}
