//! Source-aware prior context: notes a user explicitly selects and imports
//! from a connected note-taker (Granola first) or a file, kept separate from
//! live meeting evidence. This is the adapter contract and an in-memory
//! store. A provider is connected only when the person signs in to it
//! (`granola.rs`), nothing is stored on disk, and nothing is written back.

use serde::Serialize;
use std::time::Duration;

/// Most notes kept at once, the most text per excerpt, and the longest
/// title. Prior context is a small selection, not a copy of someone's notes.
pub const MAX_ITEMS: usize = 20;
pub const MAX_EXCERPT_CHARS: usize = 2_000;
pub const MAX_TITLE_CHARS: usize = 200;
/// Attempts for one fetch, including the first.
pub const MAX_ATTEMPTS: u32 = 3;
/// The longest wait honored between attempts, even if a provider asks for more.
pub const MAX_RETRY_WAIT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Granola,
    File,
}

impl Provider {
    /// A stable short name for keys and labels.
    pub fn id(&self) -> &'static str {
        match self {
            Provider::Granola => "granola",
            Provider::File => "file",
        }
    }
}

/// What a connection can do. Import, live input, and writeback are separate
/// capabilities, verified separately; a successful import proves none of the
/// others.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub import_notes: bool,
    pub live_input: bool,
    pub writeback: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ConnectionStatus {
    NotConnected,
    Connected,
    /// The user must sign in again.
    Expired,
    /// Access was withdrawn at the provider; reconnecting is the user's choice.
    Revoked,
    RateLimited {
        retry_after_s: u64,
    },
    Unavailable,
    UnsupportedFormat,
}

/// One imported note, labeled so it can never be mistaken for something
/// said in the current meeting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub provider: Provider,
    /// The provider's identifier for the note.
    pub source_id: String,
    /// At most `MAX_TITLE_CHARS`; "Untitled note" when empty.
    pub title: String,
    /// The note's own date, YYYY-MM-DD, shown beside it.
    pub source_date: String,
    /// The selected excerpt, at most `MAX_EXCERPT_CHARS`.
    pub excerpt: String,
    /// Increases when the provider's note changes.
    pub revision: u64,
}

/// Carried by a reminder that quotes a copy the last update check could not
/// confirm as the provider's latest, so the reminder can say so.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unconfirmed {
    /// When a check last confirmed the copy, by the local clock; `None` if
    /// no check has confirmed it since it was imported.
    pub last_confirmed_ms: Option<u64>,
}

/// Why a fetch failed, as an adapter reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SourceError {
    Expired,
    Revoked,
    RateLimited {
        retry_after: Duration,
    },
    /// A dropped connection or timeout; safe to retry.
    Interrupted,
    Unavailable,
    UnsupportedFormat,
}

