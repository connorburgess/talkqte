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
pub(crate) async fn create_meeting_folder(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    name: String,
) -> Result<Vec<String>, String> {
    main_only(&window)?;
    blocking(&app, move |store| store.create_folder(&name))
        .await?
        .map_err(message)
}

#[tauri::command]
pub(crate) async fn rename_meeting_folder(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    old_name: String,
    new_name: String,
) -> Result<Vec<String>, String> {
    main_only(&window)?;
    let folders = blocking(&app, move |store| store.rename_folder(&old_name, &new_name))
        .await?
        .map_err(message)?;
    if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
        keeping.export = None;
    }
    Ok(folders)
}

#[tauri::command]
pub(crate) async fn delete_meeting_folder(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    name: String,
) -> Result<Vec<String>, String> {
    main_only(&window)?;
    let folders = blocking(&app, move |store| store.delete_folder(&name))
        .await?
        .map_err(message)?;
    if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
        keeping.export = None;
    }
    Ok(folders)
}

#[tauri::command]
pub(crate) async fn set_kept_meeting_folder(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    folder: Option<String>,
) -> Result<Summary, String> {
    main_only(&window)?;
    let summary = blocking(&app, move |store| store.set_folder(&id, folder.as_deref()))
        .await?
        .map_err(message)?;
    if let Ok(mut keeping) = app.state::<Keeping>().0.lock() {
        keeping.export = None;
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
    if mode == AfterSessionKeep::Off {
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
        if mode == AfterSessionKeep::Ask {
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
