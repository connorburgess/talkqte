//! Opt-in local calendar awareness for pre-call prompts.
//!
//! Off by default (`settings.json` `calendarPrompts: false`). When turned on by
//! the user on macOS (and never during lab runs), TalkQTE reads only upcoming
//! events in a tight window (starting within the next 5 minutes or currently in
//! progress within the first 10 minutes) through Apple EventKit, extracting
//! only the event identifier/start time for deduplication, a sanitized title,
//! start/end timestamps, and whether URL/location/notes contain a known meeting
//! link. Attendee lists, organizers, descriptions, and unrelated calendar entries
//! are never retained. Notes are inspected transiently only for meeting-link
//! detection; attendees and organizers are never accessed. Everything stays local.

use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How often the macOS calendar thread polls EventKit while enabled.
pub const POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Events starting up to this many seconds from now are queried.
pub const UPCOMING_WINDOW_SECS: i64 = 5 * 60;
/// Events already in progress up to this many seconds after start are queried.
pub const IN_PROGRESS_WINDOW_SECS: i64 = 10 * 60;
/// Surface the pre-call prompt ~2 minutes before start (<= 149s rounds to "2 min").
pub const PROMPT_LEAD_SECS: i64 = 149;
/// Maximum characters retained in a prompt or pre-filled meeting title.
pub const MAX_TITLE_CHARS: usize = 120;
/// Maximum number of deduplication keys kept in memory.
const MAX_SEEN_EVENTS: usize = 200;
/// Prune deduplication keys older than 2 hours.
const SEEN_RETENTION_SECS: i64 = 2 * 60 * 60;

/// Known video/audio meeting link hosts and markers.
const MEETING_DOMAINS: &[&str] = &[
    "meet.google.com",
    "zoom.us",
    "teams.microsoft.com",
    "teams.live.com",
    "webex.com",
    "whereby.com",
    "around.co",
    "tuple.app",
    "chime.aws",
    "meet.jit.si",
    "discord.gg",
];

/// Returns the current Unix timestamp in seconds.
pub fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

fn is_domain_prefix_boundary(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '/' | '.' | '@' | ':' | '(' | '<' | '"' | '\'' | ',' | '=' | '['
        )
}

fn is_domain_suffix_boundary(rest: &str) -> bool {
    let mut chars = rest.chars();
    let Some(next) = chars.next() else {
        return true;
    };
    if next.is_whitespace()
        || matches!(
            next,
            '/' | '?' | '#' | ':' | ')' | '>' | '"' | '\'' | ',' | ']'
        )
    {
        return true;
    }
    // Allow trailing sentence punctuation like "zoom.us." only if not followed
    // by another hostname label (so "zoom.us.evil.com" does not match).
    if next == '.' {
        return !chars
            .next()
            .is_some_and(|after| after.is_ascii_alphanumeric());
    }
    false
}

fn contains_domain(lower: &str, domain: &str) -> bool {
    let mut start = 0;
    while let Some(offset) = lower[start..].find(domain) {
        let idx = start + offset;
        let end = idx + domain.len();
        let before_ok = lower[..idx]
            .chars()
            .next_back()
            .is_none_or(is_domain_prefix_boundary);
        let after_ok = is_domain_suffix_boundary(&lower[end..]);
        if before_ok && after_ok {
            return true;
        }
        start = idx + 1;
    }
    false
}

