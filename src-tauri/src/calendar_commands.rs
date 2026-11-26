//! Tauri commands and macOS polling thread for opt-in calendar pre-call prompts.
//!
//! Settings belong to the main notebook window only. The floating companion
//! receives only the narrow `calendarPrompt` summary and can only reply with
//! `respond_to_calendar_prompt` (Start or Dismiss). Calendar access is never
//! queried or requested while off or during lab runs.

use crate::{
    calendar::{self, Answer, CalendarSource, PermissionStatus, Settings},
    AppState,
};
use tauri::{Emitter, Manager};

/// Managed calendar backend (`EventKitSource` on macOS outside lab runs;
/// `UnavailableSource` otherwise).
pub(crate) struct CalendarBackend(pub Box<dyn CalendarSource>);

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "Only the notebook can change this.".into())
}

fn current_settings(enabled: bool, backend: &dyn CalendarSource) -> Settings {
    if !enabled {
        return Settings {
            enabled: false,
            status: if cfg!(target_os = "macos") && !crate::settings::lab_run() {
                PermissionStatus::Off
            } else {
                PermissionStatus::Unavailable
            },
            error: None,
        };
    }
    let os_status = backend.authorization_status();
    let status = match (os_status, enabled) {
        (PermissionStatus::Unavailable, _) => PermissionStatus::Unavailable,
        (_, false) => PermissionStatus::Off,
        (PermissionStatus::Denied, true) => PermissionStatus::Denied,
        (PermissionStatus::Connected, true) => PermissionStatus::Connected,
        (PermissionStatus::Off, true) => PermissionStatus::Off,
    };
    Settings {
        enabled: enabled && os_status != PermissionStatus::Unavailable,
        status,
        error: None,
    }
}

#[tauri::command]
pub(crate) fn calendar_settings(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
    backend: tauri::State<CalendarBackend>,
) -> Result<Settings, String> {
    main_only(&window)?;
    let enabled = state
        .0
        .lock()
        .map_err(|_| "The session is unavailable.")?
        .calendar
        .enabled();
    Ok(current_settings(enabled, backend.0.as_ref()))
}

fn request_is_current(state: &AppState, revision: u64) -> bool {
    state
        .0
        .lock()
        .is_ok_and(|runtime| runtime.calendar.settings_change_is_current(revision))
}

fn settings_snapshot(state: &AppState, backend: &dyn CalendarSource) -> Result<Settings, String> {
    let enabled = state
        .0
        .lock()
        .map_err(|_| "The session is unavailable.")?
        .calendar
        .enabled();
    Ok(current_settings(enabled, backend))
}

fn read_events_for_request(
    state: &AppState,
    backend: &dyn CalendarSource,
    revision: u64,
    now: i64,
) -> Vec<calendar::CalendarEvent> {
    let may_read = state.0.lock().is_ok_and(|runtime| {
        runtime.calendar.settings_change_is_current(revision) && !runtime.live_session_open()
    });
    if !may_read {
        return Vec::new();
    }
    backend.upcoming_events(
        now - calendar::IN_PROGRESS_WINDOW_SECS,
        now + calendar::UPCOMING_WINDOW_SECS,
    )
}

