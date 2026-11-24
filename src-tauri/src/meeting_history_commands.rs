//! The notebook's commands for kept meetings. The companion window has none
//! of them. File work runs off the main thread.

use crate::{
    meeting_history::{Availability, Content, Error, Listing, Meeting, Store, Summary},
    AppState,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "Only the notebook can use kept meetings.".into())
}

fn message(error: Error) -> String {
    error.message().into()
}

/// The meeting the current session was kept as, so later notes or meeting
/// notes can be added to it, and whether to offer keeping at all.
pub(crate) struct Keeping(Mutex<KeepingState>);

struct KeepingState {
    /// "Offer to keep each meeting". On by default: offering stores nothing.
    /// For this launch only until the settings file holds it.
    offer: bool,
    kept: Option<Kept>,
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
        Self(Mutex::new(KeepingState {
            offer: true,
            kept: None,
        }))
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
    offer: bool,
    /// The current session's number, so a choice in the notebook (Not this
    /// one) applies to that session only.
    session: u64,
    /// The ended session's kept meeting, if the person kept it.
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
        offer: keeping.offer,
        session,
        kept,
    })
}

#[tauri::command]
pub(crate) fn set_offer_to_keep(
    window: tauri::WebviewWindow,
    keeping: tauri::State<Keeping>,
    offer: bool,
) -> Result<(), String> {
    main_only(&window)?;
    keeping
        .0
        .lock()
        .map_err(|_| "Kept meetings are unavailable.")?
        .offer = offer;
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
    }
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
    }
    Ok(count)
}
