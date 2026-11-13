pub mod application_audio;
#[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
mod application_audio_host;
pub mod audio_tap;
mod capture_control;
mod companion;
#[cfg(target_os = "macos")]
mod companion_macos;
pub mod context;
mod context_import;
pub mod context_refresh;
mod context_runtime;
pub mod cue_evaluator;
pub mod engine;
pub mod granola;
pub mod live;
mod live_control;
mod live_source;
mod microphone;
pub mod model;
#[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
mod native_session_clock;
#[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
mod native_source;
pub mod notes_file;
mod processing_commands;
pub mod processing_reviews;
pub mod transcription;

use engine::{CompanionPosition, Engine, QuestionSize, Response, Sensitivity};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

struct Runtime {
    engine: Engine,
    last_tick: Instant,
    /// Active time below one millisecond, retained across syncs and demo pause.
    tick_remainder: Duration,
    tick_session: u64,
    export: Option<String>,
    /// The running live session, if any. Finish it outside this lock, because
    /// delivering transcript lines takes the lock.
    live: Option<Live>,
    live_start: live_control::StartGate,
    /// The approved application-audio source feeding the live session, if
    /// any. Dropping it cancels that source's operation.
    live_source: Option<live_source::LiveSource>,
    processing_reviews: processing_reviews::Reviews,
    processing_status: engine::ProcessingTracker,
    /// Prior notes the user imported this session, in memory only.
    context: context::ContextStore,
    /// A listed note source kept for selection, retry, or cancellation.
    pending_import: Option<context_import::PendingImport>,
    /// The explicit Granola update check and what it last found.
    refresh: context_refresh::Refresh,
    /// The Granola session for this app run, once the person has signed in.
    granola: Option<granola::Shared>,
    /// Set while a Granola sign-in waits for the browser; cleared to cancel.
    granola_sign_in: Option<Arc<AtomicBool>>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            engine: Engine::default(),
            last_tick: Instant::now(),
            tick_remainder: Duration::ZERO,
            tick_session: 0,
            export: None,
            live: None,
            live_start: live_control::StartGate::default(),
            live_source: None,
            processing_reviews: processing_reviews::Reviews::default(),
            processing_status: engine::ProcessingTracker::default(),
            context: context::ContextStore::default(),
            pending_import: None,
            refresh: context_refresh::Refresh::default(),
            granola: None,
            granola_sign_in: None,
        }
    }
}

impl Runtime {
    fn sync(&mut self) {
        self.sync_at(Instant::now());
    }

    /// The Markdown a person reviews before saving, kept so the save dialog
    /// writes exactly that text. A live session is refused, and refusing it
    /// drops any earlier preview.
    fn prepare_export(&mut self) -> Result<String, String> {
        // Live transcripts stay in memory only; this version never saves them.
        if self.engine.state.live {
            self.export = None;
            return Err("Live sessions are not saved or exported.".into());
        }
        let markdown = self.engine.markdown();
        self.export = Some(markdown.clone());
        Ok(markdown)
    }

    fn sync_at(&mut self, now: Instant) {
        let delta = now.duration_since(self.last_tick);
        self.last_tick = now;
        if self.tick_session != self.engine.session() {
            // Replay and a replacement engine each issue a new session ID.
            self.tick_session = self.engine.session();
            self.tick_remainder = Duration::ZERO;
        }
        if self.engine.state.status == engine::Status::Running {
            let elapsed = delta + self.tick_remainder;
            let millis = elapsed.as_millis();
            self.tick_remainder =
                Duration::from_nanos(u64::from(elapsed.subsec_nanos() % 1_000_000));
            self.engine
                .advance(u64::try_from(millis).unwrap_or(u64::MAX));
        }
        self.processing_reviews.reconcile(&self.engine);
        self.reconcile_live_source();
    }
}

struct AppState(Mutex<Runtime>);

// Emit while holding the state lock, preserving revision order across commands/ticks.
fn publish(app: &tauri::AppHandle, runtime: &mut Runtime) {
    let _ = app.emit_to("main", "session:changed", &runtime.engine.state);
    let cue_state = runtime.engine.cue_snapshot();
    let _ = app.emit_to("cue", "cue:changed", &cue_state);
    publish_processing(app, runtime);
}

fn capture_state(snapshot: Option<microphone::Snapshot>) -> engine::CaptureState {
    use engine::CaptureState;
    use microphone::Status;
    match snapshot {
        None => CaptureState::Unknown,
        Some(s) => match s.status {
            Status::Off => CaptureState::Off,
            Status::Starting => CaptureState::Starting,
            Status::Listening => CaptureState::Running,
            Status::Stopping => CaptureState::Stopping,
            Status::Error if s.can_start => CaptureState::Off,
            Status::Error => CaptureState::Stopping,
        },
    }
}

