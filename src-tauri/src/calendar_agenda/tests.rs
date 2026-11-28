use super::*;

fn configured() -> (Agenda, Instant) {
    let now = Instant::now();
    let mut agenda = Agenda::default();
    agenda.clock(Horizon::utc(1_800_000_000));
    agenda.set_enabled(true);
    agenda.permission(PermissionStatus::Connected);
    agenda.request(false, now);
    (agenda, now)
}
fn calendar(id: &str) -> CalendarSummary {
    CalendarSummary {
        id: id.into(),
        title: "Project Atlas".into(),
        source_label: "On this Mac".into(),
        included: true,
    }
}
fn event(h: &Horizon, id: &str, n: i64) -> Event {
    Event {
        occurrence_key: Event::key(id, "fictional-recurring-event", h.start + n, None),
        title: "Atlas planning".into(),
        calendar_id: id.into(),
        calendar_title: "untrusted".into(),
        is_all_day: false,
        local_date: h.start_date.clone(),
        end_local_date: h.start_date.clone(),
        start_epoch_s: h.start + n,
        end_epoch_s: h.start + n + 60,
        has_meeting_link: true,
    }
}
fn batch(h: &Horizon) -> Batch {
    Batch {
        calendars: vec![calendar("atlas")],
        events: vec![event(h, "atlas", 60)],
        truncated: false,
    }
}
fn complete(agenda: &mut Agenda, now: Instant) {
    let t = agenda.begin(now, false).unwrap();
    let data = batch(&t.horizon);
    agenda.finish(
        &t,
        PermissionStatus::Connected,
        Ok(data),
        now,
        1_800_000_000,
    );
}

