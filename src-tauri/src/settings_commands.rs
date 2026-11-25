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
    crate::transcription::cloud::set_provider(settings.transcription_provider);
    crate::transcription::cloud::set_language(settings.transcription_language);
    // Checked when the file was read; a model no longer offered keeps the
    // default.
    if crate::meeting_notes::set_notes_model(settings.notes_model).is_err() {
        let _ = crate::meeting_notes::set_notes_model(crate::meeting_notes::DEFAULT_MODEL);
    }
    crate::llm_provider::apply_preferences(crate::llm_provider::Preferences {
        cue_provider: settings.cue_provider,
        cue_model_override: settings.cue_model_override.clone(),
        notes_model: settings.notes_model,
        notes_model_override: settings.notes_model_override.clone(),
    });
    let engine = &mut runtime.engine;
    engine.set_question_size(settings.question_size);
    engine.set_companion_position(settings.companion_position);
    engine.set_sensitivity(settings.sensitivity);
    engine.set_overlay(settings.overlay_enabled);
    if engine.set_user_name(settings.user_name.clone()).is_err() {
        let _ = engine.set_user_name(None);
    }
    runtime.call_prompt.restore(
        settings.call_prompt_enabled,
        settings.call_prompt_auto_start && !crate::settings::lab_run(),
        &settings.call_prompt_not_for,
    );
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
    let auto_start = watcher.auto_start();
    let not_for = watcher.not_for_ids().to_vec();
    record(app, |settings| {
        settings.call_prompt_enabled = enabled;
        settings.call_prompt_auto_start = auto_start;
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

/// The menu bar and login choices, as Settings shows them. Open at login is
/// read from the system each time, never from the settings file.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Presence {
    /// This launch has a menu bar item to keep running in.
    menu_bar: bool,
    keep_running: bool,
    open_at_login: crate::login_item::Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn presence(
    app: &tauri::AppHandle,
    store: &Store,
    login: &crate::login_item::LoginItems,
    error: Option<String>,
) -> Presence {
    Presence {
        menu_bar: crate::menu_bar::has_item(app),
        keep_running: store.saved().keep_running_in_menu_bar,
        open_at_login: login.0.status(),
        error,
    }
}

#[tauri::command]
pub(crate) fn presence_settings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: tauri::State<Store>,
    login: tauri::State<crate::login_item::LoginItems>,
) -> Result<Presence, String> {
    main_only(&window)?;
    Ok(presence(&app, &store, &login, None))
}

/// Whether closing the notebook leaves TalkQTE in the menu bar. Saved.
#[tauri::command]
pub(crate) fn set_keep_running_in_menu_bar(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: tauri::State<Store>,
    login: tauri::State<crate::login_item::LoginItems>,
    enabled: bool,
) -> Result<Presence, String> {
    main_only(&window)?;
    if enabled && !crate::menu_bar::has_item(&app) {
        return Err("TalkQTE has no menu bar item in this launch.".into());
    }
    store.record(|settings| settings.keep_running_in_menu_bar = enabled);
    Ok(presence(&app, &store, &login, None))
}

/// Turns Open at login on or off through the system, then reports what the
/// system says.
#[tauri::command]
pub(crate) fn set_open_at_login(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: tauri::State<Store>,
    login: tauri::State<crate::login_item::LoginItems>,
    enabled: bool,
) -> Result<Presence, String> {
    main_only(&window)?;
    let (_, error) = crate::login_item::change(login.0.as_ref(), enabled);
    Ok(presence(&app, &store, &login, error))
}

/// Opens System Settings at Login Items, where macOS asks for approval.
#[tauri::command]
pub(crate) fn open_login_items(
    window: tauri::WebviewWindow,
    login: tauri::State<crate::login_item::LoginItems>,
) -> Result<(), String> {
    main_only(&window)?;
    login.0.open_settings();
    Ok(())
}