fn publish_processing(app: &tauri::AppHandle, runtime: &mut Runtime) -> engine::ProcessingSnapshot {
    // Never wait behind device startup/teardown while holding Runtime. Unknown
    // remains explicit; neither engine End nor a busy lock confirms capture off.
    let controller = app.state::<microphone::Controller>();
    let (generation, microphone) = controller.control_snapshot();
    let capture = capture_state(microphone);
    #[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
    let capture = application_audio_host::with_source(app, capture);
    let (operation, mut startup) = runtime
        .live_start
        .control()
        .unwrap_or((None, engine::StartupState::Unknown));
    // Loading describes the model, not microphone permission/startup.
    if runtime.live.is_some() && startup == engine::StartupState::Loading {
        startup = engine::StartupState::Idle;
    }
    let target = engine::StopTarget {
        operation,
        microphone: generation.to_string(),
    };
    let (snapshot, changed) = runtime.processing_status.update_with_capture_control(
        &runtime.engine,
        capture,
        target,
        startup,
    );
    if changed {
        let _ = app.emit_to("main", "processing:changed", &snapshot);
    }
    snapshot
}

#[tauri::command]
fn processing_snapshot(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<engine::ProcessingSnapshot, String> {
    if window.label() != "main" {
        return Err("Processing status is available in the notebook only.".into());
    }
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| "Processing status is unavailable.")?;
    Ok(publish_processing(&app, &mut runtime))
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
    let Runtime {
        engine,
        processing_reviews,
        ..
    } = &mut *runtime;
    processing_reviews.reconcile(engine);
    publish(app, &mut runtime);
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
    // Both windows ignore a snapshot older than the last one they saw, so
    // a replacement engine must not start its revisions over: the notebook
    // would keep the old clock and the companion would open for a question
    // it never receives.
    next.state.revision = state.revision;
    next.set_sensitivity(state.sensitivity);
    next.set_overlay(state.overlay_enabled);
    next.set_companion_position(state.companion_position);
    next.set_question_size(state.question_size);
    next.state.notes = state.notes.clone();
    next.state.user_name = state.user_name.clone();
    next.copy_focus_from(previous);
    next.copy_notes_from(previous);
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
fn set_live_cues_paused(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    paused: bool,
) -> Result<(), String> {
    change(&app, &state, |e| e.set_live_cues_paused(paused))
}
#[tauri::command]
fn end_demo(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let live = state
        .0
        .lock()
        .ok()
        .and_then(|mut runtime| runtime.take_live_for_stop());
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
/// Keeps a quoted line in the notebook; an explicit choice, from either window.
#[tauri::command]
fn keep_line(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    id: String,
) -> Result<(), String> {
    change(&app, &state, |e| e.keep_line(&id))
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
    // A preset replaces wherever the person dragged the window to.
    companion::reset_drag(&app);
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
fn set_focus(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    lines: Vec<String>,
) -> Result<(), String> {
    change(&app, &state, |e| e.set_focus(lines))
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
    state
        .0
        .lock()
        .map_err(|_| "Could not prepare the export.")?
        .prepare_export()
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

/// The app's own folder for downloaded models.
fn models_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("models"))
}

/// Where the local speech model is loaded from: `TALKQTE_WHISPER_MODEL`, a
/// developer-supplied file that is not checksum-checked, or the downloaded
/// model in the app's data folder, which is.
fn model_path(app: &tauri::AppHandle) -> Option<(std::path::PathBuf, bool)> {
    if let Some(path) = std::env::var_os("TALKQTE_WHISPER_MODEL") {
        return Some((path.into(), false));
    }
    models_dir(app).map(|dir| (model::installed_path(&dir, &model::TINY_EN), true))
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
    } else if !model_path(&app).is_some_and(|(path, pinned)| {
        if pinned {
            path.parent()
                .is_some_and(|dir| model::is_installed(dir, &model::TINY_EN))
        } else {
            path.is_file()
        }
    }) {
        Some("The local speech model is not installed.")
    } else {
        None
    };
    LiveStatus {
        available: reason.is_none(),
        reason,
    }
}

/// What the notebook shows about the optional model download.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    revision: u64,
    /// `unavailable`, `developer`, `missing`, `downloading`, or `installed`.
    status: &'static str,
    name: &'static str,
    size_bytes: u64,
    needed_bytes: u64,
    received: u64,
    message: Option<String>,
}

#[derive(Default)]
pub struct ModelDownload {
    status: Mutex<ModelStatus>,
    cancel: Arc<AtomicBool>,
}

