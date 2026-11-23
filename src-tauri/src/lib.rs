pub mod anthropic_api;
pub mod application_audio;
#[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
mod application_audio_host;
pub mod audio_tap;
mod capture_control;
#[cfg(feature = "claude-cli")]
pub mod claude_cli;
mod companion;
#[cfg(target_os = "macos")]
mod companion_macos;
pub mod context;
mod context_import;
pub mod context_refresh;
mod context_runtime;
pub mod cue_evaluator;
#[cfg(all(
    debug_assertions,
    target_os = "macos",
    feature = "native-audio-spike",
    feature = "lab-evaluator"
))]
mod dev_lab_source;
#[cfg(all(
    debug_assertions,
    any(feature = "claude-cli", feature = "lab-evaluator"),
    feature = "native-audio-spike"
))]
mod dev_model;
#[cfg(all(
    debug_assertions,
    target_os = "macos",
    feature = "native-audio-spike",
    feature = "lab-evaluator"
))]
mod dev_off;
#[cfg(all(
    debug_assertions,
    target_os = "macos",
    feature = "native-audio-spike",
    feature = "lab-evaluator"
))]
mod dev_source_observation;
#[cfg(all(
    debug_assertions,
    target_os = "macos",
    feature = "native-audio-spike",
    feature = "lab-evaluator"
))]
mod dev_stop;
#[cfg(debug_assertions)]
mod dev_user_name;
pub mod engine;
pub mod granola;
#[cfg(all(
    debug_assertions,
    target_os = "macos",
    feature = "native-audio-spike",
    feature = "lab-evaluator"
))]
mod lab_evaluator;
pub mod live;
mod live_control;
mod live_source;
mod microphone;
#[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
mod native_session_clock;
#[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
mod native_source;
pub mod notes_file;
mod processing_commands;
pub mod processing_reviews;
mod provider_key_commands;
pub mod provider_keys;
#[cfg(any(
    test,
    all(
        debug_assertions,
        target_os = "macos",
        feature = "lab-evaluator",
        feature = "native-audio-spike"
    )
))]
mod selected_attestation;
pub mod timing_log;
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
    /// Active time below one millisecond, retained across syncs.
    tick_remainder: Duration,
    tick_session: u64,
    export: Option<String>,
    /// The running live session, if any. Finish it outside this lock, because
    /// delivering transcript lines takes the lock.
    live: Option<Live>,
    live_start: live_control::StartGate,
    #[cfg(all(
        debug_assertions,
        target_os = "macos",
        feature = "native-audio-spike",
        feature = "lab-evaluator"
    ))]
    lab_stop_drains: dev_stop::Drains,
    /// The approved application-audio source feeding the live session, if
    /// any. Dropping it cancels that source's operation.
    live_source: Option<live_source::LiveSource>,
    /// A live session started for an application source alone, if any.
    source_session: Option<live_source::SourceSession>,
    processing_reviews: processing_reviews::Reviews,
    processing_status: engine::ProcessingTracker,
    /// Prior notes the user imported this session, in memory only.
    context: context::ContextStore,
    /// A listed note source kept for selection, retry, or cancellation.
    pending_import: Option<context_import::PendingImport>,
    /// Identity of the latest explicit file read; cancellation/replacement wins.
    pending_file_pick: Option<Arc<()>>,
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
            #[cfg(all(
                debug_assertions,
                target_os = "macos",
                feature = "native-audio-spike",
                feature = "lab-evaluator"
            ))]
            lab_stop_drains: dev_stop::Drains::default(),
            live_source: None,
            source_session: None,
            processing_reviews: processing_reviews::Reviews::default(),
            processing_status: engine::ProcessingTracker::default(),
            context: context::ContextStore::default(),
            pending_import: None,
            pending_file_pick: None,
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
    /// writes exactly that text. It is the notes, plus the session's
    /// transcript and cues only when the person chose to keep the meeting. A
    /// running live session is refused, and refusing it drops any earlier
    /// preview.
    fn prepare_export(&mut self) -> Result<String, String> {
        // Live transcripts stay in memory only; this version never saves them.
        if self.engine.state.live
            && matches!(
                self.engine.state.status,
                engine::Status::Running | engine::Status::Paused
            )
        {
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

    /// Read the same live clock arithmetic as `sync_at` without advancing the
    /// engine, polling a provider or reconciling capture. A transport worker
    /// calls this only after obtaining the Runtime lock without waiting.
    #[cfg(all(
        debug_assertions,
        target_os = "macos",
        feature = "native-audio-spike",
        feature = "lab-evaluator"
    ))]
    fn lab_clock_at(&self, now: Instant) -> Option<lab_evaluator::ClockSample> {
        let session = self.engine.session();
        if !self.engine.state.live
            || self.engine.state.status != engine::Status::Running
            || self.engine.is_live_stopping()
            || self.live.as_ref()?.session != session
        {
            return None;
        }
        let remainder = if self.tick_session == session {
            self.tick_remainder
        } else {
            Duration::ZERO
        };
        let delta = now.checked_duration_since(self.last_tick)?;
        let millis = delta.checked_add(remainder)?.as_millis();
        let elapsed_ms = self
            .engine
            .state
            .elapsed_ms
            .saturating_add(u64::try_from(millis).unwrap_or(u64::MAX))
            .min(self.engine.state.duration_ms);
        Some(lab_evaluator::ClockSample {
            session_id: session,
            elapsed_ms,
        })
    }
}

struct AppState(Mutex<Runtime>);

#[cfg(all(
    debug_assertions,
    target_os = "macos",
    feature = "native-audio-spike",
    feature = "lab-evaluator"
))]
fn sample_lab_clock(state: &Mutex<Runtime>) -> Option<lab_evaluator::ClockSample> {
    let runtime = state.try_lock().ok()?;
    // Sample after acquiring the lock: never estimate from a cached tick or
    // from an Instant older than a concurrently completed clock update.
    runtime.lab_clock_at(Instant::now())
}

