mod companion;
#[cfg(target_os = "macos")]
mod companion_macos;
pub mod context;
pub mod engine;
mod microphone;
pub mod transcription;

use engine::{CompanionPosition, Engine, QuestionSize, Response, Sensitivity};
use std::{sync::Mutex, time::Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

struct Runtime {
    engine: Engine,
    last_tick: Instant,
    export: Option<String>,
}

impl Runtime {
    fn sync(&mut self) {
        let now = Instant::now();
        self.engine
            .advance(now.duration_since(self.last_tick).as_millis() as u64);
        self.last_tick = now;
    }
}

struct AppState(Mutex<Runtime>);

// Emit while holding the state lock, preserving revision order across commands/ticks.
fn publish(app: &tauri::AppHandle, runtime: &Runtime) {
    let _ = app.emit_to("main", "session:changed", &runtime.engine.state);
    let cue_state = runtime.engine.cue_snapshot();
    let _ = app.emit_to("cue", "cue:changed", &cue_state);
}

fn change(
    app: &tauri::AppHandle,
    state: &AppState,
    action: impl FnOnce(&mut Engine) -> Result<(), String>,
) -> Result<(), String> {
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| "The demo is unavailable. Please restart TalkQTE.")?;
    runtime.sync();
    let result = action(&mut runtime.engine);
    publish(app, &runtime);
    drop(runtime);
    companion::refresh(app);
    result
}

#[tauri::command]
fn snapshot(
    window: tauri::WebviewWindow,
    state: tauri::State<AppState>,
) -> Result<serde_json::Value, String> {
    let runtime = state.0.lock().map_err(|_| "The demo is unavailable.")?;
    if window.label() == "cue" {
        serde_json::to_value(runtime.engine.cue_snapshot())
    } else {
        serde_json::to_value(&runtime.engine.state)
    }
    .map_err(|_| "Could not read the demo.".into())
}

#[tauri::command]
fn start_demo(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    change(&app, &state, Engine::start)
}
#[tauri::command]
fn pause_demo(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    change(&app, &state, Engine::pause)
}
#[tauri::command]
fn resume_demo(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    change(&app, &state, Engine::resume)
}
#[tauri::command]
fn end_demo(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    change(&app, &state, |e| {
        e.end();
        Ok(())
    })
}
#[tauri::command]
fn respond_to_cue(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    id: String,
    response: Response,
) -> Result<(), String> {
    change(&app, &state, |e| e.respond(&id, response))
}
#[tauri::command]
fn inspect_cue(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    id: String,
    expanded: bool,
) -> Result<(), String> {
    change(&app, &state, |e| e.inspect_cue(&id, expanded))
}
#[tauri::command]
fn set_companion_position(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    value: CompanionPosition,
) -> Result<(), String> {
    change(&app, &state, |e| {
        e.set_companion_position(value);
        Ok(())
    })
}
#[tauri::command]
fn set_question_size(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    value: QuestionSize,
) -> Result<(), String> {
    change(&app, &state, |e| {
        e.set_question_size(value);
        Ok(())
    })
}
#[tauri::command]
fn update_notes(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    notes: String,
) -> Result<(), String> {
    change(&app, &state, |e| e.update_notes(notes))
}
#[tauri::command]
fn set_sensitivity(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    value: Sensitivity,
) -> Result<(), String> {
    change(&app, &state, |e| {
        e.set_sensitivity(value);
        Ok(())
    })
}
#[tauri::command]
fn set_overlay(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    change(&app, &state, |e| {
        e.set_overlay(enabled);
        Ok(())
    })
}

#[tauri::command]
fn export_preview(state: tauri::State<AppState>) -> Result<String, String> {
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| "Could not prepare the export.")?;
    let markdown = runtime.engine.markdown();
    runtime.export = Some(markdown.clone());
    Ok(markdown)
}

#[tauri::command]
async fn export_markdown(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let markdown = state
        .0
        .lock()
        .map_err(|_| "Could not prepare the export.")?
        .export
        .clone()
        .ok_or("Review the export before choosing a destination.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("Markdown", &["md"])
            .set_file_name("talkqte-demo.md")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = file
            .into_path()
            .map_err(|_| "Choose a local file destination.")?;
        std::fs::write(path, markdown)
            .map_err(|_| "Could not save the file. Choose a writable destination.")?;
        Ok(true)
    })
    .await
    .map_err(|_| "Could not open the save dialog.")?
}

pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(target_os = "macos")]
    let context = companion_macos::configure(context);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState(Mutex::new(Runtime {
            engine: Engine::default(),
            last_tick: Instant::now(),
            export: None,
        })))
        .manage(companion::WindowState::default())
        .manage(microphone::Controller::default())
        .invoke_handler(tauri::generate_handler![
            snapshot,
            start_demo,
            pause_demo,
            resume_demo,
            end_demo,
            respond_to_cue,
            inspect_cue,
            set_companion_position,
            set_question_size,
            update_notes,
            set_sensitivity,
            set_overlay,
            export_preview,
            export_markdown,
            microphone::microphone_snapshot,
            microphone::start_microphone,
            microphone::stop_microphone
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            companion_macos::hide_controls(app)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut last_placement = Instant::now();
                let mut runtime_mode = companion::Mode::Hidden;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    let state = handle.state::<AppState>();
                    let Ok(mut runtime) = state.0.lock() else {
                        break;
                    };
                    let before = runtime.engine.state.revision;
                    runtime.sync();
                    if runtime.engine.state.revision != before {
                        publish(&handle, &runtime);
                    }
                    let cue = runtime.engine.cue_snapshot();
                    drop(runtime);
                    microphone::refresh(&handle);
                    let Some(microphone) = handle.state::<microphone::Controller>().try_status()
                    else {
                        continue;
                    };
                    let mode = companion::Mode::for_snapshot(&cue, microphone);
                    let needs_placement =
                        mode != runtime_mode || last_placement.elapsed().as_secs() >= 1;
                    runtime_mode = mode;
                    if needs_placement {
                        companion::refresh(&handle);
                        last_placement = Instant::now();
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
                )
            {
                companion::refresh(window.app_handle());
            }
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                window.app_handle().exit(0);
            }
        })
        .build(context)
        .expect("TalkQTE could not start")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                microphone::stop_on_exit(app);
            }
        });
}
