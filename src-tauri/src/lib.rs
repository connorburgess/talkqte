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
    /// The running live session, if any. Finish it outside this lock, because
    /// delivering transcript lines takes the lock.
    live: Option<Live>,
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
    next.state.user_name = state.user_name.clone();
    next.continue_sessions_from(previous);
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
fn end_demo(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let live = state
        .0
        .lock()
        .ok()
        .and_then(|mut runtime| runtime.live.take());
    let result = change(&app, &state, |e| {
        e.end();
        Ok(())
    });
    // End during a live session releases the microphone and discards
    // transcription in progress; nothing more reaches the ended session.
    if let Some(live) = live {
        tauri::async_runtime::spawn_blocking(move || finish_live(&app, live, false));
    }
    result
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
fn set_user_name(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    name: Option<String>,
) -> Result<(), String> {
    change(&app, &state, |e| e.set_user_name(name))
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

/// A live session's parts: the engine session it feeds, the microphone start
/// capturing for it, and its runner once capture has begun.
struct Live {
    session: u64,
    microphone: Option<u64>,
    runner: Option<live::LiveSession>,
}

/// Finishes a live session already taken out of the runtime: releases its
/// microphone, transcribes the queued audio (`flush`) or discards it, then
/// ends the engine session if it is still the one this fed. Blocks; call it
/// without holding the runtime lock, because delivering lines takes it.
fn finish_live(app: &tauri::AppHandle, live: Live, flush: bool) {
    if let Some(generation) = live.microphone {
        let controller = app.state::<microphone::Controller>().inner().clone();
        microphone::stop_blocking(app, controller, generation);
    }
    if let Some(runner) = live.runner {
        if flush {
            runner.stop();
        } else {
            runner.end();
        }
    }
    let state = app.state::<AppState>();
    let _ = change(app, &state, |e| {
        if e.state.live && e.session() == live.session && e.state.status == engine::Status::Running
        {
            e.end();
        }
        Ok(())
    });
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
            runtime.sync();
            if runtime.live.is_some()
                || matches!(
                    runtime.engine.state.status,
                    engine::Status::Running | engine::Status::Paused
                )
            {
                return Err(if runtime.engine.state.live || runtime.live.is_some() {
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
            let session = runtime.engine.session();
            runtime.live = Some(Live {
                session,
                microphone: None,
                runner: None,
            });
            publish(&app, &runtime);
            session
        };
        companion::refresh(&app);
        let handle = app.clone();
        let controller = microphone.inner().clone();
        let stopper = controller.clone();
        let on_tap: microphone::OnTap = Box::new(move |generation, chunker| {
            let sink_app = handle.clone();
            let sink = move |session, segment| {
                let state = sink_app.state::<AppState>();
                let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
                runtime.sync();
                let result = runtime.engine.ingest(session, segment);
                publish(&sink_app, &runtime);
                result
            };
            // Attach the runner only to the session that asked for it.
            let kept = handle
                .state::<AppState>()
                .0
                .lock()
                .is_ok_and(|mut runtime| {
                    runtime.sync();
                    let engine = &runtime.engine;
                    if !(engine.state.live
                        && engine.session() == session
                        && engine.state.status == engine::Status::Running)
                    {
                        return false;
                    }
                    // Line times count from when capture began on the session clock.
                    let started_at = engine.state.elapsed_ms;
                    let Some(live) = runtime
                        .live
                        .as_mut()
                        .filter(|live| live.session == session && live.runner.is_none())
                    else {
                        return false;
                    };
                    live.microphone = Some(generation);
                    live.runner = Some(live::LiveSession::start(
                        chunker, session, started_at, recognizer, sink,
                    ));
                    true
                });
            if !kept {
                microphone::stop_blocking(&handle, stopper, generation);
            }
        });
        match microphone::start(app.clone(), controller.clone(), Some((3_000, on_tap))).await {
            Ok(generation) => {
                let orphaned = state.0.lock().map_or(true, |mut runtime| {
                    match runtime.live.as_mut().filter(|live| live.session == session) {
                        Some(live) => {
                            live.microphone = Some(generation);
                            false
                        }
                        None => true,
                    }
                });
                if orphaned {
                    // Stopped while capture was being requested.
                    let handle = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        microphone::stop_blocking(&handle, controller, generation)
                    });
                }
                Ok(())
            }
            Err(error) => {
                // Capture never began, so the session ends with nothing in it.
                let live =
                    state.0.lock().ok().and_then(|mut runtime| {
                        runtime.live.take_if(|live| live.session == session)
                    });
                if let Some(live) = live {
                    let handle = app.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        finish_live(&handle, live, false)
                    })
                    .await;
                }
                Err(error)
            }
        }
    }
}

/// Stops a live session: capture stops first, queued audio is transcribed,
/// then the session ends. Does nothing when no live session is running.
#[tauri::command]
async fn stop_live_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let Some(live) = state
        .0
        .lock()
        .ok()
        .and_then(|mut runtime| runtime.live.take())
    else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || finish_live(&app, live, true))
        .await
        .map_err(|_| "Could not finish the live session.".into())
}

/// Stop microphone during a live session stops the whole session, so the
/// notebook never shows a live session with nothing listening.
#[tauri::command]
async fn stop_microphone(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    microphone: tauri::State<'_, microphone::Controller>,
) -> Result<(), String> {
    if state.0.lock().is_ok_and(|runtime| runtime.live.is_some()) {
        stop_live_session(app, state).await
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
            set_user_name,
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
                    // A live session whose microphone was refused, failed, or
                    // stopped elsewhere ends rather than run with nothing
                    // listening. The check never waits on the device.
                    let controller = handle.state::<microphone::Controller>();
                    let lost = runtime
                        .live
                        .as_ref()
                        .and_then(|live| live.microphone)
                        .is_some_and(|generation| {
                            controller.try_is_live(generation) == Some(false)
                        });
                    if lost {
                        if let Some(live) = runtime.live.take() {
                            let app = handle.clone();
                            tauri::async_runtime::spawn_blocking(move || {
                                finish_live(&app, live, true)
                            });
                        }
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