// Emit while holding the state lock, preserving revision order across commands/ticks.
fn publish(app: &tauri::AppHandle, runtime: &mut Runtime) {
    let _ = app.emit_to("main", "session:changed", &runtime.engine.state);
    let cue_state = runtime.cue_snapshot();
    let emitted = app.emit_to("cue", "cue:changed", &cue_state).is_ok();
    #[cfg(all(
        debug_assertions,
        target_os = "macos",
        feature = "native-audio-spike",
        feature = "lab-evaluator"
    ))]
    lab_evaluator::observe_published(&runtime.engine, &cue_state, emitted);
    // Publication success is not evidence that the companion painted a cue.
    let _ = emitted;
    timing_log::observe_published(&runtime.engine);
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
    let source = application_audio_host::source_status(app).map(|source| {
        let combined = application_audio_host::overall_capture(capture, source.phase);
        (combined, (capture, source))
    });
    #[cfg(not(all(target_os = "macos", feature = "native-audio-spike")))]
    let source: Option<(
        engine::CaptureState,
        (engine::CaptureState, engine::SourceCapture),
    )> = None;
    let (capture, source) = match source {
        Some((combined, source)) => (combined, Some(source)),
        None => (capture, None),
    };
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
    let (snapshot, changed) = runtime.processing_status.update_with_source(
        &runtime.engine,
        capture,
        target,
        startup,
        source,
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
        .map_err(|_| "The session is unavailable. Please restart TalkQTE.")?;
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
    let runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
    if window.label() == "cue" {
        serde_json::to_value(runtime.cue_snapshot())
    } else {
        serde_json::to_value(&runtime.engine.state)
    }
    .map_err(|_| "Could not read the session.".into())
}

/// The engine for a new live session: the lab's backend when a lab launch
/// selects it; with the `claude-cli` development feature the Claude Code
/// backend; otherwise the Anthropic API with the person's own key when one is
/// stored, or the plain engine with no cue backend. Each sends nothing until
/// the person approves the session review.
pub(crate) fn live_engine() -> Engine {
    #[cfg(all(
        debug_assertions,
        target_os = "macos",
        feature = "native-audio-spike",
        feature = "lab-evaluator"
    ))]
    if lab_evaluator::selected() {
        // An explicit malformed selection stays unavailable in the lab path;
        // only an absent selector may use the existing default below.
        return lab_evaluator::connected_engine();
    }
    #[cfg(feature = "claude-cli")]
    return claude_cli::connected_engine();
    #[cfg(not(feature = "claude-cli"))]
    if provider_keys::global().is_set(provider_keys::Provider::Anthropic) {
        // The person's own key: sends nothing until the session review is
        // approved, and never falls back to another service.
        anthropic_api::connected_engine()
    } else {
        Engine::live()
    }
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
fn set_live_cues_paused(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    paused: bool,
) -> Result<(), String> {
    change(&app, &state, |e| e.set_live_cues_paused(paused))
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
/// Holds the cue until it is dismissed, from either window.
#[tauri::command]
fn inspect_cue(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    id: String,
) -> Result<(), String> {
    change(&app, &state, |e| e.inspect_cue(&id))
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

/// The person's choice, for this session only, to include its transcript
/// and the cues shown in the export. Changing it drops any earlier preview,
/// so only a preview of the new content can be saved.
#[tauri::command]
fn set_keep_meeting(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    keep: bool,
) -> Result<(), String> {
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    runtime.engine.set_keep_meeting(keep);
    runtime.export = None;
    publish(&app, &mut runtime);
    Ok(())
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
            .set_file_name("talkqte-notes.md")
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveStatus {
    available: bool,
    reason: Option<&'static str>,
    /// The cloud service this launch transcribes with, when one is
    /// selected; absent otherwise, and then nothing is transcribed.
    #[serde(skip_serializing_if = "Option::is_none")]
    transcription: Option<&'static str>,
}

/// Why a live session cannot start, if it cannot. Audio is sent to
/// Deepgram only once a cue review is approved, so a start needs both a cue
/// connection and a Deepgram credential: the person's own keys, or in a
/// development launch the lab's or Claude Code connection and a token file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LiveUnavailable {
    /// No Anthropic key is stored and no development cue connection exists.
    Build,
    /// The provider refused the stored Anthropic key.
    CueKeyRejected,
    /// No Deepgram key is stored and no development launch selects one.
    Selection,
    Settings,
    TokenMetadata,
    /// Deepgram refused the stored key.
    KeyRejected,
    /// The Keychain could not be read for the Deepgram key.
    KeyUnreadable,
    /// The Keychain could not be read for the Anthropic key.
    CueKeyUnreadable,
}

impl LiveUnavailable {
    fn message(self) -> &'static str {
        match self {
            Self::Build => "Add your Anthropic API key in Settings to start a live session.",
            Self::CueKeyRejected => {
                "Anthropic rejected your API key. Replace it in Settings to start a live session."
            }
            Self::Selection => "Add your Deepgram API key in Settings to start a live session.",
            Self::Settings | Self::TokenMetadata => {
                "The cloud transcription settings are not usable."
            }
            Self::KeyRejected => {
                "Deepgram rejected your API key. Replace it in Settings to start a live session."
            }
            Self::KeyUnreadable => {
                "Your Deepgram key could not be read from the Keychain. Check it in Settings."
            }
            Self::CueKeyUnreadable => {
                "Your Anthropic key could not be read from the Keychain. Check it in Settings."
            }
        }
    }
}

/// Whether this build registers a cue connection for live sessions: the
/// lab's, the development Claude Code connection, or the person's own
/// Anthropic key.
fn cue_connection() -> Result<(), LiveUnavailable> {
    #[cfg(all(
        debug_assertions,
        target_os = "macos",
        feature = "native-audio-spike",
        feature = "lab-evaluator"
    ))]
    if lab_evaluator::selected() {
        return Ok(());
    }
    if cfg!(feature = "claude-cli") {
        return Ok(());
    }
    match provider_keys::global().status().anthropic.state {
        provider_keys::KeyState::Set => Ok(()),
        provider_keys::KeyState::Rejected => Err(LiveUnavailable::CueKeyRejected),
        provider_keys::KeyState::NotSet => Err(LiveUnavailable::Build),
        provider_keys::KeyState::Unreadable => Err(LiveUnavailable::CueKeyUnreadable),
    }
}

