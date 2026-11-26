//! The notebook's commands for kept meetings, plus the companion's narrow
//! `respond_to_end_prompt` action for the end-of-call dock card. The
//! companion can never list, search, read, rename or export kept meetings.
//! File work runs off the main thread.

use crate::{
    engine::{EndPrompt, EndPromptAction, EndPromptState},
    meeting_history::{
        default_title, Availability, Content, Error, Listing, Meeting, Store, Summary,
    },
    settings::{AfterSessionKeep, Store as SettingsStore},
    AppState,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "Only the notebook can use kept meetings.".into())
}

fn message(error: Error) -> String {
    error.message().into()
}

/// The meeting the current session was kept as, so later notes or meeting
/// notes can be added to it.
pub(crate) struct Keeping(Mutex<KeepingState>);

#[derive(Default)]
struct KeepingState {
    kept: Option<Kept>,
    /// The Markdown previewed from the Meetings view, held so the save
    /// dialog writes exactly what the person reviewed.
    export: Option<String>,
}

struct Kept {
    session: u64,
    id: String,
    title: String,
    include_application: bool,
    content: Content,
}

impl Default for Keeping {
    fn default() -> Self {
        Self(Mutex::new(KeepingState::default()))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionKept {
    id: String,
    title: String,
    /// The session's notes, meeting notes or transcript changed since it
    /// was kept, so an update would add something.
    changed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    availability: Availability,
    after_session_keep: AfterSessionKeep,
    auto_prior_context: bool,
    /// The current session's number, so a choice in the notebook (Not this
    /// one) applies to that session only.
    session: u64,
    /// The ended session's kept meeting, if the person kept it or it was
    /// auto-saved.
    #[serde(skip_serializing_if = "Option::is_none")]
    kept: Option<SessionKept>,
}

pub(crate) fn manage(app: &tauri::App) {
    app.manage(Store::for_app(app.handle()));
    app.manage(Keeping::default());
}

/// Runs `work` with the store on a blocking thread.
async fn blocking<T: Send + 'static>(
    app: &tauri::AppHandle,
    work: impl FnOnce(&Store) -> T + Send + 'static,
) -> Result<T, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<Store>()))
        .await
        .map_err(|_| "Kept meetings are unavailable.".to_string())
}

#[tauri::command]
pub(crate) fn meeting_history_status(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    store: tauri::State<Store>,
    keeping: tauri::State<Keeping>,
) -> Result<Status, String> {
    main_only(&window)?;
    let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let keeping = keeping
        .0
        .lock()
        .map_err(|_| "Kept meetings are unavailable.")?;
    let session = runtime.engine.history_session();
    let after_session_keep = app
        .try_state::<SettingsStore>()
        .map_or(AfterSessionKeep::Auto, |settings| {
            settings.saved().after_session_keep
        });
    let auto_prior_context = !crate::settings::lab_run()
        && app
            .try_state::<SettingsStore>()
            .is_none_or(|settings| settings.saved().auto_prior_context);
    let kept = keeping
        .kept
        .as_ref()
        .filter(|kept| kept.session == session)
        .map(|kept| SessionKept {
            id: kept.id.clone(),
            title: kept.title.clone(),
            changed: runtime
                .engine
                .keepable_meeting(kept.include_application)
                .is_some_and(|now| now != kept.content),
        });
    Ok(Status {
        availability: store.availability(),
        after_session_keep,
        auto_prior_context,
        session,
        kept,
    })
}

#[tauri::command]
pub(crate) fn set_after_session_keep(
    window: tauri::WebviewWindow,
    store: tauri::State<SettingsStore>,
    mode: AfterSessionKeep,
) -> Result<(), String> {
    main_only(&window)?;
    store.record(|settings| settings.after_session_keep = mode);
    Ok(())
}