impl ModelDownload {
    /// The status, even after a panic while it was held: the guard in the
    /// download thread must always be able to reset it.
    fn lock(&self) -> std::sync::MutexGuard<'_, ModelStatus> {
        self.status
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn model_status_now(app: &tauri::AppHandle, revision: u64) -> ModelStatus {
    let spec = model::TINY_EN;
    let status = if !cfg!(feature = "local-whisper") {
        "unavailable"
    } else if std::env::var_os("TALKQTE_WHISPER_MODEL").is_some() {
        "developer"
    } else if models_dir(app).is_some_and(|dir| model::is_installed(&dir, &spec)) {
        "installed"
    } else {
        "missing"
    };
    ModelStatus {
        revision,
        status,
        name: spec.name,
        size_bytes: spec.bytes,
        needed_bytes: spec.bytes + model::SPACE_MARGIN,
        received: 0,
        message: None,
    }
}

/// Updates the download status and tells the main window.
fn set_model_status(app: &tauri::AppHandle, update: impl FnOnce(&mut ModelStatus)) {
    let download = app.state::<ModelDownload>();
    let mut status = download.lock();
    update(&mut status);
    status.revision += 1;
    let _ = app.emit_to("main", "model:changed", status.clone());
}

#[tauri::command]
fn model_status(app: tauri::AppHandle, download: tauri::State<ModelDownload>) -> ModelStatus {
    let mut status = download.lock().clone();
    if status.status != "downloading" {
        let message = status.message.take();
        status = ModelStatus {
            message,
            ..model_status_now(&app, status.revision)
        };
    }
    status
}

/// Puts the download status back to what is on disk when the download
/// thread ends for any reason, including a panic.
#[cfg(feature = "local-whisper")]
struct DownloadDone {
    app: tauri::AppHandle,
    message: Option<String>,
}

#[cfg(feature = "local-whisper")]
impl Drop for DownloadDone {
    fn drop(&mut self) {
        let message = self.message.take().or_else(|| {
            std::thread::panicking()
                .then(|| "The download stopped unexpectedly. Nothing was installed.".into())
        });
        let app = self.app.clone();
        set_model_status(&self.app, |status| {
            let revision = status.revision;
            *status = ModelStatus {
                message,
                ..model_status_now(&app, revision)
            };
        });
    }
}

/// Downloads the pinned speech model after the person chose to. The request
/// carries no account, audio, or transcript; the file is checked against
/// its pinned SHA-256 before it is installed.
#[tauri::command]
fn download_model(
    app: tauri::AppHandle,
    download: tauri::State<ModelDownload>,
) -> Result<(), String> {
    #[cfg(not(feature = "local-whisper"))]
    {
        let _ = (app, download);
        Err("This build does not include local transcription.".into())
    }
    #[cfg(feature = "local-whisper")]
    {
        let dir = models_dir(&app).ok_or("The app's storage folder is unavailable.")?;
        {
            // Checked and set under one lock, so two downloads never overlap.
            let mut status = download.lock();
            if status.status == "downloading" {
                return Err("The model is already downloading.".into());
            }
            let revision = status.revision;
            *status = ModelStatus {
                status: "downloading",
                ..model_status_now(&app, revision)
            };
            download.cancel.store(false, Ordering::Release);
        }
        set_model_status(&app, |_| {});
        let cancel = download.cancel.clone();
        let thread_app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("talkqte-model-download".into())
            .spawn(move || {
                let app = thread_app;
                let mut done = DownloadDone {
                    app: app.clone(),
                    message: None,
                };
                let mut last_percent = 0;
                let result = model::download(
                    &dir,
                    &model::TINY_EN,
                    &model::Https,
                    model::available_space,
                    |received, total| {
                        let percent = received * 100 / total.max(1);
                        if percent != last_percent {
                            last_percent = percent;
                            set_model_status(&app, |status| status.received = received);
                        }
                    },
                    &cancel,
                );
                done.message = result.err().map(|failure| failure.message());
            });
        if spawned.is_err() {
            set_model_status(&app, |status| {
                let revision = status.revision;
                *status = model_status_now(&app, revision);
            });
            return Err("Could not start the download.".into());
        }
        Ok(())
    }
}

/// Asks a running download to stop. It stops at its next read, within the
/// fetcher's time limits, and then reports that nothing was installed.
#[tauri::command]
fn cancel_model_download(app: tauri::AppHandle, download: tauri::State<ModelDownload>) {
    download.cancel.store(true, Ordering::Release);
    set_model_status(&app, |status| {
        if status.status == "downloading" {
            status.message = Some("Cancelling…".into());
        }
    });
}

/// Deletes the downloaded model; a live session must be stopped first.
#[tauri::command]
fn remove_model(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    download: tauri::State<ModelDownload>,
) -> Result<(), String> {
    if state.0.lock().is_ok_and(|runtime| {
        runtime.live.is_some()
            || (runtime.engine.state.live && runtime.engine.state.status == engine::Status::Running)
    }) {
        return Err("Stop the live session before removing the model.".into());
    }
    let dir = models_dir(&app).ok_or("The app's storage folder is unavailable.")?;
    // Held throughout, so a download cannot start while the file is removed.
    let mut status = download.lock();
    if status.status == "downloading" {
        return Err("Cancel the download before removing the model.".into());
    }
    model::remove(&dir, &model::TINY_EN).map_err(|_| "The model could not be removed.")?;
    let revision = status.revision + 1;
    *status = model_status_now(&app, revision);
    let _ = app.emit_to("main", "model:changed", status.clone());
    Ok(())
}

/// The longest live chunk, and the shortest that may end at a pause.
#[cfg(feature = "local-whisper")]
const LIVE_CHUNK_MS: u64 = 3_000;
#[cfg(feature = "local-whisper")]
const LIVE_PAUSE_MIN_MS: u64 = 1_000;

/// What the notebook shows about prior notes picked from a file.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedNotes {
    file_name: String,
    notes: Vec<notes_file::NoteSummary>,
    /// Notes in the file that are not listed: beyond the limit or repeated.
    skipped: usize,
}

fn publish_context(app: &tauri::AppHandle, runtime: &mut Runtime) {
    // The engine may quote an imported note as a context reminder.
    let cue_changed = runtime.sync_prior_notes();
    emit_context(app, runtime, cue_changed);
}

/// Tells the windows about prior notes the engine has already been given.
fn emit_context(app: &tauri::AppHandle, runtime: &mut Runtime, cue_changed: bool) {
    if cue_changed {
        // A changed or removed note may be visible in either window, even held.
        publish(app, runtime);
    }
    let _ = app.emit_to("main", "context:changed", runtime.context.items());
    publish_processing(app, runtime);
}