/// A note source behind the native boundary. Authentication and provider
/// mapping live in the implementation; the store sees only validated items.
pub trait NoteSource {
    fn provider(&self) -> Provider;
    fn capabilities(&self) -> Capabilities;
    fn fetch(&mut self, selection: &[String]) -> Result<Vec<ContextItem>, SourceError>;
    /// Whether the chooser asks the person for the date of a note that has
    /// none. Only a Markdown or plain-text file does; other sources state
    /// their dates, and a note without one is skipped.
    fn asks_for_dates(&self) -> bool {
        false
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    /// The connection cannot import notes, whatever its status.
    NotSupported,
    Cancelled,
    Failed(ConnectionStatus),
}

/// Fetches the user's selection with bounded retries, outside any lock on
/// the store. Only interrupted requests and rate limits are retried, waiting
/// at most `MAX_RETRY_WAIT`; expired or revoked access stops at once.
/// `cancelled` is checked before each attempt and after each fetch. `wait`
/// pauses and returns false if the user cancelled during the pause, so a
/// long wait can be cut short.
pub fn fetch_selection(
    source: &mut dyn NoteSource,
    selection: &[String],
    cancelled: &dyn Fn() -> bool,
    wait: &mut dyn FnMut(Duration) -> bool,
) -> Result<Vec<ContextItem>, FetchError> {
    if !source.capabilities().import_notes {
        return Err(FetchError::NotSupported);
    }
    let mut attempt = 1;
    loop {
        if cancelled() {
            return Err(FetchError::Cancelled);
        }
        let result = source.fetch(selection);
        // A cancel during the request discards what it returned.
        if cancelled() {
            return Err(FetchError::Cancelled);
        }
        let error = match result {
            Ok(items) => return Ok(items),
            Err(error) => error,
        };
        let delay = match &error {
            SourceError::Interrupted => Duration::from_secs(1 << (attempt - 1)),
            SourceError::RateLimited { retry_after } => *retry_after,
            _ => return Err(FetchError::Failed(status_for(&error))),
        };
        if attempt >= MAX_ATTEMPTS || delay > MAX_RETRY_WAIT {
            return Err(FetchError::Failed(status_for(&error)));
        }
        if !wait(delay) {
            return Err(FetchError::Cancelled);
        }
        attempt += 1;
    }
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub added: usize,
    /// Replaced by a newer revision.
    pub updated: usize,
    /// Already imported at the same or a newer revision.
    pub unchanged: usize,
    /// Not imported because the store already holds `MAX_ITEMS` notes.
    pub over_limit: usize,
    /// Dropped because they were not selected, came from another provider,
    /// or lacked a valid ID, date, or text.
    pub rejected: usize,
}

/// Imported prior context for this app session, held in memory only.
#[derive(Default)]
pub struct ContextStore {
    items: Vec<ContextItem>,
}

impl ContextStore {
    pub fn items(&self) -> &[ContextItem] {
        &self.items
    }

    /// Merges fetched notes. Only notes from `provider` whose IDs are in the
    /// user's `selection` are accepted. A repeated import replaces a note
    /// only with a newer revision, so it never duplicates or rolls one back.
    pub fn merge(
        &mut self,
        provider: Provider,
        selection: &[String],
        fetched: Vec<ContextItem>,
    ) -> MergeOutcome {
        let mut outcome = MergeOutcome::default();
        for item in fetched {
            let Some(item) = validated(item, provider)
                .filter(|item| selection.iter().any(|id| id.trim() == item.source_id))
            else {
                outcome.rejected += 1;
                continue;
            };
            let kept = self.items.iter().position(|kept| {
                kept.provider == item.provider && kept.source_id == item.source_id
            });
            match kept {
                Some(index) if item.revision > self.items[index].revision => {
                    self.items[index] = item;
                    outcome.updated += 1;
                }
                Some(_) => outcome.unchanged += 1,
                None if self.items.len() < MAX_ITEMS => {
                    self.items.push(item);
                    outcome.added += 1;
                }
                None => outcome.over_limit += 1,
            }
        }
        outcome
    }

    /// Removes one imported note.
    pub fn remove(&mut self, provider: Provider, source_id: &str) -> bool {
        let source_id = source_id.trim();
        let before = self.items.len();
        self.items
            .retain(|item| !(item.provider == provider && item.source_id == source_id));
        self.items.len() != before
    }

    /// Removes every note imported from a provider. This is a separate
    /// choice from disconnecting, which must only stop future access, as
    /// PRIVACY.md requires.
    pub fn remove_all_from(&mut self, provider: Provider) -> usize {
        let before = self.items.len();
        self.items.retain(|item| item.provider != provider);
        before - self.items.len()
    }
}

fn status_for(error: &SourceError) -> ConnectionStatus {
    match error {
        SourceError::Expired => ConnectionStatus::Expired,
        SourceError::Revoked => ConnectionStatus::Revoked,
        SourceError::RateLimited { retry_after } => ConnectionStatus::RateLimited {
            retry_after_s: retry_after.as_secs(),
        },
        SourceError::Interrupted | SourceError::Unavailable => ConnectionStatus::Unavailable,
        SourceError::UnsupportedFormat => ConnectionStatus::UnsupportedFormat,
    }
}

/// Invisible formatting characters (zero-width and direction overrides)
/// that would make two IDs look the same.
fn invisible(character: char) -> bool {
    matches!(
        character,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}'
    )
}

