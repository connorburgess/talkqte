//! One explicit, user-started check of the Granola notes already imported:
//! is each copy still the provider's latest revision? There is no timer, no
//! background queue and no retry; every check is started by the person and
//! covers only the notes kept at that moment.
//!
//! The rules follow `docs/selected-note-refresh-plan.md`:
//! - A check needs a provider-supported workspace identity, read before and
//!   after every request. Without one, or if it changes, nothing is applied.
//! - At most one check is outstanding. A local timeout does not prove the
//!   sent request ended, so no replacement starts until it has settled.
//! - Stop, Disconnect and removing a note invalidate the pending result.
//! - An omitted note, an older or unversioned reply and a failed request
//!   leave the copy in place and mark it not verified; none is treated as
//!   deletion.
//!
//! Network work runs on its own thread, never under the notebook lock.

use crate::context::{ContextItem, ContextStore, Provider, SourceError};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};

/// The most note identifiers sent in one request, matching the import limit.
pub const BATCH: usize = 10;
/// How long the notebook waits for a check before reporting a timeout.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(25);

/// A provider connection that can be asked about already selected notes.
pub trait RefreshSource {
    /// Whether this provider offers a workspace identity that
    /// `workspace` can read. The notebook offers a check only when it does.
    fn binding_supported(&self) -> bool;
    /// The provider's own identifier for the workspace its requests are
    /// scoped to; `None` when it offers nothing that can be verified.
    fn workspace(&mut self) -> Result<Option<String>, SourceError>;
    /// The selected notes the provider returned. A note it omits is simply
    /// absent; other notes it volunteers are dropped by the caller.
    fn fetch_available(&mut self, selection: &[String]) -> Result<Vec<ContextItem>, SourceError>;
}

/// Why a kept copy could not be confirmed as the provider's latest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Unverified {
    /// The provider did not return the note. Not proof of deletion.
    Missing,
    /// The reply carried no usable update time.
    Unversioned,
    /// The reply was older than the kept copy.
    Older,
    /// The reply had no valid date or text.
    Unreadable,
    Unavailable,
    Expired,
    Revoked,
    RateLimited,
    UnsupportedFormat,
    Workspace,
    TimedOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Freshness {
    /// The kept copy matched the provider's revision at the last check.
    Current,
    /// The last check replaced the copy with a newer revision.
    Updated,
    NotVerified,
}