fn contains_word(lower: &str, word: &str) -> bool {
    let mut start = 0;
    while let Some(offset) = lower[start..].find(word) {
        let idx = start + offset;
        let end = idx + word.len();
        let before_ok = lower[..idx]
            .chars()
            .next_back()
            .is_none_or(|ch| !ch.is_ascii_alphanumeric());
        let after_ok = lower[end..]
            .chars()
            .next()
            .is_none_or(|ch| !ch.is_ascii_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        start = idx + 1;
    }
    false
}

/// Checks whether a single text field contains a known meeting link or huddle marker.
pub fn has_meeting_link(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    MEETING_DOMAINS
        .iter()
        .any(|domain| contains_domain(&lower, domain))
        || contains_word(&lower, "huddle")
}

/// Checks URL, location, and notes fields for a known meeting link.
/// Raw field contents are discarded immediately after this check.
pub fn event_has_meeting_link(
    url: Option<&str>,
    location: Option<&str>,
    notes: Option<&str>,
) -> bool {
    [url, location, notes]
        .into_iter()
        .flatten()
        .any(has_meeting_link)
}

/// Strips control/bidi-override characters, normalizes whitespace, and bounds length.
pub fn sanitize_title(raw: &str) -> String {
    let filtered: String = raw
        .chars()
        .filter(|c| {
            (!c.is_control() || c.is_whitespace())
                && !matches!(
                    c,
                    '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}'
                )
        })
        .collect();
    let normalized = filtered.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = normalized.chars().count();
    if count <= MAX_TITLE_CHARS {
        return normalized;
    }
    let mut truncated: String = normalized
        .chars()
        .take(MAX_TITLE_CHARS.saturating_sub(1))
        .collect();
    truncated = truncated.trim_end().to_string();
    truncated.push('…');
    truncated
}

/// Permission status exposed to Settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStatus {
    Off,
    Connected,
    Denied,
    Unavailable,
}

/// Minimal metadata extracted from one calendar event in the tight window.
/// Contains no raw URLs, notes, locations, attendees, or calendar identifiers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start_epoch_s: i64,
    pub end_epoch_s: i64,
    pub has_meeting_link: bool,
    pub is_all_day: bool,
}

/// Provider-independent calendar source. Production macOS uses EventKit;
/// unit tests use a scripted fake; lab runs and other OSes use `UnavailableSource`.
pub trait CalendarSource: Send + Sync {
    fn authorization_status(&self) -> PermissionStatus;
    fn request_access(&self) -> PermissionStatus;
    /// Separate wider agenda query. Existing prompt fakes remain unavailable.
    fn agenda(
        &self,
        _ticket: &crate::calendar_agenda::Ticket,
    ) -> Result<crate::calendar_agenda::Batch, crate::calendar_agenda::ReadError> {
        Err(crate::calendar_agenda::ReadError::Unavailable)
    }
    fn agenda_change_version(&self) -> u64 {
        0
    }
    fn upcoming_events(
        &self,
        window_start_epoch_s: i64,
        window_end_epoch_s: i64,
    ) -> Vec<CalendarEvent>;
}

/// No calendar integration (non-macOS platforms and lab runs).
pub struct UnavailableSource;

impl CalendarSource for UnavailableSource {
    fn authorization_status(&self) -> PermissionStatus {
        PermissionStatus::Unavailable
    }
    fn request_access(&self) -> PermissionStatus {
        PermissionStatus::Unavailable
    }
    fn upcoming_events(&self, _: i64, _: i64) -> Vec<CalendarEvent> {
        Vec::new()
    }
}

/// Pre-call prompt sent to the floating companion window.
/// Narrow by design: only prompt ID, bounded title, and rounded minutes until start.
/// Never carries raw calendar event IDs, links, notes, locations, or attendees.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: u64,
    pub title: String,
    pub minutes_until_start: i64,
}

/// An answer from the companion's pre-call prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Answer {
    Start,
    Dismiss,
}

/// Calendar settings payload for the Settings UI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub status: PermissionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct EventKey {
    id: String,
    start_epoch_s: i64,
}

#[derive(Clone, Debug)]
struct ActivePrompt {
    prompt: Prompt,
    key: EventKey,
}

fn minutes_until_start(delta_secs: i64) -> i64 {
    if delta_secs >= 0 {
        (delta_secs + 30) / 60
    } else {
        -((-delta_secs + 30) / 60)
    }
}

fn in_prompt_window(start_epoch_s: i64, end_epoch_s: i64, now_epoch_s: i64) -> bool {
    if end_epoch_s <= start_epoch_s || end_epoch_s <= now_epoch_s {
        return false;
    }
    let delta = start_epoch_s - now_epoch_s;
    (-IN_PROGRESS_WINDOW_SECS..=PROMPT_LEAD_SECS).contains(&delta)
}

#[derive(Default)]
pub struct Watcher {
    enabled: bool,
    active: Option<ActivePrompt>,
    seen: Vec<EventKey>,
    next_id: u64,
    settings_revision: u64,
}

impl Watcher {
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Reserves the latest setting intent before any asynchronous native work.
    pub fn begin_settings_change(&mut self) -> u64 {
        self.settings_revision = self.settings_revision.wrapping_add(1);
        self.settings_revision
    }