/// Turns calendar pre-call prompts on or off and saves the choice. Turning on
/// asks macOS for Calendar access if not yet determined, and immediately checks
/// the tight window when connected.
#[tauri::command]
pub(crate) async fn set_calendar_prompts(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    backend: tauri::State<'_, CalendarBackend>,
    enabled: bool,
) -> Result<Settings, String> {
    main_only(&window)?;
    if !enabled {
        {
            let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
            if runtime.calendar.set_enabled(false) {
                crate::publish(&app, &mut runtime);
            }
            runtime.pending_calendar_title = None;
            crate::settings_commands::record_calendar_prompts(&app, false);
        }
        crate::companion::refresh(&app);
        return Ok(current_settings(false, backend.0.as_ref()));
    }

    let revision = state
        .0
        .lock()
        .map_err(|_| "The session is unavailable.")?
        .calendar
        .begin_settings_change();
    let before = backend.0.authorization_status();
    if before == PermissionStatus::Unavailable {
        return Ok(Settings {
            enabled: false,
            status: PermissionStatus::Unavailable,
            error: Some("Calendar prompts are not available on this platform yet.".into()),
        });
    }

    let auth = if before == PermissionStatus::Off {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if !request_is_current(&handle.state::<AppState>(), revision) {
                return PermissionStatus::Off;
            }
            handle.state::<CalendarBackend>().0.request_access()
        })
        .await
        .map_err(|_| "Could not check Calendar permission.".to_string())?
    } else {
        before
    };

    // A newer disable/reset wins even if an OS permission request just completed.
    if !request_is_current(&state, revision) {
        return settings_snapshot(&state, backend.0.as_ref());
    }
    let events = if auth == PermissionStatus::Connected {
        let handle = app.clone();
        let now = calendar::now_epoch_secs();
        tauri::async_runtime::spawn_blocking(move || {
            read_events_for_request(
                &handle.state::<AppState>(),
                handle.state::<CalendarBackend>().0.as_ref(),
                revision,
                now,
            )
        })
        .await
        .unwrap_or_default()
    } else {
        Vec::new()
    };

    {
        let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
        let Some(mut changed) = runtime.calendar.finish_settings_change(revision, true) else {
            let enabled = runtime.calendar.enabled();
            drop(runtime);
            return Ok(current_settings(enabled, backend.0.as_ref()));
        };
        crate::settings_commands::record_calendar_prompts(&app, true);
        let busy = runtime.live_session_open();
        if auth == PermissionStatus::Connected {
            changed |= runtime
                .calendar
                .observe(&events, busy, calendar::now_epoch_secs());
        } else {
            changed |= runtime.calendar.clear_active();
        }
        if changed {
            crate::publish(&app, &mut runtime);
        }
    }
    crate::companion::refresh(&app);
    Ok(current_settings(true, backend.0.as_ref()))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CalendarStart {
    title: String,
}

/// Companion answer to pre-call prompt `id`. Start opens the notebook with the
/// matched event title pre-filled as the default meeting title; it never starts
/// capture or sends anything on its own.
#[tauri::command]
pub(crate) fn respond_to_calendar_prompt(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    id: u64,
    answer: Answer,
) -> Result<(), String> {
    let title = {
        let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
        let title = runtime.calendar.answer(id, answer);
        if let Some(ref matched) = title {
            runtime.pending_calendar_title = Some(matched.clone());
        }
        crate::publish(&app, &mut runtime);
        title
    };
    crate::companion::refresh(&app);
    if let Some(title) = title {
        crate::menu_bar::show_notebook(&app);
        let _ = app.emit_to("main", "calendar-prompt:start", CalendarStart { title });
    }
    Ok(())
}