/// Lets the user choose a notes file, reads it, and lists its notes for
/// selection. Nothing is imported until `import_context_notes`.
#[tauri::command]
async fn pick_context_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<PickedNotes>, String> {
    let picker = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .add_filter("TalkQTE notes", &["json"])
            .blocking_pick_file()
            .map(|file| {
                file.into_path()
                    .map_err(|_| "Choose a local file.".to_string())
            })
    })
    .await
    .map_err(|_| "Could not open the file chooser.")?;
    let Some(path) = picked.transpose()? else {
        return Ok(None);
    };
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let source = tauri::async_runtime::spawn_blocking(move || notes_file::FileSource::read(&path))
        .await
        .map_err(|_| "The file could not be read.")??;
    let notes = source.summaries();
    let skipped = source.skipped;
    // A new pick replaces any file still waiting for a selection.
    state
        .0
        .lock()
        .map_err(|_| "The notebook is unavailable.")?
        .pending_import = Some(context_import::PendingImport::new(Box::new(source)));
    Ok(Some(PickedNotes {
        file_name,
        notes,
        skipped,
    }))
}

/// Imports the selected notes from the file read by `pick_context_file`.
#[tauri::command]
async fn import_context_notes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<context::MergeOutcome, String> {
    // The fetch may go to a provider, so it runs off the main thread and
    // outside the lock, with real pauses between retries.
    let (mut attempt, provider) = {
        let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
        let pending = runtime
            .pending_import
            .as_mut()
            .ok_or("Choose notes first.")?;
        let provider = pending.provider();
        if provider == context::Provider::Granola && ids.len() > 10 {
            return Err("Choose up to 10 Granola notes per import.".into());
        }
        (
            pending.start().ok_or("An import is already running.")?,
            provider,
        )
    };
    let selection = ids.clone();
    let (attempt, fetched) = tauri::async_runtime::spawn_blocking(move || {
        let fetched = attempt.fetch(&selection);
        (attempt, fetched)
    })
    .await
    .map_err(|_| "The notes could not be read. Close the chooser and try again.".to_string())?;
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    if !runtime
        .pending_import
        .as_mut()
        .is_some_and(|pending| pending.restore(attempt))
    {
        return Err("Import cancelled. Nothing was imported.".into());
    }
    let fetched = fetched.map_err(|error| match error {
        context::FetchError::Failed(context::ConnectionStatus::Expired) => {
            "Granola's sign-in has expired. Close this chooser, disconnect, and connect again."
        }
        context::FetchError::Failed(context::ConnectionStatus::Revoked) => {
            "Granola withdrew this app's access. Close this chooser, disconnect, and connect again if you want to."
        }
        context::FetchError::Failed(context::ConnectionStatus::RateLimited { .. }) => {
            "Granola asked for a pause. Try importing again in a moment."
        }
        context::FetchError::Failed(context::ConnectionStatus::UnsupportedFormat) => {
            "Granola returned a note format TalkQTE cannot read yet. Nothing was imported. Cancel to return to your notebook."
        }
        _ => "The selected notes could not be read. Nothing was imported. Try again, or cancel to choose other notes.",
    })?;
    runtime.pending_import = None;
    let (outcome, cue_changed) = runtime.merge_imported_notes(provider, &ids, fetched);
    emit_context(&app, &mut runtime, cue_changed);
    Ok(outcome)
}

#[tauri::command]
fn cancel_context_import(state: tauri::State<AppState>) {
    if let Ok(mut runtime) = state.0.lock() {
        runtime.pending_import = None;
    }
}

#[tauri::command]
fn context_items(state: tauri::State<AppState>) -> Result<Vec<context::ContextItem>, String> {
    state
        .0
        .lock()
        .map(|runtime| runtime.context.items().to_vec())
        .map_err(|_| "The notebook is unavailable.".into())
}

/// Removes one imported note; an explicit choice, separate from anything else.
#[tauri::command]
fn remove_context_item(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    provider: context::Provider,
    source_id: String,
) -> Result<(), String> {
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    if !runtime.context.remove(provider, &source_id) {
        return Err("That note is no longer imported.".into());
    }
    runtime.refresh.forget(provider, &source_id);
    publish_context(&app, &mut runtime);
    Ok(())
}

/// Removes every note imported from a file; an explicit choice that leaves
/// nothing of them in memory.
#[tauri::command]
fn remove_context_from(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<usize, String> {
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let removed = runtime.context.remove_all_from(context::Provider::File)
        + runtime.context.remove_all_from(context::Provider::Granola);
    runtime.pending_import = None;
    runtime.refresh.forget_all();
    publish_context(&app, &mut runtime);
    Ok(removed)
}

/// What the interface may know about the Granola connection: whether one is
/// open and which tools the server offered. Never account identity.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GranolaStatus {
    connected: bool,
    tools: Vec<String>,
    /// Whether this connection can verify its workspace for an update check.
    update_check: bool,
    freshness: Vec<context_refresh::NoteFreshness>,
}

fn granola_status_now(runtime: &Runtime) -> GranolaStatus {
    GranolaStatus {
        connected: runtime.granola.is_some(),
        tools: runtime
            .granola
            .as_ref()
            .map(granola::Shared::tool_names)
            .unwrap_or_default(),
        update_check: runtime
            .granola
            .as_ref()
            .is_some_and(context_refresh::RefreshSource::binding_supported),
        freshness: runtime.refresh.freshness(&runtime.context),
    }
}

