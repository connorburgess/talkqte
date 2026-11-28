//! Main-only agenda IPC. OS work never holds the session mutex; calendar events
//! are emitted only to main, never added to engine/companion snapshots.
use crate::{
    calendar::{CalendarSource, PermissionStatus},
    calendar_agenda::{self as agenda, Snapshot, Ticket},
    calendar_commands::CalendarBackend,
    AppState,
};
use std::time::Instant;
use tauri::{Emitter, Manager};

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "Only the notebook can use the agenda.".into())
}
fn supported() -> bool {
    cfg!(target_os = "macos") && !crate::settings::lab_run()
}
fn horizon() -> agenda::Horizon {
    let now = crate::calendar::now_epoch_secs();
    #[cfg(target_os = "macos")]
    {
        crate::calendar_agenda_macos::horizon(now, None)
            .unwrap_or_else(|| agenda::Horizon::utc(now))
    }
    #[cfg(not(target_os = "macos"))]
    {
        agenda::Horizon::utc(now)
    }
}
fn snapshot(app: &tauri::AppHandle) -> Result<Snapshot, String> {
    let state = app.state::<AppState>();
    snapshot_with(
        &state,
        supported(),
        || app.state::<CalendarBackend>().0.authorization_status(),
        horizon,
    )
}
/// Authorization and local-clock reads stay outside the session lock. The seam
/// permits held fictional reads without constructing a Tauri app or EventKit.
fn snapshot_with(
    state: &AppState,
    available: bool,
    authorization: impl FnOnce() -> PermissionStatus,
    clock: impl FnOnce() -> agenda::Horizon,
) -> Result<Snapshot, String> {
    let (enabled, revision) = {
        let runtime = state.0.lock().map_err(|_| "The agenda is unavailable.")?;
        (
            runtime.calendar_agenda.enabled(),
            runtime.calendar_agenda.snapshot.revision,
        )
    };
    let permission = if !available {
        PermissionStatus::Unavailable
    } else if enabled {
        authorization()
    } else {
        PermissionStatus::Off
    };
    let clock = clock();
    let mut runtime = state.0.lock().map_err(|_| "The agenda is unavailable.")?;
    // A newer enable, reset, filter, clock, permission or worker result wins
    // over this out-of-lock observation. Never retire its ticket or cache.
    if runtime.calendar_agenda.snapshot.revision == revision {
        runtime.calendar_agenda.clock(clock);
        let permission = if !available {
            PermissionStatus::Unavailable
        } else if runtime.calendar_agenda.enabled() {
            permission
        } else {
            PermissionStatus::Off
        };
        runtime.calendar_agenda.permission(permission);
    }
    let live = runtime.live_session_open();
    let prompts = runtime.calendar.enabled();
    Ok(runtime.calendar_agenda.view(Instant::now(), live, prompts))
}