/// Opens System Settings → Privacy & Security → Calendars on macOS when permission
/// was previously denied.
#[tauri::command]
pub(crate) fn open_calendar_settings(window: tauri::WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    #[cfg(target_os = "macos")]
    {
        open::that("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
            .map_err(|_| "Could not open System Settings.".to_string())?;
    }
    Ok(())
}

/// Polls EventKit every 15 seconds while opt-in is enabled and no live session
/// is open. Does nothing at all while disabled or in lab runs.
#[cfg(target_os = "macos")]
pub(crate) fn install(app: &tauri::AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("talkqte-calendar".into())
        .spawn(move || loop {
            std::thread::sleep(calendar::POLL_INTERVAL);
            let state = app.state::<AppState>();
            let should_poll = state
                .0
                .lock()
                .is_ok_and(|runtime| runtime.calendar.enabled() && !runtime.live_session_open());
            if !should_poll {
                continue;
            }
            let backend = app.state::<CalendarBackend>();
            if backend.0.authorization_status() != PermissionStatus::Connected {
                if let Ok(mut runtime) = state.0.lock() {
                    if runtime.calendar.clear_active() {
                        crate::publish(&app, &mut runtime);
                        drop(runtime);
                        crate::companion::refresh(&app);
                    }
                }
                continue;
            }
            let now = calendar::now_epoch_secs();
            let events = backend.0.upcoming_events(
                now - calendar::IN_PROGRESS_WINDOW_SECS,
                now + calendar::UPCOMING_WINDOW_SECS,
            );
            let Ok(mut runtime) = state.0.lock() else {
                continue;
            };
            let busy = runtime.live_session_open();
            if runtime.calendar.observe(&events, busy, now) {
                crate::publish(&app, &mut runtime);
                drop(runtime);
                crate::companion::refresh(&app);
            }
        });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install(_: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    struct MustNotRead;
    impl CalendarSource for MustNotRead {
        fn authorization_status(&self) -> PermissionStatus {
            panic!("disabled Calendar settings must not query authorization");
        }
        fn request_access(&self) -> PermissionStatus {
            panic!("disabled Calendar settings must not request access");
        }
        fn upcoming_events(&self, _: i64, _: i64) -> Vec<calendar::CalendarEvent> {
            panic!("disabled Calendar settings must not read events");
        }
    }

    #[test]
    fn a_newer_disable_wins_over_delayed_permission_or_event_results() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{mpsc, Arc, Mutex};
        use std::thread;

        struct DelayedSource {
            delay_permission: bool,
            started: mpsc::Sender<()>,
            resume: Mutex<mpsc::Receiver<()>>,
            fetches: AtomicUsize,
        }
        impl DelayedSource {
            fn delay(&self) {
                self.started.send(()).unwrap();
                self.resume.lock().unwrap().recv().unwrap();
            }
        }
        impl CalendarSource for DelayedSource {
            fn authorization_status(&self) -> PermissionStatus {
                PermissionStatus::Connected
            }
            fn request_access(&self) -> PermissionStatus {
                if self.delay_permission {
                    self.delay();
                }
                PermissionStatus::Connected
            }
            fn upcoming_events(&self, _: i64, _: i64) -> Vec<calendar::CalendarEvent> {
                self.fetches.fetch_add(1, Ordering::SeqCst);
                if !self.delay_permission {
                    self.delay();
                }
                vec![calendar::CalendarEvent {
                    id: "fictional-event".into(),
                    title: "Fictional Review".into(),
                    start_epoch_s: 1_700_000_120,
                    end_epoch_s: 1_700_001_800,
                    has_meeting_link: true,
                    is_all_day: false,
                }]
            }
        }

        for delay_permission in [true, false] {
            let state = Arc::new(AppState(Mutex::new(crate::Runtime::default())));
            let revision = state.0.lock().unwrap().calendar.begin_settings_change();
            let (started, waiting) = mpsc::channel();
            let (resume, resumed) = mpsc::channel();
            let backend = Arc::new(DelayedSource {
                delay_permission,
                started,
                resume: Mutex::new(resumed),
                fetches: AtomicUsize::new(0),
            });
            let worker_state = state.clone();
            let worker_backend = backend.clone();
            let work = thread::spawn(move || {
                assert_eq!(worker_backend.request_access(), PermissionStatus::Connected);
                let events = read_events_for_request(
                    &worker_state,
                    worker_backend.as_ref(),
                    revision,
                    1_700_000_000,
                );
                let mut runtime = worker_state.0.lock().unwrap();
                // This same gate precedes both persistence and prompt application in the command.
                assert_eq!(
                    runtime.calendar.finish_settings_change(revision, true),
                    None
                );
                assert!(!runtime.calendar.observe(&events, false, 1_700_000_000));
            });
            waiting
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            state.0.lock().unwrap().calendar.set_enabled(false);
            resume.send(()).unwrap();
            work.join().unwrap();
            assert_eq!(
                backend.fetches.load(Ordering::SeqCst),
                usize::from(!delay_permission)
            );
            let runtime = state.0.lock().unwrap();
            assert!(!runtime.calendar.enabled());
            assert!(runtime.calendar.prompt().is_none());
        }
    }

    #[test]
    fn inspecting_disabled_settings_never_touches_calendar() {
        let settings = current_settings(false, &MustNotRead);
        assert!(!settings.enabled);
        assert!(matches!(
            settings.status,
            PermissionStatus::Off | PermissionStatus::Unavailable
        ));
    }
}