pub(crate) fn live_availability() -> Result<(), LiveUnavailable> {
    classify_live_availability(
        cue_connection(),
        transcription::cloud::selected,
        transcription::cloud::readiness,
    )
}

fn classify_live_availability(
    cue_connection: Result<(), LiveUnavailable>,
    selected: impl FnOnce() -> bool,
    readiness: impl FnOnce() -> Result<(), transcription::cloud::ReadinessFailure>,
) -> Result<(), LiveUnavailable> {
    cue_connection?;
    if !selected() {
        return Err(LiveUnavailable::Selection);
    }
    readiness().map_err(|failure| match failure {
        transcription::cloud::ReadinessFailure::Settings => LiveUnavailable::Settings,
        transcription::cloud::ReadinessFailure::TokenMetadata => LiveUnavailable::TokenMetadata,
        transcription::cloud::ReadinessFailure::NoKey => LiveUnavailable::Selection,
        transcription::cloud::ReadinessFailure::KeyRejected => LiveUnavailable::KeyRejected,
        transcription::cloud::ReadinessFailure::KeyUnreadable => LiveUnavailable::KeyUnreadable,
    })
}

pub(crate) fn live_unavailable() -> Option<&'static str> {
    live_availability().err().map(LiveUnavailable::message)
}

#[tauri::command]
fn live_status() -> LiveStatus {
    let reason = live_unavailable();
    LiveStatus {
        available: reason.is_none(),
        reason,
        transcription: transcription::cloud::selected().then_some(transcription::cloud::PROVIDER),
    }
}

/// Microphone audio handed to a cloud stream, a tenth of a second at a time.
const CLOUD_CHUNK_MS: u64 = 100;

/// What the notebook shows about prior notes picked from a file.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedNotes {
    file_name: String,
    notes: Vec<notes_file::NoteSummary>,
    /// Notes in the file that are not listed: beyond the limit or repeated.
    skipped: usize,
    /// Whether a note without a date asks for one: a Markdown or text file.
    asks_for_dates: bool,
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
    let ticket = begin_file_pick(&state)?;
    let picker = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .add_filter("Notes", &notes_file::EXTENSIONS)
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
    read_context_file(&state, ticket, path).await.map(Some)
}

/// An explicit local path avoids the system chooser when its service is unavailable.
/// It lists a file only; selection/import and processing approval stay separate.
#[tauri::command]
async fn read_context_file_path(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<PickedNotes, String> {
    let path = notes_file::explicit_path(&path)?;
    let ticket = begin_file_pick(&state)?;
    read_context_file(&state, ticket, path).await
}

fn begin_file_pick(state: &AppState) -> Result<Arc<()>, String> {
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let ticket = Arc::new(());
    runtime.pending_file_pick = Some(ticket.clone());
    runtime.pending_import = None;
    Ok(ticket)
}

async fn read_context_file(
    state: &AppState,
    ticket: Arc<()>,
    path: std::path::PathBuf,
) -> Result<PickedNotes, String> {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let source = tauri::async_runtime::spawn_blocking(move || notes_file::FileSource::read(&path))
        .await
        .map_err(|_| "The file could not be read.")??;
    let notes = source.summaries();
    let skipped = source.skipped;
    let asks_for_dates = context::NoteSource::asks_for_dates(&source);
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    finish_file_pick(&mut runtime, &ticket, source)?;
    Ok(PickedNotes {
        file_name,
        notes,
        skipped,
        asks_for_dates,
    })
}

fn finish_file_pick(
    runtime: &mut Runtime,
    ticket: &Arc<()>,
    source: notes_file::FileSource,
) -> Result<(), String> {
    if !runtime
        .pending_file_pick
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, ticket))
    {
        return Err("The file selection changed. Choose notes again.".into());
    }
    runtime.pending_file_pick = None;
    runtime.pending_import = Some(context_import::PendingImport::new(Box::new(source)));
    Ok(())
}

/// Imports the selected notes from the file read by `pick_context_file`.
#[tauri::command]
async fn import_context_notes(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    // Dates entered for Markdown or plain-text notes that have none.
    dates: Option<std::collections::HashMap<String, String>>,
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
    let dates = dates.unwrap_or_default();
    let (attempt, fetched) = tauri::async_runtime::spawn_blocking(move || {
        let fetched = attempt.fetch_with_dates(&selection, &dates);
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
        runtime.pending_file_pick = None;
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
    let Some(cue_changed) = runtime.remove_imported_note(provider, &source_id) else {
        return Err("That note is no longer imported.".into());
    };
    emit_context(&app, &mut runtime, cue_changed);
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
        // Visible to the windows only through `disconnect_granola` below.
        self.disconnect_update_checks();
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
    runtime.pending_file_pick = None;
    runtime.pending_import = Some(context_import::PendingImport::new(Box::new(shared)));
    Ok(PickedNotes {
        file_name: "Granola · the last 30 days".into(),
        notes,
        skipped,
        asks_for_dates: false,
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
fn disconnect_granola(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<GranolaStatus, String> {
    let mut runtime = state.0.lock().map_err(|_| "The notebook is unavailable.")?;
    let before = runtime.engine.state.revision;
    let status = runtime.disconnect_granola();
    // A reminder's warning may lose its confirmation time.
    if runtime.engine.state.revision != before {
        publish(&app, &mut runtime);
    }
    Ok(status)
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
    #[cfg(all(
        debug_assertions,
        target_os = "macos",
        feature = "native-audio-spike",
        feature = "lab-evaluator"
    ))]
    let empty_source_handle = live.microphone.is_none() && live.runner.is_none();
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
    let finished = change(app, &state, |e| {
        e.finish_live_stop(live.session);
        Ok(())
    })
    .is_ok();
    #[cfg(all(
        debug_assertions,
        target_os = "macos",
        feature = "native-audio-spike",
        feature = "lab-evaluator"
    ))]
    if finished {
        if let Ok(mut runtime) = state.0.lock() {
            runtime
                .lab_stop_drains
                .acknowledge(live.session, empty_source_handle);
        }
    }
    let _ = finished;
}

