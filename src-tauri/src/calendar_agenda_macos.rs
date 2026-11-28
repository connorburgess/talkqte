//! Read-only EventKit/Calendar projection. No attendee/organizer/description access.
use crate::calendar::{event_has_meeting_link, sanitize_title};
use crate::calendar_agenda::{
    self as agenda, Batch, CalendarSummary, Event, Horizon, ReadError, Ticket,
};
use block2::RcBlock;
use objc2::{
    class, msg_send,
    rc::{autoreleasepool, Retained},
    runtime::{AnyObject, Bool},
};
use objc2_foundation::{NSArray, NSString};
use std::{
    cell::{Cell, RefCell},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

#[link(name = "EventKit", kind = "framework")]
extern "C" {
    static EKEventStoreChangedNotification: *const NSString;
}
#[link(name = "Foundation", kind = "framework")]
extern "C" {
    static NSCalendarDayChangedNotification: *const NSString;
    static NSSystemTimeZoneDidChangeNotification: *const NSString;
}
#[link(name = "AppKit", kind = "framework")]
extern "C" {
    static NSWorkspaceDidWakeNotification: *const NSString;
}

struct Observation {
    center: Retained<AnyObject>,
    token: Retained<AnyObject>,
}
// Notification tokens are retained/released normally and callbacks touch only an atomic.
unsafe impl Send for Observation {}
impl Drop for Observation {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![&*self.center, removeObserver: &*self.token];
        }
    }
}
#[derive(Default)]
pub(crate) struct Changes {
    version: Arc<AtomicU64>,
    installed: AtomicBool,
    observations: Mutex<Vec<Observation>>,
}
impl Changes {
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }
    /// Called only after agenda opt-in and full Calendar authorization.
    pub fn install(&self) {
        if self.installed.swap(true, Ordering::AcqRel) {
            return;
        }
        autoreleasepool(|_| unsafe {
            let center: Option<Retained<AnyObject>> =
                msg_send![class!(NSNotificationCenter), defaultCenter];
            let workspace: Option<Retained<AnyObject>> =
                msg_send![class!(NSWorkspace), sharedWorkspace];
            let workspace_center: Option<Retained<AnyObject>> =
                workspace.and_then(|w| msg_send![&*w, notificationCenter]);
            let mut registrations = Vec::new();
            if let Some(c) = center {
                for name in [
                    EKEventStoreChangedNotification,
                    NSCalendarDayChangedNotification,
                    NSSystemTimeZoneDidChangeNotification,
                ] {
                    if let Some(o) = observe(c.clone(), name, self.version.clone()) {
                        registrations.push(o);
                    }
                }
            }
            if let Some(c) = workspace_center {
                if let Some(o) = observe(c, NSWorkspaceDidWakeNotification, self.version.clone()) {
                    registrations.push(o);
                }
            }
            if let Ok(mut saved) = self.observations.lock() {
                *saved = registrations;
            }
        });
    }
}
unsafe fn observe(
    center: Retained<AnyObject>,
    name: *const NSString,
    signal: Arc<AtomicU64>,
) -> Option<Observation> {
    if name.is_null() {
        return None;
    }
    let block = RcBlock::new(move |_notification: *mut AnyObject| {
        signal.fetch_add(1, Ordering::Release);
    });
    let token: Option<Retained<AnyObject>> = unsafe {
        msg_send![&*center, addObserverForName: &*name, object: std::ptr::null::<AnyObject>(), queue: std::ptr::null::<AnyObject>(), usingBlock: &*block]
    };
    token.map(|token| Observation { center, token })
}

