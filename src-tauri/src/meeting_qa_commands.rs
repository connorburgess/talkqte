use crate::{
    llm_provider,
    meeting_history::{Meeting, Store},
    meeting_qa::{self, Answer, Entry, Record, SavedQuestions, Scope, Source},
    provider_keys, AppState,
};
use serde::Deserialize;
use tauri::{Emitter, Manager};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SavedRef {
    id: String,
    revision: u64,
}
impl SavedRef {
    fn source(&self) -> Source {
        Source::Saved {
            id: self.id.clone(),
            revision: self.revision,
        }
    }
}
const CHANGED: &str = "The selected saved meeting changed or is unavailable. Reopen it before asking. No answer was added.";

/// Store -> saved record is the only nested lock order. Never holds either
/// during transport, key access, or an async wait. Disk work stays off the UI.
async fn saved_access<T: Send + 'static>(
    app: &tauri::AppHandle,
    selected: SavedRef,
    work: impl FnOnce(&mut Record, &Meeting) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = app.state::<Store>().with_question_snapshot(
            &selected.id,
            selected.revision,
            |meeting| {
                let state = app.state::<SavedQuestions>();
                let mut record = state.0.lock().map_err(|_| "Ask unavailable.")?;
                work(&mut record, meeting)
            },
        );
        match result {
            Ok(value) => value,
            Err(_) => {
                // Invalidate chat/tickets as well as withholding the answer/auth
                // side effect. Keep the process-lifetime ledger unchanged.
                let state = app.state::<SavedQuestions>();
                let mut record = state.0.lock().map_err(|_| "Ask unavailable.")?;
                if record.source() == Some(&selected.source()) {
                    record.forget();
                }
                Err(CHANGED.into())
            }
        }
    })
    .await
    .map_err(|_| "Ask worker stopped.".to_string())?
}

#[tauri::command]
pub async fn question_scope(
    app: tauri::AppHandle,
    saved: Option<SavedRef>,
    reset_conversation: Option<bool>,
) -> Result<Scope, String> {
    if let Some(selected) = saved {
        let source = selected.source();
        saved_access(&app, selected, move |record, meeting| {
            if reset_conversation == Some(true) {
                record.forget();
            }
            record.prepare_source(
                meeting
                    .content
                    .transcript
                    .iter()
                    .enumerate()
                    .map(|(index, line)| meeting_qa::Line {
                        // Positional only within this exact saved ID + revision.
                        id: format!("saved-line-{index}"),
                        at_ms: line.at_ms,
                        text: line.text.clone(),
                    }),
                source,
                false,
                llm_provider::resolved_cue_model(),
            )
        })
        .await
    } else {
        let state = app.state::<AppState>();
        let mut runtime = state.0.lock().map_err(|_| "Notebook unavailable.")?;
        if reset_conversation == Some(true) {
            runtime.engine.meeting_qa.forget();
        }
        runtime.engine.question_scope()
    }
}
#[tauri::command]
pub async fn question_history(
    app: tauri::AppHandle,
    saved: Option<SavedRef>,
) -> Result<Vec<Entry>, String> {
    if let Some(selected) = saved {
        let source = selected.source();
        saved_access(&app, selected, move |record, _| {
            Ok(if record.source() == Some(&source) {
                record.history()
            } else {
                vec![]
            })
        })
        .await
    } else {
        Ok(app
            .state::<AppState>()
            .0
            .lock()
            .map_err(|_| "Notebook unavailable.")?
            .engine
            .meeting_qa
            .history())
    }
}
#[tauri::command]
pub fn cancel_question(
    app: tauri::AppHandle,
    ticket: String,
    saved: Option<SavedRef>,
    close: Option<bool>,
) -> Result<(), String> {
    let cancel = |record: &mut Record| {
        if close == Some(true) {
            record.close_ticket(&ticket);
        } else {
            record.cancel_ticket(&ticket);
        }
    };
    if let Some(selected) = saved {
        let state = app.state::<SavedQuestions>();
        let mut record = state.0.lock().map_err(|_| "Ask unavailable.")?;
        if record.source() == Some(&selected.source()) {
            cancel(&mut record);
        }
    } else {
        cancel(
            &mut app
                .state::<AppState>()
                .0
                .lock()
                .map_err(|_| "Notebook unavailable.")?
                .engine
                .meeting_qa,
        );
    }
    Ok(())
}
#[tauri::command]
pub async fn ask_question(
    app: tauri::AppHandle,
    ticket: String,
    question: String,
    saved: Option<SavedRef>,
) -> Result<Answer, String> {
    let flight = meeting_qa::Flight::acquire()?;
    let target = llm_provider::resolved_cue_model();
    let sent_question = question.clone();
    let p = if let Some(selected) = saved.clone() {
        let source = selected.source();
        let store_app = app.clone();
        saved_access(&app, selected, move |record, meeting| {
            if !record.matches_saved(meeting) || record.source() != Some(&source) {
                return Err(CHANGED.into());
            }
            let request = record.begin(&ticket, &question, &target)?;
            store_app
                .state::<Store>()
                .track_question(&meeting.id, request.withdrawal())
                .map_err(|_| CHANGED.to_string())?;
            Ok(request)
        })
        .await?
    } else {
        app.state::<AppState>()
            .0
            .lock()
            .map_err(|_| "Notebook unavailable.")?
            .engine
            .meeting_qa
            .begin(&ticket, &question, &target)?
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
        match provider_keys::global().get(request.target.provider.key_provider()) {
            Ok(key) => meeting_qa::network(&request, key),
            Err(_) => meeting_qa::NetworkResult {
                answer: Err("Add the selected provider's key in Settings before asking.".into()),
                rejected: false,
            },
        }
    })
    .await
    .unwrap_or(meeting_qa::NetworkResult {
        answer: Err("The answer worker stopped. You can retry.".into()),
        rejected: false,
    });
    let complete = move |record: &mut Record| {
        // Acceptance and auth effects share the source/record lock. Never mark a
        // credential rejected because a withdrawn/edited/deleted source replied.
        if !record.finish(&p, sent_question, &outcome.answer) {
            return Err(
                "Question cancelled, expired, or its source changed. No answer was added.".into(),
            );
        }
        if outcome.rejected {
            provider_keys::global().mark_rejected(p.target.provider.key_provider());
        }
        outcome.answer
    };
    if let Some(selected) = saved {
        saved_access(&app, selected, move |record, meeting| {
            if !record.matches_saved(meeting) {
                record.forget();
                return Err(CHANGED.into());
            }
            complete(record)
        })
        .await
    } else {
        complete(
            &mut app
                .state::<AppState>()
                .0
                .lock()
                .map_err(|_| "Notebook unavailable.")?
                .engine
                .meeting_qa,
        )
    }
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