/// A microphone session's cloud stream ended with a failure: the session
/// records why and stops, as if Stop were chosen, without flushing to any
/// other recognizer. Runs off the feeding thread, which the stop joins.
fn stop_after_cloud_failure(
    app: &tauri::AppHandle,
    session: u64,
    failure: transcription::cloud::SttFailure,
) {
    let app = app.clone();
    std::thread::spawn(move || {
        let live = app
            .state::<AppState>()
            .0
            .lock()
            .ok()
            .and_then(|mut runtime| {
                runtime
                    .engine
                    .cloud_transcription_stopped(session, failure.code());
                let live = runtime
                    .live
                    .as_ref()
                    .is_some_and(|live| live.session == session)
                    .then(|| runtime.take_live_for_stop())
                    .flatten();
                publish(&app, &mut runtime);
                live
            });
        if let Some(live) = live {
            finish_live(&app, live, false);
        }
    });
}

/// Starts a live session: the microphone feeds cloud transcription, and the
/// cue engine runs on what is said. Nothing is recorded or stored. Audio is
/// sent to the provider only after the session's review is approved. A build
/// or launch without cloud transcription refuses the start; nothing is
/// transcribed on this device.
#[tauri::command]
async fn start_live_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    microphone: tauri::State<'_, microphone::Controller>,
) -> Result<(), String> {
    {
        if let Some(reason) = live_unavailable() {
            return Err(reason.into());
        }
        let start = state
            .0
            .lock()
            .map_err(|_| "The session is unavailable.")?
            .begin_live_start()?;
        // Made only once this start holds the gate, so a refused second
        // start can never replace or reuse this session's minute budget.
        let streams = transcription::cloud::streams()
            .map_err(|_| "The cloud transcription settings are not usable.")?;
        // Nothing is opened here: the stream opens once the review is
        // approved. The start can still be cancelled before capture.
        let (start, streams) =
            tauri::async_runtime::spawn_blocking(move || start.load(|| Ok(streams)))
                .await
                .map_err(|_| "Could not start the live session.")??;
        let (opener, reopener) = streams.into_parts();
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
        let on_tap: microphone::OnTap = Box::new(move |generation, chunker| {
            // The cloud stream takes short fixed chunks.
            let approval_app = handle.clone();
            let failure_app = handle.clone();
            let keep_app = handle.clone();
            let dropped_app = handle.clone();
            let reconnect_app = handle.clone();
            let sink_app = handle.clone();
            let sink = move |session, segment| {
                let state = sink_app.state::<AppState>();
                let mut runtime = state.0.lock().map_err(|_| "The session is unavailable.")?;
                runtime.sync();
                let result = runtime.ingest_timed(session, segment);
                publish(&sink_app, &mut runtime);
                result
            };
            // Attach the runner only to the session that asked for it.
            let kept =
                handle
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
                        live.runner =
                            Some(live::LiveSession::start_cloud(
                                chunker,
                                session,
                                started_at,
                                transcription::cloud::CloudFeed::new(
                                    session,
                                    2,
                                    opener,
                                    move || {
                                        approval_app.state::<AppState>().0.lock().ok().and_then(
                                            |runtime| runtime.engine.audio_approval(session),
                                        )
                                    },
                                    sink,
                                )
                                .stop_sending_when(move || {
                                    keep_app.state::<AppState>().0.lock().map_or(
                                        Some(transcription::cloud::SttFailure::Withdrawn),
                                        |runtime| {
                                            transcription::cloud::withdrawal(
                                                runtime.engine.audio_withdrawal(session),
                                            )
                                        },
                                    )
                                })
                                .on_dropped(move || {
                                    let state = dropped_app.state::<AppState>();
                                    if let Ok(mut runtime) = state.0.lock() {
                                        runtime.engine.cloud_transcription_dropped(session);
                                        publish(&dropped_app, &mut runtime);
                                    };
                                })
                                .on_failure(move |failure| {
                                    stop_after_cloud_failure(&failure_app, session, failure)
                                })
                                .on_reconnect(move |lost_ms| {
                                    let state = reconnect_app.state::<AppState>();
                                    if let Ok(mut runtime) = state.0.lock() {
                                        runtime
                                            .engine
                                            .cloud_transcription_reconnected(session, lost_ms);
                                        publish(&reconnect_app, &mut runtime);
                                    };
                                })
                                .with_reopener(reopener),
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
            Some((CLOUD_CHUNK_MS, on_tap)),
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

fn application_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

pub fn run() {
    let context = application_context();
    #[cfg(target_os = "macos")]
    let context = companion_macos::configure(context);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState(Mutex::new(Runtime::default())))
        .manage(companion::WindowState::default())
        .manage(microphone::Controller::default())
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
            set_live_cues_paused,
            respond_to_cue,
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
            set_keep_meeting,
            live_status,
            provider_key_commands::provider_keys_status,
            provider_key_commands::set_provider_key,
            provider_key_commands::test_provider_key,
            provider_key_commands::remove_provider_key,
            provider_key_commands::cue_usage,
            companion::companion_anchor,
            pick_context_file,
            read_context_file_path,
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
            start_live_session,
            stop_live_session,
            microphone::microphone_snapshot,
            microphone::start_microphone,
            stop_microphone
        ])
        .setup(|app| {
            // A lab launch may give the user's name; it is set before the
            // first session, as if typed in Settings.
            #[cfg(debug_assertions)]
            {
                dev_user_name::initialize();
                if let Ok(mut runtime) = app.state::<AppState>().0.lock() {
                    dev_user_name::apply(&mut runtime.engine);
                }
            }
            #[cfg(all(
                debug_assertions,
                any(feature = "claude-cli", feature = "lab-evaluator"),
                feature = "native-audio-spike"
            ))]
            dev_model::initialize();
            #[cfg(all(
                debug_assertions,
                target_os = "macos",
                feature = "native-audio-spike",
                feature = "lab-evaluator"
            ))]
            {
                lab_evaluator::initialize_from_environment();
                let handle = app.handle().clone();
                lab_evaluator::set_clock_sampler(Arc::new(move || {
                    let state = handle.try_state::<AppState>()?;
                    sample_lab_clock(&state.0)
                }));
            }
            #[cfg(target_os = "macos")]
            companion_macos::hide_controls(app)?;
            #[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
            application_audio_host::install(app.handle())?;
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
                #[cfg(all(
                    debug_assertions,
                    target_os = "macos",
                    feature = "native-audio-spike",
                    feature = "lab-evaluator"
                ))]
                lab_evaluator::cancel_active(lab_evaluator::ControlReason::Exit);
                microphone::stop_on_exit(app);
                // End any model call still in flight, and its helpers.
                #[cfg(feature = "claude-cli")]
                claude_cli::end_all();
                #[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
                application_audio_host::exit(app);
            }
        });
}

