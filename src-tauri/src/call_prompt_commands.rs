//! The call-starting prompt's commands and its macOS watcher thread. The
//! settings are the main window's; the companion can only answer an offer.

use crate::{
    call_prompt::{Answer, Settings},
    AppState,
};
#[cfg(target_os = "macos")]
use tauri::Manager;

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "Only the notebook can change this.".into())
}

fn changed(app: &tauri::AppHandle, runtime: &mut crate::Runtime) {
    crate::publish(app, runtime);
}

#[tauri::command]
pub(crate) fn call_prompt_settings(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
) -> Result<Settings, String> {
    main_only(&window)?;
    let runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
    Ok(runtime.call_prompt.settings().clone())
}

/// Turn the prompt or auto-start on or off; the choice is saved. Off stops
/// every read of the microphone's in-use state and the frontmost application.
#[tauri::command]
pub(crate) fn set_call_prompt(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    enabled: Option<bool>,
    auto_start: Option<bool>,
) -> Result<Settings, String> {
    main_only(&window)?;
    if auto_start == Some(true) && crate::settings::lab_run() {
        return Err("Lab runs do not enable automatic session start.".into());
    }
    let settings = {
        let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
        let mut did_change = false;
        if let Some(enabled) = enabled {
            did_change |= runtime.call_prompt.set_enabled(enabled);
        }
        if let Some(auto_start) = auto_start {
            did_change |= runtime.call_prompt.set_auto_start(auto_start);
        }
        if did_change {
            changed(&app, &mut runtime);
        }
        crate::settings_commands::record_call_prompt(&app, &runtime.call_prompt);
        runtime.call_prompt.settings().clone()
    };
    crate::companion::refresh(&app);
    Ok(settings)
}

#[tauri::command]
pub(crate) fn clear_call_prompt_apps(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<Settings, String> {
    main_only(&window)?;
    let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
    runtime.call_prompt.clear_not_for();
    crate::settings_commands::record_call_prompt(&app, &runtime.call_prompt);
    Ok(runtime.call_prompt.settings().clone())
}

/// The companion's answer to offer `id`. Start immediately begins a live
/// session (or opens the notebook if keys are missing).
#[tauri::command]
pub(crate) fn respond_to_call_prompt(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    id: u64,
    answer: Answer,
) -> Result<(), String> {
    let start = {
        let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
        let start = runtime
            .call_prompt
            .answer(id, answer, std::time::Instant::now());
        // Not for this app and Don't ask again are saved choices.
        crate::settings_commands::record_call_prompt(&app, &runtime.call_prompt);
        changed(&app, &mut runtime);
        start
    };
    crate::companion::refresh(&app);
    if let Some(_preselect) = start {
        if crate::live_unavailable().is_some() {
            // Keys are missing: bring the notebook forward so the person sees why.
            crate::menu_bar::show_notebook(&app);
        } else {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::start_live_session_now(app, None, false).await;
            });
        }
    }
    Ok(())
}

/// Read the two signals once a second while the prompt or auto-start is on;
/// nothing at all while both are off. The reads happen without the runtime
/// lock.
#[cfg(target_os = "macos")]
pub(crate) fn install(app: &tauri::AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("talkqte-call-prompt".into())
        .spawn(move || loop {
            std::thread::sleep(crate::call_prompt::POLL);
            let state = app.state::<AppState>();
            if !state
                .0
                .lock()
                .is_ok_and(|runtime| runtime.call_prompt.watching())
            {
                continue;
            }
            let signals = crate::call_prompt::native::read();
            let can_auto_start = !crate::settings::lab_run() && crate::live_unavailable().is_none();
            let microphone_busy = app
                .state::<crate::microphone::Controller>()
                .try_not_capturing()
                != Some(true)
                || app.state::<crate::dictation::Controller>().is_active();
            let Ok(mut runtime) = state.0.lock() else {
                continue;
            };
            let busy = microphone_busy || runtime.live_session_open();
            let observation = runtime.call_prompt.observe_with(
                &signals,
                busy,
                can_auto_start,
                std::time::Instant::now(),
            );
            if observation.prompt_changed {
                changed(&app, &mut runtime);
            }
            let auto_start = observation.auto_start;
            let should_refresh = observation.prompt_changed || auto_start.is_some();
            drop(runtime);
            if should_refresh {
                crate::companion::refresh(&app);
            }
            if auto_start.is_some() {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::start_live_session_now(app, None, true).await;
                });
            }
        });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install(_: &tauri::AppHandle) {}
