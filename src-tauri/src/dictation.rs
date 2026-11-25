//! In-memory voice dictation for the notebook's Notes and Focus fields.
//!
//! Captures microphone audio in memory (never written to disk), resamples to
//! 16 kHz mono via `audio_tap`, streams to Deepgram (`mip_opt_out=true`) with
//! the person's stored Keychain key (or development token file when selected),
//! and emits finalized text back to the main notebook window only.
//!
//! Never runs concurrently with a live session or the standalone microphone
//! monitor, and enforces a 2-minute safety cap per dictation.

use crate::{
    audio_tap::Chunker,
    microphone::{self, CaptureStream, Failure, Meter},
    transcription::{
        cloud::{
            self, Budget, Language, ReadinessFailure, Source, StreamingTranscriber, SttEvent,
            SttFailure,
        },
        deepgram,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

/// Maximum duration of a single dictation session before automatic stop.
pub const MAX_DURATION: Duration = Duration::from_secs(120);
/// Microphone chunk size handed to Deepgram (100 ms).
pub const CLOUD_CHUNK_MS: u64 = 100;
/// How often the runner drains audio chunks and polls Deepgram events.
pub const DRAIN_EVERY: Duration = Duration::from_millis(100);
/// How long a normal Stop waits for Deepgram to flush the last results.
pub const FINISH_WAIT: Duration = Duration::from_secs(5);
const INPUT_TIMEOUT: Duration = Duration::from_secs(3);

/// Which notebook field receives finalized dictation text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Notes,
    Focus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Off,
    Starting,
    Listening,
    Stopping,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub status: Status,
    pub target: Option<Target>,
    pub can_start: bool,
    pub message: Option<String>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            status: Status::Off,
            target: None,
            can_start: true,
            message: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEvent {
    pub target: Target,
    pub seq: u64,
    pub text: String,
}

pub(crate) trait Sink: Send + Sync + 'static {
    fn emit_snapshot(&self, snapshot: &Snapshot);
    fn emit_text(&self, event: &TextEvent);
    fn emit_key_rejected(&self);
}

#[derive(Clone)]
struct TauriSink<R: tauri::Runtime>(tauri::AppHandle<R>);

impl<R: tauri::Runtime> Sink for TauriSink<R> {
    fn emit_snapshot(&self, snapshot: &Snapshot) {
        let _ = self.0.emit_to("main", "dictation:changed", snapshot);
    }

    fn emit_text(&self, event: &TextEvent) {
        let _ = self.0.emit_to("main", "dictation:text", event);
    }

    fn emit_key_rejected(&self) {
        let _ = self.0.emit_to(
            "main",
            crate::provider_key_commands::CHANGED,
            crate::provider_keys::global().status(),
        );
    }
}

pub type TranscriberOpener =
    Box<dyn FnOnce() -> Result<Box<dyn StreamingTranscriber>, SttFailure> + Send>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FinishOutcome {
    Ok,
    Aborted,
    CapReached,
    Failed(SttFailure),
}

struct ActiveCapture {
    _stream: Box<dyn CaptureStream>,
    meter: Arc<Meter>,
    last_blocks: u64,
    last_callback: Instant,
}

struct RunnerHandle {
    stop: Arc<AtomicBool>,
    abort: Arc<AtomicBool>,
    thread: JoinHandle<FinishOutcome>,
}

#[derive(Default)]
struct State {
    snapshot: Snapshot,
    generation: u64,
    capture: Option<ActiveCapture>,
    runner: Option<RunnerHandle>,
    cleanup_pending: bool,
}

impl State {
    fn update(&mut self, status: Status, target: Option<Target>, message: Option<&str>) {
        self.snapshot.revision += 1;
        self.snapshot.status = status;
        self.snapshot.target = target;
        self.snapshot.can_start =
            matches!(status, Status::Off | Status::Error) && !self.cleanup_pending;
        self.snapshot.message = message.map(str::to_owned);
    }

    fn is_actively_holding(&self) -> bool {
        self.cleanup_pending
            || matches!(
                self.snapshot.status,
                Status::Starting | Status::Listening | Status::Stopping
            )
    }
}

struct StartSpec {
    generation: u64,
    target: Target,
    meter: Arc<Meter>,
    opener: TranscriberOpener,
    sink: Arc<dyn Sink>,
    now: Instant,
    max_duration: Duration,
}

struct StopCleanup {
    snapshot: Snapshot,
    retired: Option<Box<dyn CaptureStream>>,
    runner: Option<RunnerHandle>,
}

/// Core dictation state machine, independent of Tauri so unit tests can
/// exercise capture, streaming, stopping, safety caps, and failures offline.
#[derive(Clone, Default)]
pub struct Controller {
    state: Arc<Mutex<State>>,
    active: Arc<AtomicBool>,
}

impl Controller {
    /// Lock-free check of whether dictation is starting, listening, stopping,
    /// or waiting on device cleanup.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub fn snapshot(&self) -> Result<Snapshot, String> {
        self.state
            .lock()
            .map(|state| state.snapshot.clone())
            .map_err(|_| "Dictation controls are unavailable. Restart TalkQTE.".into())
    }

    fn sync_active(&self, state: &State) {
        self.active
            .store(state.is_actively_holding(), Ordering::Release);
    }

    fn is_generation(&self, generation: u64) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.generation == generation)
    }

    fn is_starting(&self, generation: u64) -> bool {
        self.state.lock().is_ok_and(|state| {
            state.generation == generation && state.snapshot.status == Status::Starting
        })
    }

    fn begin_start(&self, target: Target) -> Result<(u64, Snapshot), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Dictation controls are unavailable.")?;
        if state.cleanup_pending {
            return Err(
                "Dictation is still stopping. Wait for it to finish, then try again.".into(),
            );
        }
        if matches!(
            state.snapshot.status,
            Status::Starting | Status::Listening | Status::Stopping
        ) {
            return Err("Dictation is already running. Stop it first.".into());
        }
        state.generation += 1;
        state.update(
            Status::Starting,
            Some(target),
            Some("Checking microphone access…"),
        );
        self.sync_active(&state);
        Ok((state.generation, state.snapshot.clone()))
    }

    fn complete_start(
        &self,
        spec: StartSpec,
        built: Result<(Box<dyn CaptureStream>, Option<Chunker>), Failure>,
    ) -> Option<StopCleanup> {
        let StartSpec {
            generation,
            target,
            meter,
            opener,
            sink,
            now,
            max_duration,
        } = spec;
        let (stream, chunker) = match built {
            Ok((stream, Some(chunker))) => (stream, chunker),
            Ok((stream, None)) => {
                let mut state = self.state.lock().ok()?;
                if state.generation != generation || state.snapshot.status != Status::Starting {
                    drop(state);
                    drop(stream);
                    return None;
                }
                state.cleanup_pending = true;
                state.generation += 1;
                state.update(
                    Status::Error,
                    Some(target),
                    Some(capture_failure_message(Failure::Unsupported)),
                );
                self.sync_active(&state);
                return Some(StopCleanup {
                    snapshot: state.snapshot.clone(),
                    retired: Some(stream),
                    runner: None,
                });
            }
            Err(failure) => {
                let mut state = self.state.lock().ok()?;
                if state.generation != generation || state.snapshot.status != Status::Starting {
                    return None;
                }
                state.update(
                    Status::Error,
                    Some(target),
                    Some(capture_failure_message(failure)),
                );
                self.sync_active(&state);
                return Some(StopCleanup {
                    snapshot: state.snapshot.clone(),
                    retired: None,
                    runner: None,
                });
            }
        };

        {
            let state = self.state.lock().ok()?;
            if state.generation != generation || state.snapshot.status != Status::Starting {
                drop(state);
                drop(stream);
                return None;
            }
        }

        if let Err(failure) = stream.play() {
            let mut state = self.state.lock().ok()?;
            if state.generation != generation || state.snapshot.status != Status::Starting {
                drop(state);
                drop(stream);
                return None;
            }
            state.cleanup_pending = true;
            state.generation += 1;
            state.update(
                Status::Error,
                Some(target),
                Some(capture_failure_message(failure)),
            );
            self.sync_active(&state);
            return Some(StopCleanup {
                snapshot: state.snapshot.clone(),
                retired: Some(stream),
                runner: None,
            });
        }

        let transcriber = match opener() {
            Ok(transcriber) => transcriber,
            Err(failure) => {
                let mut state = self.state.lock().ok()?;
                if state.generation != generation || state.snapshot.status != Status::Starting {
                    drop(state);
                    drop(stream);
                    return None;
                }
                state.cleanup_pending = true;
                state.generation += 1;
                state.update(
                    Status::Error,
                    Some(target),
                    Some(stt_failure_message(failure)),
                );
                self.sync_active(&state);
                return Some(StopCleanup {
                    snapshot: state.snapshot.clone(),
                    retired: Some(stream),
                    runner: None,
                });
            }
        };

        let stop = Arc::new(AtomicBool::new(false));
        let abort = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let abort_flag = abort.clone();
        let core = self.clone();
        let runner_sink = sink.clone();
        let thread = std::thread::Builder::new()
            .name("talkqte-dictation".into())
            .spawn(move || {
                run_transcriber(
                    generation,
                    target,
                    chunker,
                    transcriber,
                    stop_flag,
                    abort_flag,
                    now,
                    max_duration,
                    core,
                    runner_sink,
                )
            });

        let Ok(thread) = thread else {
            let mut state = self.state.lock().ok()?;
            state.cleanup_pending = true;
            state.generation += 1;
            state.update(
                Status::Error,
                Some(target),
                Some("Could not start dictation."),
            );
            self.sync_active(&state);
            return Some(StopCleanup {
                snapshot: state.snapshot.clone(),
                retired: Some(stream),
                runner: None,
            });
        };

        let mut state = self.state.lock().ok()?;
        if state.generation != generation || state.snapshot.status != Status::Starting {
            drop(state);
            abort.store(true, Ordering::Release);
            stop.store(true, Ordering::Release);
            drop(stream);
            let _ = thread.join();
            return None;
        }
        state.capture = Some(ActiveCapture {
            _stream: stream,
            meter,
            last_blocks: 0,
            last_callback: now,
        });
        state.runner = Some(RunnerHandle {
            stop,
            abort,
            thread,
        });
        state.update(
            Status::Starting,
            Some(target),
            Some("Waiting for microphone audio…"),
        );
        self.sync_active(&state);
        Some(StopCleanup {
            snapshot: state.snapshot.clone(),
            retired: None,
            runner: None,
        })
    }

    fn request_stop(&self, abort: bool) -> Result<Option<StopCleanup>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Dictation controls are unavailable.")?;
        let target = state.snapshot.target;
        let retired = state.capture.take().map(|capture| capture._stream);
        let runner = state.runner.take();
        if retired.is_none() && runner.is_none() {
            if matches!(state.snapshot.status, Status::Starting) {
                state.generation += 1;
                state.update(Status::Off, None, None);
                self.sync_active(&state);
                return Ok(Some(StopCleanup {
                    snapshot: state.snapshot.clone(),
                    retired: None,
                    runner: None,
                }));
            }
            return Ok(None);
        }
        if abort {
            if let Some(runner) = &runner {
                runner.abort.store(true, Ordering::Release);
                runner.stop.store(true, Ordering::Release);
            }
        }
        state.generation += 1;
        state.cleanup_pending = true;
        state.update(
            Status::Stopping,
            target,
            Some(if abort {
                "Stopping dictation…"
            } else {
                "Finishing dictation…"
            }),
        );
        self.sync_active(&state);
        Ok(Some(StopCleanup {
            snapshot: state.snapshot.clone(),
            retired,
            runner,
        }))
    }

    fn finish_cleanup(&self, outcome: FinishOutcome) -> Option<Snapshot> {
        let mut state = self.state.lock().ok()?;
        state.cleanup_pending = false;
        let target = state.snapshot.target;
        let snapshot = match state.snapshot.status {
            Status::Stopping => {
                match outcome {
                    FinishOutcome::Ok | FinishOutcome::Aborted => {
                        state.update(Status::Off, None, None);
                    }
                    FinishOutcome::CapReached => {
                        state.update(
                            Status::Off,
                            None,
                            Some("Dictation stopped at the 2-minute limit."),
                        );
                    }
                    FinishOutcome::Failed(failure) => {
                        state.update(Status::Error, target, Some(stt_failure_message(failure)));
                    }
                }
                Some(state.snapshot.clone())
            }
            Status::Error => {
                state.snapshot.revision += 1;
                state.snapshot.can_start = true;
                Some(state.snapshot.clone())
            }
            _ => None,
        };
        self.sync_active(&state);
        snapshot
    }

    fn take_capture_for_runner(&self, generation: u64) -> Option<Box<dyn CaptureStream>> {
        let mut state = self.state.lock().ok()?;
        if state.generation != generation {
            return None;
        }
        state.capture.take().map(|capture| capture._stream)
    }

    fn fail_from_runner(&self, generation: u64, failure: SttFailure, sink: &dyn Sink) {
        let (snapshot, retired) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.generation != generation {
                return;
            }
            let target = state.snapshot.target;
            let retired = state.capture.take().map(|capture| capture._stream);
            state.runner.take();
            state.generation += 1;
            state.cleanup_pending = retired.is_some();
            state.update(Status::Error, target, Some(stt_failure_message(failure)));
            self.sync_active(&state);
            (state.snapshot.clone(), retired)
        };
        sink.emit_snapshot(&snapshot);
        if let Some(stream) = retired {
            drop(stream);
            if let Some(cleaned) = self.finish_cleanup(FinishOutcome::Ok) {
                sink.emit_snapshot(&cleaned);
            }
        }
    }

    fn finish_cap_from_runner(&self, generation: u64, outcome: FinishOutcome, sink: &dyn Sink) {
        let snapshot = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.generation != generation {
                return;
            }
            let target = state.snapshot.target;
            state.runner.take();
            state.cleanup_pending = false;
            state.generation += 1;
            match outcome {
                FinishOutcome::Failed(failure) if failure != SttFailure::CapReached => {
                    state.update(Status::Error, target, Some(stt_failure_message(failure)));
                }
                _ => {
                    state.update(
                        Status::Off,
                        None,
                        Some("Dictation stopped at the 2-minute limit."),
                    );
                }
            }
            self.sync_active(&state);
            state.snapshot.clone()
        };
        sink.emit_snapshot(&snapshot);
    }

    fn poll(&self, now: Instant) -> Option<StopCleanup> {
        let mut state = self.state.try_lock().ok()?;
        let target = state.snapshot.target;
        let capture = state.capture.as_mut()?;
        let blocks = capture.meter.blocks.load(Ordering::Acquire);
        if blocks != capture.last_blocks {
            capture.last_blocks = blocks;
            capture.last_callback = now;
        }
        let failure = if capture.meter.failed.load(Ordering::Acquire) {
            Some(Failure::Device)
        } else if now.saturating_duration_since(capture.last_callback) >= INPUT_TIMEOUT {
            Some(Failure::Stalled)
        } else {
            None
        };
        if let Some(failure) = failure {
            let retired = state.capture.take().map(|capture| capture._stream);
            let runner = state.runner.take();
            if let Some(runner) = &runner {
                runner.abort.store(true, Ordering::Release);
                runner.stop.store(true, Ordering::Release);
            }
            state.cleanup_pending = true;
            state.generation += 1;
            state.update(
                Status::Error,
                target,
                Some(capture_failure_message(failure)),
            );
            self.sync_active(&state);
            return Some(StopCleanup {
                snapshot: state.snapshot.clone(),
                retired,
                runner,
            });
        }
        if blocks == 0 {
            return None;
        }
        if state.snapshot.status != Status::Listening {
            state.update(Status::Listening, target, None);
            self.sync_active(&state);
            Some(StopCleanup {
                snapshot: state.snapshot.clone(),
                retired: None,
                runner: None,
            })
        } else {
            None
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_transcriber(
    generation: u64,
    target: Target,
    mut chunker: Chunker,
    mut transcriber: Box<dyn StreamingTranscriber>,
    stop: Arc<AtomicBool>,
    abort: Arc<AtomicBool>,
    started_at: Instant,
    max_duration: Duration,
    core: Controller,
    sink: Arc<dyn Sink>,
) -> FinishOutcome {
    let mut cap_reached = false;
    let mut stream_failure: Option<SttFailure> = None;

    while !stop.load(Ordering::Acquire) {
        if started_at.elapsed() >= max_duration {
            cap_reached = true;
            break;
        }
        for chunk in chunker.drain(0) {
            if stop.load(Ordering::Acquire) {
                break;
            }
            let _ = transcriber.push(&chunk.samples);
        }
        for event in transcriber.poll() {
            match event {
                SttEvent::Final { seq, text, .. } => {
                    if !abort.load(Ordering::Acquire) && core.is_generation(generation) {
                        sink.emit_text(&TextEvent { target, seq, text });
                    }
                }
                SttEvent::Failed(failure) => {
                    stream_failure = Some(failure);
                    break;
                }
                SttEvent::Partial | SttEvent::Connected { .. } => {}
            }
        }
        if stream_failure.is_some() {
            break;
        }
        std::thread::sleep(DRAIN_EVERY);
    }

    if abort.load(Ordering::Acquire) {
        transcriber.abort();
        return FinishOutcome::Aborted;
    }

    if let Some(failure) = stream_failure {
        transcriber.abort();
        if failure == SttFailure::CapReached {
            if let Some(stream) = core.take_capture_for_runner(generation) {
                drop(stream);
            }
            core.finish_cap_from_runner(generation, FinishOutcome::CapReached, &*sink);
            return FinishOutcome::CapReached;
        }
        if failure == SttFailure::Auth {
            sink.emit_key_rejected();
        }
        core.fail_from_runner(generation, failure, &*sink);
        return FinishOutcome::Failed(failure);
    }

    if cap_reached {
        if let Some(stream) = core.take_capture_for_runner(generation) {
            drop(stream);
        }
        for chunk in chunker.finish(0) {
            let _ = transcriber.push(&chunk.samples);
        }
        let mut flush_failure = None;
        for event in transcriber.finish(FINISH_WAIT) {
            match event {
                SttEvent::Final { seq, text, .. } => {
                    if !abort.load(Ordering::Acquire) && core.is_generation(generation) {
                        sink.emit_text(&TextEvent { target, seq, text });
                    }
                }
                SttEvent::Failed(failure) => {
                    if failure == SttFailure::Auth {
                        sink.emit_key_rejected();
                    }
                    flush_failure = Some(failure);
                }
                SttEvent::Partial | SttEvent::Connected { .. } => {}
            }
        }
        let outcome = match flush_failure {
            Some(failure) => FinishOutcome::Failed(failure),
            None => FinishOutcome::CapReached,
        };
        core.finish_cap_from_runner(generation, outcome, &*sink);
        return outcome;
    }

    // Normal stop: the caller already dropped the capture stream before
    // setting `stop`, so `chunker.finish(0)` drains every last buffered sample.
    for chunk in chunker.finish(0) {
        if abort.load(Ordering::Acquire) {
            transcriber.abort();
            return FinishOutcome::Aborted;
        }
        let _ = transcriber.push(&chunk.samples);
    }
    let mut flush_failure = None;
    for event in transcriber.finish(FINISH_WAIT) {
        match event {
            SttEvent::Final { seq, text, .. } => {
                if !abort.load(Ordering::Acquire) {
                    sink.emit_text(&TextEvent { target, seq, text });
                }
            }
            SttEvent::Failed(failure) => {
                if failure == SttFailure::Auth {
                    sink.emit_key_rejected();
                }
                flush_failure = Some(failure);
            }
            SttEvent::Partial | SttEvent::Connected { .. } => {}
        }
    }
    match flush_failure {
        Some(SttFailure::CapReached) => FinishOutcome::CapReached,
        Some(failure) => FinishOutcome::Failed(failure),
        None => FinishOutcome::Ok,
    }
}

fn perform_cleanup(controller: Controller, sink: Arc<dyn Sink>, cleanup: StopCleanup) {
    sink.emit_snapshot(&cleanup.snapshot);
    let has_work = cleanup.retired.is_some() || cleanup.runner.is_some();
    if !has_work {
        return;
    }
    // Release the capture stream FIRST so the audio tap closes, then signal a
    // normal stop (unless already aborted) and join the runner to flush finals.
    if let Some(stream) = cleanup.retired {
        drop(stream);
    }
    let outcome = match cleanup.runner {
        Some(runner) => {
            runner.stop.store(true, Ordering::Release);
            runner.thread.join().unwrap_or(FinishOutcome::Aborted)
        }
        None => FinishOutcome::Ok,
    };
    if let Some(snapshot) = controller.finish_cleanup(outcome) {
        sink.emit_snapshot(&snapshot);
    }
}

fn spawn_cleanup(controller: Controller, sink: Arc<dyn Sink>, cleanup: StopCleanup) {
    sink.emit_snapshot(&cleanup.snapshot);
    if cleanup.retired.is_none() && cleanup.runner.is_none() {
        return;
    }
    let retired = cleanup.retired;
    let runner = cleanup.runner;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(stream) = retired {
            drop(stream);
        }
        let outcome = match runner {
            Some(runner) => {
                runner.stop.store(true, Ordering::Release);
                runner.thread.join().unwrap_or(FinishOutcome::Aborted)
            }
            None => FinishOutcome::Ok,
        };
        if let Some(snapshot) = controller.finish_cleanup(outcome) {
            sink.emit_snapshot(&snapshot);
        }
    });
}