#[cfg(test)]
mod granola_privacy_tests;

#[cfg(all(
    test,
    debug_assertions,
    target_os = "macos",
    feature = "native-audio-spike",
    feature = "lab-evaluator"
))]
mod lab_clock_tests {
    use super::*;

    fn live(now: Instant) -> Runtime {
        let mut runtime = Runtime {
            engine: Engine::live(),
            last_tick: now,
            ..Runtime::default()
        };
        runtime.engine.start().unwrap();
        runtime.tick_session = runtime.engine.session();
        runtime.live = Some(Live {
            operation: None,
            session: runtime.engine.session(),
            microphone: None,
            runner: None,
        });
        runtime
    }

    #[test]
    fn sampled_clock_matches_next_sync_without_mutating_the_runtime() {
        let origin = Instant::now();
        let now = origin + Duration::from_micros(1_700);
        let mut runtime = live(origin);
        runtime.tick_remainder = Duration::from_micros(600);
        runtime.engine.state.elapsed_ms = 42;
        let revision = runtime.engine.state.revision;
        let sample = runtime.lab_clock_at(now).unwrap();
        assert_eq!(sample.session_id, runtime.engine.session());
        assert_eq!(sample.elapsed_ms, 44);
        assert_eq!(runtime.engine.state.elapsed_ms, 42);
        assert_eq!(runtime.engine.state.revision, revision);
        assert_eq!(runtime.last_tick, origin);
        assert_eq!(runtime.tick_remainder, Duration::from_micros(600));
        runtime.sync_at(now);
        assert_eq!(runtime.engine.state.elapsed_ms, sample.elapsed_ms);
        assert_eq!(runtime.tick_remainder, Duration::from_micros(300));
    }

    #[test]
    fn a_replaced_session_does_not_borrow_the_previous_fractional_remainder() {
        let origin = Instant::now();
        let mut runtime = live(origin);
        runtime.tick_session = runtime.engine.session() + 1;
        runtime.tick_remainder = Duration::from_micros(900);
        let now = origin + Duration::from_micros(200);
        let sample = runtime.lab_clock_at(now).unwrap();
        assert_eq!(sample.elapsed_ms, 0);
        runtime.sync_at(now);
        assert_eq!(runtime.engine.state.elapsed_ms, sample.elapsed_ms);
        assert_eq!(runtime.tick_remainder, Duration::from_micros(200));
    }

    #[test]
    fn stopped_draining_inactive_and_mismatched_sessions_cannot_calibrate() {
        let now = Instant::now();
        let mut runtime = live(now);
        runtime.engine.begin_live_stop();
        assert_eq!(runtime.engine.state.status, engine::Status::Running);
        assert!(runtime.lab_clock_at(now).is_none(), "Stop precedes drain");

        let mut runtime = live(now);
        runtime.live.as_mut().unwrap().session += 1;
        assert!(runtime.lab_clock_at(now).is_none());
        runtime.live = None;
        assert!(runtime.lab_clock_at(now).is_none());

        let mut runtime = live(now);
        runtime.engine.end();
        assert!(runtime.lab_clock_at(now).is_none());
        assert!(Runtime::default().lab_clock_at(now).is_none());
    }

    #[test]
    fn the_sampler_refuses_a_busy_runtime_without_waiting_for_it() {
        let state = Arc::new(Mutex::new(live(Instant::now())));
        let guard = state.lock().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let owner = state.clone();
        let task = std::thread::spawn(move || {
            send.send(sample_lab_clock(&owner).is_none()).unwrap();
        });
        let result = receive.recv_timeout(Duration::from_secs(2));
        drop(guard);
        task.join().unwrap();
        assert!(result.unwrap());
        assert!(sample_lab_clock(&state).is_some());
    }

    #[test]
    fn a_clock_sample_older_than_the_last_tick_is_unavailable() {
        let now = Instant::now();
        let runtime = live(now + Duration::from_millis(1));
        assert!(runtime.lab_clock_at(now).is_none());
    }