#[tauri::command]
pub(crate) async fn set_auto_prior_context(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    store: tauri::State<'_, SettingsStore>,
    enabled: bool,
) -> Result<(), String> {
    main_only(&window)?;
    if crate::settings::lab_run() {
        return Err("Auto prior context is not available in lab runs.".into());
    }
    store.record(|settings| settings.auto_prior_context = enabled);
    crate::refresh_auto_prior_context(&app).await;
    Ok(())
}

/// Keeps the session that just ended, under `title`. The application's
/// name only with `include_application`.
#[tauri::command]
pub(crate) async fn keep_meeting_in_history(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    title: String,
    include_application: bool,
) -> Result<Summary, String> {
    main_only(&window)?;
    let (session, content) = {
        let state = app.state::<AppState>();
        let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
        let content = runtime
            .engine
            .keepable_meeting(include_application)
            .ok_or("Only a live session that has ended, with a transcript, can be kept.")?;
        (runtime.engine.history_session(), content)
    };
    {
        let keeping = app.state::<Keeping>();
        let keeping = keeping
            .0
            .lock()
            .map_err(|_| "Kept meetings are unavailable.")?;
        if keeping
            .kept
            .as_ref()
            .is_some_and(|kept| kept.session == session)
        {
            return Err("This meeting is already kept.".into());
        }
    }
    let stored = content.clone();
    let summary = blocking(&app, move |store| store.keep(&title, stored))
        .await?
        .map_err(message)?;
    let keeping = app.state::<Keeping>();
    if let Ok(mut keeping) = keeping.0.lock() {
        keeping.kept = Some(Kept {
            session,
            id: summary.id.clone(),
            title: summary.title.clone(),
            include_application,
            content,
        });
    }
    if let Ok(mut runtime) = app.state::<AppState>().0.lock() {
        if runtime
            .end_prompt
            .as_ref()
            .is_some_and(|prompt| prompt.session == session)
        {
            runtime.end_prompt = None;
            crate::publish(&app, &mut runtime);
        }
    }
    crate::companion::refresh(&app);
    Ok(summary)
}

/// Adds the session's later changes (notes, meeting notes kept after it
/// ended, echo answers) to the meeting it was kept as.
#[tauri::command]
pub(crate) async fn update_kept_session_meeting(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Summary, String> {
    main_only(&window)?;
    let (id, include_application, session) = {
        let keeping = app.state::<Keeping>();
        let keeping = keeping
            .0
            .lock()
            .map_err(|_| "Kept meetings are unavailable.")?;
        let kept = keeping.kept.as_ref().ok_or(message(Error::Missing))?;
        (kept.id.clone(), kept.include_application, kept.session)
    };
    let content = {
        let state = app.state::<AppState>();
        let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
        if runtime.engine.history_session() != session {
            return Err("A new session has started; the kept meeting stays as it was.".into());
        }
        runtime
            .engine
            .keepable_meeting(include_application)
            .ok_or("This session can no longer be kept.")?
    };
    let stored = content.clone();
    let target = id.clone();
    let summary = blocking(&app, move |store| store.update(&target, stored))
        .await?
        .map_err(message)?;
    if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
        if let Some(kept) = keeping.kept.as_mut().filter(|kept| kept.id == id) {
            kept.content = content;
            kept.title = summary.title.clone();
        }
    }
    Ok(summary)
}

#[tauri::command]
pub(crate) async fn kept_meetings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    query: Option<String>,
) -> Result<Listing, String> {
    main_only(&window)?;
    blocking(&app, move |store| store.list(query.as_deref())).await
}

#[tauri::command]
pub(crate) async fn open_kept_meeting(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<Meeting, String> {
    main_only(&window)?;
    blocking(&app, move |store| store.open_meeting(&id))
        .await?
        .map_err(message)
}

#[tauri::command]
pub(crate) async fn rename_kept_meeting(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    title: String,
) -> Result<Summary, String> {
    main_only(&window)?;
    let summary = blocking(&app, move |store| store.rename(&id, &title))
        .await?
        .map_err(message)?;
    if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
        if let Some(kept) = keeping.kept.as_mut().filter(|kept| kept.id == summary.id) {
            kept.title = summary.title.clone();
        }
        keeping.export = None;
    }
    Ok(summary)
}