fn emit(app: &tauri::AppHandle, snapshot: &Snapshot) {
    let _ = app.emit_to("main", "calendar:agenda-changed", snapshot);
}
pub(crate) fn emit_current(app: &tauri::AppHandle) {
    if let Ok(snapshot) = snapshot(app) {
        emit(app, &snapshot);
    }
}
fn begin(app: &tauri::AppHandle) -> Option<Ticket> {
    let state = app.state::<AppState>();
    let mut runtime = state.0.lock().ok()?;
    let live = runtime.live_session_open();
    runtime.calendar_agenda.begin(Instant::now(), live)
}
fn dispatch(app: &tauri::AppHandle) {
    if let Some(ticket) = begin(app) {
        emit_current(app);
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || worker(&app, ticket));
    }
}
fn read(
    backend: &dyn CalendarSource,
    ticket: &Ticket,
) -> (PermissionStatus, Result<agenda::Batch, agenda::ReadError>) {
    if ticket.cancelled() {
        return (PermissionStatus::Off, Err(agenda::ReadError::Cancelled));
    }
    let mut auth = backend.authorization_status();
    if auth == PermissionStatus::Off && ticket.request_permission && !ticket.cancelled() {
        auth = backend.request_access();
    }
    if ticket.cancelled() {
        return (auth, Err(agenda::ReadError::Cancelled));
    }
    if auth != PermissionStatus::Connected {
        return (auth, Err(agenda::ReadError::Unavailable));
    }
    let result = backend.agenda(ticket);
    // Revocation during enumeration wins before accepting any projected fields.
    (backend.authorization_status(), result)
}
fn worker(app: &tauri::AppHandle, mut ticket: Ticket) {
    loop {
        let (auth, result) = read(app.state::<CalendarBackend>().0.as_ref(), &ticket);
        let state = app.state::<AppState>();
        if let Ok(mut runtime) = state.0.lock() {
            runtime.calendar_agenda.finish(
                &ticket,
                auth,
                result,
                Instant::now(),
                crate::calendar::now_epoch_secs(),
            );
        }
        emit_current(app);
        let Some(next) = begin(app) else {
            break;
        };
        ticket = next;
    }
}
#[tauri::command]
pub(crate) fn calendar_agenda(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Snapshot, String> {
    main_only(&window)?;
    let value = snapshot(&app)?;
    emit(&app, &value);
    Ok(value)
}
#[tauri::command]
pub(crate) fn set_calendar_agenda(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<Snapshot, String> {
    main_only(&window)?;
    if !supported() {
        return snapshot(&app);
    }
    let enable_revision = {
        let state = app.state::<AppState>();
        let mut runtime = state.0.lock().map_err(|_| "The agenda is unavailable.")?;
        let revision = runtime.calendar_agenda.set_enabled(enabled);
        crate::settings_commands::record(&app, |settings| settings.calendar_agenda = enabled);
        revision
    };
    let _ = snapshot(&app)?;
    if enabled {
        app.state::<AppState>()
            .0
            .lock()
            .map_err(|_| "The agenda is unavailable.")?
            .calendar_agenda
            .request_for_enable(enable_revision, Instant::now());
        dispatch(&app);
    }
    let value = snapshot(&app)?;
    emit(&app, &value);
    Ok(value)
}
#[tauri::command]
pub(crate) fn set_included_calendars(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<Snapshot, String> {
    main_only(&window)?;
    let ids = agenda::included_ids(ids).map_err(str::to_owned)?;
    if !supported() {
        return snapshot(&app);
    }
    {
        let state = app.state::<AppState>();
        let mut runtime = state.0.lock().map_err(|_| "The agenda is unavailable.")?;
        runtime.calendar_agenda.set_ids(ids.clone());
        crate::settings_commands::record(&app, |settings| {
            settings.calendar_selected_ids = Some(ids)
        });
        runtime.calendar_agenda.request(false, Instant::now());
    }
    let _ = snapshot(&app)?;
    dispatch(&app);
    let value = snapshot(&app)?;
    emit(&app, &value);
    Ok(value)
}
#[tauri::command]
pub(crate) fn refresh_calendar_agenda(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Snapshot, String> {
    main_only(&window)?;
    let _ = snapshot(&app)?;
    app.state::<AppState>()
        .0
        .lock()
        .map_err(|_| "The agenda is unavailable.")?
        .calendar_agenda
        .request(false, Instant::now());
    dispatch(&app);
    let value = snapshot(&app)?;
    emit(&app, &value);
    Ok(value)
}
pub(crate) fn resume(app: &tauri::AppHandle) {
    let Ok(value) = snapshot(app) else {
        return;
    };
    if !value.agenda_enabled || value.paused_while_live {
        return;
    }
    if let Ok(mut runtime) = app.state::<AppState>().0.lock() {
        runtime.calendar_agenda.resume(Instant::now());
    }
    dispatch(app);
}
pub(crate) fn install(app: &tauri::AppHandle) {
    if !supported() {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("talkqte-agenda".into())
        .spawn(move || {
            let mut published = 0;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let state = app.state::<AppState>();
                if !state
                    .0
                    .lock()
                    .is_ok_and(|runtime| runtime.calendar_agenda.enabled())
                {
                    continue;
                }
                let signal = app.state::<CalendarBackend>().0.agenda_change_version();
                if snapshot(&app).is_err() {
                    continue;
                }
                if let Ok(mut runtime) = state.0.lock() {
                    let live = runtime.live_session_open();
                    runtime.calendar_agenda.tick(Instant::now(), live, signal);
                }
                dispatch(&app);
                if let Ok(value) = snapshot(&app) {
                    if value.revision != published {
                        emit(&app, &value);
                        published = value.revision;
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::CalendarEvent;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[test]
    fn held_authorization_read_cannot_retire_a_newer_enabled_refresh() {
        use std::sync::{mpsc, Arc, Mutex};
        for auth in [PermissionStatus::Off, PermissionStatus::Denied] {
            for ready in [false, true] {
                let state = Arc::new(AppState(Mutex::new(crate::Runtime::default())));
                let old_clock = agenda::Horizon::utc(1_800_000_000);
                let new_clock = agenda::Horizon::utc(1_800_086_400);
                {
                    let mut runtime = state.0.lock().unwrap();
                    runtime.calendar_agenda.clock(old_clock.clone());
                    runtime.calendar_agenda.set_enabled(true);
                    runtime
                        .calendar_agenda
                        .permission(PermissionStatus::Connected);
                }
                let (entered, started) = mpsc::channel();
                let (release, held) = mpsc::channel();
                let reader_state = state.clone();
                let reader = std::thread::spawn(move || {
                    snapshot_with(
                        &reader_state,
                        true,
                        || {
                            entered.send(()).unwrap();
                            held.recv().unwrap();
                            auth
                        },
                        || old_clock,
                    )
                    .unwrap()
                });
                started
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap();
                let (ticket, revision) = {
                    let mut runtime = state.0.lock().unwrap();
                    let a = &mut runtime.calendar_agenda;
                    a.set_enabled(false);
                    a.set_enabled(true);
                    a.clock(new_clock.clone());
                    a.permission(PermissionStatus::Connected);
                    a.request(true, Instant::now());
                    let ticket = a.begin(Instant::now(), false).unwrap();
                    if ready {
                        let batch = agenda::Batch {
                            calendars: vec![agenda::CalendarSummary {
                                id: "atlas".into(),
                                title: "Atlas".into(),
                                source_label: "On this Mac".into(),
                                included: true,
                            }],
                            ..Default::default()
                        };
                        a.finish(
                            &ticket,
                            PermissionStatus::Connected,
                            Ok(batch),
                            Instant::now(),
                            1_800_086_400,
                        );
                    }
                    let revision = a.view(Instant::now(), false, false).revision;
                    (ticket, revision)
                };
                release.send(()).unwrap();
                let value = reader.join().unwrap();
                assert_eq!(
                    value.permission,
                    PermissionStatus::Connected,
                    "held old authorization must not overwrite newer opt-in"
                );
                assert_eq!(
                    value.sync_state,
                    if ready {
                        agenda::SyncState::Ready
                    } else {
                        agenda::SyncState::Loading
                    }
                );
                assert_eq!(value.today_local_date, new_clock.today);
                assert_eq!(value.revision, revision);
                if ready {
                    assert_eq!(value.calendars.len(), 1);
                    assert!(value.last_updated_epoch_ms.is_some());
                }
                assert!(
                    !ticket.cancelled(),
                    "held old authorization must not cancel the newer worker"
                );
            }
        }
    }
    #[test]
    fn fresh_authorization_applies_but_off_and_unavailable_never_read_the_source() {
        use std::sync::Mutex;
        let state = AppState(Mutex::new(crate::Runtime::default()));
        let clock = || agenda::Horizon::utc(1_800_000_000);
        let off = snapshot_with(
            &state,
            true,
            || panic!("off agenda must not read authorization"),
            clock,
        )
        .unwrap();
        assert_eq!(off.permission, PermissionStatus::Off);
        state.0.lock().unwrap().calendar_agenda.set_enabled(true);
        let denied = snapshot_with(&state, true, || PermissionStatus::Denied, clock).unwrap();
        assert_eq!(denied.permission, PermissionStatus::Denied);
        let connected = snapshot_with(&state, true, || PermissionStatus::Connected, clock).unwrap();
        assert_eq!(connected.permission, PermissionStatus::Connected);
        let unavailable = snapshot_with(
            &state,
            false,
            || panic!("lab/nonmac must not read authorization"),
            clock,
        )
        .unwrap();
        assert_eq!(unavailable.permission, PermissionStatus::Unavailable);
        assert!(unavailable.calendars.is_empty());
    }
    struct Fake {
        calls: AtomicUsize,
        revoke: bool,
        cancel_on_permission: bool,
        ticket: Ticket,
    }
    impl CalendarSource for Fake {
        fn authorization_status(&self) -> PermissionStatus {
            if self.revoke && self.calls.load(Ordering::SeqCst) > 0 {
                PermissionStatus::Denied
            } else if self.cancel_on_permission {
                PermissionStatus::Off
            } else {
                PermissionStatus::Connected
            }
        }
        fn request_access(&self) -> PermissionStatus {
            // Simulate a permission dialog completing after the user disables.
            self.ticket.cancel_for_test();
            PermissionStatus::Connected
        }
        fn agenda(&self, _: &Ticket) -> Result<agenda::Batch, agenda::ReadError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(agenda::Batch::default())
        }
        fn upcoming_events(&self, _: i64, _: i64) -> Vec<CalendarEvent> {
            panic!("agenda must not widen prompt scan")
        }
    }
    fn ticket() -> Ticket {
        let mut a = agenda::Agenda::default();
        a.set_enabled(true);
        a.request(true, Instant::now());
        a.begin(Instant::now(), false).unwrap()
    }
    #[test]
    fn late_permission_completion_never_queries_after_disable() {
        let t = ticket();
        let fake = Fake {
            calls: AtomicUsize::new(0),
            revoke: false,
            cancel_on_permission: true,
            ticket: t.clone(),
        };
        assert_eq!(read(&fake, &t).1.unwrap_err(), agenda::ReadError::Cancelled);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn authorization_is_rechecked_after_projection() {
        let t = ticket();
        let fake = Fake {
            calls: AtomicUsize::new(0),
            revoke: true,
            cancel_on_permission: false,
            ticket: t.clone(),
        };
        assert_eq!(read(&fake, &t).0, PermissionStatus::Denied);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn already_cancelled_work_never_touches_source() {
        struct NoReads;
        impl CalendarSource for NoReads {
            fn authorization_status(&self) -> PermissionStatus {
                panic!("authorization read")
            }
            fn request_access(&self) -> PermissionStatus {
                panic!("permission request")
            }
            fn upcoming_events(&self, _: i64, _: i64) -> Vec<CalendarEvent> {
                panic!("event read")
            }
        }
        let t = ticket();
        t.cancel_for_test();
        assert_eq!(
            read(&NoReads, &t).1.unwrap_err(),
            agenda::ReadError::Cancelled
        );
    }
}
