use crate::{
    llm_provider,
    meeting_qa::{self, Answer, Entry, Scope},
    provider_keys, AppState,
};
use tauri::Emitter;
#[tauri::command]
pub fn question_scope(state: tauri::State<AppState>) -> Result<Scope, String> {
    state
        .0
        .lock()
        .map_err(|_| "Notebook unavailable.")?
        .engine
        .question_scope()
}
#[tauri::command]
pub fn question_history(state: tauri::State<AppState>) -> Result<Vec<Entry>, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "Notebook unavailable.")?
        .engine
        .meeting_qa
        .history())
}
#[tauri::command]
pub fn cancel_question(state: tauri::State<AppState>, ticket: String) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "Notebook unavailable.")?
        .engine
        .meeting_qa
        .cancel_ticket(&ticket);
    Ok(())
}
#[tauri::command]
pub async fn ask_question(
    state: tauri::State<'_, AppState>,
    ticket: String,
    question: String,
) -> Result<Answer, String> {
    let flight = meeting_qa::Flight::acquire()?;
    let p = {
        let mut r = state.0.lock().map_err(|_| "Notebook unavailable.")?;
        r.engine
            .meeting_qa
            .begin(&ticket, &question, &llm_provider::resolved_cue_model())?
    };
    let request = p.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let _flight = flight;
        if request.cancelled() {
            return meeting_qa::NetworkResult {
                answer: Err("Question cancelled.".into()),
                rejected: false,
            };
        }
        let keys = provider_keys::global();
        let provider = request.target.provider.key_provider();
        match keys.get(provider) {
            Ok(key) => meeting_qa::network(&request, key),
            Err(_) => meeting_qa::NetworkResult {
                answer: Err("Add the selected provider's key in Settings before asking.".into()),
                rejected: false,
            },
        }
    })
    .await;
    let mut r = state.0.lock().map_err(|_| "Notebook unavailable.")?;
    let outcome = outcome.unwrap_or(meeting_qa::NetworkResult {
        answer: Err("The answer worker stopped. You can retry.".into()),
        rejected: false,
    });
    // Authentication side effects and acceptance share the lifecycle lock.
    if r.engine.meeting_qa.accepts(&p) && outcome.rejected {
        provider_keys::global().mark_rejected(p.target.provider.key_provider());
    }
    if !r.engine.meeting_qa.finish(&p, question, &outcome.answer) {
        return Err(
            "Question cancelled, expired, or its session changed. No answer was added.".into(),
        );
    }
    outcome.answer
}
/// Explicit dock clicks alone focus the notebook. Passive cues never use this.
#[tauri::command]
pub fn open_meeting_panel(app: tauri::AppHandle, panel: String) -> Result<(), String> {
    if !matches!(panel.as_str(), "transcript" | "ask") {
        return Err("Unknown notebook panel.".into());
    }
    crate::menu_bar::show_notebook(&app);
    app.emit_to("main", "meeting:open-panel", panel)
        .map_err(|_| "Notebook unavailable.".into())
}