fn readiness_error(failure: ReadinessFailure) -> &'static str {
    match failure {
        ReadinessFailure::NoKey => "Add your Deepgram API key in Settings to dictate.",
        ReadinessFailure::KeyRejected => {
            "Deepgram rejected your API key. Replace it in Settings to dictate."
        }
        ReadinessFailure::KeyUnreadable if cfg!(windows) => {
            "Your Deepgram key could not be read from Windows Credential Manager. Check it in Settings."
        }
        ReadinessFailure::KeyUnreadable if cfg!(target_os = "linux") => {
            "Your Deepgram key could not be read from the keyring. Check it in Settings."
        }
        ReadinessFailure::KeyUnreadable => {
            "Your Deepgram key could not be read from the Keychain. Check it in Settings."
        }
        ReadinessFailure::Settings | ReadinessFailure::TokenMetadata => {
            "The cloud transcription settings are not usable."
        }
    }
}

fn capture_failure_message(failure: Failure) -> &'static str {
    match failure {
        Failure::Permission => "Microphone access is unavailable. Check TalkQTE in System Settings → Privacy & Security → Microphone, then try again.",
        Failure::NoDevice => "No microphone is available. Connect an input device, then try again.",
        Failure::Unsupported => "This microphone or platform is not supported for dictation yet.",
        Failure::Device if cfg!(windows) => "Dictation stopped. Check your input device, and that Settings → Privacy & security → Microphone lets desktop apps use it, then try again.",
        Failure::Device if cfg!(target_os = "linux") => "Dictation stopped. Check your input device in your desktop's sound settings, then try again.",
        Failure::Device => "Dictation stopped. Check your input device and permission, then try again.",
        Failure::Stalled => "The microphone stopped delivering audio. Check your input device, then try again.",
    }
}

