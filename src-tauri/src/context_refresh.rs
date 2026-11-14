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

use crate::context::{ContextItem, ContextStore, MergeOutcome, Provider, SourceError, Unconfirmed};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex, PoisonError,
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
    /// Identifiers from the last `fetch_available` that the provider itself
    /// reported as no longer available to this person. An omitted note is
    /// not one of these. No real adapter reports any.
    fn withdrawn(&mut self) -> Vec<String> {
        Vec::new()
    }
}

/// Why a kept copy could not be confirmed as the provider's latest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Unverified {
    /// The provider did not return the note. Not proof of deletion.
    Missing,
    /// The provider reported the note as no longer available to this
    /// person. The copy is kept but not used for reminders.
    Withdrawn,
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
    /// Every note of the check was imported again while it was pending,
    /// so nothing was left to check.
    Reimported,
    /// Every note of the check was removed while it was pending.
    Removed,
    /// While it was pending, some notes of the check were removed and the
    /// rest imported again.
    RemovedOrReimported,
    TimedOut,
    /// The provider's workspace identity was missing, before the first note
    /// request or after a later one; nothing from the check was applied.
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
    withdrawn: Vec<String>,
    workspace: String,
}

/// One started check. It carries the selection made at the start and the
/// flags that tie its result to the notebook state that started it.
pub struct Ticket {
    id: u64,
    selection: Vec<String>,
    /// The notebook's current selection for this check, which shrinks when
    /// a note is removed; shared so a removed note is not asked about.
    live: Live,
    /// Notes the provider reported as withdrawn in batches answered before
    /// the check failed or timed out.
    received_withdrawn: Live,
    workspace: Option<String>,
    cancelled: Arc<AtomicBool>,
    settled: Arc<AtomicBool>,
}

type Live = Arc<Mutex<Vec<String>>>;

fn live_ids(live: &Live) -> std::sync::MutexGuard<'_, Vec<String>> {
    live.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Current {
    id: u64,
    selection: Live,
    cancelled: Arc<AtomicBool>,
    /// Whether notes left the check because the person removed them or
    /// imported them again, so an emptied check can say which.
    removed: bool,
    reimported: bool,
}