    pub fn settings_change_is_current(&self, revision: u64) -> bool {
        revision == self.settings_revision
    }

    /// A superseded permission/query result must neither enable nor be persisted.
    pub fn finish_settings_change(&mut self, revision: u64, enabled: bool) -> Option<bool> {
        self.settings_change_is_current(revision)
            .then(|| self.set_enabled(enabled))
    }

    /// Enables or disables calendar prompts. Disabling immediately clears any active prompt.
    pub fn set_enabled(&mut self, enabled: bool) -> bool {
        self.begin_settings_change();
        let changed = self.enabled != enabled;
        self.enabled = enabled;
        if !enabled {
            return self.clear_active() || changed;
        }
        changed
    }

    pub fn prompt(&self) -> Option<&Prompt> {
        self.active.as_ref().map(|active| &active.prompt)
    }

    pub fn clear_active(&mut self) -> bool {
        self.active.take().is_some()
    }

    /// Consumes and returns the currently active prompt's title if a live session
    /// is starting directly from the notebook while the prompt is displayed.
    pub fn take_active_title(&mut self) -> Option<String> {
        self.active.take().map(|active| active.prompt.title)
    }

    /// Observes the latest events from `CalendarSource` in the tight window.
    /// Returns `true` when the displayed prompt changed.
    pub fn observe(&mut self, events: &[CalendarEvent], busy: bool, now_epoch_s: i64) -> bool {
        if !self.enabled || busy {
            return self.clear_active();
        }
        self.seen
            .retain(|key| key.start_epoch_s >= now_epoch_s - SEEN_RETENTION_SECS);

        if let Some(active) = &mut self.active {
            if let Some(matched) = events.iter().find(|event| {
                event.id == active.key.id
                    && event.start_epoch_s == active.key.start_epoch_s
                    && !event.is_all_day
                    && event.has_meeting_link
                    && in_prompt_window(event.start_epoch_s, event.end_epoch_s, now_epoch_s)
            }) {
                let title = sanitize_title(&matched.title);
                if title.is_empty() {
                    return self.clear_active();
                }
                let mins = minutes_until_start(matched.start_epoch_s - now_epoch_s);
                let changed =
                    active.prompt.minutes_until_start != mins || active.prompt.title != title;
                active.prompt.minutes_until_start = mins;
                active.prompt.title = title;
                return changed;
            }
            return self.clear_active();
        }

        let mut candidates: Vec<(&CalendarEvent, String)> = events
            .iter()
            .filter(|event| {
                !event.is_all_day
                    && event.has_meeting_link
                    && in_prompt_window(event.start_epoch_s, event.end_epoch_s, now_epoch_s)
                    && !self.seen.iter().any(|seen| {
                        seen.id == event.id && seen.start_epoch_s == event.start_epoch_s
                    })
            })
            .filter_map(|event| {
                let title = sanitize_title(&event.title);
                (!title.is_empty()).then_some((event, title))
            })
            .collect();

        candidates.sort_by(|(a, _), (b, _)| {
            (a.start_epoch_s - now_epoch_s)
                .abs()
                .cmp(&(b.start_epoch_s - now_epoch_s).abs())
                .then_with(|| a.start_epoch_s.cmp(&b.start_epoch_s))
                .then_with(|| a.id.cmp(&b.id))
        });

        let Some((chosen, title)) = candidates.into_iter().next() else {
            return false;
        };

        let key = EventKey {
            id: chosen.id.clone(),
            start_epoch_s: chosen.start_epoch_s,
        };
        if self.seen.len() >= MAX_SEEN_EVENTS {
            let drain = self.seen.len() + 1 - MAX_SEEN_EVENTS;
            self.seen.drain(..drain);
        }
        self.seen.push(key.clone());
        self.next_id += 1;
        self.active = Some(ActivePrompt {
            prompt: Prompt {
                id: self.next_id,
                title,
                minutes_until_start: minutes_until_start(chosen.start_epoch_s - now_epoch_s),
            },
            key,
        });
        true
    }

    /// Handles the user's answer to prompt `id`.
    /// Returns `Some(title)` when `Start` is chosen, `None` for `Dismiss` or stale `id`.
    pub fn answer(&mut self, id: u64, answer: Answer) -> Option<String> {
        let active = self.active.take_if(|active| active.prompt.id == id)?;
        match answer {
            Answer::Start => Some(active.prompt.title),
            Answer::Dismiss => None,
        }
    }
}