/// What the notebook may show beside one imported Granola note.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFreshness {
    pub source_id: String,
    /// The revision of the kept copy this finding is about.
    pub revision: u64,
    pub state: Freshness,
    pub reason: Option<Unverified>,
    /// When a check last confirmed or updated this copy, by the local clock.
    pub verified_at_ms: Option<u64>,
    /// The provider's own update time for the kept copy, if it gave one.
    /// Neither time shows when a person last edited the source.
    pub provider_updated_at_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Checked,
    /// Stopped, disconnected, or replaced; nothing was applied.
    Cancelled,
    TimedOut,
    /// The provider offered no workspace identity; no note request was sent.
    WorkspaceUnverified,
    WorkspaceChanged,
    Unavailable,
    Expired,
    Revoked,
    RateLimited,
    UnsupportedFormat,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub status: CheckStatus,
    pub retry_after_s: Option<u64>,
    /// Every Granola note still kept that has been checked in this session.
    pub notes: Vec<NoteFreshness>,
    /// Whether a kept copy was replaced, so the caller republishes context.
    #[serde(skip)]
    pub store_changed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BeginError {
    /// A check is already running.
    Running,
    /// An earlier request timed out locally and has not finished yet.
    Unsettled,
    NoNotes,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CheckError {
    Cancelled,
    TimedOut,
    WorkspaceUnverified,
    WorkspaceChanged,
    Source(SourceError),
}

#[derive(Debug, PartialEq, Eq)]
pub struct Fetched {
    items: Vec<ContextItem>,
    workspace: String,
}

/// One started check. It carries the selection made at the start and the
/// flags that tie its result to the notebook state that started it.
pub struct Ticket {
    id: u64,
    selection: Vec<String>,
    workspace: Option<String>,
    cancelled: Arc<AtomicBool>,
    settled: Arc<AtomicBool>,
}

struct Current {
    id: u64,
    selection: Vec<String>,
    cancelled: Arc<AtomicBool>,
}

struct Entry {
    source_id: String,
    /// The kept revision the finding is about; a later import of another
    /// revision makes the finding obsolete.
    revision: u64,
    state: Freshness,
    reason: Option<Unverified>,
    verified_at_ms: Option<u64>,
}

/// Check state for this app session, in memory only.
#[derive(Default)]
pub struct Refresh {
    next: u64,
    current: Option<Current>,
    /// The latest request's completion flag, kept after Stop, a timeout and
    /// Disconnect so the one-request bound holds until it really ends.
    settled: Option<Arc<AtomicBool>>,
    /// The workspace the first successful check of this connection saw.
    workspace: Option<String>,
    notes: Vec<Entry>,
}

impl Refresh {
    /// Starts a check of the Granola notes kept right now.
    pub fn begin(&mut self, store: &ContextStore) -> Result<Ticket, BeginError> {
        if self.current.is_some() {
            return Err(BeginError::Running);
        }
        if self
            .settled
            .as_ref()
            .is_some_and(|settled| !settled.load(Ordering::Acquire))
        {
            return Err(BeginError::Unsettled);
        }
        let selection: Vec<String> = store
            .items()
            .iter()
            .filter(|item| item.provider == Provider::Granola)
            .map(|item| item.source_id.clone())
            .collect();
        if selection.is_empty() {
            return Err(BeginError::NoNotes);
        }
        self.next += 1;
        let cancelled = Arc::new(AtomicBool::new(false));
        let settled = Arc::new(AtomicBool::new(false));
        self.settled = Some(settled.clone());
        self.current = Some(Current {
            id: self.next,
            selection: selection.clone(),
            cancelled: cancelled.clone(),
        });
        Ok(Ticket {
            id: self.next,
            selection,
            workspace: self.workspace.clone(),
            cancelled,
            settled,
        })
    }

    /// Ends the running check, if any; its result will be discarded. A
    /// request already sent may still finish at the provider.
    pub fn stop(&mut self) {
        if let Some(current) = self.current.take() {
            current.cancelled.store(true, Ordering::Release);
        }
    }

    /// Disconnect also forgets what earlier checks of that connection found.
    pub fn disconnect(&mut self) {
        self.stop();
        self.workspace = None;
        self.notes.clear();
    }

    /// A removed note leaves the selection at once, so a pending result
    /// cannot touch a later copy with the same identifier.
    pub fn forget(&mut self, provider: Provider, source_id: &str) {
        if provider != Provider::Granola {
            return;
        }
        let source_id = source_id.trim();
        self.notes.retain(|entry| entry.source_id != source_id);
        if let Some(current) = &mut self.current {
            current.selection.retain(|id| id != source_id);
            if current.selection.is_empty() {
                self.stop();
            }
        }
    }

    pub fn forget_all(&mut self) {
        self.notes.clear();
        self.stop();
    }

    /// Applies a finished check under the notebook lock. A result whose
    /// check was stopped, disconnected or replaced changes nothing.
    pub fn apply(
        &mut self,
        ticket: &Ticket,
        result: Result<Fetched, CheckError>,
        store: &mut ContextStore,
        now_ms: u64,
    ) -> Report {
        // Whatever happens next, this check sends nothing further: a timed
        // out or retired check must not go on to its next batch.
        ticket.cancelled.store(true, Ordering::Release);
        let current = match self.current.take() {
            Some(current) if current.id == ticket.id => current,
            other => {
                self.current = other;
                return self.report(CheckStatus::Cancelled, None, false, store);
            }
        };
        let kept = |store: &ContextStore, id: &str| {
            store
                .items()
                .iter()
                .find(|item| item.provider == Provider::Granola && item.source_id == id)
                .map(|item| item.revision)
        };
        let selection: Vec<String> = current
            .selection
            .into_iter()
            .filter(|id| kept(store, id).is_some())
            .collect();
        let fetched = match result {
            Ok(fetched) => fetched,
            Err(CheckError::Cancelled) => {
                return self.report(CheckStatus::Cancelled, None, false, store)
            }
            Err(error) => {
                let (status, reason, retry_after_s) = match error {
                    CheckError::TimedOut => (CheckStatus::TimedOut, Unverified::TimedOut, None),
                    CheckError::WorkspaceUnverified => (
                        CheckStatus::WorkspaceUnverified,
                        Unverified::Workspace,
                        None,
                    ),
                    CheckError::WorkspaceChanged => {
                        (CheckStatus::WorkspaceChanged, Unverified::Workspace, None)
                    }
                    CheckError::Source(SourceError::Expired) => {
                        (CheckStatus::Expired, Unverified::Expired, None)
                    }
                    CheckError::Source(SourceError::Revoked) => {
                        (CheckStatus::Revoked, Unverified::Revoked, None)
                    }
                    CheckError::Source(SourceError::RateLimited { retry_after }) => (
                        CheckStatus::RateLimited,
                        Unverified::RateLimited,
                        Some(retry_after.as_secs()),
                    ),
                    CheckError::Source(SourceError::UnsupportedFormat) => (
                        CheckStatus::UnsupportedFormat,
                        Unverified::UnsupportedFormat,
                        None,
                    ),
                    CheckError::Source(SourceError::Interrupted | SourceError::Unavailable)
                    | CheckError::Cancelled => {
                        (CheckStatus::Unavailable, Unverified::Unavailable, None)
                    }
                };
                for id in &selection {
                    if let Some(revision) = kept(store, id) {
                        self.record(id, revision, Freshness::NotVerified, Some(reason), None);
                    }
                }
                return self.report(status, retry_after_s, false, store);
            }
        };
        self.workspace = Some(fetched.workspace);
        let mut store_changed = false;
        for id in &selection {
            let Some(kept_revision) = kept(store, id) else {
                continue;
            };
            let Some(item) = fetched
                .items
                .iter()
                .find(|item| item.provider == Provider::Granola && item.source_id.trim() == id)
            else {
                self.record(
                    id,
                    kept_revision,
                    Freshness::NotVerified,
                    Some(Unverified::Missing),
                    None,
                );
                continue;
            };
            let revision = item.revision;
            // The note is kept, so the store can replace it but never add one.
            let outcome = store.merge(
                Provider::Granola,
                std::slice::from_ref(id),
                vec![item.clone()],
            );
            let (state, reason) = if outcome.updated == 1 {
                store_changed = true;
                (Freshness::Updated, None)
            } else if outcome.rejected == 1 {
                (Freshness::NotVerified, Some(Unverified::Unreadable))
            } else if crate::granola::updated_at_ms(revision).is_none() {
                (Freshness::NotVerified, Some(Unverified::Unversioned))
            } else if revision < kept_revision {
                (Freshness::NotVerified, Some(Unverified::Older))
            } else {
                (Freshness::Current, None)
            };
            let verified = (state != Freshness::NotVerified).then_some(now_ms);
            let now_kept = if state == Freshness::Updated {
                revision
            } else {
                kept_revision
            };
            self.record(id, now_kept, state, reason, verified);
        }
        self.report(CheckStatus::Checked, None, store_changed, store)
    }

    fn record(
        &mut self,
        source_id: &str,
        revision: u64,
        state: Freshness,
        reason: Option<Unverified>,
        verified_at_ms: Option<u64>,
    ) {
        if let Some(entry) = self
            .notes
            .iter_mut()
            .find(|entry| entry.source_id == source_id)
        {
            // A later failure keeps the time of the last successful check of
            // the same revision.
            entry.verified_at_ms =
                verified_at_ms.or(entry.verified_at_ms.filter(|_| entry.revision == revision));
            entry.revision = revision;
            entry.state = state;
            entry.reason = reason;
        } else {
            self.notes.push(Entry {
                source_id: source_id.to_string(),
                revision,
                state,
                reason,
                verified_at_ms,
            });
        }
    }

    fn report(
        &self,
        status: CheckStatus,
        retry_after_s: Option<u64>,
        store_changed: bool,
        store: &ContextStore,
    ) -> Report {
        Report {
            status,
            retry_after_s,
            notes: self.freshness(store),
            store_changed,
        }
    }

    /// What earlier checks found for the Granola notes still kept.
    pub fn freshness(&self, store: &ContextStore) -> Vec<NoteFreshness> {
        self.notes
            .iter()
            .filter_map(|entry| {
                // A copy imported again at another revision was never checked.
                let item = store.items().iter().find(|item| {
                    item.provider == Provider::Granola
                        && item.source_id == entry.source_id
                        && item.revision == entry.revision
                })?;
                Some(NoteFreshness {
                    source_id: entry.source_id.clone(),
                    revision: entry.revision,
                    state: entry.state,
                    reason: entry.reason,
                    verified_at_ms: entry.verified_at_ms,
                    provider_updated_at_ms: crate::granola::updated_at_ms(item.revision),
                })
            })
            .collect()
    }
}

/// Marks the request finished when its thread ends, however it ends.
struct Settle(Arc<AtomicBool>);

impl Drop for Settle {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn workspace_of(source: &mut dyn RefreshSource) -> Result<String, CheckError> {
    source
        .workspace()
        .map_err(CheckError::Source)?
        .map(|workspace| workspace.trim().to_string())
        .filter(|workspace| !workspace.is_empty())
        .ok_or(CheckError::WorkspaceUnverified)
}

fn request(
    source: &mut dyn RefreshSource,
    selection: &[String],
    expected: Option<&str>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Fetched, CheckError> {
    // Fail closed before any note identifier leaves the device.
    let workspace = workspace_of(source)?;
    if expected.is_some_and(|expected| expected != workspace) {
        return Err(CheckError::WorkspaceChanged);
    }
    let mut items = Vec::new();
    for batch in selection.chunks(BATCH) {
        if cancelled() {
            return Err(CheckError::Cancelled);
        }
        items.extend(source.fetch_available(batch).map_err(CheckError::Source)?);
        if cancelled() {
            return Err(CheckError::Cancelled);
        }
        if workspace_of(source)? != workspace {
            return Err(CheckError::WorkspaceChanged);
        }
    }
    Ok(Fetched { items, workspace })
}

/// Runs the check's requests one at a time on their own thread and waits
/// for them until `timeout` or until the check is stopped. A timeout or a
/// stop returns at once; the thread then finishes on its own and only then
/// marks the request settled.
pub fn run(
    ticket: &Ticket,
    mut source: Box<dyn RefreshSource + Send>,
    timeout: Duration,
) -> Result<Fetched, CheckError> {
    let (sender, receiver) = mpsc::channel();
    let selection = ticket.selection.clone();
    let expected = ticket.workspace.clone();
    let cancelled = ticket.cancelled.clone();
    let settle = Settle(ticket.settled.clone());
    let spawned = std::thread::Builder::new()
        .name("granola-update-check".into())
        .spawn(move || {
            let settle = settle;
            let result = request(source.as_mut(), &selection, expected.as_deref(), &|| {
                cancelled.load(Ordering::Acquire)
            });
            // Drop the connection clone before reporting the request ended.
            drop(source);
            let _ = sender.send(result);
            drop(settle);
        });
    if spawned.is_err() {
        // The closure, and with it the completion flag, was dropped unrun.
        return Err(CheckError::Source(SourceError::Unavailable));
    }
    let deadline = Instant::now() + timeout;
    loop {
        if ticket.cancelled.load(Ordering::Acquire) {
            return Err(CheckError::Cancelled);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining.min(POLL)) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) if remaining.is_zero() => {
                return Err(CheckError::TimedOut)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(CheckError::Source(SourceError::Unavailable))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// 12 November 2026 09:30 UTC and one hour later, as provider update times.
    const EARLIER: u64 = 1_794_562_200_000;
    const LATER: u64 = EARLIER + 3_600_000;
    /// The named local clock for "checked at".
    const NOW: u64 = LATER + 86_400_000;
    const LONG: Duration = Duration::from_secs(5);

    fn note(id: &str, revision: u64, excerpt: &str) -> ContextItem {
        ContextItem {
            provider: Provider::Granola,
            source_id: id.into(),
            title: "Garden volunteers check-in".into(),
            source_date: "2026-11-02".into(),
            excerpt: excerpt.into(),
            revision,
        }
    }

    fn store(notes: &[(&str, u64)]) -> ContextStore {
        let mut store = ContextStore::default();
        let ids: Vec<String> = notes.iter().map(|(id, _)| id.to_string()).collect();
        store.merge(
            Provider::Granola,
            &ids,
            notes
                .iter()
                .map(|(id, revision)| note(id, *revision, "Robin will label the watering cans."))
                .collect(),
        );
        store
    }

    type Gate = (mpsc::Sender<()>, mpsc::Receiver<()>);

    /// A fictional provider: scripted workspace identities and replies, a
    /// log of the identifiers it was asked for, and an optional hold on the
    /// first note request.
    struct Fictional {
        workspaces: VecDeque<Option<&'static str>>,
        replies: VecDeque<Result<Vec<ContextItem>, SourceError>>,
        asked: Arc<Mutex<Vec<Vec<String>>>>,
        gate: Option<Gate>,
    }

    impl RefreshSource for Fictional {
        fn binding_supported(&self) -> bool {
            true
        }
        fn workspace(&mut self) -> Result<Option<String>, SourceError> {
            let workspace = if self.workspaces.len() > 1 {
                self.workspaces.pop_front().unwrap()
            } else {
                self.workspaces[0]
            };
            Ok(workspace.map(str::to_string))
        }
        fn fetch_available(
            &mut self,
            selection: &[String],
        ) -> Result<Vec<ContextItem>, SourceError> {
            self.asked.lock().unwrap().push(selection.to_vec());
            if let Some((started, release)) = self.gate.take() {
                started.send(()).unwrap();
                release.recv_timeout(LONG).unwrap();
            }
            self.replies.pop_front().unwrap_or(Ok(vec![]))
        }
    }

    type Asked = Arc<Mutex<Vec<Vec<String>>>>;

    fn provider(
        workspaces: &[Option<&'static str>],
        replies: Vec<Result<Vec<ContextItem>, SourceError>>,
    ) -> (Box<Fictional>, Asked) {
        let asked = Asked::default();
        (
            Box::new(Fictional {
                workspaces: workspaces.iter().copied().collect(),
                replies: replies.into(),
                asked: asked.clone(),
                gate: None,
            }),
            asked,
        )
    }

    fn check(
        refresh: &mut Refresh,
        store: &mut ContextStore,
        source: Box<Fictional>,
        now: u64,
    ) -> Report {
        let ticket = refresh.begin(store).unwrap();
        let result = run(&ticket, source, LONG);
        refresh.apply(&ticket, result, store, now)
    }

    fn state(report: &Report, id: &str) -> (Freshness, Option<Unverified>) {
        let note = report
            .notes
            .iter()
            .find(|note| note.source_id == id)
            .unwrap();
        (note.state, note.reason)
    }

    fn wait_until_settled(refresh: &Refresh) {
        let settled = refresh.settled.clone().unwrap();
        let deadline = Instant::now() + LONG;
        while !settled.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "the request never settled");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// A provider held inside its note request, with handles to observe the
    /// request starting and to let it answer.
    fn held(
        replies: Vec<Result<Vec<ContextItem>, SourceError>>,
    ) -> (Box<Fictional>, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (mut source, _) = provider(&[Some("garden-club")], replies);
        let (started, has_started) = mpsc::channel();
        let (release, released) = mpsc::channel();
        source.gate = Some((started, released));
        (source, has_started, release)
    }

    #[test]
    fn a_changed_note_replaces_its_copy_and_an_unchanged_one_is_confirmed() {
        let mut store = store(&[("n1", EARLIER), ("n2", EARLIER)]);
        // A file note with a Granola note's identifier is another note.
        let mut file = note("n1", 1, "From a fictional file.");
        file.provider = Provider::File;
        store.merge(Provider::File, &["n1".into()], vec![file]);
        let mut refresh = Refresh::default();
        let (source, asked) = provider(
            &[Some("garden-club")],
            vec![Ok(vec![
                note("n1", LATER, "Robin moved the open day to Sunday."),
                note("n2", EARLIER, "Robin will label the watering cans."),
                // Never selected, so never kept.
                note("n9", LATER, "An unselected fictional note."),
            ])],
        );
        let report = check(&mut refresh, &mut store, source, NOW);
        assert_eq!(report.status, CheckStatus::Checked);
        assert!(report.store_changed);
        assert_eq!(
            *asked.lock().unwrap(),
            [vec!["n1".to_string(), "n2".to_string()]],
            "only the kept Granola notes are requested, once"
        );
        assert_eq!(state(&report, "n1"), (Freshness::Updated, None));
        assert_eq!(state(&report, "n2"), (Freshness::Current, None));
        assert_eq!(store.items().len(), 3);
        assert_eq!(
            store.items()[0].excerpt,
            "Robin moved the open day to Sunday."
        );
        assert_eq!(store.items()[2].excerpt, "From a fictional file.");
        // The check time and the provider's update time stay distinct.
        let updated = &report.notes[0];
        assert_eq!(updated.verified_at_ms, Some(NOW));
        assert_eq!(updated.provider_updated_at_ms, Some(LATER));
    }

    #[test]
    fn omitted_older_unversioned_and_unreadable_replies_keep_the_copy_unverified() {
        let mut store = store(&[("n1", LATER), ("n2", LATER), ("n3", LATER), ("n4", LATER)]);
        let mut refresh = Refresh::default();
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(vec![
                note("n1", LATER, "Robin will label the watering cans."),
                note("n2", LATER, "Robin will label the watering cans."),
                note("n3", LATER, "Robin will label the watering cans."),
                note("n4", LATER, "Robin will label the watering cans."),
            ])],
        );
        let first = check(&mut refresh, &mut store, source, NOW);
        assert!(first
            .notes
            .iter()
            .all(|note| note.state == Freshness::Current));

        let mut undated = note("n4", LATER + 1, "A reply without a date.");
        undated.source_date = String::new();
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(vec![
                // n1 is omitted altogether.
                note("n2", EARLIER, "An older fictional revision."),
                note("n3", 1, "A reply without an update time."),
                undated,
            ])],
        );
        let second = check(&mut refresh, &mut store, source, NOW + 60_000);
        assert_eq!(second.status, CheckStatus::Checked);
        assert!(!second.store_changed);
        for (id, reason) in [
            ("n1", Unverified::Missing),
            ("n2", Unverified::Older),
            ("n3", Unverified::Unversioned),
            ("n4", Unverified::Unreadable),
        ] {
            assert_eq!(
                state(&second, id),
                (Freshness::NotVerified, Some(reason)),
                "{id}"
            );
        }
        // Nothing was deleted, rolled back or relabeled as freshly checked.
        assert_eq!(store.items().len(), 4);
        assert!(store.items().iter().all(|item| {
            item.revision == LATER && item.excerpt == "Robin will label the watering cans."
        }));
        assert!(second
            .notes
            .iter()
            .all(|note| note.verified_at_ms == Some(NOW)));
    }

    #[test]
    fn a_provider_without_a_workspace_identity_is_never_asked_for_notes() {
        let mut store = store(&[("n1", EARLIER)]);
        let mut refresh = Refresh::default();
        for workspace in [None, Some("  ")] {
            let (source, asked) = provider(
                &[workspace],
                vec![Ok(vec![note("n1", LATER, "A newer fictional revision.")])],
            );
            let report = check(&mut refresh, &mut store, source, NOW);
            assert_eq!(report.status, CheckStatus::WorkspaceUnverified);
            assert!(asked.lock().unwrap().is_empty());
            assert_eq!(
                state(&report, "n1"),
                (Freshness::NotVerified, Some(Unverified::Workspace))
            );
            assert_eq!(store.items()[0].revision, EARLIER);
        }
    }

    #[test]
    fn a_workspace_that_changes_during_or_between_checks_changes_nothing() {
        let mut store = store(&[("n1", EARLIER)]);
        let mut refresh = Refresh::default();
        let newer = || Ok(vec![note("n1", LATER, "A note from another workspace.")]);
        // Switched elsewhere while the request was out.
        let (source, _) = provider(&[Some("garden-club"), Some("allotment")], vec![newer()]);
        let report = check(&mut refresh, &mut store, source, NOW);
        assert_eq!(report.status, CheckStatus::WorkspaceChanged);
        // The identity disappeared while the request was out.
        let (source, _) = provider(&[Some("garden-club"), None], vec![newer()]);
        let report = check(&mut refresh, &mut store, source, NOW);
        assert_eq!(report.status, CheckStatus::WorkspaceUnverified);
        assert_eq!(store.items()[0].revision, EARLIER);

        // A successful check binds the connection to the workspace it saw.
        let (source, _) = provider(&[Some("garden-club")], vec![newer()]);
        assert_eq!(
            check(&mut refresh, &mut store, source, NOW).status,
            CheckStatus::Checked
        );
        let (source, asked) = provider(
            &[Some("allotment")],
            vec![Ok(vec![note("n1", LATER + 1, "Another workspace again.")])],
        );
        let report = check(&mut refresh, &mut store, source, NOW);
        assert_eq!(report.status, CheckStatus::WorkspaceChanged);
        assert!(asked.lock().unwrap().is_empty());
        assert_eq!(store.items()[0].revision, LATER);
        // Disconnecting ends that binding along with the earlier findings.
        refresh.disconnect();
        assert!(refresh.freshness(&store).is_empty());
        let (source, _) = provider(
            &[Some("allotment")],
            vec![Ok(vec![note(
                "n1",
                LATER + 1,
                "Chosen after reconnecting.",
            )])],
        );
        assert_eq!(
            check(&mut refresh, &mut store, source, NOW).status,
            CheckStatus::Checked
        );
    }

    #[test]
    fn provider_failures_are_distinct_keep_every_copy_and_are_not_retried() {
        let mut store = store(&[("n1", EARLIER)]);
        let mut refresh = Refresh::default();
        for (error, status, reason, retry_after_s) in [
            (
                SourceError::Interrupted,
                CheckStatus::Unavailable,
                Unverified::Unavailable,
                None,
            ),
            (
                SourceError::Unavailable,
                CheckStatus::Unavailable,
                Unverified::Unavailable,
                None,
            ),
            (
                SourceError::Expired,
                CheckStatus::Expired,
                Unverified::Expired,
                None,
            ),
            (
                SourceError::Revoked,
                CheckStatus::Revoked,
                Unverified::Revoked,
                None,
            ),
            (
                SourceError::RateLimited {
                    retry_after: Duration::from_secs(7),
                },
                CheckStatus::RateLimited,
                Unverified::RateLimited,
                Some(7),
            ),
            (
                SourceError::UnsupportedFormat,
                CheckStatus::UnsupportedFormat,
                Unverified::UnsupportedFormat,
                None,
            ),
        ] {
            let (source, asked) = provider(
                &[Some("garden-club")],
                vec![
                    Err(error),
                    Ok(vec![note("n1", LATER, "Only a retry would see this.")]),
                ],
            );
            let report = check(&mut refresh, &mut store, source, NOW);
            assert_eq!(
                (report.status, report.retry_after_s),
                (status, retry_after_s)
            );
            assert_eq!(state(&report, "n1"), (Freshness::NotVerified, Some(reason)));
            assert_eq!(asked.lock().unwrap().len(), 1, "no automatic retry");
            assert_eq!(store.items().len(), 1);
            assert_eq!(store.items()[0].revision, EARLIER);
        }
    }

    #[test]
    fn a_timed_out_request_blocks_a_replacement_until_it_settles_and_is_discarded() {
        let mut store = store(&[("n1", EARLIER)]);
        let mut refresh = Refresh::default();
        let (source, has_started, release) =
            held(vec![Ok(vec![note("n1", LATER, "A late fictional reply.")])]);
        let ticket = refresh.begin(&store).unwrap();
        assert_eq!(
            run(&ticket, source, Duration::from_millis(60)),
            Err(CheckError::TimedOut)
        );
        has_started.recv_timeout(LONG).unwrap();
        let report = refresh.apply(&ticket, Err(CheckError::TimedOut), &mut store, NOW);
        assert_eq!(report.status, CheckStatus::TimedOut);
        assert_eq!(
            state(&report, "n1"),
            (Freshness::NotVerified, Some(Unverified::TimedOut))
        );
        // The sent request has not ended, so no second one may start.
        assert_eq!(refresh.begin(&store).err(), Some(BeginError::Unsettled));
        release.send(()).unwrap();
        wait_until_settled(&refresh);
        assert_eq!(
            store.items()[0].revision,
            EARLIER,
            "the late reply is dropped"
        );
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(vec![note("n1", LATER, "Checked again on request.")])],
        );
        let report = check(&mut refresh, &mut store, source, NOW);
        assert_eq!(state(&report, "n1"), (Freshness::Updated, None));
    }

    #[test]
    fn stopping_a_check_returns_at_once_and_discards_its_late_result() {
        let mut store = store(&[("n1", EARLIER)]);
        let mut refresh = Refresh::default();
        let (source, has_started, release) =
            held(vec![Ok(vec![note("n1", LATER, "A late fictional reply.")])]);
        let ticket = refresh.begin(&store).unwrap();
        assert_eq!(refresh.begin(&store).err(), Some(BeginError::Running));
        let result = std::thread::scope(|scope| {
            let waiting = scope.spawn(|| run(&ticket, source, LONG));
            has_started.recv_timeout(LONG).unwrap();
            refresh.stop();
            waiting.join().unwrap()
        });
        assert_eq!(result, Err(CheckError::Cancelled));
        // Even a success that raced the stop is not applied.
        let late = Ok(Fetched {
            items: vec![note("n1", LATER, "A late fictional reply.")],
            workspace: "garden-club".into(),
        });
        let report = refresh.apply(&ticket, late, &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Cancelled);
        assert!(report.notes.is_empty() && !report.store_changed);
        assert_eq!(store.items()[0].revision, EARLIER);
        // The stopped request still counts until the provider answers.
        assert_eq!(refresh.begin(&store).err(), Some(BeginError::Unsettled));
        release.send(()).unwrap();
        wait_until_settled(&refresh);
        assert!(refresh.begin(&store).is_ok());
    }

    #[test]
    fn disconnecting_mid_check_discards_the_result_and_earlier_findings() {
        let mut store = store(&[("n1", EARLIER), ("n2", EARLIER)]);
        let mut refresh = Refresh::default();
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(vec![note(
                "n2",
                EARLIER,
                "Robin will label the watering cans.",
            )])],
        );
        check(&mut refresh, &mut store, source, NOW);
        let (source, has_started, release) =
            held(vec![Ok(vec![note("n1", LATER, "A late fictional reply.")])]);
        let ticket = refresh.begin(&store).unwrap();
        let result = std::thread::scope(|scope| {
            let waiting = scope.spawn(|| run(&ticket, source, LONG));
            has_started.recv_timeout(LONG).unwrap();
            refresh.disconnect();
            waiting.join().unwrap()
        });
        release.send(()).unwrap();
        let report = refresh.apply(&ticket, result, &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Cancelled);
        assert!(report.notes.is_empty());
        // Disconnect keeps the imported copies exactly as they were.
        assert_eq!(store.items().len(), 2);
        assert!(store.items().iter().all(|item| item.revision == EARLIER));
        // A check that starts after reconnecting is a new one; the retired
        // ticket cannot stand in for it.
        wait_until_settled(&refresh);
        let replacement = refresh.begin(&store).unwrap();
        let late = Ok(Fetched {
            items: vec![note("n1", LATER, "A late fictional reply.")],
            workspace: "garden-club".into(),
        });
        assert_eq!(
            refresh.apply(&ticket, late, &mut store, NOW).status,
            CheckStatus::Cancelled
        );
        assert_eq!(store.items()[0].revision, EARLIER);
        assert_eq!(refresh.begin(&store).err(), Some(BeginError::Running));
        drop(replacement);
    }

    #[test]
    fn a_note_removed_while_a_check_is_pending_is_not_restored_or_updated() {
        let mut store = store(&[("n1", EARLIER), ("n2", EARLIER)]);
        let mut refresh = Refresh::default();
        let reply = || {
            Ok(Fetched {
                items: vec![
                    note("n1", LATER, "A newer copy of the removed note."),
                    note("n2", LATER, "A newer copy of the kept note."),
                ],
                workspace: "garden-club".into(),
            })
        };
        let ticket = refresh.begin(&store).unwrap();
        assert!(store.remove(Provider::Granola, "n1"));
        refresh.forget(Provider::Granola, "n1");
        let report = refresh.apply(&ticket, reply(), &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Checked);
        assert_eq!(report.notes.len(), 1);
        assert_eq!(state(&report, "n2"), (Freshness::Updated, None));
        assert_eq!(store.items().len(), 1);
        assert_eq!(store.items()[0].source_id, "n2");

        // Removed and deliberately imported again while a check is pending:
        // the pending result still may not touch the new copy. These checks
        // send nothing, so there is no request to wait for.
        refresh.settled = None;
        let ticket = refresh.begin(&store).unwrap();
        store.remove(Provider::Granola, "n2");
        refresh.forget(Provider::Granola, "n2");
        store.merge(
            Provider::Granola,
            &["n2".into()],
            vec![note("n2", EARLIER, "Imported again by choice.")],
        );
        let report = refresh.apply(&ticket, reply(), &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Cancelled);
        assert_eq!(store.items()[0].excerpt, "Imported again by choice.");

        // Removing everything ends the check and its findings.
        refresh.settled = None;
        let ticket = refresh.begin(&store).unwrap();
        store.remove_all_from(Provider::Granola);
        refresh.forget_all();
        let report = refresh.apply(&ticket, reply(), &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Cancelled);
        assert!(store.items().is_empty() && report.notes.is_empty());
        refresh.settled = None;
        assert_eq!(refresh.begin(&store).err(), Some(BeginError::NoNotes));
    }

    #[test]
    fn a_timed_out_check_does_not_go_on_to_its_second_batch() {
        let ids: Vec<String> = (0..20).map(|n| format!("n{n}")).collect();
        let pairs: Vec<(&str, u64)> = ids.iter().map(|id| (id.as_str(), EARLIER)).collect();
        let mut store = store(&pairs);
        let mut refresh = Refresh::default();
        let (mut source, asked) = provider(&[Some("garden-club")], vec![Ok(vec![]), Ok(vec![])]);
        let (started, has_started) = mpsc::channel();
        let (release, released) = mpsc::channel();
        source.gate = Some((started, released));
        let ticket = refresh.begin(&store).unwrap();
        let result = run(&ticket, source, Duration::from_millis(60));
        has_started.recv_timeout(LONG).unwrap();
        let report = refresh.apply(&ticket, result, &mut store, NOW);
        assert_eq!(report.status, CheckStatus::TimedOut);
        release.send(()).unwrap();
        wait_until_settled(&refresh);
        assert_eq!(
            asked.lock().unwrap().len(),
            1,
            "no request after the timeout"
        );
    }

    #[test]
    fn a_finding_does_not_carry_over_to_a_copy_imported_at_another_revision() {
        let mut store = store(&[("n1", EARLIER)]);
        let mut refresh = Refresh::default();
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(vec![note(
                "n1",
                EARLIER,
                "Robin will label the watering cans.",
            )])],
        );
        let report = check(&mut refresh, &mut store, source, NOW);
        assert_eq!(state(&report, "n1"), (Freshness::Current, None));
        assert_eq!(report.notes[0].revision, EARLIER);
        // A manual import of a newer revision is a copy no check has seen.
        store.merge(
            Provider::Granola,
            &["n1".into()],
            vec![note("n1", LATER, "Imported again by choice.")],
        );
        assert!(refresh.freshness(&store).is_empty());
    }

    #[test]
    fn twenty_notes_are_checked_in_two_requests_one_after_the_other() {
        let ids: Vec<String> = (0..20).map(|n| format!("n{n}")).collect();
        let pairs: Vec<(&str, u64)> = ids.iter().map(|id| (id.as_str(), EARLIER)).collect();
        let mut store = store(&pairs);
        let mut refresh = Refresh::default();
        let batch = |range: std::ops::Range<usize>| {
            Ok(ids[range]
                .iter()
                .map(|id| note(id, LATER, "A newer fictional revision."))
                .collect())
        };
        // The workspace changes only after the first batch was answered.
        let (source, asked) = provider(
            &[Some("garden-club"), Some("garden-club"), Some("allotment")],
            vec![batch(0..10), batch(10..20)],
        );
        let report = check(&mut refresh, &mut store, source, NOW);
        assert_eq!(report.status, CheckStatus::WorkspaceChanged);
        assert!(store.items().iter().all(|item| item.revision == EARLIER));
        let asked = asked.lock().unwrap().clone();
        assert_eq!(asked.len(), 2);
        assert!(asked.iter().all(|batch| batch.len() == BATCH));

        let (source, asked) = provider(&[Some("garden-club")], vec![batch(0..10), batch(10..20)]);
        let report = check(&mut refresh, &mut store, source, NOW);
        assert_eq!(report.status, CheckStatus::Checked);
        assert_eq!(asked.lock().unwrap().len(), 2);
        assert!(report
            .notes
            .iter()
            .all(|note| note.state == Freshness::Updated));
        assert_eq!(report.notes.len(), 20);
    }
}