    #[test]
    fn backend_selection_is_explicit_inert_and_never_falls_back_on_bad_settings() {
        let without = [
            "TALKQTE_DEV_CUE_BACKEND",
            "TALKQTE_DEV_LAB_DESCRIPTOR",
            "TALKQTE_DEV_LAB_PROVIDER",
            "TALKQTE_DEV_LAB_MODEL",
            "TALKQTE_DEV_LAB_EFFORT",
            "TALKQTE_DEV_LAB_CONTEXT",
            "TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD",
        ];
        for case in [
            "absent",
            "malformed",
            "valid",
            "api-fresh",
            "api-history",
            "api-empty-context",
            "api-invalid-context",
            "subscription-history",
            "orphan-history",
            "orphan-empty",
            "orphan-unknown",
        ] {
            let mut variables = vec![("TALKQTE_TEST_SELECTOR_CASE", case)];
            if case == "malformed" {
                variables.push(("TALKQTE_DEV_CUE_BACKEND", "fictional-invalid-selector"));
            } else if case == "valid" || case == "subscription-history" {
                variables.extend([
                    ("TALKQTE_DEV_CUE_BACKEND", "lab-subscription"),
                    (
                        "TALKQTE_DEV_LAB_DESCRIPTOR",
                        "/fictional-lab/run/descriptor.json",
                    ),
                    ("TALKQTE_DEV_LAB_PROVIDER", "codex"),
                    ("TALKQTE_DEV_LAB_MODEL", "gpt-6.1-sol"),
                    ("TALKQTE_DEV_LAB_EFFORT", "medium"),
                ]);
            }
            if case.starts_with("api-") {
                variables.extend([
                    ("TALKQTE_DEV_CUE_BACKEND", "lab-api"),
                    (
                        "TALKQTE_DEV_LAB_DESCRIPTOR",
                        "/fictional-lab/run/descriptor.json",
                    ),
                    ("TALKQTE_DEV_LAB_PROVIDER", "anthropic-api"),
                    ("TALKQTE_DEV_LAB_MODEL", "claude-opus-5-5"),
                    ("TALKQTE_DEV_LAB_EFFORT", "low"),
                    ("TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD", "250000"),
                ]);
            }
            match case {
                "api-history" | "subscription-history" | "orphan-history" => {
                    variables.push(("TALKQTE_DEV_LAB_CONTEXT", "bounded-history"))
                }
                "api-empty-context" | "orphan-empty" => {
                    variables.push(("TALKQTE_DEV_LAB_CONTEXT", ""))
                }
                "api-invalid-context" | "orphan-unknown" => {
                    variables.push(("TALKQTE_DEV_LAB_CONTEXT", "unknown"))
                }
                _ => {}
            }
            let result =
                crate::test_isolation::run("lab_clock_tests::selector_child", &variables, &without);
            assert!(result.left.is_empty(), "constructor wrote a file");
        }
        use std::os::unix::ffi::OsStringExt;
        let invalid = std::ffi::OsString::from_vec(vec![0xff]);
        for case in ["orphan-nonunicode", "api-nonunicode"] {
            let mut variables = vec![
                ("TALKQTE_TEST_SELECTOR_CASE", std::ffi::OsStr::new(case)),
                ("TALKQTE_DEV_LAB_CONTEXT", invalid.as_os_str()),
            ];
            if case == "api-nonunicode" {
                variables.extend([
                    ("TALKQTE_DEV_CUE_BACKEND", std::ffi::OsStr::new("lab-api")),
                    (
                        "TALKQTE_DEV_LAB_DESCRIPTOR",
                        std::ffi::OsStr::new("/fictional-lab/run/descriptor.json"),
                    ),
                    (
                        "TALKQTE_DEV_LAB_PROVIDER",
                        std::ffi::OsStr::new("anthropic-api"),
                    ),
                    (
                        "TALKQTE_DEV_LAB_MODEL",
                        std::ffi::OsStr::new("claude-opus-5-5"),
                    ),
                    ("TALKQTE_DEV_LAB_EFFORT", std::ffi::OsStr::new("low")),
                    (
                        "TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD",
                        std::ffi::OsStr::new("250000"),
                    ),
                ]);
            }
            let result = crate::test_isolation::run_os(
                "lab_clock_tests::selector_child",
                &variables,
                &without,
            );
            assert!(result.left.is_empty(), "constructor wrote a file");
        }
    }

    #[test]
    #[ignore = "run in an isolated process with frozen fictional settings"]
    fn selector_child() {
        lab_evaluator::initialize_from_environment();
        let case = std::env::var("TALKQTE_TEST_SELECTOR_CASE").unwrap();
        let mut engine = live_engine();
        engine.start().unwrap();
        let snapshot = engine.processing_snapshot(engine::CaptureState::Off, 0);
        match case.as_str() {
            "absent" => {
                assert!(!lab_evaluator::selected());
                #[cfg(feature = "claude-cli")]
                assert_eq!(snapshot.processor.unwrap().id, "claude-cli");
                #[cfg(not(feature = "claude-cli"))]
                assert!(snapshot.processor.is_none());
            }
            "malformed" => {
                assert!(lab_evaluator::selected());
                assert_eq!(snapshot.processor.unwrap().id, "lab-subscription");
                assert_eq!(
                    engine.evaluation_status(),
                    Some(engine::EvaluationStatus::Unavailable(
                        engine::EvaluationIssue::LabUnavailable
                    ))
                );
            }
            "valid" => {
                assert!(lab_evaluator::selected());
                let processor = snapshot.processor.unwrap();
                assert_eq!(processor.id, "lab-subscription");
                assert_eq!(processor.model, "gpt-6.1-sol");
                assert_eq!(snapshot.issue, None);
            }
            "api-fresh" | "api-history" => {
                let processor = snapshot.processor.unwrap();
                assert_eq!(processor.id, "lab-api");
                assert_eq!(
                    processor.data_policy.contains("24 segments"),
                    case == "api-history"
                );
                assert_eq!(snapshot.issue, None);
            }
            "api-empty-context"
            | "api-invalid-context"
            | "subscription-history"
            | "orphan-history"
            | "orphan-empty"
            | "orphan-unknown"
            | "orphan-nonunicode"
            | "api-nonunicode" => {
                assert!(lab_evaluator::selected());
                assert_eq!(
                    engine.evaluation_status(),
                    Some(engine::EvaluationStatus::Unavailable(
                        engine::EvaluationIssue::LabUnavailable
                    ))
                );
                assert!(engine
                    .review_processing(engine::ConversationScope::RecentAndNewSpeech, &[])
                    .is_err());
            }
            _ => panic!("unknown fictional selector case"),
        }
        assert!(!engine.has_processing_permission());
        assert!(!snapshot.sending);
    }
}

#[cfg(test)]
mod test_isolation;

#[cfg(test)]
mod carry_over_tests {
    use super::*;

