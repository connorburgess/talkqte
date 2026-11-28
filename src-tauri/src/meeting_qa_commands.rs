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

/// Caller holds the matching source/record guard through acceptance and auth.
fn finish_question(
    record: &mut Record,
    prepared: &meeting_qa::Prepared,
    question: String,
    outcome: meeting_qa::NetworkResult,
    credential_revision: Option<provider_keys::CredentialRevision>,
    keys: &provider_keys::Keys,
) -> Result<Answer, String> {
    if !record.finish(prepared, question, &outcome.answer) {
        return Err(
            "Question cancelled, expired, or its source changed. No answer was added.".into(),
        );
    }
    if outcome.rejected {
        if let Some(revision) = credential_revision {
            keys.mark_rejected(&revision);
        }
    }
    outcome.answer
}

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
    let (outcome, credential_revision) =
        tauri::async_runtime::spawn_blocking(move || {
            let _flight = flight;
            if request.cancelled() {
                return (
                    meeting_qa::NetworkResult {
                        answer: Err("Question cancelled.".into()),
                        rejected: false,
                    },
                    None,
                );
            }
            match provider_keys::global().get_with_revision(request.target.provider.key_provider())
            {
                Ok((key, revision)) => (meeting_qa::network(&request, key), Some(revision)),
                Err(_) => (
                    meeting_qa::NetworkResult {
                        answer: Err(
                            "Add the selected provider's key in Settings before asking.".into()
                        ),
                        rejected: false,
                    },
                    None,
                ),
            }
        })
        .await
        .unwrap_or((
            meeting_qa::NetworkResult {
                answer: Err("The answer worker stopped. You can retry.".into()),
                rejected: false,
            },
            None,
        ));
    let complete = move |record: &mut Record| {
        // Acceptance and auth effects share the source/record lock. Never mark a
        // credential rejected because a withdrawn/edited/deleted source replied.
        finish_question(
            record,
            &p,
            sent_question,
            outcome,
            credential_revision,
            provider_keys::global(),
        )
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

#[cfg(test)]
mod credential_tests {
    use super::*;
    use provider_keys::{KeyState, MemoryStore, Probe, ProbeResult, Provider, Secret};

    struct Offline;
    impl Probe for Offline {
        fn check(&self, _: Provider, _: &Secret) -> ProbeResult {
            panic!("Ask completion must not probe a provider");
        }
    }

    #[test]
    fn ask_auth_completion_requires_both_current_source_and_original_credential() {
        for model in [
            &llm_provider::ANTHROPIC_MODELS[0],
            &llm_provider::OPENAI_MODELS[0],
            &llm_provider::GEMINI_MODELS[0],
        ] {
            let target = llm_provider::ResolvedModel::from_curated(model);
            let provider = target.provider.key_provider();
            let text = match provider {
                Provider::Anthropic => "sk-ant-api03-FICTIONALfictional0123456789abcdefghij-_XYZ",
                Provider::OpenAi => "sk-proj-FICTIONALfictional0123456789abcdefghij-_XYZ",
                Provider::Gemini => "AIzaSyFICTIONALfictional0123456789abcdef",
                _ => unreachable!(),
            };
            for boundary in ["current", "replace", "remove", "readd", "cancel", "source"] {
                let keys =
                    provider_keys::Keys::new(Box::<MemoryStore>::default(), Box::new(Offline));
                keys.set(provider, text).unwrap();
                let mut record = Record::default();
                let scope = record
                    .prepare_source(
                        [meeting_qa::Line {
                            id: "fictional-line".into(),
                            at_ms: 0,
                            text: "The fictional greenhouse check is Saturday.".into(),
                        }],
                        Source::Current {
                            session: "fictional-session".into(),
                        },
                        false,
                        target.clone(),
                    )
                    .unwrap();
                let prepared = record
                    .begin(&scope.ticket, "When is the check?", &target)
                    .unwrap();
                let (_, revision) = keys.get_with_revision(provider).unwrap();
                // The original request is held here, then a source/credential
                // boundary occurs before the existing 401 outcome is released.
                match boundary {
                    "replace" => {
                        keys.set(provider, &format!("{text}replacement")).unwrap();
                    }
                    "remove" => {
                        keys.remove(provider).unwrap();
                    }
                    "readd" => {
                        keys.remove(provider).unwrap();
                        keys.set(provider, text).unwrap();
                    }
                    "cancel" => record.cancel(),
                    "source" => record.bind(Source::Saved {
                        id: "fictional-other".into(),
                        revision: 1,
                    }),
                    _ => {}
                }
                let outcome = meeting_qa::NetworkResult {
                    answer: Err("The provider rejected its key.".into()),
                    rejected: true,
                };
                assert!(finish_question(
                    &mut record,
                    &prepared,
                    "When is the check?".into(),
                    outcome,
                    Some(revision),
                    &keys
                )
                .is_err());
                assert_eq!(
                    keys.status().of(provider).state,
                    if boundary == "current" {
                        KeyState::Rejected
                    } else if boundary == "remove" {
                        KeyState::NotSet
                    } else {
                        KeyState::Set
                    }
                );
                assert!(record.history().is_empty());
            }
        }
    }
}
