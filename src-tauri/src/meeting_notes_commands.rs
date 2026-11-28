//! The notebook's commands for model-written meeting notes. The webview
//! receives the plan, the checked notes and fixed messages; never the key,
//! the request body or any provider text. The secret-store read and the
//! request run off the main thread, outside the notebook lock.

use crate::llm_provider;
use crate::meeting_notes::{self, Draft, Failure, PlanView};
use crate::provider_keys::{self, KeyState};
use crate::AppState;

/// The confirmation's facts, with this session's cue spend so far.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReply {
    #[serde(flatten)]
    plan: PlanView,
    /// Estimated spend of this session's cue requests with the same provider
    /// when known and non-zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    cue_spent_micro_usd: Option<u64>,
    retry: bool,
    prior_reserved_micro_usd: u64,
}

/// Reply from `write_meeting_notes` with provider and custom-model flags.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftReply {
    #[serde(flatten)]
    draft: Draft,
    provider_name: &'static str,
    custom_model: bool,
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
    provider_name: &'static str,
    custom_model: bool,
    retry_available: bool,
}

/// What a notes request would send and cost. Sends nothing.
#[tauri::command]
pub fn meeting_notes_plan(
    state: tauri::State<AppState>,
    include_notes: bool,
    retry: Option<bool>,
) -> Result<PlanReply, String> {
    let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let retry = retry.unwrap_or(false);
    let plan = if retry {
        runtime.engine.meeting_notes_retry_plan(include_notes)
    } else {
        runtime.engine.meeting_notes_plan_view(include_notes)
    }
    .map_err(|refusal| {
        refusal
            .message_for(llm_provider::cue_provider())
            .to_string()
    })?;
    let cue_spent_micro_usd = llm_provider::cue_usage()
        .filter(|usage| usage.provider == plan.provider)
        .and_then(|usage| usage.spent_micro_usd)
        .filter(|spent| *spent > 0);
    Ok(PlanReply {
        plan,
        cue_spent_micro_usd,
        retry,
        prior_reserved_micro_usd: runtime.engine.meeting_notes().reserved_micro_usd(),
    })
}

/// Sends an initial request or one reviewed validation retry, with the
/// plan named by `fingerprint`, and returns the checked notes. Input that
/// differs from that plan is refused and nothing is sent.
#[tauri::command]
pub async fn write_meeting_notes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    include_notes: bool,
    fingerprint: String,
    retry: Option<bool>,
) -> Result<DraftReply, String> {
    let (prepared, session, generation) = {
        let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
        let active_provider = llm_provider::cue_provider();
        let prepared = if retry.unwrap_or(false) {
            runtime
                .engine
                .begin_meeting_notes_retry(include_notes, &fingerprint)
        } else {
            runtime
                .engine
                .begin_meeting_notes(include_notes, &fingerprint)
        }
        .map_err(|refusal| refusal.message_for(active_provider).to_string())?;
        let session = runtime.engine.session();
        crate::publish(&app, &mut runtime);
        (
            prepared,
            session,
            runtime.engine.meeting_notes().generation(),
        )
    };
    let provider = prepared.target().provider;
    let custom_model = prepared.target().custom;
    let key_provider = provider.key_provider();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let keys = provider_keys::global();
        let read = keys.get(key_provider);
        let status = keys.status();
        let key_status = status.of(key_provider);
        let rejected = key_status.state == KeyState::Rejected;
        let key = meeting_notes::key(read, rejected)?;
        Ok::<_, meeting_notes::Refusal>(meeting_notes::write_network(key, &prepared, || {
            keys.mark_rejected(key_provider)
        }))
    })
    .await;
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let result = match outcome {
        // Nothing was sent: the key could not be used.
        Ok(Err(refusal)) => {
            runtime
                .engine
                .abandon_meeting_notes_attempt(session, generation);
            crate::publish(&app, &mut runtime);
            return Err(refusal.message_for(provider).to_string());
        }
        // Stop waiting came before anything was sent.
        Ok(Ok(written)) if !written.sent => {
            runtime
                .engine
                .abandon_meeting_notes_attempt(session, generation);
            crate::publish(&app, &mut runtime);
            return Err(match written.result {
                Err(Failure::Cancelled) => meeting_notes::Refusal::Cancelled.message().into(),
                Err(Failure::Unreachable) => meeting_notes::unsent_offline_for(provider).into(),
                _ => "The request could not be prepared. Nothing was sent.".into(),
            });
        }
        Ok(Ok(written)) => {
            let result = written.result;
            let current = runtime.engine.finish_meeting_notes_attempt(
                session,
                generation,
                provider,
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
            runtime.engine.finish_meeting_notes_attempt(
                session,
                generation,
                provider,
                Err(failure),
                None,
            );
            crate::publish(&app, &mut runtime);
            Err(failure)
        }
    };
    result
        .map(|draft| DraftReply {
            draft,
            provider_name: provider.name(),
            custom_model,
        })
        .map_err(|failure| failure.message_for(provider))
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
        provider_name: record.provider_name(),
        custom_model: record.custom_model(),
        retry_available: record.retry_available(),
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

/// The effective model the next notes request uses.
#[tauri::command]
pub fn meeting_notes_model() -> String {
    llm_provider::resolved_notes_model().id
}

/// Chooses a curated model for the active provider's next notes request.
#[tauri::command]
pub fn set_meeting_notes_model(app: tauri::AppHandle, model: String) -> Result<String, String> {
    let prefs = llm_provider::set_curated_notes_model(&model)?;
    let _ = meeting_notes::set_notes_model(&model);
    crate::settings_commands::record(&app, |settings| {
        if prefs.cue_provider == llm_provider::CueProvider::Anthropic {
            if let Some(m) = crate::anthropic_api::model(&prefs.notes_model) {
                settings.notes_model = m.id;
            }
        }
        settings.notes_model_override = prefs.notes_model_override.clone();
    });
    Ok(prefs.effective_notes_model)
}