    #[test]
    fn a_replacement_engine_continues_the_revision_count() {
        let mut previous = Engine::fictional();
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
    fn a_running_live_session_is_refused_export_and_afterwards_only_notes_are_exported() {
        let mut runtime = Runtime::default();
        runtime
            .engine
            .update_notes("A fictional notebook line.".into())
            .unwrap();
        let reviewed = runtime.prepare_export().unwrap();
        assert!(reviewed.contains("A fictional notebook line."));
        assert_eq!(runtime.export.as_deref(), Some(reviewed.as_str()));

        // Starting a live session forgets the earlier preview, so the save
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

        // While the session is stopping it is still running: still refused.
        runtime.engine.begin_live_stop();
        assert!(runtime.prepare_export().is_err());
        assert!(runtime.export.is_none());

        // After Stop the transcript stays on screen and is never exported;
        // the notes written beside the session can be.
        runtime.engine.end();
        assert_eq!(runtime.engine.state.transcript.len(), 1);
        let after = runtime.prepare_export().unwrap();
        assert_eq!(after, "# TalkQTE notes\n\nA fictional notebook line.\n");
        assert!(!after.contains("blue tin"));
        assert_eq!(runtime.export.as_deref(), Some(after.as_str()));
    }

    #[test]
    fn keeping_the_meeting_is_chosen_per_session_and_only_reviewed_text_is_saved() {
        // A plain live engine: phrase rules raise the cue in every build.
        let mut runtime = Runtime {
            engine: Engine::live(),
            ..Runtime::default()
        };
        runtime
            .engine
            .update_notes("Fictional notes beside the call.".into())
            .unwrap();
        runtime.engine.set_user_name(Some("Jordan".into())).unwrap();
        runtime.engine.start().unwrap();
        let session = runtime.engine.session();
        assert!(!runtime.engine.state.keep_meeting);
        runtime.engine.advance(65_000);
        runtime
            .engine
            .ingest(
                session,
                engine::Segment {
                    id: "l1".into(),
                    at_ms: 65_000,
                    speaker: "Speaker".into(),
                    text: "Can someone take the fictional\ndraft soon?".into(),
                },
            )
            .unwrap();
        // The phrase rules raise a cue from that line.
        let cue = runtime.engine.state.cue.clone().expect("a cue is shown");
        // Choosing during the session still saves nothing while it runs.
        runtime.engine.set_keep_meeting(true);
        assert!(runtime.prepare_export().is_err());
        runtime.engine.end();
        let kept = runtime.prepare_export().unwrap();
        assert!(kept.starts_with("# TalkQTE notes\n\nFictional notes beside the call.\n"));
        assert!(kept.contains(&format!(
            "## Cues shown\n\n- 01:05 · {}: {}",
            cue.kind, cue.question
        )));
        assert!(kept.contains("## Transcript\n\n"));
        assert!(kept.contains("- 01:05 Can someone take the fictional draft soon?\n"));
        // Never the name, speaker labels or anything else.
        assert!(!kept.contains("Jordan") && !kept.contains("Speaker"));
        assert_eq!(runtime.export.as_deref(), Some(kept.as_str()));
        // Turning it off again leaves the notes only.
        runtime.engine.set_keep_meeting(false);
        assert_eq!(
            runtime.prepare_export().unwrap(),
            "# TalkQTE notes\n\nFictional notes beside the call.\n"
        );
        // The next session starts with the choice off and an empty record.
        runtime.engine.set_keep_meeting(true);
        runtime.engine.start().unwrap();
        assert!(!runtime.engine.state.keep_meeting);
        runtime.engine.set_keep_meeting(true);
        runtime.engine.end();
        let next = runtime.prepare_export().unwrap();
        assert!(next.contains("## Cues shown\n\nNone.\n"));
        assert!(next.contains("## Transcript\n\n"));
        assert!(!next.contains("draft soon"));
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

    /// A runtime replaying the engine's fictional test scenario.
    fn scripted() -> Runtime {
        Runtime {
            engine: Engine::fictional(),
            ..Runtime::default()
        }
    }

    #[test]
    fn frequent_syncs_preserve_elapsed_time_and_scripted_cue_timing() {
        let mut runtime = scripted();
        runtime.engine.start().unwrap();
        let origin = runtime.last_tick;
        let mut expected = Engine::fictional();
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
            11_000
        );
        runtime.sync_at(origin + Duration::from_millis(15_000));
        assert_eq!(runtime.engine.state.elapsed_ms, 15_000);
        runtime.sync_at(origin + Duration::from_millis(26_000));
        assert!(runtime.engine.state.cue.is_none());
    }

    #[test]
    fn pause_excludes_idle_time_but_keeps_the_same_sessions_fraction() {
        let mut runtime = scripted();
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
            let mut runtime = scripted();
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

#[cfg(test)]
mod live_readiness_diagnostics_tests {
    use super::*;
    use transcription::cloud::ReadinessFailure;

    #[test]
    fn readiness_preserves_short_circuit_order_and_public_refusals() {
        assert_eq!(
            classify_live_availability(
                Err(LiveUnavailable::Build),
                || panic!("selection read"),
                || panic!("metadata read")
            ),
            Err(LiveUnavailable::Build)
        );
        assert_eq!(
            classify_live_availability(
                Err(LiveUnavailable::CueKeyRejected),
                || panic!("selection read"),
                || panic!("metadata read")
            ),
            Err(LiveUnavailable::CueKeyRejected)
        );
        assert_eq!(
            classify_live_availability(Ok(()), || false, || panic!("metadata read")),
            Err(LiveUnavailable::Selection)
        );
        for (ready, expected) in [
            (
                Err(ReadinessFailure::Settings),
                Err(LiveUnavailable::Settings),
            ),
            (
                Err(ReadinessFailure::TokenMetadata),
                Err(LiveUnavailable::TokenMetadata),
            ),
            (
                Err(ReadinessFailure::NoKey),
                Err(LiveUnavailable::Selection),
            ),
            (
                Err(ReadinessFailure::KeyRejected),
                Err(LiveUnavailable::KeyRejected),
            ),
            (
                Err(ReadinessFailure::KeyUnreadable),
                Err(LiveUnavailable::KeyUnreadable),
            ),
            (Ok(()), Ok(())),
        ] {
            assert_eq!(
                classify_live_availability(Ok(()), || true, || ready),
                expected
            );
        }
        assert_eq!(
            LiveUnavailable::Build.message(),
            "Add your Anthropic API key in Settings to start a live session."
        );
        assert_eq!(
            LiveUnavailable::CueKeyRejected.message(),
            "Anthropic rejected your API key. Replace it in Settings to start a live session."
        );
        assert_eq!(
            LiveUnavailable::Selection.message(),
            "Add your Deepgram API key in Settings to start a live session."
        );
        assert_eq!(
            LiveUnavailable::KeyRejected.message(),
            "Deepgram rejected your API key. Replace it in Settings to start a live session."
        );
        assert_eq!(
            LiveUnavailable::Settings.message(),
            "The cloud transcription settings are not usable."
        );
        assert_eq!(
            LiveUnavailable::TokenMetadata.message(),
            LiveUnavailable::Settings.message()
        );
    }
}

#[cfg(test)]
mod context_file_path_tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn native_path_invoke_uses_generated_acl_and_real_command_main_only() {
        use tauri::Manager;
        // Use the actual generated application manifest/capabilities, not an
        // empty mock ACL or a test-granted permission. Only the window runtime
        // is substituted; this invokes the real command through Tauri IPC.
        let mut context = application_context();
        context.config_mut().app.windows.clear();
        let app = tauri::test::mock_builder()
            .manage(AppState(Mutex::new(Runtime::default())))
            .invoke_handler(tauri::generate_handler![read_context_file_path])
            .build(context)
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let cue = tauri::WebviewWindowBuilder::new(&app, "cue", Default::default())
            .build()
            .unwrap();
        let invoke =
            |window: &tauri::WebviewWindow<tauri::test::MockRuntime>, path: &str, url: &str| {
                tauri::test::get_ipc_response(
                    window,
                    tauri::webview::InvokeRequest {
                        cmd: "read_context_file_path".into(),
                        callback: tauri::ipc::CallbackFn(0),
                        error: tauri::ipc::CallbackFn(1),
                        url: url.parse().unwrap(),
                        body: tauri::ipc::InvokeBody::Json(serde_json::json!({"path":path})),
                        headers: Default::default(),
                        invoke_key: tauri::test::INVOKE_KEY.into(),
                    },
                )
            };
        let local = "http://127.0.0.1:1420";
        let rejected = invoke(&main, "relative.md", local).unwrap_err();
        assert!(
            rejected.as_str().unwrap().contains("full local file path"),
            "{rejected}"
        );
        let path = std::env::temp_dir().join(format!("talkqte-path-ipc-{}.md", std::process::id()));
        std::fs::write(
            &path,
            "---\ntitle: Fictional IPC plan\ndate: 2026-10-20\n---\nFictional whole note.",
        )
        .unwrap();
        let response = invoke(&main, path.to_str().unwrap(), local)
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();
        assert_eq!(response["notes"].as_array().unwrap().len(), 1);
        assert_eq!(response["notes"][0]["title"], "Fictional IPC plan");
        assert!(app
            .state::<AppState>()
            .0
            .lock()
            .unwrap()
            .context
            .items()
            .is_empty());
        assert!(app
            .state::<AppState>()
            .0
            .lock()
            .unwrap()
            .pending_import
            .is_some());
        for (window, url) in [(&cue, local), (&main, "https://example.invalid/")] {
            let denied = invoke(window, path.to_str().unwrap(), url).unwrap_err();
            assert!(denied.as_str().unwrap().contains("not allowed"), "{denied}");
        }
        // Both denied invocations leave the earlier user preview intact.
        assert!(app
            .state::<AppState>()
            .0
            .lock()
            .unwrap()
            .pending_import
            .is_some());
        assert!(app
            .state::<AppState>()
            .0
            .lock()
            .unwrap()
            .context
            .items()
            .is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn explicit_file_read_lists_without_import_and_canceled_or_replaced_reads_cannot_win() {
        let state = AppState(Mutex::new(Runtime::default()));
        let path =
            std::env::temp_dir().join(format!("talkqte-path-fallback-{}.md", std::process::id()));
        std::fs::write(
            &path,
            "---\ntitle: Fictional plan\ndate: 2026-10-20\n---\nReview the fictional plan.",
        )
        .unwrap();
        let initial = begin_file_pick(&state).unwrap();
        let listed =
            tauri::async_runtime::block_on(read_context_file(&state, initial, path.clone()))
                .unwrap();
        assert_eq!(listed.notes.len(), 1);
        assert_eq!(listed.notes[0].title, "Fictional plan");
        assert!(state.0.lock().unwrap().context.items().is_empty());
        let first = begin_file_pick(&state).unwrap();
        let second = begin_file_pick(&state).unwrap();
        let read = || {
            notes_file::FileSource::read(
                &notes_file::explicit_path(path.to_str().unwrap()).unwrap(),
            )
            .unwrap()
        };
        let mut runtime = state.0.lock().unwrap();
        assert!(finish_file_pick(&mut runtime, &first, read()).is_err());
        assert!(runtime.pending_import.is_none());
        finish_file_pick(&mut runtime, &second, read()).unwrap();
        assert!(runtime.pending_import.is_some());
        assert!(runtime.context.items().is_empty());
        // Cancel uses this same invalidation before any delayed read can install.
        runtime.pending_file_pick = None;
        assert!(finish_file_pick(&mut runtime, &second, read()).is_err());
        assert!(runtime.context.items().is_empty());
        drop(runtime);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn explicit_file_pipeline_refuses_missing_wrong_format_oversize_and_invalid_text_without_import(
    ) {
        let state = AppState(Mutex::new(Runtime::default()));
        let root =
            std::env::temp_dir().join(format!("talkqte-path-refusals-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for (name, bytes) in [
            ("unsupported.pdf", b"fictional".to_vec()),
            ("invalid.txt", vec![0xff]),
            (
                "large.txt",
                vec![b'x'; (notes_file::MAX_FILE_BYTES + 1) as usize],
            ),
        ] {
            let path = root.join(name);
            std::fs::write(&path, bytes).unwrap();
            let ticket = begin_file_pick(&state).unwrap();
            assert!(
                tauri::async_runtime::block_on(read_context_file(&state, ticket, path)).is_err()
            );
            assert!(state.0.lock().unwrap().pending_import.is_none());
            assert!(state.0.lock().unwrap().context.items().is_empty());
        }
        let ticket = begin_file_pick(&state).unwrap();
        assert!(tauri::async_runtime::block_on(read_context_file(
            &state,
            ticket,
            root.join("missing.md")
        ))
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_file_path_rejects_expansion_urls_controls_and_unbounded_arguments() {
        for value in [
            "",
            "relative.md",
            "~/notes.md",
            "file:///notes.md",
            "https://example.test/notes.md",
            "//host/notes.md",
            "/notes\n.md",
            "/notes\0.md",
        ] {
            assert!(notes_file::explicit_path(value).is_err());
        }
        assert!(notes_file::explicit_path(&format!("/{}", "a".repeat(4096))).is_err());
        let absolute = std::env::temp_dir().join("fictional notes.md");
        assert_eq!(
            notes_file::explicit_path(absolute.to_str().unwrap()).unwrap(),
            absolute
        );
    }
}