fn stt_failure_message(failure: SttFailure) -> &'static str {
    match failure {
        SttFailure::Auth => "Deepgram refused your API key. Replace it in Settings to dictate.",
        SttFailure::KeyUnavailable if cfg!(windows) => {
            "Your Deepgram key could not be read from Windows Credential Manager. Check it in Settings."
        }
        SttFailure::KeyUnavailable if cfg!(target_os = "linux") => {
            "Your Deepgram key could not be read from the keyring. Check it in Settings."
        }
        SttFailure::KeyUnavailable => {
            "Your Deepgram key could not be read from the Keychain. Check it in Settings."
        }
        SttFailure::Quota => {
            "Your Deepgram account cannot pay for more audio. Check credit in your Deepgram account."
        }
        SttFailure::RateLimited => {
            "Deepgram is limiting requests. Wait a minute and try again."
        }
        SttFailure::CapReached => "Dictation stopped at the 2-minute limit.",
        SttFailure::Network => {
            "The connection to Deepgram failed or was lost. Check your internet connection and try again."
        }
        SttFailure::Unavailable => "Deepgram is having a problem on its side. Try again in a moment.",
        SttFailure::Protocol | SttFailure::Closed => {
            "Dictation stopped because Deepgram closed the connection. Try again."
        }
        SttFailure::Settings => "The cloud transcription settings are not usable.",
        SttFailure::Stalled => "The connection to Deepgram stopped responding. Try again.",
        SttFailure::Withdrawn | SttFailure::LabEnded => "Dictation stopped.",
    }
}

