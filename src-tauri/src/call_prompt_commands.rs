//! The call-starting prompt's commands and its macOS watcher thread. The
//! settings are the main window's; the companion can only answer an offer.

use crate::{
    call_prompt::{Answer, Settings},
    AppState,
};
use tauri::{Emitter, Manager};

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

/// Turn the prompt on or off for this launch. Off stops every read of the
/// microphone's in-use state and the frontmost application.
#[tauri::command]
pub(crate) fn set_call_prompt(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<Settings, String> {
    main_only(&window)?;
    let settings = {
        let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
        if runtime.call_prompt.set_enabled(enabled) {
            changed(&app, &mut runtime);
        }
        runtime.call_prompt.settings().clone()
    };
    crate::companion::refresh(&app);
    Ok(settings)
}

#[tauri::command]
pub(crate) fn clear_call_prompt_apps(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
) -> Result<Settings, String> {
    main_only(&window)?;
    let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
    runtime.call_prompt.clear_not_for();
    Ok(runtime.call_prompt.settings().clone())
}

/// The companion's answer to offer `id`. Start opens the notebook with the
/// offer's sources chosen; nothing is started, listed or captured here.
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
        changed(&app, &mut runtime);
        start
    };
    crate::companion::refresh(&app);
    if let Some(preselect) = start {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.unminimize();
            // The person clicked Start: bringing the notebook forward is
            // what they asked for.
            let _ = main.set_focus();
        }
        // The name and bundle identifier go to the notebook only.
        let _ = app.emit_to("main", "call-prompt:start", preselect);
    }
    Ok(())
}

/// Read the two signals once a second while the prompt is on; nothing at all
/// while it is off. The reads happen without the runtime lock.
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
                .is_ok_and(|runtime| runtime.call_prompt.enabled())
            {
                continue;
            }
            let signals = crate::call_prompt::native::read();
            let microphone_busy = app
                .state::<crate::microphone::Controller>()
                .try_not_capturing()
                != Some(true);
            let Ok(mut runtime) = state.0.lock() else {
                continue;
            };
            let busy = microphone_busy || runtime.live_session_open();
            if runtime
                .call_prompt
                .observe(&signals, busy, std::time::Instant::now())
            {
                changed(&app, &mut runtime);
                drop(runtime);
                crate::companion::refresh(&app);
            }
        });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install(_: &tauri::AppHandle) {}
