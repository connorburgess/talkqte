//! Source-aware prior context: notes a user explicitly imports from a
//! connected note-taker (Granola first) or a file, kept separate from live
//! meeting evidence. This is the adapter contract and in-memory store only.
//! No provider is connected, nothing is fetched over the network, and
//! nothing is written back.

use serde::Serialize;
use std::time::Duration;

/// Most items kept at once, and the most text per item. Prior context is a
/// small selection, not a copy of someone's notes.
pub const MAX_ITEMS: usize = 20;
pub const MAX_EXCERPT_CHARS: usize = 2_000;
/// Attempts for one import, including the first.
pub const MAX_ATTEMPTS: u32 = 3;
/// The longest wait honored between attempts, even if a provider asks for more.
pub const MAX_RETRY_WAIT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Granola,
    File,
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
}

/// One imported note, labeled so it can never be mistaken for something
/// said in the current meeting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub provider: Provider,
    /// The provider's identifier for the note.
    pub source_id: String,
    pub title: String,
    /// The note's own date, YYYY-MM-DD, shown beside it.
    pub source_date: String,
    /// The selected excerpt, at most `MAX_EXCERPT_CHARS`.
    pub excerpt: String,
    /// Increases when the provider's note changes.
    pub revision: u64,
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
}

/// A note source behind the native boundary. Authentication and provider
/// mapping live in the implementation; the store sees only validated items.
pub trait NoteSource {
    fn provider(&self) -> Provider;
    fn capabilities(&self) -> Capabilities;
    fn fetch(&mut self, selection: &[String]) -> Result<Vec<ContextItem>, SourceError>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum ImportOutcome {
    /// Items added or updated, and items unchanged because their revision
    /// was not newer.
    Imported {
        added: usize,
        updated: usize,
        unchanged: usize,
    },
    /// The source returned nothing for the selection; nothing changed.
    Empty,
    Cancelled,
    Failed(ConnectionStatus),
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

    /// Imports the user's selection with bounded retries. Only interrupted
    /// requests and rate limits are retried, waiting at most
    /// `MAX_RETRY_WAIT`; expired or revoked access stops at once. `cancelled`
    /// is checked before every attempt and wait, and `wait` performs the
    /// pause so tests need not sleep.
    pub fn import(
        &mut self,
        source: &mut dyn NoteSource,
        selection: &[String],
        cancelled: &dyn Fn() -> bool,
        wait: &mut dyn FnMut(Duration),
    ) -> ImportOutcome {
        if !source.capabilities().import_notes {
            return ImportOutcome::Failed(ConnectionStatus::Unavailable);
        }
        let mut attempt = 1;
        let fetched = loop {
            if cancelled() {
                return ImportOutcome::Cancelled;
            }
            match source.fetch(selection) {
                Ok(items) => break items,
                Err(error) => {
                    let delay = match &error {
                        SourceError::Interrupted => Duration::from_secs(1 << (attempt - 1)),
                        SourceError::RateLimited { retry_after } => *retry_after,
                        _ => return ImportOutcome::Failed(status_for(&error)),
                    };
                    if attempt >= MAX_ATTEMPTS || delay > MAX_RETRY_WAIT {
                        return ImportOutcome::Failed(status_for(&error));
                    }
                    if cancelled() {
                        return ImportOutcome::Cancelled;
                    }
                    wait(delay);
                    attempt += 1;
                }
            }
        };
        let provider = source.provider();
        let valid: Vec<ContextItem> = fetched
            .into_iter()
            .filter_map(|item| validated(item, provider))
            .collect();
        if valid.is_empty() {
            return ImportOutcome::Empty;
        }
        let (mut added, mut updated, mut unchanged) = (0, 0, 0);
        for item in valid {
            let kept = self.items.iter().position(|kept| {
                kept.provider == item.provider && kept.source_id == item.source_id
            });
            match kept {
                // A repeated import replaces only with a newer revision, so it
                // never duplicates a note or rolls it back.
                Some(index) if item.revision > self.items[index].revision => {
                    self.items[index] = item;
                    updated += 1;
                }
                Some(_) => unchanged += 1,
                None if self.items.len() < MAX_ITEMS => {
                    self.items.push(item);
                    added += 1;
                }
                None => unchanged += 1,
            }
        }
        ImportOutcome::Imported {
            added,
            updated,
            unchanged,
        }
    }

    /// Removes one imported note.
    pub fn remove(&mut self, provider: Provider, source_id: &str) -> bool {
        let before = self.items.len();
        self.items
            .retain(|item| !(item.provider == provider && item.source_id == source_id));
        self.items.len() != before
    }

    /// Disconnecting a provider deletes every copy imported from it.
    pub fn disconnect(&mut self, provider: Provider) -> usize {
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
    }
}

/// Accepts an item only if it came from this source and has an ID, a valid
/// date, and some text; trims the excerpt to the limit.
fn validated(mut item: ContextItem, provider: Provider) -> Option<ContextItem> {
    let date_ok = item.source_date.len() == 10
        && item
            .source_date
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                4 | 7 => character == '-',
                _ => character.is_ascii_digit(),
            });
    item.excerpt = item
        .excerpt
        .trim()
        .chars()
        .take(MAX_EXCERPT_CHARS)
        .collect();
    item.title = item.title.trim().chars().take(200).collect();
    (item.provider == provider
        && !item.source_id.trim().is_empty()
        && item.source_id.len() <= 128
        && date_ok
        && !item.excerpt.is_empty())
    .then_some(item)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// Fictional notes, as a Granola adapter might map them.
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

    fn run(store: &mut ContextStore, source: &mut Scripted) -> (ImportOutcome, Vec<Duration>) {
        let mut waits = vec![];
        let outcome = store.import(source, &["n1".into()], &|| false, &mut |delay| {
            waits.push(delay)
        });
        (outcome, waits)
    }

    #[test]
    fn a_selected_note_is_imported_with_its_source_and_date() {
        let mut store = ContextStore::default();
        let (outcome, _) = run(
            &mut store,
            &mut Scripted::new(vec![Ok(vec![note("n1", 1)])]),
        );
        assert_eq!(
            outcome,
            ImportOutcome::Imported {
                added: 1,
                updated: 0,
                unchanged: 0
            }
        );
        let item = &store.items()[0];
        assert_eq!(
            (item.provider, item.source_date.as_str()),
            (Provider::Granola, "2026-10-30")
        );
    }

    #[test]
    fn repeated_imports_never_duplicate_or_roll_back_a_note() {
        let mut store = ContextStore::default();
        run(
            &mut store,
            &mut Scripted::new(vec![Ok(vec![note("n1", 2)])]),
        );
        let (same, _) = run(
            &mut store,
            &mut Scripted::new(vec![Ok(vec![note("n1", 2)])]),
        );
        let (older, _) = run(
            &mut store,
            &mut Scripted::new(vec![Ok(vec![note("n1", 1)])]),
        );
        let (newer, _) = run(
            &mut store,
            &mut Scripted::new(vec![Ok(vec![note("n1", 3)])]),
        );
        assert_eq!(
            same,
            ImportOutcome::Imported {
                added: 0,
                updated: 0,
                unchanged: 1
            }
        );
        assert_eq!(
            older,
            ImportOutcome::Imported {
                added: 0,
                updated: 0,
                unchanged: 1
            }
        );
        assert_eq!(
            newer,
            ImportOutcome::Imported {
                added: 0,
                updated: 1,
                unchanged: 0
            }
        );
        assert_eq!((store.items().len(), store.items()[0].revision), (1, 3));
    }

    #[test]
    fn expired_or_revoked_access_stops_without_retrying() {
        for (error, status) in [
            (SourceError::Expired, ConnectionStatus::Expired),
            (SourceError::Revoked, ConnectionStatus::Revoked),
        ] {
            let mut source = Scripted::new(vec![Err(error)]);
            let (outcome, waits) = run(&mut ContextStore::default(), &mut source);
            assert_eq!(outcome, ImportOutcome::Failed(status));
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
        let (outcome, waits) = run(&mut ContextStore::default(), &mut source);
        assert!(matches!(outcome, ImportOutcome::Imported { added: 1, .. }));
        assert_eq!(waits, [Duration::from_secs(1), Duration::from_secs(2)]);

        let mut source = Scripted::new(vec![Err(SourceError::Interrupted); 3]);
        let (outcome, _) = run(&mut ContextStore::default(), &mut source);
        assert_eq!(
            outcome,
            ImportOutcome::Failed(ConnectionStatus::Unavailable)
        );
        assert_eq!(source.calls, MAX_ATTEMPTS as usize);
    }

    #[test]
    fn rate_limits_are_honored_but_never_waited_on_for_long() {
        let short = SourceError::RateLimited {
            retry_after: Duration::from_secs(5),
        };
        let mut source = Scripted::new(vec![Err(short), Ok(vec![note("n1", 1)])]);
        let (outcome, waits) = run(&mut ContextStore::default(), &mut source);
        assert!(matches!(outcome, ImportOutcome::Imported { .. }));
        assert_eq!(waits, [Duration::from_secs(5)]);

        let long = SourceError::RateLimited {
            retry_after: Duration::from_secs(600),
        };
        let mut source = Scripted::new(vec![Err(long)]);
        let (outcome, waits) = run(&mut ContextStore::default(), &mut source);
        assert_eq!(
            outcome,
            ImportOutcome::Failed(ConnectionStatus::RateLimited { retry_after_s: 600 })
        );
        assert!(waits.is_empty());
    }

    #[test]
    fn cancelling_stops_before_the_next_attempt_or_wait() {
        let mut source =
            Scripted::new(vec![Err(SourceError::Interrupted), Ok(vec![note("n1", 1)])]);
        let calls = Cell::new(0);
        let cancelled = || {
            calls.set(calls.get() + 1);
            calls.get() > 1 // cancel after the first attempt starts
        };
        let mut store = ContextStore::default();
        let outcome = store.import(&mut source, &[], &cancelled, &mut |_| {
            panic!("no wait after cancel")
        });
        assert_eq!(outcome, ImportOutcome::Cancelled);
        assert!(store.items().is_empty());
        assert_eq!(source.calls, 1);
    }

    #[test]
    fn empty_and_invalid_results_change_nothing() {
        let mut store = ContextStore::default();
        let (outcome, _) = run(&mut store, &mut Scripted::new(vec![Ok(vec![])]));
        assert_eq!(outcome, ImportOutcome::Empty);
        let mut bad_date = note("n1", 1);
        bad_date.source_date = "30/10/2026".into();
        let mut blank = note("n2", 1);
        blank.excerpt = "   ".into();
        let mut other_provider = note("n3", 1);
        other_provider.provider = Provider::File;
        let (outcome, _) = run(
            &mut store,
            &mut Scripted::new(vec![Ok(vec![bad_date, blank, other_provider])]),
        );
        assert_eq!(outcome, ImportOutcome::Empty);
        assert!(store.items().is_empty());
    }

    #[test]
    fn excerpts_and_the_store_stay_small() {
        let mut long = note("n1", 1);
        long.excerpt = "a".repeat(MAX_EXCERPT_CHARS + 500);
        let mut store = ContextStore::default();
        run(&mut store, &mut Scripted::new(vec![Ok(vec![long])]));
        assert_eq!(store.items()[0].excerpt.chars().count(), MAX_EXCERPT_CHARS);
        let many: Vec<_> = (0..MAX_ITEMS + 5)
            .map(|n| note(&format!("m{n}"), 1))
            .collect();
        run(&mut store, &mut Scripted::new(vec![Ok(many)]));
        assert_eq!(store.items().len(), MAX_ITEMS);
    }

    #[test]
    fn removing_and_disconnecting_delete_the_imported_copies() {
        let mut store = ContextStore::default();
        run(
            &mut store,
            &mut Scripted::new(vec![Ok(vec![note("n1", 1), note("n2", 1)])]),
        );
        assert!(store.remove(Provider::Granola, "n1"));
        assert!(!store.remove(Provider::Granola, "n1"));
        assert_eq!(store.disconnect(Provider::Granola), 1);
        assert!(store.items().is_empty());
    }

    #[test]
    fn a_source_without_import_capability_is_refused() {
        let mut source = Scripted::new(vec![Ok(vec![note("n1", 1)])]);
        source.capabilities = Capabilities {
            live_input: true,
            ..Capabilities::default()
        };
        let (outcome, _) = run(&mut ContextStore::default(), &mut source);
        assert_eq!(
            outcome,
            ImportOutcome::Failed(ConnectionStatus::Unavailable)
        );
        assert_eq!(source.calls, 0);
    }
}