fn default_opener(language: Language) -> Result<TranscriberOpener, String> {
    let source = cloud::source().map_err(|failure| readiness_error(failure).to_string())?;
    Ok(match source {
        Source::Dev(settings) => deepgram::opener(settings),
        Source::OwnKey => {
            let (opener, _) = deepgram::key_streams(Budget::new(MAX_DURATION), language);
            opener
        }
    })
}

fn check_may_start<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let live_open = app
        .state::<crate::AppState>()
        .0
        .lock()
        .is_ok_and(|runtime| runtime.live_session_open() || runtime.source_session.is_some());
    if live_open {
        return Err("Stop the live session before dictating.".into());
    }
    if app.state::<microphone::Controller>().is_busy() {
        return Err("Stop the microphone check before dictating.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn note_dictation_snapshot<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, Controller>,
) -> Result<Snapshot, String> {
    if window.label() != "main" {
        return Err("Note dictation is available in the notebook only.".into());
    }
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || controller.snapshot())
        .await
        .map_err(|_| "Could not read dictation status.")?
}

#[tauri::command]
pub async fn start_note_dictation<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, Controller>,
    target: Target,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Note dictation is available in the notebook only.".into());
    }
    check_may_start(&app)?;
    let language = cloud::language();
    let opener = default_opener(language)?;
    let controller = state.inner().clone();
    let preparer = controller.clone();
    let (generation, snapshot) =
        tauri::async_runtime::spawn_blocking(move || preparer.begin_start(target))
            .await
            .map_err(|_| "Could not start dictation.")??;
    let sink: Arc<dyn Sink> = Arc::new(TauriSink(app.clone()));
    // Re-check after reserving so a concurrent live session or microphone check
    // cannot race past before permission/device work begins.
    if let Err(reason) = check_may_start(&app) {
        let cancel = controller.clone();
        if let Ok(Ok(Some(cleanup))) =
            tauri::async_runtime::spawn_blocking(move || cancel.request_stop(true)).await
        {
            spawn_cleanup(controller, sink, cleanup);
        }
        return Err(reason);
    }
    sink.emit_snapshot(&snapshot);

    let opener_slot = Arc::new(Mutex::new(Some(opener)));
    let controller_bg = controller.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !controller_bg.is_starting(generation) {
            return;
        }
        microphone::native::request_permission(move |permission| {
            let controller = controller_bg.clone();
            let sink = sink.clone();
            let opener_slot = opener_slot.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if !controller.is_starting(generation) {
                    return;
                }
                let Some(opener) = opener_slot.lock().ok().and_then(|mut slot| slot.take()) else {
                    return;
                };
                let meter = Arc::new(Meter::default());
                let built = permission.and_then(|()| {
                    microphone::native::build_stream(meter.clone(), Some(CLOUD_CHUNK_MS))
                });
                if let Some(cleanup) = controller.complete_start(
                    StartSpec {
                        generation,
                        target,
                        meter,
                        opener,
                        sink: sink.clone(),
                        now: Instant::now(),
                        max_duration: MAX_DURATION,
                    },
                    built,
                ) {
                    spawn_cleanup(controller, sink, cleanup);
                }
            });
        });
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_note_dictation<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, Controller>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Note dictation is available in the notebook only.".into());
    }
    let controller = state.inner().clone();
    let stopper = controller.clone();
    let cleanup = tauri::async_runtime::spawn_blocking(move || stopper.request_stop(false))
        .await
        .map_err(|_| "Could not stop dictation. Try Stop dictating again.")??;
    if let Some(cleanup) = cleanup {
        let sink: Arc<dyn Sink> = Arc::new(TauriSink(app));
        tauri::async_runtime::spawn_blocking(move || perform_cleanup(controller, sink, cleanup))
            .await
            .map_err(|_| "Could not finish stopping dictation.")?;
    }
    Ok(())
}