/// A real calendar date in YYYY-MM-DD form.
pub(crate) fn valid_date(date: &str) -> bool {
    let parts: Vec<&str> = date.split('-').collect();
    let [year, month, day] = parts.as_slice() else {
        return false;
    };
    let number = |text: &str, digits: usize| {
        if text.len() == digits && text.chars().all(|c| c.is_ascii_digit()) {
            text.parse::<u32>().ok()
        } else {
            None
        }
    };
    let (Some(year), Some(month), Some(day)) = (number(year, 4), number(month, 2), number(day, 2))
    else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    year >= 1900 && (1..=days).contains(&day)
}

/// Accepts an item only if it came from this provider and has a clean ID, a
/// real date, and some text; trims the ID, title, and excerpt.
fn validated(mut item: ContextItem, provider: Provider) -> Option<ContextItem> {
    item.source_id = item.source_id.trim().to_string();
    item.excerpt = item
        .excerpt
        .trim()
        .chars()
        .take(MAX_EXCERPT_CHARS)
        .collect();
    item.title = item.title.trim().chars().take(MAX_TITLE_CHARS).collect();
    if item.title.is_empty() {
        item.title = "Untitled note".into();
    }
    let id_ok = !item.source_id.is_empty()
        && item.source_id.len() <= 128
        && !item
            .source_id
            .chars()
            .any(|c| c.is_control() || invisible(c));
    (item.provider == provider
        && id_ok
        && valid_date(&item.source_date)
        && !item.excerpt.is_empty())
    .then_some(item)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A fictional note, as a Granola adapter might map it.
    fn note(id: &str, revision: u64) -> ContextItem {
        ContextItem {
            provider: Provider::Granola,
            source_id: id.into(),
            title: "Garden volunteers check-in".into(),
            source_date: "2026-10-30".into(),
            excerpt:
                "Jordan offered to draft the welcome guide; the printing budget is still open."
                    .into(),
            revision,
        }
    }

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    /// Replays scripted responses, one per fetch.
    struct Scripted {
        responses: Vec<Result<Vec<ContextItem>, SourceError>>,
        calls: usize,
        capabilities: Capabilities,
    }

    impl Scripted {
        fn new(responses: Vec<Result<Vec<ContextItem>, SourceError>>) -> Self {
            Self {
                responses,
                calls: 0,
                capabilities: Capabilities {
                    import_notes: true,
                    ..Capabilities::default()
                },
            }
        }
    }

    impl NoteSource for Scripted {
        fn provider(&self) -> Provider {
            Provider::Granola
        }
        fn capabilities(&self) -> Capabilities {
            self.capabilities
        }
        fn fetch(&mut self, _: &[String]) -> Result<Vec<ContextItem>, SourceError> {
            self.calls += 1;
            self.responses.remove(0)
        }
    }

    fn fetch(source: &mut Scripted) -> (Result<Vec<ContextItem>, FetchError>, Vec<Duration>) {
        let mut waits = vec![];
        let result = fetch_selection(source, &ids(&["n1"]), &|| false, &mut |delay| {
            waits.push(delay);
            true
        });
        (result, waits)
    }

    #[test]
    fn a_selected_note_is_imported_with_its_source_and_date() {
        let mut store = ContextStore::default();
        let fetched = fetch(&mut Scripted::new(vec![Ok(vec![note("n1", 1)])]))
            .0
            .unwrap();
        let outcome = store.merge(Provider::Granola, &ids(&["n1"]), fetched);
        assert_eq!(
            outcome,
            MergeOutcome {
                added: 1,
                ..MergeOutcome::default()
            }
        );
        let item = &store.items()[0];
        assert_eq!(
            (item.provider, item.source_date.as_str()),
            (Provider::Granola, "2026-10-30")
        );
    }

    #[test]
    fn notes_the_user_did_not_select_are_rejected() {
        let mut store = ContextStore::default();
        let outcome = store.merge(
            Provider::Granola,
            &ids(&["n1"]),
            vec![note("n1", 1), note("n2", 1)],
        );
        assert_eq!((outcome.added, outcome.rejected), (1, 1));
        assert_eq!(store.items().len(), 1);
    }

    #[test]
    fn repeated_imports_never_duplicate_or_roll_back_a_note() {
        let mut store = ContextStore::default();
        let selection = ids(&["n1"]);
        store.merge(Provider::Granola, &selection, vec![note("n1", 2)]);
        let same = store.merge(Provider::Granola, &selection, vec![note("n1", 2)]);
        let older = store.merge(Provider::Granola, &selection, vec![note("n1", 1)]);
        let newer = store.merge(Provider::Granola, &selection, vec![note("n1", 3)]);
        assert_eq!(same.unchanged, 1);
        assert_eq!(older.unchanged, 1);
        assert_eq!(newer.updated, 1);
        assert_eq!((store.items().len(), store.items()[0].revision), (1, 3));
    }

    #[test]
    fn expired_or_revoked_access_stops_without_retrying() {
        for (error, status) in [
            (SourceError::Expired, ConnectionStatus::Expired),
            (SourceError::Revoked, ConnectionStatus::Revoked),
            (
                SourceError::UnsupportedFormat,
                ConnectionStatus::UnsupportedFormat,
            ),
        ] {
            let mut source = Scripted::new(vec![Err(error)]);
            let (result, waits) = fetch(&mut source);
            assert_eq!(result, Err(FetchError::Failed(status)));
            assert_eq!((source.calls, waits.len()), (1, 0));
        }
    }

    #[test]
    fn interrupted_requests_retry_with_backoff_up_to_the_limit() {
        let mut source = Scripted::new(vec![
            Err(SourceError::Interrupted),
            Err(SourceError::Interrupted),
            Ok(vec![note("n1", 1)]),
        ]);
        let (result, waits) = fetch(&mut source);
        assert_eq!(result.unwrap().len(), 1);
        assert_eq!(waits, [Duration::from_secs(1), Duration::from_secs(2)]);

        let mut source = Scripted::new(vec![Err(SourceError::Interrupted); 3]);
        let (result, _) = fetch(&mut source);
        assert_eq!(
            result,
            Err(FetchError::Failed(ConnectionStatus::Unavailable))
        );
        assert_eq!(source.calls, MAX_ATTEMPTS as usize);
    }

    #[test]
    fn rate_limits_are_honored_but_never_waited_on_for_long() {
        let short = SourceError::RateLimited {
            retry_after: Duration::from_secs(5),
        };
        let mut source = Scripted::new(vec![Err(short), Ok(vec![note("n1", 1)])]);
        let (result, waits) = fetch(&mut source);
        assert!(result.is_ok());
        assert_eq!(waits, [Duration::from_secs(5)]);

        let long = SourceError::RateLimited {
            retry_after: Duration::from_secs(600),
        };
        let (result, waits) = fetch(&mut Scripted::new(vec![Err(long)]));
        let status = ConnectionStatus::RateLimited { retry_after_s: 600 };
        assert_eq!(result, Err(FetchError::Failed(status)));
        assert!(waits.is_empty());
    }

    #[test]
    fn cancelling_stops_a_wait_and_discards_a_fetch_in_progress() {
        // Cancelled during the wait: no further attempt.
        let mut source =
            Scripted::new(vec![Err(SourceError::Interrupted), Ok(vec![note("n1", 1)])]);
        let result = fetch_selection(&mut source, &ids(&["n1"]), &|| false, &mut |_| false);
        assert_eq!((result, source.calls), (Err(FetchError::Cancelled), 1));

        // Cancelled while the request was running: its results are discarded.
        let checks = Cell::new(0);
        let cancelled = || {
            checks.set(checks.get() + 1);
            checks.get() > 1
        };
        let mut source = Scripted::new(vec![Ok(vec![note("n1", 1)])]);
        let result = fetch_selection(&mut source, &ids(&["n1"]), &cancelled, &mut |_| true);
        assert_eq!(result, Err(FetchError::Cancelled));
    }

    #[test]
    fn invalid_notes_are_counted_and_change_nothing() {
        let mut store = ContextStore::default();
        let selection = ids(&["n1", "n2", "n3", "n4", "n\u{7}5", "n\u{200B}6"]);
        let mut impossible_date = note("n1", 1);
        impossible_date.source_date = "2026-13-45".into();
        let mut wrong_format = note("n2", 1);
        wrong_format.source_date = "30/10/2026".into();
        let mut blank = note("n3", 1);
        blank.excerpt = "   ".into();
        let mut other_provider = note("n4", 1);
        other_provider.provider = Provider::File;
        let control = note("n\u{7}5", 1);
        let zero_width = note("n\u{200B}6", 1);
        let outcome = store.merge(
            Provider::Granola,
            &selection,
            vec![
                impossible_date,
                wrong_format,
                blank,
                other_provider,
                control,
                zero_width,
            ],
        );
        assert_eq!(
            outcome,
            MergeOutcome {
                rejected: 6,
                ..MergeOutcome::default()
            }
        );
        assert!(store.items().is_empty());
        assert!(valid_date("2024-02-29") && !valid_date("2026-02-29") && !valid_date("0000-00-00"));
    }

    #[test]
    fn ids_are_trimmed_so_one_note_is_never_kept_twice() {
        let mut store = ContextStore::default();
        store.merge(Provider::Granola, &ids(&["n1"]), vec![note(" n1 ", 1)]);
        let again = store.merge(Provider::Granola, &ids(&["n1"]), vec![note("n1", 1)]);
        assert_eq!((again.unchanged, store.items().len()), (1, 1));
        let mut untitled = note("n2", 1);
        untitled.title = " ".into();
        store.merge(Provider::Granola, &ids(&["n2"]), vec![untitled]);
        assert_eq!(store.items()[1].title, "Untitled note");
    }

    #[test]
    fn excerpts_and_the_store_stay_small_and_the_limit_is_reported() {
        let mut long = note("n1", 1);
        long.excerpt = "a".repeat(MAX_EXCERPT_CHARS + 500);
        let mut store = ContextStore::default();
        store.merge(Provider::Granola, &ids(&["n1"]), vec![long]);
        assert_eq!(store.items()[0].excerpt.chars().count(), MAX_EXCERPT_CHARS);
        let names: Vec<String> = (0..MAX_ITEMS + 5).map(|n| format!("m{n}")).collect();
        let many = names.iter().map(|id| note(id, 1)).collect();
        let outcome = store.merge(Provider::Granola, &names, many);
        assert_eq!((outcome.added, outcome.over_limit), (MAX_ITEMS - 1, 6));
        assert_eq!(store.items().len(), MAX_ITEMS);
    }

    #[test]
    fn removing_a_note_or_a_providers_notes_is_an_explicit_choice() {
        let mut store = ContextStore::default();
        store.merge(
            Provider::Granola,
            &ids(&["n1", "n2"]),
            vec![note("n1", 1), note("n2", 1)],
        );
        assert!(store.remove(Provider::Granola, " n1 "));
        assert!(!store.remove(Provider::Granola, "n1"));
        assert_eq!(store.remove_all_from(Provider::File), 0);
        assert_eq!(store.remove_all_from(Provider::Granola), 1);
        assert!(store.items().is_empty());
    }

    #[test]
    fn a_source_without_import_capability_is_not_supported() {
        let mut source = Scripted::new(vec![Ok(vec![note("n1", 1)])]);
        source.capabilities = Capabilities {
            live_input: true,
            ..Capabilities::default()
        };
        let (result, _) = fetch(&mut source);
        assert_eq!((result, source.calls), (Err(FetchError::NotSupported), 0));
    }
}
