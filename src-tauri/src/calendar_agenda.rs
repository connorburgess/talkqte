//! Local agenda projection and refresh lifecycle; no OS, network or file access.
use crate::calendar::{sanitize_title, PermissionStatus};
use chrono::{DateTime, Days, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

pub const MAX_EVENTS: usize = 250;
pub const MAX_CALENDARS: usize = 100;
pub const MAX_ID_BYTES: usize = 512;
pub const POLL: Duration = Duration::from_secs(300);
pub const STALE_AFTER: Duration = Duration::from_secs(600);
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
const READ_ERROR: &str = "Could not refresh Apple Calendar. Try again.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Horizon {
    pub today: String,
    pub timezone: String,
    pub start_date: String,
    pub end_date: String,
    pub start: i64,
    /// Exclusive local midnight after day +14.
    pub end: i64,
}
impl Horizon {
    pub fn utc(now: i64) -> Self {
        let date = DateTime::<Utc>::from_timestamp(now, 0)
            .unwrap_or_default()
            .date_naive();
        let start = date.checked_sub_days(Days::new(1)).unwrap_or(date);
        let end = date.checked_add_days(Days::new(14)).unwrap_or(date);
        let exclusive = date.checked_add_days(Days::new(15)).unwrap_or(date);
        Self {
            today: date.to_string(),
            timezone: "UTC".into(),
            start_date: start.to_string(),
            end_date: end.to_string(),
            start: start.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp(),
            end: exclusive
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp(),
        }
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_BYTES && !id.chars().any(char::is_control)
}
pub fn included_ids(ids: Vec<String>) -> Result<Vec<String>, &'static str> {
    if ids.len() > MAX_CALENDARS || ids.iter().any(|id| !valid_id(id)) {
        return Err("Choose up to 100 valid calendars.");
    }
    let mut unique = ids;
    unique.sort();
    unique.dedup();
    // Leave room in the 64 KiB settings file for other bounded preferences;
    // JSON escaping can otherwise double a valid opaque ID's byte length.
    if serde_json::to_vec(&unique).map_or(true, |value| value.len() > 32 * 1024) {
        return Err("The calendar selection is too large.");
    }
    Ok(unique)
}
/// Malformed persisted filters fail closed. Missing/null intentionally means all.
pub fn parse_ids(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    match value {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => Some(
            serde_json::from_value(value.clone())
                .ok()
                .and_then(|ids| included_ids(ids).ok())
                .unwrap_or_default(),
        ),
    }
}
pub fn included(ids: Option<&[String]>, id: &str) -> bool {
    ids.is_none_or(|ids| ids.iter().any(|kept| kept == id))
}
fn short(raw: &str) -> String {
    sanitize_title(raw).chars().take(60).collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSummary {
    pub id: String,
    pub title: String,
    pub source_label: String,
    pub included: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub occurrence_key: String,
    pub title: String,
    pub calendar_id: String,
    pub calendar_title: String,
    pub is_all_day: bool,
    pub local_date: String,
    pub end_local_date: String,
    pub start_epoch_s: i64,
    pub end_epoch_s: i64,
    pub has_meeting_link: bool,
}
impl Event {
    pub fn key(calendar: &str, id: &str, start: i64, all_day_date: Option<&str>) -> String {
        let mut hash = Sha256::new();
        for part in [
            calendar,
            id,
            &all_day_date
                .map(str::to_owned)
                .unwrap_or_else(|| start.to_string()),
        ] {
            hash.update(part.len().to_be_bytes());
            hash.update(part.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }
}
#[derive(Clone, Debug, Default)]
pub struct Batch {
    pub calendars: Vec<CalendarSummary>,
    pub events: Vec<Event>,
    pub truncated: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadError {
    Unavailable,
    Failed,
    Cancelled,
}

pub fn normalize(mut batch: Batch, horizon: &Horizon, ids: Option<&[String]>) -> Batch {
    let mut seen = std::collections::HashSet::new();
    batch
        .calendars
        .retain(|c| valid_id(&c.id) && seen.insert(c.id.clone()));
    batch.truncated |= batch.calendars.len() > MAX_CALENDARS;
    batch.calendars.truncate(MAX_CALENDARS);
    for c in &mut batch.calendars {
        c.title = short(&c.title);
        c.source_label = short(&c.source_label);
        c.included = included(ids, &c.id);
    }
    seen.clear();
    batch.events.retain(|e| {
        e.end_epoch_s > e.start_epoch_s
            && e.start_epoch_s < horizon.end
            && e.end_epoch_s > horizon.start
            && e.occurrence_key.len() == 64
            && e.occurrence_key.bytes().all(|c| c.is_ascii_hexdigit())
            && batch
                .calendars
                .iter()
                .any(|c| c.id == e.calendar_id && c.included)
            && chrono::NaiveDate::parse_from_str(&e.local_date, "%Y-%m-%d").is_ok()
            && chrono::NaiveDate::parse_from_str(&e.end_local_date, "%Y-%m-%d").is_ok()
            && e.end_local_date >= e.local_date
            && seen.insert(e.occurrence_key.clone())
    });
    for e in &mut batch.events {
        e.title = sanitize_title(&e.title);
        if e.title.is_empty() {
            e.title = "Untitled event".into();
        }
        e.calendar_title = batch
            .calendars
            .iter()
            .find(|c| c.id == e.calendar_id)
            .map(|c| c.title.clone())
            .unwrap_or_default();
    }
    batch.events.sort_by(|a, b| {
        (a.start_epoch_s, a.end_epoch_s, &a.occurrence_key).cmp(&(
            b.start_epoch_s,
            b.end_epoch_s,
            &b.occurrence_key,
        ))
    });
    batch.truncated |= batch.events.len() > MAX_EVENTS;
    batch.events.truncate(MAX_EVENTS);
    batch
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncState {
    Idle,
    Loading,
    Refreshing,
    Ready,
    Error,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub permission: PermissionStatus,
    pub agenda_enabled: bool,
    pub prompts_enabled: bool,
    pub sync_state: SyncState,
    pub paused_while_live: bool,
    pub stale: bool,
    pub last_updated_epoch_ms: Option<i64>,
    pub error: Option<String>,
    pub today_local_date: String,
    pub timezone_label: String,
    pub horizon_start_date: String,
    pub horizon_end_date: String,
    pub truncated: bool,
    pub calendars: Vec<CalendarSummary>,
    pub events: Vec<Event>,
}
#[derive(Clone)]
pub struct Ticket {
    pub id: u64,
    generation: u64,
    pub horizon: Horizon,
    pub ids: Option<Vec<String>>,
    pub request_permission: bool,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl Ticket {
    #[cfg(test)]
    pub(crate) fn cancel_for_test(&self) {
        self.cancel.store(true, Ordering::Release);
    }
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire) || Instant::now() >= self.deadline
    }
}

pub struct Agenda {
    pub(crate) snapshot: Snapshot,
    ids: Option<Vec<String>>,
    generation: u64,
    serial: u64,
    flight: Option<Ticket>,
    pending: bool,
    explicit: bool,
    allow_permission: bool,
    horizon: Horizon,
    last_good: Option<Instant>,
    next_due: Instant,
    failures: u32,
    signal: u64,
    debounce: Option<Instant>,
    was_live: bool,
}
impl Default for Agenda {
    fn default() -> Self {
        let horizon = Horizon::utc(0);
        Self {
            snapshot: Snapshot {
                revision: 0,
                permission: PermissionStatus::Off,
                agenda_enabled: false,
                prompts_enabled: false,
                sync_state: SyncState::Idle,
                paused_while_live: false,
                stale: false,
                last_updated_epoch_ms: None,
                error: None,
                today_local_date: horizon.today.clone(),
                timezone_label: horizon.timezone.clone(),
                horizon_start_date: horizon.start_date.clone(),
                horizon_end_date: horizon.end_date.clone(),
                truncated: false,
                calendars: vec![],
                events: vec![],
            },
            ids: None,
            generation: 0,
            serial: 0,
            flight: None,
            pending: false,
            explicit: false,
            allow_permission: false,
            horizon,
            last_good: None,
            next_due: Instant::now(),
            failures: 0,
            signal: 0,
            debounce: None,
            was_live: false,
        }
    }
}
impl Agenda {
    fn changed(&mut self) {
        self.snapshot.revision += 1;
    }
    pub fn enabled(&self) -> bool {
        self.snapshot.agenda_enabled
    }
    pub fn ids(&self) -> Option<Vec<String>> {
        self.ids.clone()
    }
    fn retire(&mut self) {
        self.generation += 1;
        if let Some(t) = &self.flight {
            t.cancel.store(true, Ordering::Release);
        }
    }
    fn clear(&mut self) {
        self.snapshot.events.clear();
        self.snapshot.calendars.clear();
        self.snapshot.last_updated_epoch_ms = None;
        self.snapshot.truncated = false;
        self.snapshot.error = None;
        self.snapshot.sync_state = SyncState::Idle;
        self.last_good = None;
    }
    pub fn restore(&mut self, enabled: bool, ids: Option<Vec<String>>) {
        self.retire();
        self.clear();
        self.ids = ids;
        self.snapshot.agenda_enabled = enabled;
        self.snapshot.permission = PermissionStatus::Off;
        self.pending = enabled;
        self.explicit = false;
        self.debounce = None;
        self.allow_permission = false;
        self.changed();
    }
    pub fn set_enabled(&mut self, enabled: bool) {
        if !enabled {
            self.retire();
            self.clear();
            self.pending = false;
            self.explicit = false;
            self.debounce = None;
            self.allow_permission = false;
            self.snapshot.permission = PermissionStatus::Off;
        }
        self.snapshot.agenda_enabled = enabled;
        self.changed();
    }
    pub fn set_ids(&mut self, ids: Vec<String>) {
        self.retire();
        self.ids = Some(ids);
        self.snapshot.events.clear();
        self.snapshot.last_updated_epoch_ms = None;
        self.last_good = None;
        for c in &mut self.snapshot.calendars {
            c.included = included(self.ids.as_deref(), &c.id);
        }
        self.snapshot.error = None;
        self.snapshot.sync_state = SyncState::Idle;
        self.pending = self.enabled();
        self.changed();
    }
    pub fn permission(&mut self, permission: PermissionStatus) {
        if self.snapshot.permission == permission {
            return;
        }
        if permission != PermissionStatus::Connected {
            self.retire();
            self.clear();
            self.pending = false;
            self.allow_permission = false;
        }
        self.snapshot.permission = permission;
        self.changed();
    }
    pub fn clock(&mut self, horizon: Horizon) {
        if self.horizon == horizon {
            return;
        }
        self.retire();
        self.clear();
        self.horizon = horizon;
        self.snapshot.today_local_date = self.horizon.today.clone();
        self.snapshot.timezone_label = self.horizon.timezone.clone();
        self.snapshot.horizon_start_date = self.horizon.start_date.clone();
        self.snapshot.horizon_end_date = self.horizon.end_date.clone();
        self.pending = self.enabled();
        self.changed();
    }
    /// Coalesces all triggers, including permission requests, into one physical worker.
    pub fn request(&mut self, permission: bool, now: Instant) {
        if !self.enabled() {
            return;
        }
        self.pending = true;
        self.explicit = true;
        self.allow_permission |= permission;
        self.failures = 0;
        self.next_due = now;
    }
    pub fn begin(&mut self, now: Instant, live: bool) -> Option<Ticket> {
        if !self.enabled()
            || self.flight.is_some()
            || !self.pending
            || (live && !self.explicit)
            || now < self.next_due
        {
            return None;
        }
        if self.snapshot.permission != PermissionStatus::Connected
            && !(self.allow_permission && self.snapshot.permission == PermissionStatus::Off)
        {
            return None;
        }
        self.pending = false;
        self.explicit = false;
        self.serial += 1;
        let ticket = Ticket {
            id: self.serial,
            generation: self.generation,
            horizon: self.horizon.clone(),
            ids: self.ids.clone(),
            request_permission: std::mem::take(&mut self.allow_permission),
            cancel: Arc::new(AtomicBool::new(false)),
            deadline: now + QUERY_TIMEOUT,
        };
        self.flight = Some(ticket.clone());
        self.snapshot.sync_state = if self.last_good.is_some() {
            SyncState::Refreshing
        } else {
            SyncState::Loading
        };
        self.snapshot.error = None;
        self.changed();
        Some(ticket)
    }
    pub fn finish(
        &mut self,
        ticket: &Ticket,
        auth: PermissionStatus,
        result: Result<Batch, ReadError>,
        now: Instant,
        epoch: i64,
    ) {
        if self
            .flight
            .as_ref()
            .is_none_or(|active| active.id != ticket.id)
        {
            return;
        }
        self.flight = None;
        if self.generation != ticket.generation
            || !self.enabled()
            || ticket.cancel.load(Ordering::Acquire)
        {
            return;
        }
        self.permission(auth);
        if auth != PermissionStatus::Connected {
            return;
        }
        let result = if now >= ticket.deadline {
            Err(ReadError::Failed)
        } else {
            result
        };
        match result {
            Ok(batch) => {
                let batch = normalize(batch, &ticket.horizon, ticket.ids.as_deref());
                self.snapshot.calendars = batch.calendars;
                self.snapshot.events = batch.events;
                self.snapshot.truncated = batch.truncated;
                self.last_good = Some(now);
                self.snapshot.last_updated_epoch_ms = Some(epoch.saturating_mul(1000));
                self.snapshot.sync_state = SyncState::Ready;
                self.snapshot.error = None;
                self.failures = 0;
                self.next_due = now + POLL;
            }
            Err(_) => {
                self.snapshot.sync_state = SyncState::Error;
                self.snapshot.error = Some(READ_ERROR.into());
                self.next_due = now
                    + Duration::from_secs([15, 30, 60, 120, 300][self.failures.min(4) as usize]);
                self.failures = self.failures.saturating_add(1);
            }
        }
        if self.pending {
            self.next_due = now;
        }
        self.changed();
    }
    pub fn view(&mut self, now: Instant, live: bool, prompts: bool) -> Snapshot {
        let stale = self.enabled()
            && self
                .last_good
                .is_none_or(|time| now.saturating_duration_since(time) > STALE_AFTER);
        let paused = self.enabled() && live;
        if stale != self.snapshot.stale
            || paused != self.snapshot.paused_while_live
            || prompts != self.snapshot.prompts_enabled
        {
            self.snapshot.stale = stale;
            self.snapshot.paused_while_live = paused;
            self.snapshot.prompts_enabled = prompts;
            self.changed();
        }
        self.snapshot.clone()
    }
    /// Bounded fallback and notification debounce. During live sessions only an
    /// explicit request may dispatch; cached snapshots still disclose staleness.
    pub fn tick(&mut self, now: Instant, live: bool, signal: u64) {
        if !self.enabled() {
            self.was_live = live;
            return;
        }
        if signal != self.signal {
            self.signal = signal;
            self.debounce = Some(now + Duration::from_millis(500));
        }
        if self.was_live && !live {
            self.pending = true;
            self.next_due = now;
        }
        self.was_live = live;
        if live {
            return;
        }
        if self.debounce.is_some_and(|due| now >= due) {
            self.debounce = None;
            self.pending = true;
            self.failures = 0;
            self.next_due = now;
        }
        if self.flight.is_none() && now >= self.next_due {
            self.pending = true;
        }
    }
    pub fn resume(&mut self, now: Instant) {
        if self
            .last_good
            .is_none_or(|good| now.saturating_duration_since(good) >= Duration::from_secs(30))
        {
            self.request(false, now);
        }
    }
}

#[cfg(test)]
mod tests;