#[tauri::command]
pub(crate) async fn rename_kept_meeting_speaker(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    speaker_id: u32,
    name: String,
) -> Result<Meeting, String> {
    main_only(&window)?;
    let target = id.clone();
    let meeting = blocking(&app, move |store| {
        store.rename_speaker(&target, speaker_id, &name)
    })
    .await?
    .map_err(message)?;
    let linked_session = if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
        let linked = keeping
            .kept
            .as_mut()
            .filter(|kept| kept.id == meeting.id)
            .map(|kept| {
                kept.content.speaker_names = meeting.content.speaker_names.clone();
                kept.session
            });
        keeping.export = None;
        linked
    } else {
        None
    };
    // Never hold Keeping while acquiring Runtime (status reads use the reverse
    // order). A new session may have started while the disk write was pending.
    if let Some(session) = linked_session {
        let state = app.state::<AppState>();
        if let Ok(mut runtime) = state.0.lock() {
            let name = meeting
                .content
                .speaker_names
                .get(&speaker_id)
                .map_or("", String::as_str);
            if sync_ended_speaker(&mut runtime.engine, session, speaker_id, name) {
                runtime.export = None;
                crate::publish(&app, &mut runtime);
            }
        }
    }
    Ok(meeting)
}

#[tauri::command]
pub(crate) async fn set_kept_meeting_archived(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    archived: bool,
) -> Result<Summary, String> {
    main_only(&window)?;
    let target = id.clone();
    let summary = blocking(&app, move |store| store.set_archived(&target, archived))
        .await?
        .map_err(message)?;
    if archived {
        if let Ok(mut runtime) = app.state::<AppState>().0.lock() {
            runtime.auto_context_ids.remove(&id);
            runtime.dismissed_auto_context_ids.insert(id.clone());
            if let Some(cue_changed) =
                runtime.remove_imported_note(crate::context::Provider::History, &id)
            {
                crate::emit_context(&app, &mut runtime, cue_changed);
            }
        }
    } else if let Ok(mut runtime) = app.state::<AppState>().0.lock() {
        runtime.dismissed_auto_context_ids.remove(&id);
    }
    let _ = app.emit_to("main", "meeting-history:changed", ());
    if !archived {
        crate::refresh_auto_prior_context(&app).await;
    }
    Ok(summary)
}

#[tauri::command]
pub(crate) async fn delete_kept_meeting(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    main_only(&window)?;
    let target = id.clone();
    blocking(&app, move |store| store.delete(&target))
        .await?
        .map_err(message)?;
    if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
        if keeping.kept.as_ref().is_some_and(|kept| kept.id == id) {
            keeping.kept = None;
        }
        keeping.export = None;
    }
    if let Ok(mut runtime) = app.state::<AppState>().0.lock() {
        let was_auto = runtime.auto_context_ids.remove(&id);
        runtime.dismissed_auto_context_ids.remove(&id);
        if was_auto {
            if let Some(cue_changed) =
                runtime.remove_imported_note(crate::context::Provider::History, &id)
            {
                crate::emit_context(&app, &mut runtime, cue_changed);
            }
        }
        let session = runtime.engine.history_session();
        if runtime
            .end_prompt
            .as_ref()
            .is_some_and(|prompt| prompt.session == session)
        {
            runtime.end_prompt = None;
            crate::publish(&app, &mut runtime);
        }
    }
    crate::companion::refresh(&app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn delete_all_kept_meetings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    main_only(&window)?;
    let count = blocking(&app, |store| store.delete_all())
        .await?
        .map_err(message)?;
    if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
        keeping.kept = None;
        keeping.export = None;
    }
    if let Ok(mut runtime) = app.state::<AppState>().0.lock() {
        let auto_ids: Vec<String> = runtime.auto_context_ids.drain().collect();
        runtime.dismissed_auto_context_ids.clear();
        let mut removed_any = false;
        let mut cue_changed = false;
        for id in auto_ids {
            if let Some(changed) =
                runtime.remove_imported_note(crate::context::Provider::History, &id)
            {
                removed_any = true;
                cue_changed |= changed;
            }
        }
        if removed_any {
            crate::emit_context(&app, &mut runtime, cue_changed);
        }
        if runtime.end_prompt.is_some() {
            runtime.end_prompt = None;
            crate::publish(&app, &mut runtime);
        }
    }
    crate::companion::refresh(&app);
    Ok(count)
}

