//! Applies the saved settings at launch, records the person's changes, and
//! the notebook's commands for panel sizes and Reset settings.

use crate::{
    settings::{Panels, Settings, Status, Store},
    AppState,
};
use tauri::Manager;

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "Only the notebook can change this.".into())
}

/// Puts `settings` into effect, all of them at once, under the runtime lock.
pub(crate) fn apply(runtime: &mut crate::Runtime, settings: &Settings) {
    crate::transcription::cloud::set_language(settings.transcription_language);
    // Checked when the file was read; a model no longer offered keeps the
    // default.
    if crate::meeting_notes::set_notes_model(settings.notes_model).is_err() {
        let _ = crate::meeting_notes::set_notes_model(crate::meeting_notes::DEFAULT_MODEL);
    }
    let engine = &mut runtime.engine;
    engine.set_question_size(settings.question_size);
    engine.set_companion_position(settings.companion_position);
    engine.set_sensitivity(settings.sensitivity);
    engine.set_overlay(settings.overlay_enabled);
    if engine.set_user_name(settings.user_name.clone()).is_err() {
        let _ = engine.set_user_name(None);
    }
    runtime
        .call_prompt
        .restore(settings.call_prompt_enabled, &settings.call_prompt_not_for);
}

/// Reads the settings file and applies it, before the first snapshot is
/// published. Development launch settings are applied after this, over it.
pub(crate) fn load(app: &tauri::AppHandle) {
    let (store, settings) = Store::for_app(app);
    if let Ok(mut runtime) = app.state::<AppState>().0.lock() {
        apply(&mut runtime, &settings);
    }
    app.manage(store);
}

/// Saves a change the person made. Nothing happens before the store exists.
pub(crate) fn record(app: &tauri::AppHandle, change: impl FnOnce(&mut Settings)) {
    if let Some(store) = app.try_state::<Store>() {
        store.record(change);
    }
}

/// Saves the call-starting prompt's choices.
pub(crate) fn record_call_prompt(app: &tauri::AppHandle, watcher: &crate::call_prompt::Watcher) {
    let enabled = watcher.enabled();
    let not_for = watcher.not_for_ids().to_vec();
    record(app, |settings| {
        settings.call_prompt_enabled = enabled;
        settings.call_prompt_not_for = not_for;
    });
}

/// Whether choices are being saved, and the last failure if any.
#[tauri::command]
pub(crate) fn settings_status(
    window: tauri::WebviewWindow,
    store: tauri::State<Store>,
) -> Result<Status, String> {
    main_only(&window)?;
    Ok(store.status())
}

#[tauri::command]
pub(crate) fn panel_sizes(
    window: tauri::WebviewWindow,
    store: tauri::State<Store>,
) -> Result<Panels, String> {
    main_only(&window)?;
    Ok(store.saved().panels)
}

/// Saves the notebook's panel sizes. A size outside the notebook's limits
/// is not kept.
#[tauri::command]
pub(crate) fn set_panel_sizes(
    window: tauri::WebviewWindow,
    store: tauri::State<Store>,
    panels: Panels,
) -> Result<Panels, String> {
    main_only(&window)?;
    let panels = panels.validated();
    store.record(|settings| settings.panels = panels);
    Ok(panels)
}

/// Deletes the settings file and returns every setting to its default.
/// Refused during a live session, whose language and choices are fixed.
#[tauri::command]
pub(crate) fn reset_settings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    store: tauri::State<Store>,
) -> Result<(), String> {
    main_only(&window)?;
    {
        let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
        if runtime.live_session_open() {
            return Err("Reset settings when no live session is running.".into());
        }
        store.reset()?;
        apply(&mut runtime, &Settings::default());
        crate::companion::reset_drag(&app);
        crate::publish(&app, &mut runtime);
    }
    crate::companion::refresh(&app);
    Ok(())
}