/// Why a note left a pending check.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Left {
    Removed,
    Reimported,
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
    /// A check that ended because its notes were removed or imported
    /// again, and how to report it.
    ended: Option<(u64, CheckStatus)>,
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
        let live = Arc::new(Mutex::new(selection.clone()));
        self.current = Some(Current {
            id: self.next,
            selection: live.clone(),
            cancelled: cancelled.clone(),
            removed: false,
            reimported: false,
        });
        Ok(Ticket {
            id: self.next,
            selection,
            live,
            received_withdrawn: Live::default(),
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

    /// Disconnect ends the workspace binding and forgets which copies the
    /// retired connection confirmed. What it could not confirm stays, so a
    /// reminder keeps its warning and a withdrawn copy stays out of
    /// reminders until a later check or import.
    pub fn disconnect(&mut self) {
        self.stop();
        self.workspace = None;
        // What it confirmed is forgotten, including the time a copy that
        // has since become unconfirmed was last confirmed.
        self.notes
            .retain(|entry| entry.state == Freshness::NotVerified);
        for entry in &mut self.notes {
            entry.verified_at_ms = None;
        }
    }

    /// Merges an import the person asked for and ends the earlier finding
    /// about each note the provider actually returned in usable form at
    /// the kept revision or a newer one. An older, unreadable or absent
    /// reply leaves the finding, and with it any warning or withholding.
    pub fn merge_import(
        &mut self,
        store: &mut ContextStore,
        provider: Provider,
        selection: &[String],
        fetched: Vec<ContextItem>,
    ) -> MergeOutcome {
        let mut total = MergeOutcome::default();
        for item in fetched {
            let (id, revision) = (item.source_id.trim().to_string(), item.revision);
            let outcome = store.merge(provider, selection, vec![item]);
            let returned = outcome.added + outcome.updated == 1
                || (outcome.unchanged == 1
                    && store.items().iter().any(|kept| {
                        kept.provider == provider
                            && kept.source_id == id
                            && kept.revision == revision
                    }));
            if returned {
                self.leave(provider, &id, Left::Reimported);
            }
            total.added += outcome.added;
            total.updated += outcome.updated;
            total.unchanged += outcome.unchanged;
            total.over_limit += outcome.over_limit;
            total.rejected += outcome.rejected;
        }
        total
    }

    /// Kept notes that are held back from reminders, so the engine can
    /// remember that one of them already reminded in this session.
    pub fn withheld(&self, store: &ContextStore) -> Vec<ContextItem> {
        let eligible = self.eligible(store);
        store
            .items()
            .iter()
            .filter(|item| !eligible.iter().any(|(kept, _)| kept == *item))
            .cloned()
            .collect()
    }

    /// The notes a reminder may quote, with the warning it must carry.
    /// A copy the last check could not confirm stays eligible but says so.
    /// A copy whose access the provider reported as withdrawn is left out
    /// until a later check or import; it stays in the store and the panel.
    pub fn eligible(&self, store: &ContextStore) -> Vec<(ContextItem, Option<Unconfirmed>)> {
        store
            .items()
            .iter()
            .filter_map(|item| {
                let finding = self.notes.iter().find(|entry| {
                    item.provider == Provider::Granola
                        && entry.source_id == item.source_id
                        && entry.revision == item.revision
                        && entry.state == Freshness::NotVerified
                });
                match finding {
                    None => Some((item.clone(), None)),
                    Some(entry)
                        if matches!(
                            entry.reason,
                            Some(Unverified::Withdrawn | Unverified::Revoked)
                        ) =>
                    {
                        None
                    }
                    Some(entry) => Some((
                        item.clone(),
                        Some(Unconfirmed {
                            last_confirmed_ms: entry.verified_at_ms,
                        }),
                    )),
                }
            })
            .collect()
    }

    /// A removed note leaves the selection at once, so a pending result
    /// cannot touch a later copy with the same identifier.
    pub fn forget(&mut self, provider: Provider, source_id: &str) {
        self.leave(provider, source_id, Left::Removed);
    }

    fn leave(&mut self, provider: Provider, source_id: &str, why: Left) {
        if provider != Provider::Granola {
            return;
        }
        let source_id = source_id.trim();
        self.notes.retain(|entry| entry.source_id != source_id);
        let Some(current) = &mut self.current else {
            return;
        };
        let emptied = {
            let mut selection = live_ids(&current.selection);
            let before = selection.len();
            selection.retain(|id| id != source_id);
            if selection.len() != before {
                match why {
                    Left::Removed => current.removed = true,
                    Left::Reimported => current.reimported = true,
                }
            }
            selection.is_empty()
        };
        if emptied {
            self.end_emptied();
        }
    }

    /// Ends a check whose notes all left it, remembering how to report it.
    fn end_emptied(&mut self) {
        if let Some(current) = &self.current {
            let status = match (current.removed, current.reimported) {
                (true, true) => CheckStatus::RemovedOrReimported,
                (false, true) => CheckStatus::Reimported,
                _ => CheckStatus::Removed,
            };
            self.ended = Some((current.id, status));
        }
        self.stop();
    }

    pub fn forget_all(&mut self) {
        self.notes.clear();
        if let Some(current) = &mut self.current {
            current.removed = true;
            live_ids(&current.selection).clear();
        }
        self.end_emptied();
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
                let status = match self.ended.take_if(|(id, _)| *id == ticket.id) {
                    Some((_, status)) => status,
                    None => CheckStatus::Cancelled,
                };
                return self.report(status, None, false, store);
            }
        };
        let kept = |store: &ContextStore, id: &str| {
            store
                .items()
                .iter()
                .find(|item| item.provider == Provider::Granola && item.source_id == id)
                .map(|item| item.revision)
        };
        let selection: Vec<String> = live_ids(&current.selection)
            .iter()
            .filter(|id| kept(store, id).is_some())
            .cloned()
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
                // A provider failure or timeout does not undo what earlier
                // batches of this check reported as withdrawn. A workspace
                // that changed or could not be verified applies nothing
                // from the provider, withdrawals included.
                let binding_failed = matches!(
                    error,
                    CheckError::WorkspaceUnverified | CheckError::WorkspaceChanged
                );
                let withdrawn = if binding_failed {
                    vec![]
                } else {
                    live_ids(&ticket.received_withdrawn).clone()
                };
                for id in &selection {
                    if let Some(revision) = kept(store, id) {
                        let reason = if withdrawn.contains(id) {
                            Unverified::Withdrawn
                        } else {
                            reason
                        };
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
            if fetched
                .withdrawn
                .iter()
                .any(|withdrawn| withdrawn.trim() == id)
            {
                self.record(
                    id,
                    kept_revision,
                    Freshness::NotVerified,
                    Some(Unverified::Withdrawn),
                    None,
                );
                continue;
            }
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
            let same_copy = entry.revision == revision;
            entry.verified_at_ms = verified_at_ms.or(entry.verified_at_ms.filter(|_| same_copy));
            // A copy the provider reported as withdrawn stays withheld until
            // a check or import actually returns it; a later check that
            // merely fails or omits it says nothing new.
            let still_withheld = same_copy
                && state == Freshness::NotVerified
                && matches!(
                    entry.reason,
                    Some(Unverified::Withdrawn | Unverified::Revoked)
                );
            entry.revision = revision;
            entry.state = state;
            if !still_withheld {
                entry.reason = reason;
            }
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
    still_selected: &dyn Fn(&str) -> bool,
    received_withdrawn: &dyn Fn(&[String]),
    expected: Option<&str>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Fetched, CheckError> {
    // A check stopped before it began sends nothing at all.
    if cancelled() {
        return Err(CheckError::Cancelled);
    }
    // Fail closed before any note identifier leaves the device.
    let workspace = workspace_of(source)?;
    if expected.is_some_and(|expected| expected != workspace) {
        return Err(CheckError::WorkspaceChanged);
    }
    let mut items = Vec::new();
    let mut withdrawn = Vec::new();
    for batch in selection.chunks(BATCH) {
        if cancelled() {
            return Err(CheckError::Cancelled);
        }
        // A note removed since the check began is not asked about.
        let batch: Vec<String> = batch
            .iter()
            .filter(|id| still_selected(id))
            .cloned()
            .collect();
        if batch.is_empty() {
            continue;
        }
        items.extend(source.fetch_available(&batch).map_err(CheckError::Source)?);
        // Only what was asked about can be reported as withdrawn.
        let reported: Vec<String> = source
            .withdrawn()
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| batch.contains(id))
            .collect();
        if cancelled() {
            return Err(CheckError::Cancelled);
        }
        // A batch counts only once the workspace is confirmed again after
        // it: a withdrawal from a batch whose binding failed, or could not
        // be read, is never kept.
        if workspace_of(source)? != workspace {
            return Err(CheckError::WorkspaceChanged);
        }
        received_withdrawn(&reported);
        withdrawn.extend(reported);
    }
    Ok(Fetched {
        items,
        withdrawn,
        workspace,
    })
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
    let live = ticket.live.clone();
    let received = ticket.received_withdrawn.clone();
    let expected = ticket.workspace.clone();
    let cancelled = ticket.cancelled.clone();
    let settle = Settle(ticket.settled.clone());
    let spawned = std::thread::Builder::new()
        .name("granola-update-check".into())
        .spawn(move || {
            let settle = settle;
            let result = request(
                source.as_mut(),
                &selection,
                &|id| live_ids(&live).iter().any(|kept| kept == id),
                // Only what arrives before the check ends for the person.
                &|ids| {
                    if !cancelled.load(Ordering::Acquire) {
                        live_ids(&received).extend_from_slice(ids);
                    }
                },
                expected.as_deref(),
                &|| cancelled.load(Ordering::Acquire),
            );
            // The request has ended once the connection clone is dropped.
            // Mark that before handing over the result, so whoever receives
            // it can start the next check at once.
            drop(source);
            drop(settle);
            let _ = sender.send(result);
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
                // The check has ended for the person, so the worker must
                // not go on to another batch once the sent request returns.
                ticket.cancelled.store(true, Ordering::Release);
                return Err(CheckError::TimedOut);
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
        /// Which note request (0 for the first) the gate holds.
        hold_at: usize,
        /// Identifiers this provider reports as no longer available.
        withdrawn: Vec<String>,
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
            let call = {
                let mut asked = self.asked.lock().unwrap();
                asked.push(selection.to_vec());
                asked.len() - 1
            };
            if let Some((started, release)) = self.gate.take_if(|_| call == self.hold_at) {
                started.send(()).unwrap();
                release.recv_timeout(LONG).unwrap();
            }
            self.replies.pop_front().unwrap_or(Ok(vec![]))
        }
        fn withdrawn(&mut self) -> Vec<String> {
            self.withdrawn.clone()
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
                hold_at: 0,
                withdrawn: vec![],
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
        // Disconnecting ends that binding. The copy stays marked as not
        // confirmed until a later check says otherwise.
        refresh.disconnect();
        let kept = refresh.freshness(&store);
        assert_eq!(
            (kept[0].state, kept[0].reason),
            (Freshness::NotVerified, Some(Unverified::Workspace))
        );
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
            let mut store = store(&[("n1", EARLIER)]);
            let mut refresh = Refresh::default();
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
            withdrawn: vec![],
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
        // What the retired connection confirmed is forgotten; the note it
        // did not return stays marked.
        assert_eq!(report.notes.len(), 1);
        assert_eq!(
            state(&report, "n1"),
            (Freshness::NotVerified, Some(Unverified::Missing))
        );
        // Disconnect keeps the imported copies exactly as they were.
        assert_eq!(store.items().len(), 2);
        assert!(store.items().iter().all(|item| item.revision == EARLIER));
        // A check that starts after reconnecting is a new one; the retired
        // ticket cannot stand in for it.
        wait_until_settled(&refresh);
        let replacement = refresh.begin(&store).unwrap();
        let late = Ok(Fetched {
            items: vec![note("n1", LATER, "A late fictional reply.")],
            withdrawn: vec![],
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
                withdrawn: vec![],
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
        assert_eq!(report.status, CheckStatus::Removed);
        assert_eq!(store.items()[0].excerpt, "Imported again by choice.");

        // Removing everything ends the check and its findings.
        refresh.settled = None;
        let ticket = refresh.begin(&store).unwrap();
        store.remove_all_from(Provider::Granola);
        refresh.forget_all();
        let report = refresh.apply(&ticket, reply(), &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Removed);
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
        // The held reply arrives before the notebook has applied the
        // timeout; the worker must already know the check is over.
        release.send(()).unwrap();
        wait_until_settled(&refresh);
        assert_eq!(
            asked.lock().unwrap().len(),
            1,
            "no request after the timeout"
        );
        let report = refresh.apply(&ticket, result, &mut store, NOW);
        assert_eq!(report.status, CheckStatus::TimedOut);
    }

    #[test]
    fn a_note_removed_during_the_first_batch_is_not_requested_in_the_second() {
        let ids: Vec<String> = (0..20).map(|n| format!("n{n}")).collect();
        let pairs: Vec<(&str, u64)> = ids.iter().map(|id| (id.as_str(), EARLIER)).collect();
        let mut store = store(&pairs);
        let mut refresh = Refresh::default();
        let (source, has_started, release) = held(vec![Ok(vec![]), Ok(vec![])]);
        let asked = source.asked.clone();
        let ticket = refresh.begin(&store).unwrap();
        let result = std::thread::scope(|scope| {
            let waiting = scope.spawn(|| run(&ticket, source, LONG));
            has_started.recv_timeout(LONG).unwrap();
            assert!(store.remove(Provider::Granola, "n15"));
            refresh.forget(Provider::Granola, "n15");
            release.send(()).unwrap();
            waiting.join().unwrap()
        });
        let asked = asked.lock().unwrap().clone();
        assert_eq!(asked.len(), 2);
        assert_eq!(asked[1].len(), 9);
        assert!(!asked[1].contains(&"n15".to_string()));
        let report = refresh.apply(&ticket, result, &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Checked);
        assert_eq!(report.notes.len(), 19);
    }

    #[test]
    fn a_check_stopped_before_its_worker_starts_asks_for_nothing() {
        struct Counting(Box<Fictional>, Arc<Mutex<u32>>);
        impl RefreshSource for Counting {
            fn binding_supported(&self) -> bool {
                true
            }
            fn workspace(&mut self) -> Result<Option<String>, SourceError> {
                *self.1.lock().unwrap() += 1;
                self.0.workspace()
            }
            fn fetch_available(
                &mut self,
                selection: &[String],
            ) -> Result<Vec<ContextItem>, SourceError> {
                self.0.fetch_available(selection)
            }
        }
        let store = store(&[("n1", EARLIER)]);
        let mut refresh = Refresh::default();
        let (source, asked) = provider(&[Some("garden-club")], vec![]);
        let workspaces = Arc::new(Mutex::new(0));
        let ticket = refresh.begin(&store).unwrap();
        refresh.stop();
        let source = Box::new(Counting(source, workspaces.clone()));
        assert_eq!(run(&ticket, source, LONG), Err(CheckError::Cancelled));
        wait_until_settled(&refresh);
        assert_eq!(*workspaces.lock().unwrap(), 0, "no workspace request");
        assert!(asked.lock().unwrap().is_empty());
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

    /// Three fictional notes with titles a spoken line can name.
    fn titled_store() -> ContextStore {
        let mut store = ContextStore::default();
        let notes: Vec<ContextItem> = [
            ("n1", "Garden welcome guide"),
            ("n2", "Compost rota handover"),
            ("n3", "Seed swap budget"),
        ]
        .into_iter()
        .map(|(id, title)| ContextItem {
            title: title.into(),
            ..note(id, EARLIER, "Robin will label the watering cans.")
        })
        .collect();
        let ids: Vec<String> = notes.iter().map(|note| note.source_id.clone()).collect();
        store.merge(Provider::Granola, &ids, notes);
        store
    }

    fn unchanged(store: &ContextStore, ids: &[&str]) -> Vec<ContextItem> {
        store
            .items()
            .iter()
            .filter(|item| ids.contains(&item.source_id.as_str()))
            .cloned()
            .collect()
    }

    /// The reminder, if any, that a new live session raises for one line.
    fn reminder(
        refresh: &Refresh,
        store: &ContextStore,
        line: &str,
    ) -> Option<crate::engine::NoteRef> {
        let mut engine = crate::engine::Engine::live();
        engine.start().unwrap();
        engine.advance(10_000);
        engine.set_prior_notes(refresh.eligible(store), refresh.withheld(store));
        engine
            .ingest(
                engine.session(),
                crate::engine::Segment {
                    id: "w1".into(),
                    at_ms: 9_000,
                    speaker: "Speaker 1".into(),
                    text: line.into(),
                },
            )
            .unwrap();
        engine.state.cue.and_then(|cue| cue.note)
    }

    const GUIDE: &str = "Let's get the welcome guide sorted before the garden day.";
    const COMPOST: &str = "Let's get the compost rota handover sorted today.";

    #[test]
    fn an_unconfirmed_copy_reminds_with_a_warning_and_a_withdrawn_copy_does_not_remind() {
        let mut store = titled_store();
        let mut refresh = Refresh::default();
        // Before any check, a reminder carries no warning.
        assert_eq!(reminder(&refresh, &store, GUIDE).unwrap().unconfirmed, None);
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(unchanged(&store, &["n1", "n2", "n3"]))],
        );
        check(&mut refresh, &mut store, source, NOW);
        assert_eq!(reminder(&refresh, &store, GUIDE).unwrap().unconfirmed, None);
        assert!(reminder(&refresh, &store, COMPOST).is_some());

        // A later check: one note is not returned, one is reported as
        // withdrawn, one is unchanged.
        let (mut source, _) =
            provider(&[Some("garden-club")], vec![Ok(unchanged(&store, &["n3"]))]);
        source.withdrawn = vec!["n2".into(), "never-selected".into()];
        let report = check(&mut refresh, &mut store, source, NOW + 60_000);
        assert_eq!(
            state(&report, "n1"),
            (Freshness::NotVerified, Some(Unverified::Missing))
        );
        assert_eq!(
            state(&report, "n2"),
            (Freshness::NotVerified, Some(Unverified::Withdrawn))
        );
        assert_eq!(report.notes.len(), 3);
        // Both copies are kept; neither is treated as deleted.
        assert_eq!(store.items().len(), 3);

        let warned = reminder(&refresh, &store, GUIDE).unwrap();
        assert_eq!(
            warned.unconfirmed,
            Some(Unconfirmed {
                last_confirmed_ms: Some(NOW)
            })
        );
        assert_eq!(
            serde_json::to_value(&warned).unwrap()["unconfirmed"]["lastConfirmedMs"],
            NOW
        );
        assert_eq!(reminder(&refresh, &store, COMPOST), None);

        // A check that cannot reach the provider says nothing new about
        // the withdrawn copy, and disconnecting does not restore it.
        let (source, _) = provider(&[Some("garden-club")], vec![Err(SourceError::Interrupted)]);
        let report = check(&mut refresh, &mut store, source, NOW + 90_000);
        assert_eq!(
            state(&report, "n2"),
            (Freshness::NotVerified, Some(Unverified::Withdrawn))
        );
        assert_eq!(reminder(&refresh, &store, COMPOST), None);
        refresh.disconnect();
        assert_eq!(reminder(&refresh, &store, COMPOST), None);
        assert!(reminder(&refresh, &store, GUIDE)
            .unwrap()
            .unconfirmed
            .is_some());

        // A later check that returns both notes restores plain reminders.
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(unchanged(&store, &["n1", "n2", "n3"]))],
        );
        check(&mut refresh, &mut store, source, NOW + 120_000);
        assert_eq!(reminder(&refresh, &store, GUIDE).unwrap().unconfirmed, None);
        let restored = reminder(&refresh, &store, COMPOST).unwrap();
        assert_eq!(restored.unconfirmed, None);
        assert!(serde_json::to_value(&restored)
            .unwrap()
            .get("unconfirmed")
            .is_none());
    }

    #[test]
    fn withdrawn_access_keeps_every_copy_out_of_reminders_until_it_is_imported_again() {
        let mut store = titled_store();
        // A file note that shares an identifier is a different note.
        let mut file = note("n2", 1, "From a fictional file.");
        file.provider = Provider::File;
        file.title = "Compost rota handover".into();
        let mut refresh = Refresh::default();
        let (source, _) = provider(&[Some("garden-club")], vec![Err(SourceError::Revoked)]);
        let report = check(&mut refresh, &mut store, source, NOW);
        assert_eq!(report.status, CheckStatus::Revoked);
        assert_eq!(store.items().len(), 3);
        assert!(refresh.eligible(&store).is_empty());
        assert_eq!(reminder(&refresh, &store, GUIDE), None);
        store.merge(Provider::File, &["n2".into()], vec![file]);
        assert_eq!(
            reminder(&refresh, &store, COMPOST).unwrap().provider,
            "file"
        );
        store.remove(Provider::File, "n2");

        // A later check that fails, or that simply does not return the
        // notes, says nothing new: they stay out of reminders.
        for reply in [Err(SourceError::Interrupted), Ok(vec![])] {
            let (source, _) = provider(&[Some("garden-club")], vec![reply]);
            check(&mut refresh, &mut store, source, NOW + 60_000);
            assert!(refresh.eligible(&store).is_empty());
        }
        refresh.disconnect();
        assert!(refresh.eligible(&store).is_empty());

        // Importing again restores a note only if Granola returns it in
        // usable form at the kept revision or a newer one.
        let ids: Vec<String> = ["n1", "n2", "n3"].map(String::from).into();
        let mut older = unchanged(&store, &["n1"]);
        older[0].revision = EARLIER - 1;
        let mut unreadable = unchanged(&store, &["n2"]);
        unreadable[0].excerpt = " ".into();
        let outcome = refresh.merge_import(
            &mut store,
            Provider::Granola,
            &ids,
            older.into_iter().chain(unreadable).collect(),
        );
        assert_eq!((outcome.unchanged, outcome.rejected), (1, 1));
        assert!(refresh.eligible(&store).is_empty());

        let again = unchanged(&store, &["n1"]);
        let mut newer = unchanged(&store, &["n3"]);
        newer[0].revision = LATER;
        let outcome = refresh.merge_import(
            &mut store,
            Provider::Granola,
            &ids,
            again.into_iter().chain(newer).collect(),
        );
        assert_eq!((outcome.unchanged, outcome.updated), (1, 1));
        assert_eq!(reminder(&refresh, &store, GUIDE).unwrap().unconfirmed, None);
        assert_eq!(refresh.eligible(&store).len(), 2);
        assert_eq!(reminder(&refresh, &store, COMPOST), None);
    }

    #[test]
    fn a_copy_never_confirmed_says_so_and_other_failures_keep_it_eligible() {
        for error in [
            SourceError::Interrupted,
            SourceError::Expired,
            SourceError::RateLimited {
                retry_after: Duration::from_secs(7),
            },
            SourceError::UnsupportedFormat,
        ] {
            let mut store = titled_store();
            let mut refresh = Refresh::default();
            let (source, _) = provider(&[Some("garden-club")], vec![Err(error)]);
            check(&mut refresh, &mut store, source, NOW);
            assert_eq!(
                reminder(&refresh, &store, GUIDE).unwrap().unconfirmed,
                Some(Unconfirmed {
                    last_confirmed_ms: None
                })
            );
        }
        // Older, undated and unreadable replies keep the last confirmed time.
        let mut store = titled_store();
        let mut refresh = Refresh::default();
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(unchanged(&store, &["n1", "n2", "n3"]))],
        );
        check(&mut refresh, &mut store, source, NOW);
        let mut replies = unchanged(&store, &["n1", "n2", "n3"]);
        replies[0].revision = EARLIER - 1;
        replies[1].revision = 1;
        replies[2].revision = LATER;
        replies[2].source_date = String::new();
        let (source, _) = provider(&[Some("garden-club")], vec![Ok(replies)]);
        check(&mut refresh, &mut store, source, NOW + 60_000);
        let eligible = refresh.eligible(&store);
        assert_eq!(eligible.len(), 3);
        assert!(eligible.iter().all(|(_, warning)| *warning
            == Some(Unconfirmed {
                last_confirmed_ms: Some(NOW)
            })));
    }

    #[test]
    fn a_check_whose_notes_were_all_imported_again_says_so_instead_of_stopped() {
        let mut store = store(&[("n1", EARLIER), ("n2", EARLIER)]);
        let mut refresh = Refresh::default();
        let ids: Vec<String> = vec!["n1".into(), "n2".into()];
        let late = || {
            Ok(Fetched {
                items: vec![note("n1", LATER, "A late fictional reply.")],
                withdrawn: vec![],
                workspace: "garden-club".into(),
            })
        };
        // Only one of the two is imported again: the check goes on.
        let ticket = refresh.begin(&store).unwrap();
        let again = store.items()[..1].to_vec();
        refresh.merge_import(&mut store, Provider::Granola, &ids, again);
        let report = refresh.apply(&ticket, late(), &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Checked);
        assert_eq!(store.items()[0].revision, EARLIER, "n1 left the check");

        // Both are imported again: nothing is left to check.
        refresh.settled = None;
        let ticket = refresh.begin(&store).unwrap();
        let again = store.items().to_vec();
        refresh.merge_import(&mut store, Provider::Granola, &ids, again);
        let report = refresh.apply(&ticket, late(), &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Reimported);
        assert_eq!(store.items()[0].revision, EARLIER);

        // One removed and the other imported again, in either order: the
        // report names both, not only the import.
        for remove_first in [true, false] {
            let mut store = store_of(&[("n1", EARLIER), ("n2", EARLIER)]);
            refresh.settled = None;
            let ticket = refresh.begin(&store).unwrap();
            let again = store.items()[1..].to_vec();
            if remove_first {
                store.remove(Provider::Granola, "n1");
                refresh.forget(Provider::Granola, "n1");
                refresh.merge_import(&mut store, Provider::Granola, &ids, again);
            } else {
                refresh.merge_import(&mut store, Provider::Granola, &ids, again);
                store.remove(Provider::Granola, "n1");
                refresh.forget(Provider::Granola, "n1");
            }
            let report = refresh.apply(&ticket, late(), &mut store, NOW);
            assert_eq!(report.status, CheckStatus::RemovedOrReimported);
            assert_eq!(store.items()[0].revision, EARLIER);
        }

        // Stop is still reported as a stop.
        refresh.settled = None;
        let ticket = refresh.begin(&store).unwrap();
        refresh.stop();
        let report = refresh.apply(&ticket, late(), &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Cancelled);
    }

    fn store_of(notes: &[(&str, u64)]) -> ContextStore {
        store(notes)
    }

    /// Twenty fictional notes, so a check needs two batches of ten.
    fn twenty() -> (ContextStore, Vec<String>) {
        let ids: Vec<String> = (0..20).map(|n| format!("n{n}")).collect();
        let pairs: Vec<(&str, u64)> = ids.iter().map(|id| (id.as_str(), EARLIER)).collect();
        (store(&pairs), ids)
    }

    #[test]
    fn a_withdrawal_reported_before_a_later_batch_fails_is_kept() {
        for second in [
            Err(SourceError::Interrupted),
            Err(SourceError::Expired),
            Err(SourceError::RateLimited {
                retry_after: Duration::from_secs(7),
            }),
        ] {
            let (mut store, ids) = twenty();
            let mut refresh = Refresh::default();
            let (mut source, asked) = provider(&[Some("garden-club")], vec![Ok(vec![]), second]);
            source.withdrawn = vec!["n1".into()];
            let report = check(&mut refresh, &mut store, source, NOW);
            assert_eq!(asked.lock().unwrap().len(), 2);
            assert_ne!(report.status, CheckStatus::Checked);
            assert_eq!(
                state(&report, "n1"),
                (Freshness::NotVerified, Some(Unverified::Withdrawn))
            );
            let eligible = refresh.eligible(&store);
            assert_eq!(eligible.len(), 19);
            assert!(!eligible.iter().any(|(item, _)| item.source_id == "n1"));
            assert!(eligible.iter().all(|(_, warning)| warning.is_some()));
            assert_eq!(store.items().len(), ids.len(), "nothing is deleted");
        }
    }

    #[test]
    fn a_withdrawal_reported_before_a_timeout_is_kept() {
        let (mut store, _) = twenty();
        let mut refresh = Refresh::default();
        let (mut source, has_started, release) = held(vec![Ok(vec![]), Ok(vec![])]);
        source.withdrawn = vec!["n1".into()];
        source.hold_at = 1;
        let ticket = refresh.begin(&store).unwrap();
        let result = run(&ticket, source, Duration::from_millis(200));
        assert_eq!(result, Err(CheckError::TimedOut));
        has_started.recv_timeout(LONG).unwrap();
        let report = refresh.apply(&ticket, result, &mut store, NOW);
        release.send(()).unwrap();
        assert_eq!(report.status, CheckStatus::TimedOut);
        assert_eq!(
            state(&report, "n1"),
            (Freshness::NotVerified, Some(Unverified::Withdrawn))
        );
        assert_eq!(
            state(&report, "n15"),
            (Freshness::NotVerified, Some(Unverified::TimedOut))
        );
        assert!(!refresh
            .eligible(&store)
            .iter()
            .any(|(item, _)| item.source_id == "n1"));
    }

    #[test]
    fn a_failed_workspace_binding_applies_no_withdrawal() {
        for later in [Some("allotment"), None] {
            let (mut store, _) = twenty();
            let mut refresh = Refresh::default();
            // The binding holds for batch 1, then changes or disappears.
            let (mut source, asked) =
                provider(&[Some("garden-club"), later], vec![Ok(vec![]), Ok(vec![])]);
            source.withdrawn = vec!["n1".into()];
            let report = check(&mut refresh, &mut store, source, NOW);
            assert_eq!(asked.lock().unwrap().len(), 1);
            assert!(matches!(
                report.status,
                CheckStatus::WorkspaceChanged | CheckStatus::WorkspaceUnverified
            ));
            assert_eq!(
                state(&report, "n1"),
                (Freshness::NotVerified, Some(Unverified::Workspace))
            );
            // Still a reminder source, with the ordinary warning.
            assert!(refresh
                .eligible(&store)
                .iter()
                .any(|(item, warning)| item.source_id == "n1" && warning.is_some()));
        }
    }

    #[test]
    fn a_withdrawal_from_a_batch_whose_workspace_cannot_be_reread_is_not_kept() {
        /// Answers the first workspace read, then fails every later one.
        struct Unreadable(Box<Fictional>, usize);
        impl RefreshSource for Unreadable {
            fn binding_supported(&self) -> bool {
                true
            }
            fn workspace(&mut self) -> Result<Option<String>, SourceError> {
                self.1 += 1;
                if self.1 == 1 {
                    self.0.workspace()
                } else {
                    Err(SourceError::Interrupted)
                }
            }
            fn fetch_available(
                &mut self,
                selection: &[String],
            ) -> Result<Vec<ContextItem>, SourceError> {
                self.0.fetch_available(selection)
            }
            fn withdrawn(&mut self) -> Vec<String> {
                self.0.withdrawn()
            }
        }
        let mut store = titled_store();
        let mut refresh = Refresh::default();
        let (mut source, _) = provider(&[Some("garden-club")], vec![Ok(vec![])]);
        source.withdrawn = vec!["n1".into()];
        let ticket = refresh.begin(&store).unwrap();
        let result = run(&ticket, Box::new(Unreadable(source, 0)), LONG);
        let report = refresh.apply(&ticket, result, &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Unavailable);
        assert_eq!(
            state(&report, "n1"),
            (Freshness::NotVerified, Some(Unverified::Unavailable))
        );
        assert_eq!(refresh.eligible(&store).len(), 3);
    }

    #[test]
    fn a_withdrawal_is_not_kept_when_the_check_times_out_during_the_workspace_read() {
        /// Holds the workspace read that follows the first note request.
        struct SlowRead(Box<Fictional>, usize, Option<Gate>);
        impl RefreshSource for SlowRead {
            fn binding_supported(&self) -> bool {
                true
            }
            fn workspace(&mut self) -> Result<Option<String>, SourceError> {
                self.1 += 1;
                if self.1 == 2 {
                    if let Some((started, release)) = self.2.take() {
                        started.send(()).unwrap();
                        release.recv_timeout(LONG).unwrap();
                    }
                }
                self.0.workspace()
            }
            fn fetch_available(
                &mut self,
                selection: &[String],
            ) -> Result<Vec<ContextItem>, SourceError> {
                self.0.fetch_available(selection)
            }
            fn withdrawn(&mut self) -> Vec<String> {
                self.0.withdrawn()
            }
        }
        let mut store = titled_store();
        let mut refresh = Refresh::default();
        let (mut source, _) = provider(&[Some("garden-club")], vec![Ok(vec![])]);
        source.withdrawn = vec!["n1".into()];
        let (started, has_started) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let slow = SlowRead(source, 0, Some((started, released)));
        let ticket = refresh.begin(&store).unwrap();
        let result = run(&ticket, Box::new(slow), Duration::from_millis(200));
        assert_eq!(result, Err(CheckError::TimedOut));
        has_started.recv_timeout(LONG).unwrap();
        let report = refresh.apply(&ticket, result, &mut store, NOW);
        release.send(()).unwrap();
        wait_until_settled(&refresh);
        assert_eq!(
            state(&report, "n1"),
            (Freshness::NotVerified, Some(Unverified::TimedOut))
        );
        assert_eq!(refresh.eligible(&store).len(), 3);
    }

    #[test]
    fn withdrawn_access_holds_back_only_the_notes_the_check_covered() {
        let mut store = titled_store();
        let mut refresh = Refresh::default();
        let (source, has_started, release) = held(vec![Err(SourceError::Revoked)]);
        let ticket = refresh.begin(&store).unwrap();
        let result = std::thread::scope(|scope| {
            let waiting = scope.spawn(|| run(&ticket, source, LONG));
            has_started.recv_timeout(LONG).unwrap();
            // While the check is pending: n2 is imported again and a new
            // note n4 is imported for the first time.
            let ids: Vec<String> = ["n2", "n4"].map(String::from).into();
            let mut fresh = unchanged(&store, &["n2"]);
            fresh.push(ContextItem {
                title: "Tool shed inventory".into(),
                ..note("n4", EARLIER, "Robin will label the watering cans.")
            });
            refresh.merge_import(&mut store, Provider::Granola, &ids, fresh);
            release.send(()).unwrap();
            waiting.join().unwrap()
        });
        let report = refresh.apply(&ticket, result, &mut store, NOW);
        assert_eq!(report.status, CheckStatus::Revoked);
        let eligible: Vec<String> = refresh
            .eligible(&store)
            .into_iter()
            .map(|(item, warning)| {
                assert!(warning.is_none(), "the import is the newer evidence");
                item.source_id
            })
            .collect();
        assert_eq!(eligible, ["n2", "n4"]);
        assert_eq!(store.items().len(), 4);
    }

    #[test]
    fn disconnecting_forgets_every_confirmation_time() {
        let mut store = titled_store();
        let mut refresh = Refresh::default();
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(unchanged(&store, &["n1", "n2", "n3"]))],
        );
        check(&mut refresh, &mut store, source, NOW);
        // n2 becomes unconfirmed later and keeps the earlier time.
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(unchanged(&store, &["n1", "n3"]))],
        );
        let report = check(&mut refresh, &mut store, source, NOW + 60_000);
        let n2 = report.notes.iter().find(|note| note.source_id == "n2");
        assert_eq!(n2.unwrap().verified_at_ms, Some(NOW));

        refresh.disconnect();
        let kept = refresh.freshness(&store);
        assert_eq!(kept.len(), 1, "only what could not be confirmed stays");
        assert_eq!(
            (kept[0].state, kept[0].reason, kept[0].verified_at_ms),
            (Freshness::NotVerified, Some(Unverified::Missing), None)
        );
        // After reconnecting, a failed check gives every note the same
        // history: none has a confirmation on record.
        let (source, _) = provider(&[Some("allotment")], vec![Err(SourceError::Interrupted)]);
        check(&mut refresh, &mut store, source, NOW + 120_000);
        let warnings: Vec<_> = refresh
            .eligible(&store)
            .into_iter()
            .map(|(_, warning)| warning)
            .collect();
        assert_eq!(
            warnings,
            vec![
                Some(Unconfirmed {
                    last_confirmed_ms: None
                });
                3
            ]
        );
    }

    fn say(engine: &mut crate::engine::Engine, id: &str, at_ms: u64, text: &str) {
        engine
            .ingest(
                engine.session(),
                crate::engine::Segment {
                    id: id.into(),
                    at_ms,
                    speaker: "Speaker 1".into(),
                    text: text.into(),
                },
            )
            .unwrap();
    }

    fn sync(engine: &mut crate::engine::Engine, refresh: &Refresh, store: &ContextStore) {
        engine.set_prior_notes(refresh.eligible(store), refresh.withheld(store));
    }

    #[test]
    fn a_failed_check_keeps_a_held_reminder_and_updates_its_warning_in_place() {
        let mut store = titled_store();
        let mut refresh = Refresh::default();
        let mut engine = crate::engine::Engine::live();
        engine.start().unwrap();
        engine.advance(10_000);
        sync(&mut engine, &refresh, &store);
        say(&mut engine, "w1", 9_000, GUIDE);
        let id = engine.state.cue.as_ref().unwrap().id.clone();
        engine.inspect_cue(&id, true).unwrap();
        let warning = |engine: &crate::engine::Engine| {
            let cue = engine.state.cue.as_ref().expect("the reminder stays");
            assert!(cue.held && cue.expanded && cue.id == id);
            assert_eq!(cue.question, "Garden welcome guide");
            cue.note.as_ref().unwrap().unconfirmed
        };
        assert_eq!(warning(&engine), None);

        // Offline: the reminder stays open and gains the warning.
        let (source, _) = provider(&[Some("garden-club")], vec![Err(SourceError::Interrupted)]);
        check(&mut refresh, &mut store, source, NOW);
        let before = engine.state.revision;
        sync(&mut engine, &refresh, &store);
        assert_eq!(
            warning(&engine),
            Some(Unconfirmed {
                last_confirmed_ms: None
            })
        );
        assert!(engine.state.revision > before, "both windows are told");

        // A confirming check removes the warning, again in place; a later
        // omission brings it back with the confirmation time.
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(unchanged(&store, &["n1", "n2", "n3"]))],
        );
        check(&mut refresh, &mut store, source, NOW);
        sync(&mut engine, &refresh, &store);
        assert_eq!(warning(&engine), None);
        let (source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(unchanged(&store, &["n2", "n3"]))],
        );
        check(&mut refresh, &mut store, source, NOW + 60_000);
        sync(&mut engine, &refresh, &store);
        assert_eq!(
            warning(&engine),
            Some(Unconfirmed {
                last_confirmed_ms: Some(NOW)
            })
        );

        // A withdrawal still withdraws the reminder, held or not.
        let (mut source, _) = provider(
            &[Some("garden-club")],
            vec![Ok(unchanged(&store, &["n2", "n3"]))],
        );
        source.withdrawn = vec!["n1".into()];
        check(&mut refresh, &mut store, source, NOW + 120_000);
        sync(&mut engine, &refresh, &store);
        assert!(engine.state.cue.is_none());
    }

    #[test]
    fn a_restored_note_reminds_again_only_as_a_newer_revision() {
        for newer in [false, true] {
            let mut store = titled_store();
            let mut refresh = Refresh::default();
            let mut engine = crate::engine::Engine::live();
            engine.start().unwrap();
            engine.advance(10_000);
            sync(&mut engine, &refresh, &store);
            say(&mut engine, "w1", 9_000, GUIDE);
            let id = engine.state.cue.as_ref().unwrap().id.clone();
            engine
                .respond(&id, crate::engine::Response::Dismiss)
                .unwrap();

            // Withdrawn, then returned by a later check.
            let (mut source, _) = provider(
                &[Some("garden-club")],
                vec![Ok(unchanged(&store, &["n2", "n3"]))],
            );
            source.withdrawn = vec!["n1".into()];
            check(&mut refresh, &mut store, source, NOW);
            sync(&mut engine, &refresh, &store);
            let mut returned = unchanged(&store, &["n1", "n2", "n3"]);
            if newer {
                returned[0].revision = LATER;
                returned[0].excerpt = "Robin moved the open day to Sunday.".into();
            }
            let (source, _) = provider(&[Some("garden-club")], vec![Ok(returned)]);
            check(&mut refresh, &mut store, source, NOW + 60_000);
            sync(&mut engine, &refresh, &store);
            assert_eq!(refresh.eligible(&store).len(), 3);

            engine.advance(120_000);
            say(&mut engine, "w2", 129_000, GUIDE);
            let reminded = engine.state.cue.as_ref().and_then(|cue| cue.note.as_ref());
            assert_eq!(
                reminded.is_some(),
                newer,
                "only a newer revision than the one that reminded may remind again"
            );
            if newer {
                assert!(engine
                    .state
                    .cue
                    .as_ref()
                    .unwrap()
                    .evidence
                    .contains("Sunday"));
            }
        }
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