/// EventKit's predicate matches overlapping events, including old or ended
/// entries. Filter timestamps before reading any title or link-bearing field.
#[cfg(any(target_os = "macos", test))]
fn query_candidate(start: f64, end: f64, window_start: i64, window_end: i64, now: i64) -> bool {
    start.is_finite()
        && end.is_finite()
        && start >= window_start as f64
        && start <= window_end as f64
        && end > start
        && end > now as f64
}

/// Returns the calendar source for the running app: EventKit on macOS outside
/// lab runs, and `UnavailableSource` in lab runs or on other platforms.
pub fn for_app() -> Box<dyn CalendarSource> {
    #[cfg(target_os = "macos")]
    if !crate::settings::lab_run() {
        return Box::new(macos::EventKitSource::new());
    }
    Box::new(UnavailableSource)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{event_has_meeting_link, CalendarEvent, CalendarSource, PermissionStatus};
    use block2::RcBlock;
    use objc2::{
        class, msg_send,
        rc::{autoreleasepool, Retained},
        runtime::{AnyObject, Bool},
        sel,
    };
    use objc2_foundation::{NSArray, NSString};
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;

    #[link(name = "EventKit", kind = "framework")]
    extern "C" {}

    const EK_ENTITY_TYPE_EVENT: usize = 0;

    // SAFETY: EKEventStore is thread-safe for read queries and access requests,
    // and all access in EventKitSource is serialized through its Mutex.
    struct StoreHandle(Retained<AnyObject>);
    unsafe impl Send for StoreHandle {}
    unsafe impl Sync for StoreHandle {}

    pub struct EventKitSource {
        store: Mutex<Option<StoreHandle>>,
        changes: crate::calendar_agenda_macos::Changes,
    }

    impl EventKitSource {
        pub fn new() -> Self {
            Self {
                store: Mutex::new(None),
                changes: crate::calendar_agenda_macos::Changes::default(),
            }
        }

        fn ensure_store(&self) -> Result<(), ()> {
            let mut guard = self.store.lock().map_err(|_| ())?;
            if guard.is_none() {
                // SAFETY: `EKEventStore` responds to `new` and returns a retained instance.
                let store: Option<Retained<AnyObject>> =
                    unsafe { msg_send![class!(EKEventStore), new] };
                let Some(store) = store else {
                    return Err(());
                };
                *guard = Some(StoreHandle(store));
            }
            Ok(())
        }
    }

    fn map_auth_status(raw: isize) -> Option<PermissionStatus> {
        match raw {
            0 => None,                                   // EKAuthorizationStatusNotDetermined
            1 | 2 | 4 => Some(PermissionStatus::Denied), // Restricted, Denied, WriteOnly
            3 => Some(PermissionStatus::Connected), // EKAuthorizationStatusFullAccess / Authorized
            _ => Some(PermissionStatus::Denied),
        }
    }

    fn current_raw_status() -> isize {
        // SAFETY: class method taking EKEntityTypeEvent (0) and returning NSInteger.
        unsafe {
            msg_send![class!(EKEventStore), authorizationStatusForEntityType: EK_ENTITY_TYPE_EVENT]
        }
    }

    fn nsstring_to_string(value: Option<Retained<NSString>>) -> Option<String> {
        value.map(|s| s.to_string())
    }

    impl CalendarSource for EventKitSource {
        fn agenda_change_version(&self) -> u64 {
            self.changes.version()
        }
        fn agenda(
            &self,
            ticket: &crate::calendar_agenda::Ticket,
        ) -> Result<crate::calendar_agenda::Batch, crate::calendar_agenda::ReadError> {
            use crate::calendar_agenda::ReadError;
            if ticket.cancelled() {
                return Err(ReadError::Cancelled);
            }
            if current_raw_status() != 3 {
                return Err(ReadError::Unavailable);
            }
            self.changes.install();
            self.ensure_store().map_err(|_| ReadError::Failed)?;
            let guard = self.store.lock().map_err(|_| ReadError::Failed)?;
            if ticket.cancelled() {
                return Err(ReadError::Cancelled);
            }
            let handle = guard.as_ref().ok_or(ReadError::Failed)?;
            crate::calendar_agenda_macos::read(&handle.0, ticket)
        }
        fn authorization_status(&self) -> PermissionStatus {
            map_auth_status(current_raw_status()).unwrap_or(PermissionStatus::Off)
        }

        fn request_access(&self) -> PermissionStatus {
            if let Some(status) = map_auth_status(current_raw_status()) {
                return status;
            }
            let Ok(mut guard) = self.store.lock() else {
                return PermissionStatus::Denied;
            };
            // Always create a fresh EKEventStore for a new authorization request.
            let store: Option<Retained<AnyObject>> =
                unsafe { msg_send![class!(EKEventStore), new] };
            let Some(store) = store else {
                return PermissionStatus::Denied;
            };
            let (tx, rx) = mpsc::channel::<bool>();
            let block = RcBlock::new(move |granted: Bool, _error: *mut AnyObject| {
                let _ = tx.send(granted.as_bool());
            });
            unsafe {
                let responds_full: Bool = msg_send![
                    &*store,
                    respondsToSelector: sel!(requestFullAccessToEventsWithCompletion:)
                ];
                if responds_full.as_bool() {
                    let _: () =
                        msg_send![&*store, requestFullAccessToEventsWithCompletion: &*block];
                } else {
                    let _: () = msg_send![
                        &*store,
                        requestAccessToEntityType: EK_ENTITY_TYPE_EVENT,
                        completion: &*block
                    ];
                }
            }
            let granted = rx.recv_timeout(Duration::from_secs(60)).unwrap_or(false);
            if granted {
                // Re-create store after grant so EventKit picks up newly authorized calendars.
                let refreshed: Option<Retained<AnyObject>> =
                    unsafe { msg_send![class!(EKEventStore), new] };
                *guard = refreshed.map(StoreHandle);
            } else {
                *guard = Some(StoreHandle(store));
            }
            drop(guard);
            map_auth_status(current_raw_status()).unwrap_or(PermissionStatus::Denied)
        }

        fn upcoming_events(
            &self,
            window_start_epoch_s: i64,
            window_end_epoch_s: i64,
        ) -> Vec<CalendarEvent> {
            if current_raw_status() != 3 {
                return Vec::new();
            }
            if self.ensure_store().is_err() {
                return Vec::new();
            }
            let Ok(guard) = self.store.lock() else {
                return Vec::new();
            };
            let Some(handle) = guard.as_ref() else {
                return Vec::new();
            };
            let store = &handle.0;
            autoreleasepool(|_| {
                let start_date: Option<Retained<AnyObject>> = unsafe {
                    msg_send![
                        class!(NSDate),
                        dateWithTimeIntervalSince1970: window_start_epoch_s as f64
                    ]
                };
                let end_date: Option<Retained<AnyObject>> = unsafe {
                    msg_send![
                        class!(NSDate),
                        dateWithTimeIntervalSince1970: window_end_epoch_s as f64
                    ]
                };
                let (Some(start_date), Some(end_date)) = (start_date, end_date) else {
                    return Vec::new();
                };
                let predicate: Option<Retained<AnyObject>> = unsafe {
                    msg_send![
                        &**store,
                        predicateForEventsWithStartDate: &*start_date,
                        endDate: &*end_date,
                        calendars: std::ptr::null::<AnyObject>()
                    ]
                };
                let Some(predicate) = predicate else {
                    return Vec::new();
                };
                let events: Option<Retained<NSArray<AnyObject>>> =
                    unsafe { msg_send![&**store, eventsMatchingPredicate: &*predicate] };
                let Some(events) = events else {
                    return Vec::new();
                };
                let count: usize = unsafe { msg_send![&*events, count] };
                let mut out = Vec::with_capacity(count);
                for index in 0..count {
                    let event: *mut AnyObject =
                        unsafe { msg_send![&*events, objectAtIndex: index] };
                    if event.is_null() {
                        continue;
                    }
                    let is_all_day: Bool = unsafe { msg_send![event, isAllDay] };
                    if is_all_day.as_bool() {
                        continue;
                    }
                    let start_obj: Option<Retained<AnyObject>> =
                        unsafe { msg_send![event, startDate] };
                    let end_obj: Option<Retained<AnyObject>> = unsafe { msg_send![event, endDate] };
                    let (Some(start_obj), Some(end_obj)) = (start_obj, end_obj) else {
                        continue;
                    };
                    let start_secs: f64 = unsafe { msg_send![&*start_obj, timeIntervalSince1970] };
                    let end_secs: f64 = unsafe { msg_send![&*end_obj, timeIntervalSince1970] };
                    if !super::query_candidate(
                        start_secs,
                        end_secs,
                        window_start_epoch_s,
                        window_end_epoch_s,
                        super::now_epoch_secs(),
                    ) {
                        continue;
                    }
                    let id = nsstring_to_string(unsafe { msg_send![event, eventIdentifier] });
                    let title = nsstring_to_string(unsafe { msg_send![event, title] });
                    let (Some(id), Some(title)) = (id, title) else {
                        continue;
                    };
                    let url_obj: Option<Retained<AnyObject>> = unsafe { msg_send![event, URL] };
                    let url_str = url_obj.and_then(|u| {
                        nsstring_to_string(unsafe { msg_send![&*u, absoluteString] })
                    });
                    let location = nsstring_to_string(unsafe { msg_send![event, location] });
                    let notes = nsstring_to_string(unsafe { msg_send![event, notes] });
                    // Extract only whether a known meeting link is present; never retain raw
                    // URL, location, notes, or ever read attendees/organizer.
                    let has_meeting_link = event_has_meeting_link(
                        url_str.as_deref(),
                        location.as_deref(),
                        notes.as_deref(),
                    );
                    out.push(CalendarEvent {
                        id,
                        title: super::sanitize_title(&title),
                        start_epoch_s: start_secs.round() as i64,
                        end_epoch_s: end_secs.round() as i64,
                        has_meeting_link,
                        is_all_day: false,
                    });
                }
                out
            })
        }
    }
}

