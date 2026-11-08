//! Prior notes from a file the user chooses: a small JSON document of notes
//! with an ID, a date, and text. This is the first note source behind the
//! context contract; it needs no account or network. The file is read once
//! into memory, and only the notes the user then selects are kept.

use crate::context::{Capabilities, ContextItem, NoteSource, Provider, SourceError};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The largest notes file read, so a wrong pick cannot fill memory.
pub const MAX_FILE_BYTES: u64 = 1 << 20;
/// The most notes listed from one file.
pub const MAX_NOTES: usize = 200;
/// Characters of each note shown while choosing.
const PREVIEW_CHARS: usize = 120;

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
}

impl FileSource {
    /// Reads and parses a notes file. Errors are short messages for the
    /// person who picked the file; they never include the file's text.
    pub fn read(path: &Path) -> Result<Self, String> {
        let size = std::fs::metadata(path)
            .map_err(|_| "The file could not be read.")?
            .len();
        if size > MAX_FILE_BYTES {
            return Err("That file is larger than 1 MB. Choose a smaller notes file.".into());
        }
        let text = std::fs::read_to_string(path).map_err(|_| "The file could not be read.")?;
        Self::parse(&text)
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
        Ok(Self { notes, skipped })
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

impl NoteSource for FileSource {
    fn provider(&self) -> Provider {
        Provider::File
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
}
