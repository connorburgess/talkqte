pub mod audio_tap;
mod companion;
#[cfg(target_os = "macos")]
mod companion_macos;
pub mod context;
pub mod engine;
pub mod live;
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
    /// The running live session, if any. Stop it outside this lock, because
    /// delivering transcript lines takes the lock.
    live: Option<live::LiveSession>,
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

/// A fresh engine that keeps the person's display choices and notes.
fn carry_over(previous: &Engine, mut next: Engine) -> Engine {
    let state = &previous.state;
    next.set_sensitivity(state.sensitivity);
    next.set_overlay(state.overlay_enabled);
    next.set_companion_position(state.companion_position);
    next.set_question_size(state.question_size);
    next.state.notes = state.notes.clone();
    next
}

#[tauri::command]
fn start_demo(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    change(&app, &state, |e| {
        // After a live session, the demo starts from its script again.
        if e.state.live && !matches!(e.state.status, engine::Status::Running) {
            *e = carry_over(e, Engine::default());
        }
        e.start()
    })
}
#[tauri::command]
fn pause_demo(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    change(&app, &state, |e| {
        if e.state.live {
            return Err("A live session cannot be paused. Stop it instead.".into());
        }
        e.pause()
    })
}
#[tauri::command]
fn resume_demo(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    change(&app, &state, |e| {
        if e.state.live {
            return Err("A live session cannot be resumed. Start a new one.".into());
        }
        e.resume()
    })
}
#[tauri::command]
fn end_demo(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    microphone: tauri::State<microphone::Controller>,
) -> Result<(), String> {
    // End during a live session stops capture and discards transcription in
    // progress; nothing more reaches the ended session.
    if let Some(session_runner) = state
        .0
        .lock()
        .ok()
        .and_then(|mut runtime| runtime.live.take())
    {
        let (handle, controller) = (app.clone(), microphone.inner().clone());
        tauri::async_runtime::spawn_blocking(move || {
            microphone::stop_blocking(&handle, controller);
            session_runner.end();
        });
    }
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
    // Live transcripts stay in memory only; this version never saves them.
    if runtime.engine.state.live {
        runtime.export = None;
        return Err("Live sessions are not saved or exported.".into());
    }
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

/// Where the local speech model is expected: `TALKQTE_WHISPER_MODEL`, or the
/// app's data folder. Nothing is downloaded here.
fn model_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("TALKQTE_WHISPER_MODEL") {
        return Some(path.into());
    }
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("models").join("ggml-tiny.en.bin"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveStatus {
    available: bool,
    reason: Option<&'static str>,
}

#[tauri::command]
fn live_status(app: tauri::AppHandle) -> LiveStatus {
    let reason = if !cfg!(feature = "local-whisper") {
        Some("This build does not include local transcription.")
    } else if !model_path(&app).is_some_and(|path| path.is_file()) {
        Some("The local speech model is not installed.")
    } else {
        None
    };
    LiveStatus {
        available: reason.is_none(),
        reason,
    }
}

/// Starts a live session: the microphone feeds local transcription, and the
/// cue engine runs on what is said. Nothing is recorded, stored, or sent.
#[tauri::command]
async fn start_live_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    microphone: tauri::State<'_, microphone::Controller>,
) -> Result<(), String> {
    #[cfg(not(feature = "local-whisper"))]
    {
        let _ = (app, state, microphone);
        Err("This build does not include local transcription.".into())
    }
    #[cfg(feature = "local-whisper")]
    {
        let model = model_path(&app)
            .filter(|path| path.is_file())
            .ok_or("The local speech model is not installed.")?;
        if state.0.lock().is_ok_and(|runtime| runtime.live.is_some()) {
            return Err("A live session is already running.".into());
        }
        // Load the model before capture starts, so a bad file is reported
        // here and the microphone never opens for nothing.
        let recognizer = tauri::async_runtime::spawn_blocking(move || {
            transcription::whisper::LocalWhisper::load(&model, 4)
        })
        .await
        .map_err(|_| "Could not load the local speech model.")?
        .map_err(|_| "Could not load the local speech model.")?;
        let session = {
            let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
            if runtime.live.is_some() {
                return Err("A live session is already running.".into());
            }
            runtime.sync();
            if matches!(
                runtime.engine.state.status,
                engine::Status::Running | engine::Status::Paused
            ) {
                return Err(if runtime.engine.state.live {
                    "A live session is already running.".into()
                } else {
                    "End the demo before starting a live session.".into()
                });
            }
            // Keep the person's display choices; start from a clean session.
            let mut engine = carry_over(&runtime.engine, Engine::live());
            engine.start()?;
            runtime.export = None;
            runtime.engine = engine;
            runtime.last_tick = Instant::now();
            publish(&app, &runtime);
            runtime.engine.session()
        };
        let handle = app.clone();
        let controller = microphone.inner().clone();
        let stopper = controller.clone();
        let is_current = move |runtime: &Runtime| {
            runtime.engine.session() == session
                && runtime.engine.state.live
                && runtime.engine.state.status == engine::Status::Running
        };
        let on_tap: microphone::OnTap = Box::new(move |chunker| {
            // Line times count from when capture began on the session clock.
            let started_at = handle
                .state::<AppState>()
                .0
                .lock()
                .ok()
                .and_then(|mut runtime| {
                    runtime.sync();
                    is_current(&runtime).then_some(runtime.engine.state.elapsed_ms)
                });
            let Some(started_at) = started_at else {
                microphone::stop_blocking(&handle, stopper);
                return;
            };
            let sink_app = handle.clone();
            let session_runner = live::LiveSession::start(
                chunker,
                session,
                started_at,
                recognizer,
                move |session, segment| {
                    let state = sink_app.state::<AppState>();
                    let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
                    runtime.sync();
                    let result = runtime.engine.ingest(session, segment);
                    publish(&sink_app, &runtime);
                    result
                },
            );
            // Keep the session only if it is still the current one.
            let unused = handle
                .state::<AppState>()
                .0
                .lock()
                .ok()
                .and_then(|mut runtime| {
                    if is_current(&runtime) && runtime.live.is_none() {
                        runtime.live = Some(session_runner);
                        None
                    } else {
                        Some(session_runner)
                    }
                });
            if let Some(unused) = unused {
                microphone::stop_blocking(&handle, stopper);
                unused.end();
            }
        });
        let started = microphone::start(app.clone(), controller, Some((3_000, on_tap))).await;
        if started.is_err() {
            // Capture never began, so the live session ends with nothing in it.
            let _ = change(&app, &state, |e| {
                if e.session() == session {
                    e.end();
                }
                Ok(())
            });
        }
        started
    }
}

/// Stops a live session: capture stops first, queued audio is transcribed,
/// then the session ends.
#[tauri::command]
async fn stop_live_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    microphone: tauri::State<'_, microphone::Controller>,
) -> Result<(), String> {
    let controller = microphone.inner().clone();
    let stopper = app.clone();
    tauri::async_runtime::spawn_blocking(move || microphone::stop_blocking(&stopper, controller))
        .await
        .map_err(|_| "Could not stop the microphone. Try again.")?;
    let session_runner = state
        .0
        .lock()
        .ok()
        .and_then(|mut runtime| runtime.live.take());
    if let Some(session_runner) = session_runner {
        tauri::async_runtime::spawn_blocking(move || session_runner.stop())
            .await
            .map_err(|_| "Could not finish transcription.")?;
    }
    change(&app, &state, |e| {
        e.end();
        Ok(())
    })
}

/// Stop microphone during a live session stops the whole session, so the
/// notebook never shows a live session with nothing listening.
#[tauri::command]
async fn stop_microphone(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    microphone: tauri::State<'_, microphone::Controller>,
) -> Result<(), String> {
    let live = state.0.lock().is_ok_and(|runtime| {
        runtime.live.is_some()
            || (runtime.engine.state.live && runtime.engine.state.status == engine::Status::Running)
    });
    if live {
        stop_live_session(app, state, microphone).await
    } else {
        microphone::stop_microphone(app, microphone.inner().clone()).await
    }
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
            live: None,
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
            live_status,
            start_live_session,
            stop_live_session,
            microphone::microphone_snapshot,
            microphone::start_microphone,
            stop_microphone
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