#[cfg(test)]
pub mod fake {
    use super::{CalendarEvent, CalendarSource, PermissionStatus};
    use std::sync::Mutex;

    /// Scripted offline calendar source for unit tests. Never touches Apple Calendar.
    pub struct FakeSource {
        pub status: Mutex<PermissionStatus>,
        pub grant_on_request: Mutex<PermissionStatus>,
        pub events: Mutex<Vec<CalendarEvent>>,
        pub requests: Mutex<u32>,
        pub fetches: Mutex<Vec<(i64, i64)>>,
    }

    impl Default for FakeSource {
        fn default() -> Self {
            Self {
                status: Mutex::new(PermissionStatus::Off),
                grant_on_request: Mutex::new(PermissionStatus::Connected),
                events: Mutex::new(Vec::new()),
                requests: Mutex::new(0),
                fetches: Mutex::new(Vec::new()),
            }
        }
    }

    impl CalendarSource for FakeSource {
        fn authorization_status(&self) -> PermissionStatus {
            *self.status.lock().unwrap()
        }
        fn request_access(&self) -> PermissionStatus {
            *self.requests.lock().unwrap() += 1;
            let next = *self.grant_on_request.lock().unwrap();
            *self.status.lock().unwrap() = next;
            next
        }
        fn upcoming_events(
            &self,
            window_start_epoch_s: i64,
            window_end_epoch_s: i64,
        ) -> Vec<CalendarEvent> {
            self.fetches
                .lock()
                .unwrap()
                .push((window_start_epoch_s, window_end_epoch_s));
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| {
                    event.start_epoch_s >= window_start_epoch_s
                        && event.start_epoch_s <= window_end_epoch_s
                })
                .cloned()
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{fake::FakeSource, *};