#[tauri::command]
pub(crate) async fn kept_meeting_export_preview(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<String, String> {
    main_only(&window)?;
    let meeting = blocking(&app, move |store| store.open_meeting(&id))
        .await?
        .map_err(message)?;
    let markdown = meeting.markdown();
    if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
        keeping.export = Some(markdown.clone());
    }
    Ok(markdown)
}

#[tauri::command]
pub(crate) async fn export_kept_meeting(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    main_only(&window)?;
    let markdown = app
        .state::<Keeping>()
        .0
        .lock()
        .map_err(|_| "Kept meetings are unavailable.")?
        .export
        .clone()
        .ok_or("Review the export before choosing a destination.")?;
    let handle = app.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        use tauri_plugin_dialog::DialogExt;
        let Some(file) = handle
            .dialog()
            .file()
            .add_filter("Markdown", &["md"])
            .set_file_name("talkqte-meeting.md")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = file
            .into_path()
            .map_err(|_| "Choose a local file destination.")?;
        crate::export_file::write(&path, &markdown)?;
        Ok(true)
    })
    .await
    .map_err(|_| "Could not open the save dialog.")??;
    if saved {
        if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
            keeping.export = None;
        }
    }
    Ok(saved)
}

/// Lists kept meetings (their kept meeting notes and the person's own notes
/// only, never transcripts) for selection into Prior context.
#[tauri::command]
pub(crate) async fn list_kept_meetings_for_context(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::PickedNotes, String> {
    main_only(&window)?;
    let source = blocking(&app, crate::meeting_history::HistorySource::read)
        .await?
        .map_err(message)?;
    let notes = source.summaries();
    let skipped = source.skipped;
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    runtime.pending_file_pick = None;
    runtime.pending_import = Some(crate::context_import::PendingImport::new(Box::new(source)));
    Ok(crate::PickedNotes {
        file_name: "kept meetings".into(),
        notes,
        skipped,
        asks_for_dates: false,
    })
}

/// Called from a blocking thread when a live session finishes stopping.
/// Under `"auto"`, saves the non-empty meeting to local history (without
/// keeping any application name) and shows `Meeting saved` in the dock.
/// Under `"ask"`, shows `Meeting ended` in the dock. Lab runs and `"off"`
/// never save or prompt.
pub(crate) fn on_live_session_ended(app: &tauri::AppHandle, session: u64) {
    on_live_session_ended_with(app, session, false);
}

pub(crate) fn on_live_session_ended_with(app: &tauri::AppHandle, session: u64, force_save: bool) {
    let Some(store) = app.try_state::<Store>() else {
        return;
    };
    if store.availability() != Availability::On {
        return;
    }
    let mode = app
        .try_state::<SettingsStore>()
        .map_or(AfterSessionKeep::Auto, |settings| {
            settings.saved().after_session_keep
        });
    if !force_save && mode == AfterSessionKeep::Off {
        return;
    }
    let Some(keeping_state) = app.try_state::<Keeping>() else {
        return;
    };
    let (counts, content) = {
        let state = app.state::<AppState>();
        let Ok(mut runtime) = state.0.lock() else {
            return;
        };
        if runtime.engine.history_session() != session
            || runtime.engine.state.status != crate::engine::Status::Ended
        {
            return;
        }
        let already_kept = keeping_state
            .0
            .lock()
            .is_ok_and(|keeping| keeping.kept.as_ref().is_some_and(|k| k.session == session));
        if already_kept {
            return;
        }
        let Some(counts) = runtime.engine.end_prompt_counts() else {
            return;
        };
        if !force_save && mode == AfterSessionKeep::Ask {
            runtime.end_prompt = Some(EndPrompt {
                session,
                state: EndPromptState::Ask,
                transcript_lines: counts.0,
                has_notes: counts.1,
                error: None,
            });
            crate::publish(app, &mut runtime);
            drop(runtime);
            crate::companion::refresh(app);
            return;
        }
        let Some(content) = runtime.engine.keepable_meeting(false) else {
            return;
        };
        (counts, content)
    };

    let title = default_title(content.started_at_ms);
    let result = store.keep(&title, content.clone());
    let state = app.state::<AppState>();
    let Ok(mut runtime) = state.0.lock() else {
        return;
    };
    if runtime.engine.history_session() != session
        || runtime.engine.state.status != crate::engine::Status::Ended
    {
        return;
    }
    match result {
        Ok(summary) => {
            if let Ok(mut keeping) = keeping_state.0.lock() {
                keeping.kept = Some(Kept {
                    session,
                    id: summary.id,
                    title: summary.title,
                    include_application: false,
                    content,
                });
            }
            runtime.end_prompt = Some(EndPrompt {
                session,
                state: EndPromptState::Saved,
                transcript_lines: counts.0,
                has_notes: counts.1,
                error: None,
            });
            crate::publish(app, &mut runtime);
            drop(runtime);
            let _ = app.emit_to("main", "meeting-history:changed", ());
            crate::companion::refresh(app);
        }
        Err(error) => {
            runtime.end_prompt = Some(EndPrompt {
                session,
                state: EndPromptState::Ask,
                transcript_lines: counts.0,
                has_notes: counts.1,
                error: Some(error.message().into()),
            });
            crate::publish(app, &mut runtime);
            drop(runtime);
            crate::companion::refresh(app);
        }
    }
}

/// Companion action for the end-of-call card (`respond_to_end_prompt`).
/// Keeps only with a default date/time title and no application name, deletes
/// only the meeting kept for `session`, or opens the notebook to write notes
/// or view the kept meeting.
#[tauri::command]
pub(crate) async fn respond_to_end_prompt(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session: u64,
    action: EndPromptAction,
) -> Result<(), String> {
    let prompt = {
        let runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
        if runtime.engine.history_session() != session {
            return Ok(());
        }
        let Some(prompt) = runtime.end_prompt.clone().filter(|p| p.session == session) else {
            return Ok(());
        };
        prompt
    };

    match action {
        EndPromptAction::Dismiss => {
            if let Ok(mut runtime) = state.0.lock() {
                if runtime
                    .end_prompt
                    .as_ref()
                    .is_some_and(|p| p.session == session)
                {
                    runtime.end_prompt = None;
                    crate::publish(&app, &mut runtime);
                }
            }
            crate::companion::refresh(&app);
            Ok(())
        }
        EndPromptAction::WriteNotes => {
            if prompt.transcript_lines == 0 {
                return Ok(());
            }
            if let Ok(mut runtime) = state.0.lock() {
                if runtime
                    .end_prompt
                    .as_ref()
                    .is_some_and(|p| p.session == session)
                {
                    runtime.end_prompt = None;
                    crate::publish(&app, &mut runtime);
                }
            }
            crate::companion::refresh(&app);
            crate::menu_bar::show_notebook(&app);
            let _ = app.emit_to("main", "end-prompt:write-notes", ());
            Ok(())
        }
        EndPromptAction::Open => {
            let kept_id = app.state::<Keeping>().0.lock().ok().and_then(|keeping| {
                keeping
                    .kept
                    .as_ref()
                    .filter(|k| k.session == session)
                    .map(|k| k.id.clone())
            });
            if let Ok(mut runtime) = state.0.lock() {
                if runtime
                    .end_prompt
                    .as_ref()
                    .is_some_and(|p| p.session == session)
                {
                    runtime.end_prompt = None;
                    crate::publish(&app, &mut runtime);
                }
            }
            crate::companion::refresh(&app);
            if let Some(id) = kept_id {
                crate::menu_bar::show_notebook(&app);
                let _ = app.emit_to("main", "end-prompt:open-meeting", id);
            }
            Ok(())
        }
        EndPromptAction::Keep => {
            if prompt.state != EndPromptState::Ask {
                return Ok(());
            }
            let content = {
                let runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
                if runtime.engine.history_session() != session {
                    return Ok(());
                }
                runtime
                    .engine
                    .keepable_meeting(false)
                    .ok_or("Only an ended session with transcript or notes can be kept.")?
            };
            let already_kept =
                app.state::<Keeping>().0.lock().is_ok_and(|keeping| {
                    keeping.kept.as_ref().is_some_and(|k| k.session == session)
                });
            if already_kept {
                return Ok(());
            }
            let title = default_title(content.started_at_ms);
            let stored = content.clone();
            let result = blocking(&app, move |store| store.keep(&title, stored)).await?;
            match result {
                Ok(summary) => {
                    if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
                        keeping.kept = Some(Kept {
                            session,
                            id: summary.id,
                            title: summary.title,
                            include_application: false,
                            content,
                        });
                    }
                    if let Ok(mut runtime) = state.0.lock() {
                        if runtime
                            .end_prompt
                            .as_ref()
                            .is_some_and(|p| p.session == session)
                        {
                            runtime.end_prompt = Some(EndPrompt {
                                session,
                                state: EndPromptState::Kept,
                                transcript_lines: prompt.transcript_lines,
                                has_notes: prompt.has_notes,
                                error: None,
                            });
                            crate::publish(&app, &mut runtime);
                        }
                    }
                    let _ = app.emit_to("main", "meeting-history:changed", ());
                    crate::companion::refresh(&app);
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(2_500));
                        let cleared = handle.state::<AppState>().0.lock().is_ok_and(|mut rt| {
                            if rt.end_prompt.as_ref().is_some_and(|p| {
                                p.session == session && p.state == EndPromptState::Kept
                            }) {
                                rt.end_prompt = None;
                                crate::publish(&handle, &mut rt);
                                true
                            } else {
                                false
                            }
                        });
                        if cleared {
                            crate::companion::refresh(&handle);
                        }
                    });
                    Ok(())
                }
                Err(error) => {
                    let msg = error.message().to_string();
                    if let Ok(mut runtime) = state.0.lock() {
                        if let Some(p) =
                            runtime.end_prompt.as_mut().filter(|p| p.session == session)
                        {
                            p.error = Some(msg.clone());
                            crate::publish(&app, &mut runtime);
                        }
                    }
                    Err(msg)
                }
            }
        }
        EndPromptAction::Delete => {
            let kept_id = app.state::<Keeping>().0.lock().ok().and_then(|keeping| {
                keeping
                    .kept
                    .as_ref()
                    .filter(|k| k.session == session)
                    .map(|k| k.id.clone())
            });
            let Some(id) = kept_id else {
                return Ok(());
            };
            let target = id.clone();
            let result = blocking(&app, move |store| store.delete(&target)).await?;
            match result {
                Ok(()) => {
                    if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
                        if keeping.kept.as_ref().is_some_and(|k| k.id == id) {
                            keeping.kept = None;
                        }
                        keeping.export = None;
                    }
                    if let Ok(mut runtime) = state.0.lock() {
                        if runtime
                            .end_prompt
                            .as_ref()
                            .is_some_and(|p| p.session == session)
                        {
                            runtime.end_prompt = None;
                            crate::publish(&app, &mut runtime);
                        }
                    }
                    let _ = app.emit_to("main", "meeting-history:changed", ());
                    crate::companion::refresh(&app);
                    Ok(())
                }
                Err(error) => {
                    let msg = error.message().to_string();
                    if let Ok(mut runtime) = state.0.lock() {
                        if let Some(p) =
                            runtime.end_prompt.as_mut().filter(|p| p.session == session)
                        {
                            p.error = Some(msg.clone());
                            crate::publish(&app, &mut runtime);
                        }
                    }
                    Err(msg)
                }
            }
        }
    }
}