fn granola_error(error: &context::SourceError) -> String {
    match error {
        context::SourceError::Expired => "Granola's sign-in has expired; connect again.".into(),
        context::SourceError::Revoked => {
            "Granola withdrew this app's access; connect again if you want to.".into()
        }
        context::SourceError::RateLimited { .. } => {
            "Granola asked for a pause; try again in a moment.".into()
        }
        context::SourceError::Interrupted => "Granola could not be reached.".into(),
        context::SourceError::Unavailable => "Granola's notes are not available right now.".into(),
        context::SourceError::UnsupportedFormat => {
            "Granola returned a note format TalkQTE cannot read yet.".into()
        }
    }
}

/// Signs in to Granola in the person's browser and opens a session. Nothing
/// is read until they list and choose notes; the tokens stay in memory.
#[tauri::command]
async fn connect_granola(state: tauri::State<'_, AppState>) -> Result<GranolaStatus, String> {
    let cancel = state
        .0
        .lock()
        .map_err(|_| "The notebook is unavailable.")?
        .begin_granola_sign_in()?;
    let waiting = cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let tokens = granola::sign_in(
            &|url| open::that(url).map_err(|_| "The browser could not be opened.".to_string()),
            &|| waiting.load(Ordering::Relaxed),
        )?;
        if waiting.load(Ordering::Relaxed) {
            return Err("Sign-in cancelled.".into());
        }
        granola::Connection::open(&tokens).map_err(|error| granola_error(&error))
    })
    .await
    .map_err(|_| "The sign-in could not finish.".to_string());
    state
        .0
        .lock()
        .map_err(|_| "The notebook is unavailable.")?
        .finish_granola_sign_in(&cancel, result.and_then(|opened| opened))
}

impl Runtime {
    /// Registers a sign-in and returns the flag that cancels it; one at a
    /// time, and never beside an open connection.
    fn begin_granola_sign_in(&mut self) -> Result<Arc<AtomicBool>, String> {
        if self.granola.is_some() {
            return Err("Disconnect Granola before connecting again.".into());
        }
        if self.granola_sign_in.is_some() {
            return Err("A Granola sign-in is already in progress.".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        self.granola_sign_in = Some(cancel.clone());
        Ok(cancel)
    }

    /// Ends the sign-in that `cancel` belongs to and keeps its connection,
    /// unless it failed or was cancelled.
    fn finish_granola_sign_in(
        &mut self,
        cancel: &AtomicBool,
        result: Result<granola::Connection, String>,
    ) -> Result<GranolaStatus, String> {
        self.granola_sign_in = None;
        let connection = result?;
        // A cancel that arrived after the browser returned still wins.
        if cancel.load(Ordering::Relaxed) {
            return Err("Sign-in cancelled.".into());
        }
        self.granola = Some(granola::Shared::new(connection));
        Ok(granola_status_now(self))
    }

    /// Forgets the Granola session and cancels a sign-in still waiting for
    /// the browser. Imported notes stay.
    fn disconnect_granola(&mut self) -> GranolaStatus {
        if let Some(connection) = self.granola.take() {
            connection.disconnect();
        }
        self.refresh.disconnect();
        if let Some(cancel) = &self.granola_sign_in {
            cancel.store(true, Ordering::Relaxed);
        }
        if self
            .pending_import
            .as_ref()
            .is_some_and(|source| source.provider() == context::Provider::Granola)
        {
            self.pending_import = None;
        }
        granola_status_now(self)
    }
}

#[tauri::command]
fn cancel_granola_sign_in(state: tauri::State<AppState>) {
    if let Ok(runtime) = state.0.lock() {
        if let Some(cancel) = &runtime.granola_sign_in {
            cancel.store(true, Ordering::Relaxed);
        }
    }
}

#[tauri::command]
fn granola_status(state: tauri::State<AppState>) -> Result<GranolaStatus, String> {
    state
        .0
        .lock()
        .map(|runtime| granola_status_now(&runtime))
        .map_err(|_| "The notebook is unavailable.".into())
}

/// Lists the signed-in person's recent notes to choose from, the way a
/// picked file is listed; only the ticked notes are fetched afterwards.
#[tauri::command]
async fn list_granola_notes(state: tauri::State<'_, AppState>) -> Result<PickedNotes, String> {
    let shared = state
        .0
        .lock()
        .map_err(|_| "The notebook is unavailable.")?
        .granola
        .clone()
        .ok_or("Connect Granola first.")?;
    let listing = shared.clone();
    let (notes, skipped) = tauri::async_runtime::spawn_blocking(move || {
        listing.list_recent().map_err(|error| granola_error(&error))
    })
    .await
    .map_err(|_| "Granola's notes could not be listed.".to_string())??;
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    // A disconnect or account replacement while listing wins.
    if !shared.is_current(runtime.granola.as_ref()) {
        return Err("The Granola connection changed. Choose notes again.".into());
    }
    runtime.pending_import = Some(context_import::PendingImport::new(Box::new(shared)));
    Ok(PickedNotes {
        file_name: "Granola · the last 30 days".into(),
        notes,
        skipped,
    })
}

/// Asks Granola's assistant one fixed question about the person's recent
/// meetings and returns candidate focus lines for them to tick. Only
/// offered when the server lists the tool; nothing is stored.
#[tauri::command]
async fn suggest_granola_focus(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let shared = state
        .0
        .lock()
        .map_err(|_| "The notebook is unavailable.")?
        .granola
        .clone()
        .ok_or("Connect Granola first.")?;
    if !shared.can_suggest() {
        return Err(
            "This Granola account does not offer the assistant that answers questions.".into(),
        );
    }
    let request = shared.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        request.suggest_focus().map_err(|error| match error {
            context::SourceError::Interrupted => {
                "Granola's assistant did not answer in time; try again.".to_string()
            }
            other => granola_error(&other),
        })
    })
    .await
    .map_err(|_| "Granola's suggestions could not be fetched.".to_string())?;
    let runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    if !shared.is_current(runtime.granola.as_ref()) {
        return Err("The Granola connection changed. Ask for suggestions again.".into());
    }
    result
}