/// Bound conversions before copying native text into Rust. Long link fields are
/// ignored rather than retained; no raw strings leave this module.
fn text(value: Option<Retained<NSString>>, max_units: usize) -> Option<String> {
    let value = value?;
    (value.len_utf16() <= max_units).then(|| value.to_string())
}
fn object_date(epoch: i64) -> Option<Retained<AnyObject>> {
    unsafe { msg_send![class!(NSDate), dateWithTimeIntervalSince1970: epoch as f64] }
}
fn calendar_and_zone(
    zone_name: Option<&str>,
) -> Option<(Retained<AnyObject>, Retained<AnyObject>)> {
    unsafe {
        let calendar: Option<Retained<AnyObject>> = msg_send![class!(NSCalendar), calendarWithIdentifier: &*NSString::from_str("gregorian")];
        let zone: Option<Retained<AnyObject>> = if let Some(name) = zone_name {
            msg_send![class!(NSTimeZone), timeZoneWithName: &*NSString::from_str(name)]
        } else {
            msg_send![class!(NSTimeZone), localTimeZone]
        };
        let (calendar, zone) = (calendar?, zone?);
        let _: () = msg_send![&*calendar, setTimeZone: &*zone];
        Some((calendar, zone))
    }
}
fn formatter(zone: &AnyObject) -> Option<Retained<AnyObject>> {
    unsafe {
        let f: Option<Retained<AnyObject>> = msg_send![class!(NSDateFormatter), new];
        let f = f?;
        let locale: Option<Retained<AnyObject>> = msg_send![class!(NSLocale), localeWithLocaleIdentifier: &*NSString::from_str("en_US_POSIX")];
        let _: () = msg_send![&*f, setLocale: locale.as_deref()];
        let _: () = msg_send![&*f, setDateFormat: &*NSString::from_str("yyyy-MM-dd")];
        let _: () = msg_send![&*f, setTimeZone: zone];
        Some(f)
    }
}
fn date_string(f: &AnyObject, date: &AnyObject) -> Option<String> {
    text(unsafe { msg_send![f, stringFromDate: date] }, 16)
}
fn event_dates(
    f: &AnyObject,
    start: &AnyObject,
    end: &AnyObject,
    end_epoch: i64,
    all_day: bool,
) -> Option<(String, String)> {
    let local_date = date_string(f, start)?;
    let end_date = if all_day {
        let last = object_date(end_epoch.checked_sub(1)?)?;
        date_string(f, &last)?
    } else {
        date_string(f, end)?
    };
    Some((local_date, end_date))
}
/// Gregorian local-day arithmetic (not 86,400-second subtraction) preserves DST.
pub(crate) fn horizon(epoch: i64, zone_name: Option<&str>) -> Option<Horizon> {
    autoreleasepool(|_| unsafe {
        let (calendar, zone) = calendar_and_zone(zone_name)?;
        let now = object_date(epoch)?;
        let day: Option<Retained<AnyObject>> = msg_send![&*calendar, startOfDayForDate: &*now];
        let day = day?;
        let add = |days: isize| -> Option<Retained<AnyObject>> {
            msg_send![&*calendar, dateByAddingUnit: 16usize, value: days, toDate: &*day, options: 0usize]
        };
        let (start, last, end) = (add(-1)?, add(14)?, add(15)?);
        let f = formatter(&zone)?;
        let start_s: f64 = msg_send![&*start, timeIntervalSince1970];
        let end_s: f64 = msg_send![&*end, timeIntervalSince1970];
        let timezone = text(msg_send![&*zone, name], 120)?;
        Some(Horizon {
            today: date_string(&f, &day)?,
            timezone,
            start_date: date_string(&f, &start)?,
            end_date: date_string(&f, &last)?,
            start: start_s as i64,
            end: end_s as i64,
        })
    })
}