/// Keep the linked ended notebook consistent with an independently renamed
/// saved meeting, so its next notes update cannot restore the old name.
fn sync_ended_speaker(
    engine: &mut crate::engine::Engine,
    session: u64,
    speaker_id: u32,
    name: &str,
) -> bool {
    engine.history_session() == session
        && engine.state.status == crate::engine::Status::Ended
        && engine.rename_speaker(speaker_id, name).is_ok()
}

#[cfg(test)]
mod speaker_sync_tests {
    use super::*;
    use crate::engine::{Engine, LineOrigin, Segment, SessionSources};

    fn ended_meeting() -> Engine {
        let mut engine = Engine::live();
        engine.start().unwrap();
        engine.set_sources(SessionSources::system_audio());
        engine.advance(2_000);
        engine
            .ingest_from(
                engine.session(),
                LineOrigin::Application,
                Segment {
                    id: "fictional-remote".into(),
                    at_ms: 1_000,
                    speaker: "Speaker".into(),
                    speaker_id: Some(0),
                    text: "I will check the fictional garden gate.".into(),
                },
            )
            .unwrap();
        engine.end();
        engine
    }

    #[test]
    fn saved_speaker_rename_survives_a_later_notebook_notes_update() {
        let mut engine = ended_meeting();
        let session = engine.history_session();
        let folder = std::env::temp_dir().join(format!(
            "talkqte-fictional-speaker-sync-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = Store::open(Some(folder.clone()), false);
        let saved = store
            .keep(
                "Fictional garden planning",
                engine.keepable_meeting(false).unwrap(),
            )
            .unwrap();
        drop(store);
        let reopened = Store::open(Some(folder.clone()), false);
        let renamed = reopened
            .rename_speaker(&saved.id, 0, "Priya Patel")
            .unwrap();
        let name = renamed.content.speaker_names.get(&0).unwrap();
        assert!(sync_ended_speaker(&mut engine, session, 0, name));
        engine
            .update_notes("Bring the spare garden key.".into())
            .unwrap();
        reopened
            .update(&saved.id, engine.keepable_meeting(false).unwrap())
            .unwrap();
        let updated = reopened.open_meeting(&saved.id).unwrap();
        assert_eq!(
            updated.content.speaker_names.get(&0).map(String::as_str),
            Some("Priya Patel")
        );
        assert_eq!(updated.content.notes, "Bring the spare garden key.");
        assert_eq!(engine.state.transcript[0].speaker, "Priya Patel");
        assert!(updated
            .markdown()
            .contains("Priya Patel: I will check the fictional garden gate."));
        assert!(sync_ended_speaker(&mut engine, session, 0, ""));
        assert!(engine
            .keepable_meeting(false)
            .unwrap()
            .speaker_names
            .is_empty());
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_delayed_saved_rename_cannot_change_a_replacement_meeting() {
        let mut engine = ended_meeting();
        let previous = engine.history_session();
        engine.start().unwrap();
        engine.set_sources(SessionSources::system_audio());
        engine.advance(2_000);
        engine
            .ingest_from(
                engine.session(),
                LineOrigin::Application,
                Segment {
                    id: "replacement-remote".into(),
                    at_ms: 1_000,
                    speaker: "Speaker".into(),
                    speaker_id: Some(0),
                    text: "A different fictional conversation.".into(),
                },
            )
            .unwrap();
        assert!(!sync_ended_speaker(&mut engine, previous, 0, "Priya Patel"));
        engine.end();
        assert!(!sync_ended_speaker(&mut engine, previous, 0, "Priya Patel"));
        assert_eq!(engine.state.transcript[0].speaker, "Speaker 1");
        assert!(engine.state.speaker_names.is_empty());
    }
}
