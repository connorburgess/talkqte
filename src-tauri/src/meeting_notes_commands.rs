//! The notebook's commands for model-written meeting notes. The webview
//! receives the plan, the checked notes and fixed messages; never the key,
//! the request body or any provider text. The Keychain read and the request
//! run off the main thread, outside the notebook lock.

use crate::meeting_notes::{self, Draft, Failure, Plan};
use crate::provider_keys::{self, KeyState, Provider};
use crate::AppState;

/// The confirmation's facts, with this session's cue spend so far.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReply {
    #[serde(flatten)]
    plan: Plan,
    /// Estimated spend of this session's cue requests with the same key, if
    /// any were sent.
    #[serde(skip_serializing_if = "Option::is_none")]
    cue_spent_micro_usd: Option<u64>,
}

/// Where this session's notes stand, for the notebook to show.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<Draft>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kept: Option<String>,
    /// Absent when nothing was sent or the cost is not known.
    #[serde(skip_serializing_if = "Option::is_none")]
    spent_micro_usd: Option<u64>,
}

/// What a notes request would send and cost. Sends nothing.
#[tauri::command]
pub fn meeting_notes_plan(
    state: tauri::State<AppState>,
    include_notes: bool,
) -> Result<PlanReply, String> {
    let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let plan = runtime
        .engine
        .meeting_notes_plan(include_notes)
        .map_err(|refusal| refusal.message().to_string())?;
    Ok(PlanReply {
        plan,
        cue_spent_micro_usd: crate::anthropic_api::usage()
            .map(|usage| usage.spent_micro_usd)
            .filter(|spent| *spent > 0),
    })
}

/// Sends this session's one notes request, after the person confirmed the
/// plan named by `fingerprint`, and returns the checked notes. Input that
/// differs from that plan is refused and nothing is sent.
#[tauri::command]
pub async fn write_meeting_notes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    include_notes: bool,
    fingerprint: String,
) -> Result<Draft, String> {
    let (prepared, session) = {
        let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
        let prepared = runtime
            .engine
            .begin_meeting_notes(include_notes, &fingerprint)
            .map_err(|refusal| refusal.message().to_string())?;
        let session = runtime.engine.session();
        crate::publish(&app, &mut runtime);
        (prepared, session)
    };
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let keys = provider_keys::global();
        let read = keys.get(Provider::Anthropic);
        let rejected = keys.status().anthropic.state == KeyState::Rejected;
        let key = meeting_notes::key(read, rejected)?;
        Ok::<_, meeting_notes::Refusal>(meeting_notes::write(
            &mut crate::anthropic_api::Network,
            key,
            &prepared,
            || keys.mark_rejected(Provider::Anthropic),
        ))
    })
    .await;
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let result = match outcome {
        // Nothing was sent: the key could not be used.
        Ok(Err(refusal)) => {
            runtime.engine.abandon_meeting_notes(session);
            crate::publish(&app, &mut runtime);
            return Err(refusal.message().to_string());
        }
        // Stop waiting came before anything was sent.
        Ok(Ok(written)) if !written.sent => {
            runtime.engine.abandon_meeting_notes(session);
            crate::publish(&app, &mut runtime);
            return Err(match written.result {
                Err(Failure::Cancelled) => meeting_notes::Refusal::Cancelled.message().into(),
                _ => "The request could not be prepared. Nothing was sent.".into(),
            });
        }
        Ok(Ok(written)) => {
            let result = written.result;
            let current = runtime.engine.finish_meeting_notes(
                session,
                result.clone(),
                written.spent_micro_usd,
            );
            crate::publish(&app, &mut runtime);
            if !current {
                return Err("A new session has started, so these notes were not kept.".into());
            }
            result
        }
        // The worker failed; the request may have been sent, so its cost is
        // not known.
        Err(_) => {
            let failure = Failure::Unavailable;
            runtime
                .engine
                .finish_meeting_notes(session, Err(failure), None);
            crate::publish(&app, &mut runtime);
            Err(failure)
        }
    };
    result.map_err(|failure| failure.message())
}

/// Stops waiting for this session's request in flight; if it has not been
/// sent yet, it never is. What was sent may be billed.
#[tauri::command]
pub fn cancel_meeting_notes(state: tauri::State<AppState>) -> Result<(), String> {
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    runtime.engine.cancel_meeting_notes();
    Ok(())
}

#[tauri::command]
pub fn meeting_notes_result(state: tauri::State<AppState>) -> Result<NotesResult, String> {
    let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let record = runtime.engine.meeting_notes();
    Ok(NotesResult {
        draft: record.draft().cloned(),
        failure: record.failure().map(str::to_string),
        kept: record.kept().map(str::to_string),
        spent_micro_usd: record.spent_micro_usd(),
    })
}

/// Keeps the person's edited notes; the export then includes them. Drops
/// any earlier export preview, so only a preview of the new content saves.
#[tauri::command]
pub fn keep_meeting_notes(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    markdown: String,
) -> Result<(), String> {
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    runtime.engine.keep_meeting_notes(&markdown)?;
    runtime.export = None;
    crate::publish(&app, &mut runtime);
    Ok(())
}

#[tauri::command]
pub fn discard_meeting_notes(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    runtime.engine.discard_meeting_notes();
    runtime.export = None;
    crate::publish(&app, &mut runtime);
    Ok(())
}

/// The model the next notes request uses.
#[tauri::command]
pub fn meeting_notes_model() -> &'static str {
    meeting_notes::notes_model().id
}

/// Chooses the model for the next notes request, from those the app lists.
#[tauri::command]
pub fn set_meeting_notes_model(
    app: tauri::AppHandle,
    model: String,
) -> Result<&'static str, String> {
    let model = meeting_notes::set_notes_model(&model)?;
    crate::settings_commands::record(&app, |settings| settings.notes_model = model);
    Ok(model)
}