/// Immediately aborts any active dictation so a live session can take the
/// microphone without fighting over the device.
pub async fn stop_for_live_session<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let controller = app.state::<Controller>().inner().clone();
    if !controller.is_active() {
        return;
    }
    let stopper = controller.clone();
    if let Ok(Ok(Some(cleanup))) =
        tauri::async_runtime::spawn_blocking(move || stopper.request_stop(true)).await
    {
        let sink: Arc<dyn Sink> = Arc::new(TauriSink(app.clone()));
        let _ = tauri::async_runtime::spawn_blocking(move || {
            perform_cleanup(controller, sink, cleanup);
        })
        .await;
    }
}

/// Non-blocking exit cleanup so quitting never stalls behind a device.
pub fn stop_on_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let controller = app.state::<Controller>().inner().clone();
    if !controller.is_active() {
        return;
    }
    let sink: Arc<dyn Sink> = Arc::new(TauriSink(app.clone()));
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(Some(cleanup)) = controller.request_stop(true) {
            perform_cleanup(controller, sink, cleanup);
        }
    });
}

pub fn refresh<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let controller = app.state::<Controller>();
    if let Some(cleanup) = controller.poll(Instant::now()) {
        let sink: Arc<dyn Sink> = Arc::new(TauriSink(app.clone()));
        spawn_cleanup(controller.inner().clone(), sink, cleanup);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        audio_tap::tap,
        transcription::{
            cloud::{Full, SttEvent},
            SAMPLE_RATE,
        },
    };
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct FakeSink {
        snapshots: Mutex<Vec<Snapshot>>,
        texts: Mutex<Vec<TextEvent>>,
        rejected: AtomicUsize,
    }

    impl FakeSink {
        fn snapshots(&self) -> Vec<Snapshot> {
            self.snapshots.lock().unwrap().clone()
        }

        fn texts(&self) -> Vec<TextEvent> {
            self.texts.lock().unwrap().clone()
        }
    }

    impl Sink for FakeSink {
        fn emit_snapshot(&self, snapshot: &Snapshot) {
            self.snapshots.lock().unwrap().push(snapshot.clone());
        }

        fn emit_text(&self, event: &TextEvent) {
            self.texts.lock().unwrap().push(event.clone());
        }

        fn emit_key_rejected(&self) {
            self.rejected.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct FakeStream {
        drops: Arc<AtomicUsize>,
        fail_play: bool,
    }

    impl CaptureStream for FakeStream {
        fn play(&self) -> Result<(), Failure> {
            if self.fail_play {
                Err(Failure::Device)
            } else {
                Ok(())
            }
        }
    }

    impl Drop for FakeStream {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct ScriptedTranscriber {
        line: &'static str,
        tail: Option<&'static str>,
        samples_seen: usize,
        finals_sent: u64,
        aborted: Arc<AtomicBool>,
        fail_with: Option<SttFailure>,
    }

    impl ScriptedTranscriber {
        fn new(line: &'static str, tail: Option<&'static str>) -> Self {
            Self {
                line,
                tail,
                samples_seen: 0,
                finals_sent: 0,
                aborted: Arc::default(),
                fail_with: None,
            }
        }
    }

    impl StreamingTranscriber for ScriptedTranscriber {
        fn push(&mut self, samples: &[f32]) -> Result<(), Full> {
            self.samples_seen += samples.len();
            Ok(())
        }

        fn poll(&mut self) -> Vec<SttEvent> {
            if let Some(failure) = self.fail_with.take() {
                return vec![SttEvent::Failed(failure)];
            }
            if self.samples_seen >= SAMPLE_RATE / 2 && self.finals_sent == 0 {
                self.finals_sent += 1;
                return vec![
                    SttEvent::Partial,
                    SttEvent::Final {
                        seq: 1,
                        text: self.line.into(),
                        start_ms: 0,
                        end_ms: 500,
                        untrusted_speaker: None,
                    },
                ];
            }
            Vec::new()
        }

        fn finish(&mut self, _: Duration) -> Vec<SttEvent> {
            let mut events = self.poll();
            if let Some(tail) = self.tail.take() {
                if self.samples_seen > SAMPLE_RATE / 2 {
                    self.finals_sent += 1;
                    events.push(SttEvent::Final {
                        seq: self.finals_sent,
                        text: tail.into(),
                        start_ms: 500,
                        end_ms: 1_000,
                        untrusted_speaker: None,
                    });
                }
            }
            events
        }

        fn abort(&mut self) {
            self.aborted.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn start_captures_transcribes_and_stop_flushes_final_text() {
        let controller = Controller::default();
        let sink = Arc::new(FakeSink::default());
        assert_eq!(
            controller.snapshot().unwrap(),
            Snapshot {
                revision: 0,
                status: Status::Off,
                target: None,
                can_start: true,
                message: None,
            }
        );

        let (generation, start_snap) = controller.begin_start(Target::Notes).unwrap();
        assert_eq!(start_snap.status, Status::Starting);
        assert_eq!(start_snap.target, Some(Target::Notes));
        assert!(!start_snap.can_start);
        assert!(controller.is_active());
        assert!(controller.begin_start(Target::Focus).is_err());

        let drops = Arc::new(AtomicUsize::new(0));
        let stream = Box::new(FakeStream {
            drops: drops.clone(),
            fail_play: false,
        });
        let (mut input, chunker) = tap(16_000, 1, CLOUD_CHUNK_MS);
        let meter = Arc::new(Meter::default());
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = aborted.clone();
        let opener: TranscriberOpener = Box::new(move || {
            let mut stt = ScriptedTranscriber::new(
                "Confirm the greenhouse key handover.",
                Some("Check with Priya."),
            );
            stt.aborted = aborted_clone;
            Ok(Box::new(stt))
        });

        let cleanup = controller
            .complete_start(
                StartSpec {
                    generation,
                    target: Target::Notes,
                    meter: meter.clone(),
                    opener,
                    sink: sink.clone(),
                    now: Instant::now(),
                    max_duration: MAX_DURATION,
                },
                Ok((stream, Some(chunker))),
            )
            .unwrap();
        assert!(cleanup.retired.is_none());

        // Simulate audio callback delivering meter blocks and speech samples.
        meter.observe([0.2f32; 160].into_iter());
        let poll_update = controller.poll(Instant::now()).unwrap();
        assert_eq!(poll_update.snapshot.status, Status::Listening);
        assert_eq!(poll_update.snapshot.target, Some(Target::Notes));

        input.push_interleaved(std::iter::repeat_n(0.3f32, SAMPLE_RATE));
        let until = Instant::now() + Duration::from_secs(3);
        while sink.texts().is_empty() {
            assert!(Instant::now() < until, "expected initial final text");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            sink.texts(),
            vec![TextEvent {
                target: Target::Notes,
                seq: 1,
                text: "Confirm the greenhouse key handover.".into(),
            }]
        );

        // Push trailing audio and drop input sender (mimicking CaptureStream drop).
        input.push_interleaved(std::iter::repeat_n(0.3f32, SAMPLE_RATE / 4));
        drop(input);

        let stop_cleanup = controller.request_stop(false).unwrap().unwrap();
        assert_eq!(stop_cleanup.snapshot.status, Status::Stopping);
        perform_cleanup(controller.clone(), sink.clone(), stop_cleanup);

        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert!(!aborted.load(Ordering::SeqCst));
        assert!(!controller.is_active());
        assert_eq!(
            sink.texts(),
            vec![
                TextEvent {
                    target: Target::Notes,
                    seq: 1,
                    text: "Confirm the greenhouse key handover.".into(),
                },
                TextEvent {
                    target: Target::Notes,
                    seq: 2,
                    text: "Check with Priya.".into(),
                },
            ]
        );
        let final_snap = controller.snapshot().unwrap();
        assert_eq!(final_snap.status, Status::Off);
        assert_eq!(final_snap.target, None);
        assert!(final_snap.can_start);
        assert!(final_snap.message.is_none());
    }

    #[test]
    fn safety_cap_stops_dictation_cleanly_and_flushes_remaining_text() {
        let controller = Controller::default();
        let sink = Arc::new(FakeSink::default());
        let (generation, _) = controller.begin_start(Target::Focus).unwrap();
        let drops = Arc::new(AtomicUsize::new(0));
        let stream = Box::new(FakeStream {
            drops: drops.clone(),
            fail_play: false,
        });
        let (mut input, chunker) = tap(16_000, 1, CLOUD_CHUNK_MS);
        input.push_interleaved(std::iter::repeat_n(0.3f32, SAMPLE_RATE));
        let meter = Arc::new(Meter::default());
        let opener: TranscriberOpener = Box::new(|| {
            Ok(Box::new(ScriptedTranscriber::new(
                "Agree the launch plan",
                None,
            )))
        });

        let _ = controller.complete_start(
            StartSpec {
                generation,
                target: Target::Focus,
                meter,
                opener,
                sink: sink.clone(),
                now: Instant::now(),
                max_duration: Duration::from_millis(80),
            },
            Ok((stream, Some(chunker))),
        );

        let until = Instant::now() + Duration::from_secs(3);
        while controller.is_active() {
            assert!(Instant::now() < until, "cap did not stop dictation");
            std::thread::sleep(Duration::from_millis(20));
        }

        assert_eq!(drops.load(Ordering::SeqCst), 1);
        let snap = controller.snapshot().unwrap();
        assert_eq!(snap.status, Status::Off);
        assert!(snap.can_start);
        assert_eq!(
            snap.message.as_deref(),
            Some("Dictation stopped at the 2-minute limit.")
        );
        assert_eq!(
            sink.texts(),
            vec![TextEvent {
                target: Target::Focus,
                seq: 1,
                text: "Agree the launch plan".into(),
            }]
        );
    }

    #[test]
    fn abort_stops_immediately_without_flushing_and_stream_auth_failure_notifies() {
        // 1. Auth failure marks rejected and emits Error with can_start = true.
        let controller = Controller::default();
        let sink = Arc::new(FakeSink::default());
        let (generation, _) = controller.begin_start(Target::Notes).unwrap();
        let drops = Arc::new(AtomicUsize::new(0));
        let stream = Box::new(FakeStream {
            drops: drops.clone(),
            fail_play: false,
        });
        let (_input, chunker) = tap(16_000, 1, CLOUD_CHUNK_MS);
        let meter = Arc::new(Meter::default());
        let opener: TranscriberOpener = Box::new(|| {
            let mut stt = ScriptedTranscriber::new("unused", None);
            stt.fail_with = Some(SttFailure::Auth);
            Ok(Box::new(stt))
        });

        let _ = controller.complete_start(
            StartSpec {
                generation,
                target: Target::Notes,
                meter,
                opener,
                sink: sink.clone(),
                now: Instant::now(),
                max_duration: MAX_DURATION,
            },
            Ok((stream, Some(chunker))),
        );

        let until = Instant::now() + Duration::from_secs(3);
        while controller.is_active() {
            assert!(Instant::now() < until, "auth failure did not settle");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_eq!(sink.rejected.load(Ordering::SeqCst), 1);
        let snap = controller.snapshot().unwrap();
        assert_eq!(snap.status, Status::Error);
        assert!(snap.can_start);
        assert!(snap
            .message
            .as_deref()
            .unwrap()
            .contains("Deepgram refused your API key"));

        // 2. Abort drops stream and aborts transcriber immediately.
        let (generation, _) = controller.begin_start(Target::Focus).unwrap();
        let drops = Arc::new(AtomicUsize::new(0));
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = aborted.clone();
        let stream = Box::new(FakeStream {
            drops: drops.clone(),
            fail_play: false,
        });
        let (mut input, chunker) = tap(16_000, 1, CLOUD_CHUNK_MS);
        input.push_interleaved(std::iter::repeat_n(0.3f32, SAMPLE_RATE));
        let opener: TranscriberOpener = Box::new(move || {
            let mut stt = ScriptedTranscriber::new("Should not emit after abort", Some("Tail"));
            stt.aborted = aborted_clone;
            Ok(Box::new(stt))
        });
        let _ = controller.complete_start(
            StartSpec {
                generation,
                target: Target::Focus,
                meter: Arc::new(Meter::default()),
                opener,
                sink: sink.clone(),
                now: Instant::now(),
                max_duration: MAX_DURATION,
            },
            Ok((stream, Some(chunker))),
        );
        let stop_cleanup = controller.request_stop(true).unwrap().unwrap();
        perform_cleanup(controller.clone(), sink.clone(), stop_cleanup);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert!(aborted.load(Ordering::SeqCst));
        assert!(!controller.is_active());
        assert_eq!(controller.snapshot().unwrap().status, Status::Off);
    }

    #[test]
    fn readiness_errors_and_capture_stall_report_plain_messages() {
        assert!(readiness_error(ReadinessFailure::NoKey).contains("Deepgram API key"));
        assert!(readiness_error(ReadinessFailure::KeyRejected).contains("Deepgram rejected"));
        assert!(readiness_error(ReadinessFailure::Settings).contains("not usable"));

        let controller = Controller::default();
        let sink = Arc::new(FakeSink::default());
        let (generation, _) = controller.begin_start(Target::Notes).unwrap();
        let drops = Arc::new(AtomicUsize::new(0));
        let stream = Box::new(FakeStream {
            drops: drops.clone(),
            fail_play: false,
        });
        let (_input, chunker) = tap(16_000, 1, CLOUD_CHUNK_MS);
        let origin = Instant::now();
        let _ = controller.complete_start(
            StartSpec {
                generation,
                target: Target::Notes,
                meter: Arc::new(Meter::default()),
                opener: Box::new(|| Ok(Box::new(ScriptedTranscriber::new("unused", None)))),
                sink: sink.clone(),
                now: origin,
                max_duration: MAX_DURATION,
            },
            Ok((stream, Some(chunker))),
        );
        let stalled = controller.poll(origin + INPUT_TIMEOUT).unwrap();
        assert_eq!(stalled.snapshot.status, Status::Error);
        assert!(!stalled.snapshot.can_start);
        perform_cleanup(controller.clone(), sink.clone(), stalled);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        let settled = controller.snapshot().unwrap();
        assert_eq!(settled.status, Status::Error);
        assert!(settled.can_start);
        assert!(settled
            .message
            .as_deref()
            .unwrap()
            .contains("stopped delivering audio"));
        assert!(!sink.snapshots().is_empty());
    }

    #[test]
    #[ignore = "run in a child process by the test below"]
    fn isolated_dictation() {
        let controller = Controller::default();
        let sink = Arc::new(FakeSink::default());
        let (generation, _) = controller.begin_start(Target::Notes).unwrap();
        let stream = Box::new(FakeStream {
            drops: Arc::new(AtomicUsize::new(0)),
            fail_play: false,
        });
        let (mut input, chunker) = tap(16_000, 1, CLOUD_CHUNK_MS);
        let meter = Arc::new(Meter::default());
        let _ = controller.complete_start(
            StartSpec {
                generation,
                target: Target::Notes,
                meter: meter.clone(),
                opener: Box::new(|| {
                    Ok(Box::new(ScriptedTranscriber::new(
                        "Secret garden key note.",
                        None,
                    )))
                }),
                sink: sink.clone(),
                now: Instant::now(),
                max_duration: MAX_DURATION,
            },
            Ok((stream, Some(chunker))),
        );
        meter.observe([0.2f32; 160].into_iter());
        let _ = controller.poll(Instant::now());
        input.push_interleaved(std::iter::repeat_n(0.3f32, SAMPLE_RATE));
        let until = Instant::now() + Duration::from_secs(3);
        while sink.texts().is_empty() {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(input);
        let cleanup = controller.request_stop(false).unwrap().unwrap();
        perform_cleanup(controller, sink, cleanup);
    }

    #[test]
    fn a_dictation_session_writes_no_file_and_prints_nothing() {
        let crate::test_isolation::Isolated { left, printed } =
            crate::test_isolation::run("dictation::tests::isolated_dictation", &[], &[]);
        assert!(left.is_empty(), "dictation left files: {left:?}");
        assert!(!printed.contains("Secret garden"), "printed: {printed}");
    }
}