    fn event(id: &str, title: &str, start: i64, end: i64, link: bool) -> CalendarEvent {
        CalendarEvent {
            id: id.into(),
            title: title.into(),
            start_epoch_s: start,
            end_epoch_s: end,
            has_meeting_link: link,
            is_all_day: false,
        }
    }

    #[test]
    fn detects_all_major_meeting_providers_and_rejects_unrelated_text() {
        let matches = [
            "https://meet.google.com/abc-defg-hij",
            "Join Zoom: https://us02web.zoom.us/j/9988776655",
            "https://zoom.us/j/123456",
            "https://teams.microsoft.com/l/meetup-join/19%3ameeting",
            "https://teams.live.com/meet/999999",
            "https://acme.webex.com/meet/design",
            "https://whereby.com/fictional-room",
            "https://around.co/r/fictional",
            "https://tuple.app/c/fictional",
            "https://chime.aws/1234567890",
            "https://meet.jit.si/FictionalSync",
            "https://discord.gg/fictional-server",
            "https://app.slack.com/huddle/T123/C456",
            "Quick Slack Huddle",
            "Join at zoom.us.",
        ];
        for sample in matches {
            assert!(has_meeting_link(sample), "expected match for {sample}");
        }

        let non_matches = [
            "",
            "Conference room B",
            "https://example.com/calendar",
            "https://notzoom.us/j/123",
            "https://zoom.us.evil.example/j/123",
            "Team huddled in hallway",
            "Lunch at noon",
        ];
        for sample in non_matches {
            assert!(!has_meeting_link(sample), "unexpected match for {sample}");
        }

        assert!(event_has_meeting_link(
            Some("https://meet.google.com/xyz-abcd-efg"),
            None,
            None
        ));
        assert!(event_has_meeting_link(
            None,
            Some("https://acme.webex.com/meet/weekly"),
            None
        ));
        assert!(event_has_meeting_link(
            None,
            None,
            Some("Join on Slack Huddle")
        ));
        assert!(!event_has_meeting_link(
            None,
            Some("Room 4B"),
            Some("Bring notebook")
        ));
    }