pub(crate) fn read(store: &AnyObject, ticket: &Ticket) -> Result<Batch, ReadError> {
    autoreleasepool(|_| unsafe {
        if ticket.cancelled() {
            return Err(ReadError::Cancelled);
        }
        let calendars: Option<Retained<NSArray<AnyObject>>> =
            msg_send![store, calendarsForEntityType: 0usize];
        let calendars = calendars.ok_or(ReadError::Failed)?;
        let count: usize = msg_send![&*calendars, count];
        let mut batch = Batch::default();
        let mut selected = Vec::new();
        for index in 0..count.min(agenda::MAX_CALENDARS) {
            if ticket.cancelled() {
                return Err(ReadError::Cancelled);
            }
            let raw: *mut AnyObject = msg_send![&*calendars, objectAtIndex: index];
            let Some(calendar) = Retained::retain(raw) else {
                continue;
            };
            let Some(id) = text(
                msg_send![&*calendar, calendarIdentifier],
                agenda::MAX_ID_BYTES,
            ) else {
                continue;
            };
            if !agenda::valid_id(&id) {
                continue;
            }
            let title = text(msg_send![&*calendar, title], 4096)
                .map(|s| sanitize_title(&s).chars().take(60).collect())
                .unwrap_or_else(|| "Calendar".into());
            let source: Option<Retained<AnyObject>> = msg_send![&*calendar, source];
            let kind: isize = source
                .map(|source| msg_send![&*source, sourceType])
                .unwrap_or(0);
            let source_label = match kind {
                0 => "On this Mac",
                1 => "Exchange",
                2 => "Synced calendar",
                3 => "Subscribed",
                4 => "iCloud",
                5 => "Birthdays",
                _ => "Apple Calendar",
            }
            .to_string();
            let included = agenda::included(ticket.ids.as_deref(), &id);
            batch.calendars.push(CalendarSummary {
                id,
                title,
                source_label,
                included,
            });
            if included {
                selected.push(calendar);
            }
        }
        batch.truncated = count > agenda::MAX_CALENDARS;
        // EventKit's nil calendar filter means ALL; an explicit empty choice must
        // return no events, never accidentally widen the query.
        if selected.is_empty() {
            return Ok(batch);
        }
        let start = object_date(ticket.horizon.start).ok_or(ReadError::Failed)?;
        let end = object_date(ticket.horizon.end).ok_or(ReadError::Failed)?;
        let selected = NSArray::from_retained_slice(&selected);
        let predicate: Option<Retained<AnyObject>> = msg_send![store, predicateForEventsWithStartDate: &*start, endDate: &*end, calendars: &*selected];
        let predicate = predicate.ok_or(ReadError::Failed)?;
        let (_, zone) = calendar_and_zone(None).ok_or(ReadError::Failed)?;
        let f = formatter(&zone).ok_or(ReadError::Failed)?;
        let results = RefCell::new(batch);
        let scanned = Cell::new(0usize);
        let block = RcBlock::new(|event: *mut AnyObject, stop: *mut Bool| {
            if ticket.cancelled() || scanned.get() >= 10_000 {
                if !stop.is_null() {
                    *stop = Bool::YES;
                }
                results.borrow_mut().truncated = true;
                return;
            }
            scanned.set(scanned.get() + 1);
            if event.is_null() {
                return;
            }
            let status: isize = msg_send![event, status];
            if status == 2 {
                return;
            }
            let start: Option<Retained<AnyObject>> = msg_send![event, startDate];
            let end: Option<Retained<AnyObject>> = msg_send![event, endDate];
            let (Some(start), Some(end)) = (start, end) else {
                return;
            };
            let a: f64 = msg_send![&*start, timeIntervalSince1970];
            let b: f64 = msg_send![&*end, timeIntervalSince1970];
            if !a.is_finite()
                || !b.is_finite()
                || b <= a
                || a >= ticket.horizon.end as f64
                || b <= ticket.horizon.start as f64
            {
                return;
            }
            let calendar: Option<Retained<AnyObject>> = msg_send![event, calendar];
            let Some(calendar) = calendar else {
                return;
            };
            let Some(calendar_id) = text(
                msg_send![&*calendar, calendarIdentifier],
                agenda::MAX_ID_BYTES,
            ) else {
                return;
            };
            if !results
                .borrow()
                .calendars
                .iter()
                .any(|c| c.id == calendar_id && c.included)
            {
                return;
            }
            let Some(id) = text(msg_send![event, eventIdentifier], agenda::MAX_ID_BYTES) else {
                return;
            };
            let title = text(msg_send![event, title], 4096)
                .map(|s| sanitize_title(&s))
                .unwrap_or_else(|| "Untitled event".into());
            let all_day: Bool = msg_send![event, isAllDay];
            let is_all_day = all_day.as_bool();
            // All-day dates use the event zone when supplied. Its exclusive end
            // is converted to the last inclusive day before leaving the adapter.
            let event_zone: Option<Retained<AnyObject>> = if is_all_day {
                msg_send![event, timeZone]
            } else {
                None
            };
            let _: () = msg_send![&*f, setTimeZone: event_zone.as_deref().unwrap_or(&zone)];
            let Some((local_date, end_local_date)) =
                event_dates(&f, &start, &end, b as i64, is_all_day)
            else {
                return;
            };
            let url: Option<Retained<AnyObject>> = msg_send![event, URL];
            let url = url.and_then(|url| text(msg_send![&*url, absoluteString], 4096));
            let location = text(msg_send![event, location], 4096);
            let has_meeting_link =
                event_has_meeting_link(url.as_deref(), location.as_deref(), None);
            let occurrence_key = Event::key(
                &calendar_id,
                &id,
                a as i64,
                is_all_day.then_some(local_date.as_str()),
            );
            let value = Event {
                occurrence_key,
                title,
                calendar_id,
                calendar_title: String::new(),
                is_all_day,
                local_date,
                end_local_date,
                start_epoch_s: a as i64,
                end_epoch_s: b as i64,
                has_meeting_link,
            };
            let mut out = results.borrow_mut();
            if out
                .events
                .iter()
                .any(|e| e.occurrence_key == value.occurrence_key)
            {
                return;
            }
            out.events.push(value);
            out.events.sort_by(|a, b| {
                (a.start_epoch_s, a.end_epoch_s, &a.occurrence_key).cmp(&(
                    b.start_epoch_s,
                    b.end_epoch_s,
                    &b.occurrence_key,
                ))
            });
            if out.events.len() > agenda::MAX_EVENTS {
                out.truncated = true;
                out.events.truncate(agenda::MAX_EVENTS);
            }
        });
        let _: () =
            msg_send![store, enumerateEventsMatchingPredicate: &*predicate, usingBlock: &*block];
        drop(block);
        if ticket.cancelled() {
            return Err(ReadError::Cancelled);
        }
        Ok(results.into_inner())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_day_exclusive_end_becomes_inclusive_across_dst() {
        autoreleasepool(|_| {
            let (_, zone) = calendar_and_zone(Some("America/New_York")).unwrap();
            let f = formatter(&zone).unwrap();
            for (start, end, first, last) in [
                (
                    "2026-03-08T05:00:00Z",
                    "2026-03-09T04:00:00Z",
                    "2026-03-08",
                    "2026-03-08",
                ),
                (
                    "2026-10-31T04:00:00Z",
                    "2026-11-03T05:00:00Z",
                    "2026-10-31",
                    "2026-11-02",
                ),
            ] {
                let start = chrono::DateTime::parse_from_rfc3339(start)
                    .unwrap()
                    .timestamp();
                let end = chrono::DateTime::parse_from_rfc3339(end)
                    .unwrap()
                    .timestamp();
                let dates = event_dates(
                    &f,
                    &object_date(start).unwrap(),
                    &object_date(end).unwrap(),
                    end,
                    true,
                )
                .unwrap();
                assert_eq!(dates, (first.into(), last.into()));
            }
        });
    }
    #[test]
    fn local_horizon_uses_calendar_days_across_both_dst_changes() {
        // Foundation dates only: never constructs EKEventStore or reads calendars.
        for (iso, hours, first, last) in [
            ("2026-03-08T12:00:00Z", 383, "2026-03-07", "2026-03-22"),
            ("2026-11-01T12:00:00Z", 385, "2026-10-31", "2026-11-15"),
        ] {
            let epoch = chrono::DateTime::parse_from_rfc3339(iso)
                .unwrap()
                .timestamp();
            let h = horizon(epoch, Some("America/New_York")).unwrap();
            assert_eq!((h.end - h.start) / 3600, hours);
            assert_eq!(h.start_date, first);
            assert_eq!(h.end_date, last);
            assert_eq!(h.timezone, "America/New_York");
        }
    }
}
