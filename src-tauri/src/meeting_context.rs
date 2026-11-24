//! Kept meetings as prior context: the person may choose earlier meetings
//! they kept as prior context for the next session, through the same chooser,
//! store, reminders and processing review as notes from a file or Granola.
//!
//! First slice: what a chosen meeting contributes is its kept meeting notes
//! and the person's own notes from it, in that order, bounded like any
//! imported note (`context::MAX_EXCERPT_CHARS`). Never its transcript, cues,
//! sources or application name. Its title and date travel with it, so a
//! reminder or a cited source names that meeting. A meeting with neither
//! kind of notes is not offered.
//!
//! Choosing one is an import, not permission to send it anywhere. Whether it
//! reaches a cue model is decided by the session's processing review; the
//! own-key Anthropic connection takes no prior notes, so today it does not.

use crate::{
    context::{Capabilities, ContextItem, NoteSource, Provider, SourceError, MAX_EXCERPT_CHARS},
    meeting_history::{Meeting, Store},
    notes_file::NoteSummary,
};

/// The most kept meetings the chooser lists, newest first.
pub const MAX_LISTED: usize = 200;
/// The most kept meetings one import takes.
pub const MAX_PER_IMPORT: usize = 5;
const PREVIEW_CHARS: usize = 160;

/// What one kept meeting contributes as prior context.
pub fn excerpt(meeting: &Meeting) -> Option<String> {
    let meeting_notes = meeting
        .content
        .meeting_notes
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let notes = Some(meeting.content.notes.trim()).filter(|text| !text.is_empty());
    let text = match (meeting_notes, notes) {
        (None, None) => return None,
        (Some(kept), None) => format!("Meeting notes:\n{kept}"),
        (None, Some(notes)) => format!("Your notes:\n{notes}"),
        (Some(kept), Some(notes)) => format!("Meeting notes:\n{kept}\n\nYour notes:\n{notes}"),
    };
    Some(text.chars().take(MAX_EXCERPT_CHARS).collect())
}

/// The meeting's local date, YYYY-MM-DD, from its start and the person's UTC
/// offset in minutes (checked to ±14 hours).
pub fn local_date(meeting: &Meeting, offset_minutes: i32) -> Option<String> {
    let offset = chrono::FixedOffset::east_opt(offset_minutes.checked_mul(60)?)?;
    let start = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
        i64::try_from(meeting.content.started_at_ms).ok()?,
    )?;
    Some(start.with_timezone(&offset).format("%Y-%m-%d").to_string())
}

/// The person's kept meetings as a note source for one chooser.
#[derive(Debug)]
pub struct MeetingSource {
    items: Vec<ContextItem>,
    /// Kept meetings not listed: beyond the limit, unreadable, or with no
    /// notes to bring.
    pub skipped: usize,
}

impl MeetingSource {
    /// Reads the history once: the newest meetings with notes to bring.
    pub fn read(store: &Store, offset_minutes: i32) -> Self {
        let listing = store.list(None);
        let mut items = Vec::new();
        let mut skipped = listing.unreadable;
        for summary in listing.meetings {
            if items.len() >= MAX_LISTED {
                skipped += 1;
                continue;
            }
            let Ok(meeting) = store.open_meeting(&summary.id) else {
                skipped += 1;
                continue;
            };
            match (excerpt(&meeting), local_date(&meeting, offset_minutes)) {
                (Some(excerpt), Some(date)) => items.push(ContextItem {
                    provider: Provider::Meeting,
                    source_id: meeting.id,
                    title: meeting.title,
                    source_date: date,
                    excerpt,
                    revision: meeting.revision,
                }),
                _ => skipped += 1,
            }
        }
        Self { items, skipped }
    }

    pub fn summaries(&self) -> Vec<NoteSummary> {
        self.items
            .iter()
            .map(|item| NoteSummary {
                source_id: item.source_id.clone(),
                title: item.title.clone(),
                source_date: item.source_date.clone(),
                preview: item
                    .excerpt
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(PREVIEW_CHARS)
                    .collect(),
            })
            .collect()
    }
}

impl NoteSource for MeetingSource {
    fn provider(&self) -> Provider {
        Provider::Meeting
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            import_notes: true,
            ..Capabilities::default()
        }
    }

    /// The chosen meetings as read when the chooser opened. A meeting deleted
    /// since is gone from the history, and the store skips an id it was not
    /// given.
    fn fetch(&mut self, selection: &[String]) -> Result<Vec<ContextItem>, SourceError> {
        Ok(self
            .items
            .iter()
            .filter(|item| selection.contains(&item.source_id))
            .cloned()
            .collect())
    }
}

#[cfg(test)]
#[path = "meeting_context_tests.rs"]
mod tests;