    #[test]
    fn off_by_default_and_clears_prompt_when_disabled() {
        let mut watcher = Watcher::default();
        assert!(!watcher.enabled());
        let now = 1_700_000_000;
        let events = [event(
            "e1",
            "Weekly Design Sync",
            now + 120,
            now + 1920,
            true,
        )];
        assert!(!watcher.observe(&events, false, now));
        assert_eq!(watcher.prompt(), None);

        assert!(watcher.set_enabled(true));
        assert!(watcher.observe(&events, false, now));
        assert!(watcher.prompt().is_some());

        assert!(watcher.set_enabled(false));
        assert_eq!(watcher.prompt(), None);
        assert!(!watcher.observe(&events, false, now));
    }

    #[test]
    fn pre_call_window_timing_and_in_progress_bounds() {
        let mut watcher = Watcher::default();
        watcher.set_enabled(true);
        let start = 1_700_000_000;
        let end = start + 1_800;
        let events = [event("e1", "Weekly Design Sync", start, end, true)];

        // 4 minutes before start: still outside lead window (~2 min before start).
        assert!(!watcher.observe(&events, false, start - 240));
        assert_eq!(watcher.prompt(), None);

        // ~2 minutes before start: prompt surfaces with "starts in 2 min".
        assert!(watcher.observe(&events, false, start - 120));
        assert_eq!(
            watcher.prompt(),
            Some(&Prompt {
                id: 1,
                title: "Weekly Design Sync".into(),
                minutes_until_start: 2,
            })
        );

        // 1 minute before start: updates countdown while keeping same prompt id.
        assert!(watcher.observe(&events, false, start - 60));
        assert_eq!(
            watcher.prompt(),
            Some(&Prompt {
                id: 1,
                title: "Weekly Design Sync".into(),
                minutes_until_start: 1,
            })
        );

        // Starting now.
        assert!(watcher.observe(&events, false, start));
        assert_eq!(watcher.prompt().unwrap().minutes_until_start, 0);

        // 11 minutes past start: outside 10-minute in-progress window -> withdraws.
        assert!(watcher.observe(&events, false, start + 11 * 60));
        assert_eq!(watcher.prompt(), None);

        // An event already 11 minutes in progress never prompts.
        let mut fresh = Watcher::default();
        fresh.set_enabled(true);
        assert!(!fresh.observe(&events, false, start + 11 * 60));
        assert_eq!(fresh.prompt(), None);

        // An event without a meeting link or an all-day event never prompts.
        let no_link = [event("e2", "Lunch", start, end, false)];
        assert!(!fresh.observe(&no_link, false, start - 60));
        assert_eq!(fresh.prompt(), None);
        let mut all_day = event("e3", "Offsite", start, end, true);
        all_day.is_all_day = true;
        assert!(!fresh.observe(&[all_day], false, start - 60));
        assert_eq!(fresh.prompt(), None);
    }