#[test]
fn default_and_prompt_opt_in_do_not_enable_agenda() {
    let mut a = Agenda::default();
    a.request(true, Instant::now());
    assert!(a.begin(Instant::now(), false).is_none());
    let v = a.view(Instant::now(), false, true);
    assert!(!v.agenda_enabled);
    assert!(v.prompts_enabled);
    assert!(v.events.is_empty());
}
#[test]
fn filters_distinguish_all_none_and_removed_ids_without_widening() {
    let h = Horizon::utc(1_800_000_000);
    assert_eq!(normalize(batch(&h), &h, None).events.len(), 1);
    assert!(normalize(batch(&h), &h, Some(&[])).events.is_empty());
    assert!(normalize(batch(&h), &h, Some(&["removed-calendar".into()]))
        .events
        .is_empty());
    assert_eq!(parse_ids(None), None);
    assert_eq!(parse_ids(Some(&serde_json::Value::Null)), None);
    for raw in [
        serde_json::json!(false),
        serde_json::json!(["ok", 3]),
        serde_json::json!([""]),
    ] {
        assert_eq!(parse_ids(Some(&raw)), Some(vec![]));
    }
    assert!(included_ids(vec!["\n".into()]).is_err());
    assert!(included_ids(vec!["x".repeat(513)]).is_err());
    assert!(included_ids(vec!["id".into(); 101]).is_err());
}
#[test]
fn projection_is_bounded_deterministic_and_contains_only_contract_fields() {
    let h = Horizon::utc(1_800_000_000);
    let mut b = batch(&h);
    b.events = (1..=300)
        .rev()
        .map(|n| event(&h, "atlas", n * 60))
        .collect();
    b.events.push(event(&h, "unselected", 1));
    b.events.push(b.events[0].clone());
    b.events.push(event(&h, "atlas", -600)); // ends before horizon
    b.calendars[0].title = "\nAtlas\t\u{202e} planning".into();
    b.events[0].title = "x".repeat(1000);
    let a = normalize(b.clone(), &h, None);
    b.events.reverse();
    let c = normalize(b, &h, None);
    assert_eq!(a.events, c.events);
    assert_eq!(a.events.len(), MAX_EVENTS);
    assert!(a.truncated);
    assert!(a
        .events
        .windows(2)
        .all(|w| w[0].start_epoch_s <= w[1].start_epoch_s));
    assert!(a
        .events
        .iter()
        .all(|e| e.calendar_title == a.calendars[0].title && e.title.chars().count() <= 120));
    let value = serde_json::to_value(&a.events[0]).unwrap();
    let keys: Vec<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "calendarId",
            "calendarTitle",
            "endEpochS",
            "endLocalDate",
            "hasMeetingLink",
            "isAllDay",
            "localDate",
            "occurrenceKey",
            "startEpochS",
            "title"
        ]
    );
    assert!(!serde_json::to_string(&a.events)
        .unwrap()
        .contains("fictional-recurring-event"));
}
#[test]
fn occurrence_keys_distinguish_recurrences_and_preserve_all_day_date() {
    assert_ne!(
        Event::key("a", "series", 1, None),
        Event::key("a", "series", 2, None)
    );
    assert_ne!(
        Event::key("a", "series", 1, None),
        Event::key("b", "series", 1, None)
    );
    assert_eq!(
        Event::key("a", "series", 1, Some("2026-03-08")),
        Event::key("a", "series", 3601, Some("2026-03-08"))
    );
    assert_ne!(
        Event::key("a", "series", 1, Some("2026-03-08")),
        Event::key("a", "series", 1, Some("2026-03-09"))
    );
}
#[test]
fn disable_reenable_keeps_physical_slot_and_rejects_old_completion() {
    let (mut a, now) = configured();
    let old = a.begin(now, false).unwrap();
    a.set_enabled(false);
    assert!(old.cancelled());
    assert!(a.view(now, false, false).events.is_empty());
    a.set_enabled(true);
    a.permission(PermissionStatus::Connected);
    a.request(true, now);
    assert!(
        a.begin(now, false).is_none(),
        "blocked OS query must retain the physical slot"
    );
    a.finish(
        &old,
        PermissionStatus::Connected,
        Ok(batch(&old.horizon)),
        now,
        1,
    );
    assert!(a.snapshot.events.is_empty());
    complete(&mut a, now);
    assert_eq!(a.snapshot.events.len(), 1);
}
#[test]
fn filter_reset_and_clock_changes_discard_held_results() {
    for mode in 0..3 {
        let (mut a, now) = configured();
        let old = a.begin(now, false).unwrap();
        match mode {
            0 => a.set_ids(vec![]),
            1 => a.restore(false, None),
            _ => a.clock(Horizon::utc(1_800_086_400)),
        }
        assert!(old.cancelled());
        assert!(a.begin(now, false).is_none());
        a.finish(
            &old,
            PermissionStatus::Connected,
            Ok(batch(&old.horizon)),
            now,
            1,
        );
        assert!(a.snapshot.events.is_empty());
        assert_eq!(a.snapshot.last_updated_epoch_ms, None);
    }
}
#[test]
fn revocation_clears_previous_data_and_disallows_background_permission_requests() {
    let (mut a, now) = configured();
    complete(&mut a, now);
    a.request(false, now);
    let t = a.begin(now, false).unwrap();
    a.finish(&t, PermissionStatus::Denied, Ok(batch(&t.horizon)), now, 1);
    assert!(a.snapshot.events.is_empty());
    assert!(a.snapshot.calendars.is_empty());
    assert_eq!(a.snapshot.permission, PermissionStatus::Denied);
    a.tick(now + POLL, false, 1);
    assert!(a.begin(now + POLL, false).is_none());
}
#[test]
fn many_refreshes_coalesce_but_polling_during_flight_does_not_loop() {
    let (mut a, now) = configured();
    let first = a.begin(now, false).unwrap();
    a.tick(now + Duration::from_secs(1), false, 0);
    a.finish(
        &first,
        PermissionStatus::Connected,
        Ok(batch(&first.horizon)),
        now + Duration::from_secs(2),
        1,
    );
    assert!(a.begin(now + Duration::from_secs(2), false).is_none());
    a.request(false, now);
    let second = a.begin(now, false).unwrap();
    for _ in 0..100 {
        a.request(false, now);
        assert!(a.begin(now, false).is_none());
    }
    a.finish(
        &second,
        PermissionStatus::Connected,
        Ok(batch(&second.horizon)),
        now,
        1,
    );
    let rerun = a.begin(now, false).unwrap();
    a.finish(
        &rerun,
        PermissionStatus::Connected,
        Ok(batch(&rerun.horizon)),
        now,
        1,
    );
    assert!(a.begin(now, false).is_none());
}
#[test]
fn live_pauses_automatic_work_but_allows_manual_and_catches_up_on_end() {
    let (mut a, now) = configured();
    complete(&mut a, now);
    a.tick(now + POLL, true, 1);
    assert!(a.begin(now + POLL, true).is_none());
    assert!(a.view(now + POLL, true, false).paused_while_live);
    a.request(false, now + POLL);
    let t = a.begin(now + POLL, true).unwrap();
    a.finish(
        &t,
        PermissionStatus::Connected,
        Ok(batch(&t.horizon)),
        now + POLL,
        1,
    );
    a.tick(now + POLL, false, 1);
    assert!(a.begin(now + POLL, false).is_some());
}
#[test]
fn error_retains_cache_with_backoff_and_monotonic_staleness() {
    let (mut a, now) = configured();
    complete(&mut a, now);
    a.request(false, now);
    let t = a.begin(now, false).unwrap();
    a.finish(
        &t,
        PermissionStatus::Connected,
        Err(ReadError::Failed),
        now,
        1,
    );
    assert_eq!(a.snapshot.events.len(), 1);
    assert_eq!(a.snapshot.error.as_deref(), Some(READ_ERROR));
    a.tick(now + Duration::from_secs(14), false, 0);
    assert!(a.begin(now + Duration::from_secs(14), false).is_none());
    a.tick(now + Duration::from_secs(15), false, 0);
    assert!(a.begin(now + Duration::from_secs(15), false).is_some());
    assert!(!a.view(now + STALE_AFTER, false, false).stale);
    assert!(
        a.view(now + STALE_AFTER + Duration::from_secs(1), false, false)
            .stale
    );
}
#[test]
fn notification_bursts_debounce_and_deadline_rejects_late_success() {
    let (mut a, now) = configured();
    complete(&mut a, now);
    a.tick(now, false, 1);
    a.tick(now + Duration::from_millis(400), false, 2);
    a.tick(now + Duration::from_millis(600), false, 2);
    assert!(a.begin(now + Duration::from_millis(600), false).is_none());
    a.tick(now + Duration::from_millis(900), false, 2);
    let t = a.begin(now + Duration::from_millis(900), false).unwrap();
    a.finish(
        &t,
        PermissionStatus::Connected,
        Ok(batch(&t.horizon)),
        t.deadline,
        1,
    );
    assert_eq!(a.snapshot.sync_state, SyncState::Error);
    assert_eq!(a.snapshot.last_updated_epoch_ms, Some(1_800_000_000_000));
}

#[test]
fn oversized_escaped_selection_cannot_overflow_the_settings_budget() {
    let ids = (0..100)
        .map(|n| format!("{n}{}", "\"".repeat(500)))
        .collect();
    assert!(included_ids(ids).is_err());
}
#[test]
fn repeated_errors_back_off_to_five_minutes_without_clearing_good_data() {
    let (mut a, mut now) = configured();
    complete(&mut a, now);
    a.request(false, now);
    for seconds in [15, 30, 60, 120, 300, 300] {
        let t = a.begin(now, false).unwrap();
        a.finish(
            &t,
            PermissionStatus::Connected,
            Err(ReadError::Failed),
            now,
            1,
        );
        assert_eq!(a.snapshot.events.len(), 1);
        a.tick(now + Duration::from_secs(seconds - 1), false, 0);
        assert!(a
            .begin(now + Duration::from_secs(seconds - 1), false)
            .is_none());
        now += Duration::from_secs(seconds);
        a.tick(now, false, 0);
    }
    assert!(a.begin(now, false).is_some());
}