/// Checks once, on request, whether the imported Granola notes are still the
/// provider's latest revisions. See `context_refresh.rs` for the rules.
#[tauri::command]
async fn check_granola_updates(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<context_refresh::Report, String> {
    let (ticket, shared) = {
        let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
        let shared = runtime.granola.clone().ok_or("Connect Granola first.")?;
        if !context_refresh::RefreshSource::binding_supported(&shared) {
            return Err("This Granola connection cannot be checked for updates yet.".into());
        }
        let runtime = &mut *runtime;
        let ticket = runtime
            .refresh
            .begin(&runtime.context)
            .map_err(|error| match error {
                context_refresh::BeginError::Running => "A check is already running.",
                context_refresh::BeginError::Unsettled => {
                    "The earlier check has not finished at Granola yet. Try again in a moment."
                }
                context_refresh::BeginError::NoNotes => "No Granola notes are selected.",
            })?;
        (ticket, shared)
    };
    let finished = tauri::async_runtime::spawn_blocking(move || {
        let result =
            context_refresh::run(&ticket, Box::new(shared), context_refresh::CHECK_TIMEOUT);
        (ticket, result)
    })
    .await;
    let Ok((ticket, result)) = finished else {
        // Without a ticket to apply, end the check so another can start.
        if let Ok(mut runtime) = state.0.lock() {
            runtime.refresh.stop();
        }
        return Err("The check could not finish.".into());
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let runtime = &mut *runtime;
    let (report, cue_changed) = runtime.finish_update_check(&ticket, result, now_ms);
    if let Some(cue_changed) = cue_changed {
        emit_context(&app, runtime, cue_changed);
    }
    Ok(report)
}

/// Stops a running update check; its result is discarded. A request already
/// sent may still finish at the provider.
#[tauri::command]
fn stop_granola_update_check(state: tauri::State<AppState>) {
    if let Ok(mut runtime) = state.0.lock() {
        runtime.refresh.stop();
    }
}

/// Forgets the Granola session. Imported notes stay until removed, as they
/// would for a file; nothing is written back.
#[tauri::command]
fn disconnect_granola(state: tauri::State<AppState>) -> Result<GranolaStatus, String> {
    state
        .0
        .lock()
        .map(|mut runtime| runtime.disconnect_granola())
        .map_err(|_| "The notebook is unavailable.".into())
}

/// A live session's parts: the engine session it feeds, the microphone start
/// capturing for it, and its runner once capture has begun.
struct Live {
    operation: Option<String>,
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
        e.finish_live_stop(live.session);
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
        let (model, pinned) = model_path(&app)
            .filter(|(path, _)| path.is_file())
            .ok_or("The local speech model is not installed.")?;
        let start = state
            .0
            .lock()
            .map_err(|_| "The session is unavailable.")?
            .begin_live_start()?;
        // Load the model before capture starts, so a bad file is reported
        // here and the microphone never opens for nothing.
        // A downloaded model is checked against its pinned checksum first.
        let (start, recognizer) = tauri::async_runtime::spawn_blocking(move || {
            start.load(|| {
                if pinned {
                    model::verify(&model, &model::TINY_EN)?;
                }
                transcription::whisper::LocalWhisper::load(&model, 4)
                    .map_err(|_| "Could not load the local speech model.".to_string())
            })
        })
        .await
        .map_err(|_| "Could not load the local speech model.")??;
        let session = {
            let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
            runtime.sync();
            let session = runtime.install_live_start(&start)?;
            publish(&app, &mut runtime);
            session
        };
        companion::refresh(&app);
        let handle = app.clone();
        let controller = microphone.inner().clone();
        let stopper = controller.clone();
        let reservation_app = app.clone();
        let start_guard = start.guard();
        let on_reserved: microphone::OnReserved = Box::new(move |generation| {
            reservation_app
                .state::<AppState>()
                .0
                .lock()
                .is_ok_and(|mut runtime| {
                    runtime.reserve_live_microphone(&start_guard, session, generation)
                })
        });
        let on_tap: microphone::OnTap = Box::new(move |generation, mut chunker| {
            // Chunks end at the first pause after a second, or at the
            // longest length, so words are cut less often and arrive sooner.
            chunker.cut_at_pauses(LIVE_PAUSE_MIN_MS);
            let sink_app = handle.clone();
            let sink = move |session, segment| {
                let state = sink_app.state::<AppState>();
                let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
                runtime.sync();
                let result = runtime.engine.ingest(session, segment);
                publish(&sink_app, &mut runtime);
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
        match microphone::start(
            app.clone(),
            controller.clone(),
            Some((LIVE_CHUNK_MS, on_tap)),
            Some(on_reserved),
        )
        .await
        {
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
                let live = state.0.lock().ok().and_then(|mut runtime| {
                    if runtime
                        .live
                        .as_ref()
                        .is_some_and(|live| live.session == session)
                    {
                        runtime.take_live_for_stop()
                    } else {
                        None
                    }
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
/// then the session ends. Also cancels model loading before capture exists.
#[tauri::command]
async fn stop_live_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let live = {
        let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
        let live = runtime.take_live_for_stop();
        publish(&app, &mut runtime);
        live
    };
    let Some(live) = live else {
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
    state
        .0
        .lock()
        .map_err(|_| "The session is unavailable.")?
        .live_start
        .cancel();
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
        .manage(AppState(Mutex::new(Runtime::default())))
        .manage(companion::WindowState::default())
        .manage(microphone::Controller::default())
        .manage(ModelDownload::default())
        .invoke_handler(tauri::generate_handler![
            #[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
            application_audio_host::app::application_audio,
            capture_control::stop_capture,
            processing_commands::review_processing_scope,
            processing_commands::approve_processing_scope,
            processing_commands::cancel_processing_review,
            processing_commands::revoke_processing,
            processing_commands::set_processing_paused,
            processing_snapshot,
            snapshot,
            start_demo,
            pause_demo,
            resume_demo,
            set_live_cues_paused,
            end_demo,
            respond_to_cue,
            keep_line,
            inspect_cue,
            set_companion_position,
            set_question_size,
            update_notes,
            set_sensitivity,
            set_user_name,
            set_focus,
            set_overlay,
            export_preview,
            export_markdown,
            live_status,
            model_status,
            pick_context_file,
            import_context_notes,
            cancel_context_import,
            context_items,
            remove_context_item,
            remove_context_from,
            connect_granola,
            cancel_granola_sign_in,
            granola_status,
            list_granola_notes,
            disconnect_granola,
            suggest_granola_focus,
            check_granola_updates,
            stop_granola_update_check,
            download_model,
            cancel_model_download,
            remove_model,
            start_live_session,
            stop_live_session,
            microphone::microphone_snapshot,
            microphone::start_microphone,
            stop_microphone
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            companion_macos::hide_controls(app)?;
            #[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
            application_audio_host::install(app.handle())?;
            // A download interrupted by quitting never counts as installed.
            if let Some(dir) = models_dir(app.handle()) {
                model::clean_partials(&dir);
            }
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
                        publish(&handle, &mut runtime);
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
                        if let Some(live) = runtime.take_live_for_stop() {
                            publish(&handle, &mut runtime);
                            let app = handle.clone();
                            tauri::async_runtime::spawn_blocking(move || {
                                finish_live(&app, live, true)
                            });
                        }
                    }
                    let cue = runtime.engine.cue_snapshot();
                    publish_processing(&handle, &mut runtime);
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
            if window.label() == "cue" {
                if let tauri::WindowEvent::Moved(position) = event {
                    companion::moved(window.app_handle(), (position.x, position.y));
                }
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
                #[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
                application_audio_host::exit(app);
            }
        });
}

#[cfg(test)]
mod granola_privacy_tests;

#[cfg(test)]
mod test_isolation;

#[cfg(test)]
mod carry_over_tests {
    use super::*;

    #[test]
    fn a_replacement_engine_continues_the_revision_count() {
        let mut previous = Engine::default();
        previous.start().unwrap();
        previous.advance(5_200);
        previous.pause().unwrap();
        previous.resume().unwrap();
        previous.end();
        let before = previous.state.revision;
        assert!(before >= 4, "the first session published several snapshots");
        let next = carry_over(&previous, Engine::live());
        assert!(next.state.revision > before);
        let again = carry_over(&next, Engine::default());
        assert!(again.state.revision > next.state.revision);
    }
}

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn a_live_session_is_never_prepared_for_export_and_drops_an_earlier_preview() {
        let mut runtime = Runtime::default();
        runtime
            .engine
            .update_notes("A fictional notebook line.".into())
            .unwrap();
        let reviewed = runtime.prepare_export().unwrap();
        assert!(reviewed.contains("A fictional notebook line."));
        assert_eq!(runtime.export.as_deref(), Some(reviewed.as_str()));

        // Starting a live session forgets the demo preview, so the save
        // dialog has nothing to write while the microphone is in use.
        let ticket = runtime.begin_live_start().unwrap();
        let (ticket, ()) = ticket.load(|| Ok(())).unwrap(); // No model or device.
        let session = runtime.install_live_start(&ticket).unwrap();
        assert!(runtime.export.is_none());
        runtime.engine.advance(1_000);
        runtime
            .engine
            .ingest(
                session,
                engine::Segment {
                    id: "l1".into(),
                    at_ms: 1_000,
                    speaker: "Speaker".into(),
                    text: "The greenhouse keys are in the blue tin.".into(),
                },
            )
            .unwrap();
        // The notebook still shows the line; only saving it is refused.
        assert_eq!(runtime.engine.state.transcript.len(), 1);
        assert_eq!(
            runtime.prepare_export().unwrap_err(),
            "Live sessions are not saved or exported."
        );
        assert!(runtime.export.is_none());

        // Stopping keeps the transcript on screen and still refuses to save it.
        runtime.engine.end();
        assert_eq!(runtime.engine.state.transcript.len(), 1);
        assert!(runtime.prepare_export().is_err());
        assert!(runtime.export.is_none());

        // The demo that follows starts from its script: notes carry over, the
        // live transcript does not, and export works again.
        runtime.engine = carry_over(&runtime.engine, Engine::default());
        let after = runtime.prepare_export().unwrap();
        assert!(after.contains("A fictional notebook line."));
        assert!(!after.contains("blue tin"));
    }
}

#[cfg(test)]
mod processing_capture_tests {
    use super::*;

    #[test]
    fn capture_confirmation_comes_from_the_adapter_including_failed_cleanup() {
        use engine::CaptureState as C;
        use microphone::Status as M;
        assert_eq!(capture_state(None), C::Unknown);
        for (status, can_start, expected) in [
            (M::Off, true, C::Off),
            (M::Starting, false, C::Starting),
            (M::Listening, false, C::Running),
            (M::Stopping, false, C::Stopping),
            (M::Error, false, C::Stopping),
            (M::Error, true, C::Off),
        ] {
            assert_eq!(
                capture_state(Some(microphone::Snapshot {
                    status,
                    can_start,
                    ..microphone::Snapshot::default()
                })),
                expected
            );
        }
    }
}

#[cfg(test)]
mod session_clock_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn frequent_syncs_preserve_elapsed_time_and_demo_cue_timing() {
        let mut runtime = Runtime::default();
        runtime.engine.start().unwrap();
        let origin = runtime.last_tick;
        let mut expected = Engine::default();
        expected.start().unwrap();
        // The same duration must have the same effect regardless of how often
        // commands, transcript delivery and the timer synchronize the clock.
        for tick in 1..=10_000 {
            runtime.sync_at(origin + Duration::from_micros(tick * 1_500));
        }
        expected.advance(15_000);
        assert_eq!(runtime.engine.state.elapsed_ms, 15_000);
        assert_eq!(
            runtime.engine.state.transcript.len(),
            expected.state.transcript.len()
        );
        assert_eq!(
            runtime.engine.state.cue.as_ref().map(|c| &c.id),
            expected.state.cue.as_ref().map(|c| &c.id)
        );
        assert_eq!(
            runtime.engine.state.cue.as_ref().unwrap().remaining_ms,
            8_000
        );
        runtime.sync_at(origin + Duration::from_millis(15_000));
        assert_eq!(runtime.engine.state.elapsed_ms, 15_000);
        runtime.sync_at(origin + Duration::from_millis(23_000));
        assert!(runtime.engine.state.cue.is_none());
    }

    #[test]
    fn pause_excludes_idle_time_but_keeps_the_same_sessions_fraction() {
        let mut runtime = Runtime::default();
        let origin = runtime.last_tick;
        runtime.sync_at(origin + Duration::from_micros(10_750));
        runtime.engine.start().unwrap();
        runtime.sync_at(origin + Duration::from_micros(11_250));
        runtime.engine.pause().unwrap();
        runtime.sync_at(origin + Duration::from_micros(20_999_750));
        assert_eq!(runtime.engine.state.elapsed_ms, 0);
        runtime.engine.resume().unwrap();
        runtime.sync_at(origin + Duration::from_micros(21_000_250));
        assert_eq!(runtime.engine.state.elapsed_ms, 1);
    }

    #[test]
    fn replay_and_engine_replacement_do_not_inherit_a_fraction() {
        for replace in [false, true] {
            let mut runtime = Runtime::default();
            let origin = runtime.last_tick;
            runtime.engine.start().unwrap();
            runtime.sync_at(origin + Duration::from_micros(900));
            runtime.engine.end();
            runtime.sync_at(origin + Duration::from_secs(10));
            if replace {
                runtime.engine = carry_over(&runtime.engine, Engine::live());
            }
            runtime.engine.start().unwrap();
            runtime.sync_at(origin + Duration::from_micros(10_000_500));
            assert_eq!(runtime.engine.state.elapsed_ms, 0);
            runtime.sync_at(origin + Duration::from_micros(10_001_000));
            assert_eq!(runtime.engine.state.elapsed_ms, 1);
        }
    }

    #[test]
    fn pausing_live_cues_does_not_pause_the_session_clock() {
        let mut runtime = Runtime {
            engine: Engine::live(),
            ..Runtime::default()
        };
        let origin = runtime.last_tick;
        runtime.engine.start().unwrap();
        runtime.sync_at(origin + Duration::from_micros(500));
        runtime.engine.set_live_cues_paused(true).unwrap();
        runtime.sync_at(origin + Duration::from_micros(1_000));
        assert_eq!(runtime.engine.state.elapsed_ms, 1);
        runtime.engine.set_live_cues_paused(false).unwrap();
        runtime.sync_at(origin + Duration::from_micros(1_500));
        runtime.sync_at(origin + Duration::from_micros(2_000));
        assert_eq!(runtime.engine.state.elapsed_ms, 2);
    }
}