    #[test]
    fn once_per_event_deduplication_and_recurring_occurrences() {
        let mut watcher = Watcher::default();
        watcher.set_enabled(true);
        let start = 1_700_000_000;
        let events = [event("series-1", "Daily Standup", start, start + 900, true)];

        assert!(watcher.observe(&events, false, start - 120));
        let id = watcher.prompt().unwrap().id;
        assert_eq!(watcher.answer(id, Answer::Dismiss), None);
        assert_eq!(watcher.prompt(), None);

        // Same occurrence does not prompt again.
        assert!(!watcher.observe(&events, false, start - 60));
        assert_eq!(watcher.prompt(), None);

        // Stale answer changes nothing.
        assert_eq!(watcher.answer(id, Answer::Start), None);

        // Next day's occurrence with same series id prompts once.
        let tomorrow = start + 86_400;
        let next_events = [event(
            "series-1",
            "Daily Standup",
            tomorrow,
            tomorrow + 900,
            true,
        )];
        assert!(watcher.observe(&next_events, false, tomorrow - 120));
        let next_id = watcher.prompt().unwrap().id;
        assert!(next_id > id);
        assert_eq!(
            watcher.answer(next_id, Answer::Start),
            Some("Daily Standup".into())
        );
        assert_eq!(watcher.prompt(), None);
    }

    #[test]
    fn fake_calendar_source_queries_tight_window_only() {
        let source = FakeSource::default();
        assert_eq!(source.authorization_status(), PermissionStatus::Off);
        assert_eq!(source.request_access(), PermissionStatus::Connected);
        let now = 1_700_000_000;
        *source.events.lock().unwrap() = vec![
            event("far", "Later Meeting", now + 3600, now + 5400, true),
            event("near", "Fictional Sync", now + 120, now + 1920, true),
        ];
        let fetched =
            source.upcoming_events(now - IN_PROGRESS_WINDOW_SECS, now + UPCOMING_WINDOW_SECS);
        assert_eq!(fetched.len(), 1);
        assert_eq!(fetched[0].id, "near");
        assert_eq!(
            *source.fetches.lock().unwrap(),
            [(now - IN_PROGRESS_WINDOW_SECS, now + UPCOMING_WINDOW_SECS)]
        );
    }

    #[test]
    fn edited_or_cancelled_events_withdraw_the_offer_and_stale_start_cannot_apply_title() {
        let mut watcher = Watcher::default();
        watcher.set_enabled(true);
        let now = 1_700_000_000;
        let mut meeting = event(
            "fictional-1",
            "Fictional Review",
            now + 120,
            now + 1800,
            true,
        );
        assert!(watcher.observe(&[meeting.clone()], false, now));
        let id = watcher.prompt().unwrap().id;
        meeting.title = "Fictional Revised Review".into();
        assert!(watcher.observe(&[meeting.clone()], false, now));
        assert_eq!(watcher.prompt().unwrap().title, "Fictional Revised Review");
        meeting.has_meeting_link = false;
        assert!(watcher.observe(&[meeting], false, now));
        assert!(watcher.prompt().is_none());
        assert_eq!(watcher.answer(id, Answer::Start), None);
    }

    #[test]
    fn query_scope_excludes_completed_events_and_old_overlaps_before_extracting_fields() {
        let now = 1_700_000_000;
        let lower = now - IN_PROGRESS_WINDOW_SECS;
        let upper = now + UPCOMING_WINDOW_SECS;
        let eligible =
            |start: i64, end: i64| query_candidate(start as f64, end as f64, lower, upper, now);
        assert!(eligible(now + 120, now + 1800));
        assert!(eligible(now - 120, now + 600));
        // EventKit can return both of these overlaps; neither may expose fields.
        assert!(!eligible(now - 120, now - 1));
        assert!(!eligible(now - 120, now));
        assert!(!eligible(lower - 1, now + 600));
        assert!(!eligible(upper + 1, now + 1800));
        assert!(!query_candidate(
            f64::NAN,
            now as f64 + 600.0,
            lower,
            upper,
            now
        ));
    }

    #[test]
    fn sanitizes_control_and_bidi_characters_from_event_titles() {
        let clean = sanitize_title("  Weekly\u{202E} Design\n\tSync  ");
        assert_eq!(clean, "Weekly Design Sync");
    }
}
