//! Microphone activity only: no sample buffers, recordings, or transcript data
//! leave the capture callback. The UI receives a small status snapshot.
mod native;

use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // Used by the macOS adapter only.
const MAX_METER_SAMPLES: usize = 4_096;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // Used by the macOS adapter only.
const ACTIVITY_POWER: f32 = 0.0001; // Approximate -40 dBFS RMS; not speech detection.
const ACTIVITY_HOLD: Duration = Duration::from_millis(600);
const INPUT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Off,
    Starting,
    Listening,
    Stopping,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Quiet,
    Active,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub status: Status,
    pub can_start: bool,
    pub activity: Activity,
    pub message: Option<String>,
    pub device_name: Option<String>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            status: Status::Off,
            can_start: true,
            activity: Activity::Quiet,
            message: None,
            device_name: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Failure {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))] // Used by the macOS adapter only.
    Permission,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))] // Used by the macOS adapter only.
    NoDevice,
    Unsupported,
    Device,
    Stalled,
}

impl Failure {
    fn message(self) -> &'static str {
        match self {
            Self::Permission => "Microphone access is unavailable. Check TalkQTE in System Settings → Privacy & Security → Microphone, then try again.",
            Self::NoDevice => "No microphone is available. Connect an input device, then try again.",
            Self::Unsupported => "This microphone or platform is not supported by the activity monitor yet.",
            Self::Device => "Microphone monitoring stopped. Check your input device and permission, then try again.",
            Self::Stalled => "The microphone stopped delivering audio. Check your input device, then try again.",
        }
    }
}

#[derive(Default)]
pub(super) struct Meter {
    blocks: AtomicU64,
    active: AtomicBool,
    failed: AtomicBool,
}

impl Meter {
    // The callback does bounded arithmetic and atomic writes only. It never
    // allocates, locks, logs, emits UI events, or retains a sample.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))] // Used by the macOS adapter only.
    fn observe(&self, samples: impl Iterator<Item = f32>) {
        let mut power = 0.0;
        let mut count = 0;
        for sample in samples.take(MAX_METER_SAMPLES) {
            if sample.is_finite() {
                let sample = sample.clamp(-1.0, 1.0);
                power += sample * sample;
                count += 1;
            }
        }
        if count == 0 {
            return;
        }
        if power / count as f32 >= ACTIVITY_POWER {
            self.active.store(true, Ordering::Release);
        }
        self.blocks.fetch_add(1, Ordering::Release);
    }
}

pub(super) trait CaptureStream: Send + Sync {
    fn play(&self) -> Result<(), Failure>;
    // Cached by the adapter at stream construction; never query hardware here.
    fn device_name(&self) -> Option<&str> {
        None
    }
}

fn display_device_name(name: Option<&str>) -> Option<String> {
    let name: String = name?
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(120)
        .collect();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

struct Capture {
    // Dropping the stream releases the input device. Never drop it in a callback.
    _stream: Box<dyn CaptureStream>,
    meter: Arc<Meter>,
    last_blocks: u64,
    last_callback: Instant,
    active_until: Option<Instant>,
}

#[derive(Default)]
struct State {
    snapshot: Snapshot,
    generation: u64,
    capture: Option<Capture>,
    cleanup_pending: bool,
}

impl State {
    fn update(&mut self, status: Status, activity: Activity, message: Option<&str>) {
        self.snapshot.revision += 1;
        self.snapshot.status = status;
        self.snapshot.can_start =
            matches!(status, Status::Off | Status::Error) && !self.cleanup_pending;
        self.snapshot.activity = activity;
        self.snapshot.message = message.map(str::to_owned);
        if matches!(status, Status::Off | Status::Error) {
            self.snapshot.device_name = None;
        }
    }
}

// Retired streams must be released by a worker, never the timer or UI thread.
struct Update {
    snapshot: Snapshot,
    retired: Option<Box<dyn CaptureStream>>,
}

enum Reservation {
    Ready(u64, Snapshot),
    Cancelled(Option<Update>),
}

impl Update {
    fn status(snapshot: Snapshot) -> Self {
        Self {
            snapshot,
            retired: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct Controller(Arc<Mutex<State>>, Arc<AtomicU64>);

impl Controller {
    fn reserve_start(&self, on_reserved: Option<OnReserved>) -> Result<Reservation, String> {
        let (generation, snapshot) = self.begin_start()?;
        // Do not hold the microphone mutex while the owner records this ID.
        // Once accepted, Stop can retire this exact generation even before
        // permission/device work runs. Rejection never requests permission.
        if on_reserved.is_some_and(|accept| !accept(generation)) {
            return Ok(Reservation::Cancelled(
                self.request_stop_of(Some(generation))?,
            ));
        }
        Ok(Reservation::Ready(generation, snapshot))
    }
    // Timer and window placement must never wait behind native stream startup.
    pub fn try_status(&self) -> Option<Status> {
        self.0.try_lock().ok().map(|state| state.snapshot.status)
    }

    /// Whether the microphone is not capturing, read without waiting: see
    /// `not_capturing`. None while the controller is busy, which callers must
    /// treat as possibly capturing.
    #[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
    pub fn try_not_capturing(&self) -> Option<bool> {
        self.0
            .try_lock()
            .ok()
            .map(|state| not_capturing(state.snapshot.status, state.snapshot.can_start))
    }

    /// Read authority without waiting behind native device startup. The
    /// atomic generation is updated under the state lock before device work.
    /// A busy lock means unknown status, not unknown operation ownership.
    pub(crate) fn control_snapshot(&self) -> (u64, Option<Snapshot>) {
        match self.0.try_lock() {
            Ok(state) => (state.generation, Some(state.snapshot.clone())),
            Err(_) => (self.1.load(Ordering::Acquire), None),
        }
    }

    #[cfg(test)]
    pub(crate) fn try_snapshot(&self) -> Option<Snapshot> {
        self.0.try_lock().ok().map(|state| state.snapshot.clone())
    }

    pub fn snapshot(&self) -> Result<Snapshot, String> {
        self.0
            .lock()
            .map(|state| state.snapshot.clone())
            .map_err(|_| "Microphone controls are unavailable. Restart TalkQTE.".into())
    }

    fn begin_start(&self) -> Result<(u64, Snapshot), String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Microphone controls are unavailable.")?;
        if state.cleanup_pending {
            return Err(
                "The microphone is still stopping. Wait for it to finish, then try again.".into(),
            );
        }
        if matches!(state.snapshot.status, Status::Starting | Status::Listening) {
            return Err("Microphone monitoring is already starting or running.".into());
        }
        state.generation += 1;
        self.1.store(state.generation, Ordering::Release);
        state.update(
            Status::Starting,
            Activity::Quiet,
            Some("Checking microphone access…"),
        );
        Ok((state.generation, state.snapshot.clone()))
    }

    /// Whether this start is still starting or listening. `None` when the
    /// controller is busy, so the app's timer never waits on a device.
    pub fn try_is_live(&self, generation: u64) -> Option<bool> {
        self.0.try_lock().ok().map(|state| {
            state.generation == generation
                && matches!(state.snapshot.status, Status::Starting | Status::Listening)
        })
    }

    /// True while this start's stream is the active capture.
    pub fn is_capturing(&self, generation: u64) -> bool {
        self.0
            .lock()
            .is_ok_and(|state| state.generation == generation && state.capture.is_some())
    }

    fn is_starting(&self, generation: u64) -> bool {
        self.0.lock().is_ok_and(|state| {
            state.generation == generation && state.snapshot.status == Status::Starting
        })
    }

    fn complete_start(
        &self,
        generation: u64,
        meter: Arc<Meter>,
        stream: Result<Box<dyn CaptureStream>, Failure>,
        now: Instant,
    ) -> Option<Update> {
        let Ok(mut state) = self.0.lock() else {
            return None;
        };
        if state.generation != generation || state.snapshot.status != Status::Starting {
            // A late permission/device response must never restart a stopped mic.
            drop(state);
            drop(stream);
            return None;
        }
        match stream {
            Ok(stream) => {
                // Start is serialized with cancellation. This runs on a worker,
                // and the audio callback never attempts to acquire this lock.
                if let Err(failure) = stream.play() {
                    state.cleanup_pending = true;
                    state.update(Status::Error, Activity::Quiet, Some(failure.message()));
                    return Some(Update {
                        snapshot: state.snapshot.clone(),
                        retired: Some(stream),
                    });
                }
                state.snapshot.device_name = display_device_name(stream.device_name());
                state.capture = Some(Capture {
                    _stream: stream,
                    meter,
                    last_blocks: 0,
                    last_callback: now,
                    active_until: None,
                });
                state.update(
                    Status::Starting,
                    Activity::Quiet,
                    Some("Waiting for microphone audio…"),
                );
            }
            Err(failure) => state.update(Status::Error, Activity::Quiet, Some(failure.message())),
        }
        Some(Update::status(state.snapshot.clone()))
    }

    fn request_stop(&self) -> Result<Update, String> {
        self.request_stop_of(None)?
            .ok_or_else(|| "Microphone controls are unavailable.".into())
    }

    /// Stops capture, or with `Some(generation)` only if that start is still
    /// the current one, so a late stop never ends a newer capture.
    fn request_stop_of(&self, generation: Option<u64>) -> Result<Option<Update>, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Microphone controls are unavailable.")?;
        if generation.is_some_and(|generation| generation != state.generation) {
            return Ok(None);
        }
        // A start that already failed has nothing to stop; leave its error
        // (such as refused access) visible instead of replacing it with Off.
        if generation.is_some() && state.capture.is_none() && state.snapshot.status == Status::Error
        {
            return Ok(None);
        }
        state.generation += 1;
        self.1.store(state.generation, Ordering::Release);
        let retired = state.capture.take().map(|capture| capture._stream);
        state.cleanup_pending |= retired.is_some();
        if state.cleanup_pending {
            state.update(
                Status::Stopping,
                Activity::Quiet,
                Some("Stopping microphone…"),
            );
        } else {
            state.update(Status::Off, Activity::Quiet, None);
        }
        Ok(Some(Update {
            snapshot: state.snapshot.clone(),
            retired,
        }))
    }

    // Called only after the old stream has actually been released. An error
    // remains visible until explicit retry; an explicit stop completes as Off.
    fn cleanup_finished(&self) -> Option<Snapshot> {
        let Ok(mut state) = self.0.lock() else {
            return None;
        };
        state.cleanup_pending = false;
        if state.snapshot.status == Status::Stopping {
            state.update(Status::Off, Activity::Quiet, None);
            Some(state.snapshot.clone())
        } else if state.snapshot.status == Status::Error {
            state.snapshot.revision += 1;
            state.snapshot.can_start = true;
            Some(state.snapshot.clone())
        } else {
            None
        }
    }

    fn poll(&self, now: Instant) -> Option<Update> {
        // A device operation must not hold up the demo's timer or window updates.
        let Ok(mut state) = self.0.try_lock() else {
            return None;
        };
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
            state.cleanup_pending = true;
            state.generation += 1;
            self.1.store(state.generation, Ordering::Release);
            state.update(Status::Error, Activity::Quiet, Some(failure.message()));
            return Some(Update {
                snapshot: state.snapshot.clone(),
                retired,
            });
        }
        if blocks == 0 {
            return None;
        }
        if capture.meter.active.swap(false, Ordering::AcqRel) {
            capture.active_until = Some(now + ACTIVITY_HOLD);
        }
        let activity = if capture.active_until.is_some_and(|until| now < until) {
            Activity::Active
        } else {
            Activity::Quiet
        };
        if state.snapshot.status != Status::Listening || state.snapshot.activity != activity {
            state.update(Status::Listening, activity, None);
            Some(Update::status(state.snapshot.clone()))
        } else {
            None
        }
    }
}

fn publish(app: &tauri::AppHandle, snapshot: &Snapshot) {
    let _ = app.emit_to("main", "microphone:changed", snapshot);
    let _ = app.emit_to("cue", "microphone:changed", snapshot);
}

fn publish_and_cleanup(app: &tauri::AppHandle, controller: Controller, update: Update) {
    publish(app, &update.snapshot);
    if let Some(stream) = update.retired {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            drop(stream);
            if let Some(snapshot) = controller.cleanup_finished() {
                publish(&app, &snapshot);
            }
        });
    }
}

/// Stops capture from a worker thread (for a live session ending). Does
/// nothing if the microphone is already off.
/// Stops the capture begun by `generation` (see `start`), if it is still
/// current, and publishes the change. Blocks briefly on the controller lock.
pub fn stop_blocking(app: &tauri::AppHandle, controller: Controller, generation: u64) {
    if let Ok(Some(update)) = controller.request_stop_of(Some(generation)) {
        publish_and_cleanup(app, controller, update);
    }
}

/// Request release of only the captured generation; acknowledgment does not
/// mean stream teardown has completed. Status events carry that confirmation.
pub(crate) fn stop_exact(
    app: &tauri::AppHandle,
    controller: Controller,
    generation: u64,
) -> Result<(), String> {
    if let Some(update) = controller.request_stop_of(Some(generation))? {
        publish_and_cleanup(app, controller, update);
    }
    Ok(())
}

#[tauri::command]
pub async fn microphone_snapshot(state: tauri::State<'_, Controller>) -> Result<Snapshot, String> {
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || controller.snapshot())
        .await
        .map_err(|_| "Could not read microphone status.")?
}

#[tauri::command]
pub async fn start_microphone(
    app: tauri::AppHandle,
    state: tauri::State<'_, Controller>,
) -> Result<(), String> {
    let may_start = |app: &tauri::AppHandle| {
        app.state::<crate::AppState>()
            .0
            .lock()
            .is_ok_and(|runtime| runtime.microphone_may_start())
    };
    if !may_start(&app) {
        return Err("Stop the live session before checking the microphone.".into());
    }
    // Checked again once the start is reserved, so a session that began in
    // between still refuses it before any permission request.
    let owner = app.clone();
    let refused = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let noted = refused.clone();
    let on_reserved: OnReserved = Box::new(move |_| {
        let allowed = may_start(&owner);
        if !allowed {
            noted.store(true, std::sync::atomic::Ordering::Release);
        }
        allowed
    });
    start(app, state.inner().clone(), None, Some(on_reserved))
        .await
        .map(|_| ())
        .map_err(|error| {
            if refused.load(std::sync::atomic::Ordering::Acquire) {
                "Stop the live session before checking the microphone.".into()
            } else {
                error
            }
        })
}

/// Called with the start's generation and the tap's chunker once capture has
/// really started.
pub type OnTap = Box<dyn FnOnce(u64, crate::audio_tap::Chunker) + Send>;

/// Records a reserved capture generation in its owning session before any
/// permission request. Return false if that session has stopped or changed.
pub type OnReserved = Box<dyn FnOnce(u64) -> bool + Send>;

/// Off, or failed with its device already released, so a new start may
/// follow. A failure whose cleanup is still pending, or any open state, may
/// still be capturing. The processing status maps an error the same way.
/// Used by the development build's application-audio source session.
#[cfg(all(target_os = "macos", feature = "native-audio-spike"))]
pub fn not_capturing(status: Status, can_start: bool) -> bool {
    status == Status::Off || (status == Status::Error && can_start)
}

/// Starts capture. With `tap`, the callback also feeds a transcription tap
/// with chunks of the given length, and `OnTap` receives its chunker only if
/// this start is still current when the stream begins. Returns the start's
/// generation once it is requested; permission and device results come later.
pub async fn start(
    app: tauri::AppHandle,
    controller: Controller,
    tap: Option<(u64, OnTap)>,
    on_reserved: Option<OnReserved>,
) -> Result<u64, String> {
    let preparer = controller.clone();
    let reserved =
        tauri::async_runtime::spawn_blocking(move || preparer.reserve_start(on_reserved))
            .await
            .map_err(|_| "Could not start the microphone check.")??;
    let (generation, snapshot) = match reserved {
        Reservation::Ready(generation, snapshot) => (generation, snapshot),
        Reservation::Cancelled(update) => {
            if let Some(update) = update {
                publish_and_cleanup(&app, controller, update);
            }
            return Err("Live session start was cancelled.".into());
        }
    };
    publish(&app, &snapshot);
    // The permission callback may be shared between threads, so the one-shot
    // tap hand-off is taken out of a lock exactly once.
    let chunk_ms = tap.as_ref().map(|(chunk_ms, _)| *chunk_ms);
    let on_tap = Arc::new(Mutex::new(tap.map(|(_, on_tap)| on_tap)));
    // Only an explicit main-window command can request microphone access.
    // Neither device locks nor authorization callbacks run on the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        if !controller.is_starting(generation) {
            return;
        }
        native::request_permission(move |permission| {
            let controller = controller.clone();
            let app = app.clone();
            let on_tap = on_tap.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if !controller.is_starting(generation) {
                    return;
                }
                let on_tap = on_tap.lock().ok().and_then(|mut slot| slot.take());
                let meter = Arc::new(Meter::default());
                let built = permission.and_then(|()| native::build_stream(meter.clone(), chunk_ms));
                let (stream, chunker) = match built {
                    Ok((stream, chunker)) => (Ok(stream), chunker),
                    Err(failure) => (Err(failure), None),
                };
                if let Some(update) =
                    controller.complete_start(generation, meter, stream, Instant::now())
                {
                    publish_and_cleanup(&app, controller.clone(), update);
                }
                if let (Some(chunker), Some(on_tap)) = (chunker, on_tap) {
                    if controller.is_capturing(generation) {
                        on_tap(generation, chunker);
                    }
                }
            });
        });
    });
    Ok(generation)
}

/// Stops the microphone check. The `stop_microphone` command in `lib.rs`
/// calls this, or stops the live session when one is running.
pub async fn stop_microphone(app: tauri::AppHandle, controller: Controller) -> Result<(), String> {
    let stopper = controller.clone();
    let update = tauri::async_runtime::spawn_blocking(move || stopper.request_stop())
        .await
        .map_err(|_| "Could not stop the microphone check. Try Stop microphone again.")??;
    publish_and_cleanup(&app, controller, update);
    Ok(())
}

pub fn stop_on_exit(app: &tauri::AppHandle) {
    let controller = app.state::<Controller>().inner().clone();
    let app = app.clone();
    // A stalled device must not block the event loop or prevent Quit.
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(update) = controller.request_stop() {
            publish_and_cleanup(&app, controller, update);
        }
    });
}

pub fn refresh(app: &tauri::AppHandle) {
    let controller = app.state::<Controller>();
    if let Some(update) = controller.poll(Instant::now()) {
        publish_and_cleanup(app, controller.inner().clone(), update);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        cell::Cell,
        sync::atomic::AtomicUsize,
    };

    /// Counts the allocations a thread makes while it has counting on, so a
    /// test can show that the capture callback allocates nothing. Other
    /// threads, and code outside the counted span, are unaffected.
    struct CountingAllocator;

    thread_local! {
        static COUNTING: Cell<bool> = const { Cell::new(false) };
        static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    }

    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            if COUNTING.try_with(Cell::get).unwrap_or(false) {
                let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
            }
            unsafe { System.alloc(layout) }
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe { System.dealloc(pointer, layout) }
        }
    }

    #[global_allocator]
    static ALLOCATOR: CountingAllocator = CountingAllocator;

    /// Allocations `work` makes on this thread.
    fn allocations_during(work: impl FnOnce()) -> usize {
        ALLOCATIONS.set(0);
        COUNTING.set(true);
        work();
        COUNTING.set(false);
        ALLOCATIONS.get()
    }

    struct FakeStream {
        starts: Arc<AtomicUsize>,
        drops: Arc<AtomicUsize>,
        fail: bool,
    }
    impl CaptureStream for FakeStream {
        fn device_name(&self) -> Option<&str> {
            Some("Garden USB microphone")
        }
        fn play(&self) -> Result<(), Failure> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            if self.fail {
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
    fn fake(fail: bool) -> (Box<dyn CaptureStream>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let starts = Arc::new(AtomicUsize::new(0));
        let drops = Arc::new(AtomicUsize::new(0));
        (
            Box::new(FakeStream {
                starts: starts.clone(),
                drops: drops.clone(),
                fail,
            }),
            starts,
            drops,
        )
    }
    fn finish(controller: &Controller, update: Update) {
        if let Some(stream) = update.retired {
            drop(stream);
            controller.cleanup_finished();
        }
    }
    fn running() -> (Controller, Arc<Meter>, Arc<AtomicUsize>, Instant) {
        let controller = Controller::default();
        let (generation, _) = controller.begin_start().unwrap();
        let meter = Arc::new(Meter::default());
        let (stream, _, drops) = fake(false);
        let now = Instant::now();
        controller.complete_start(generation, meter.clone(), Ok(stream), now);
        (controller, meter, drops, now)
    }

    #[test]
    fn unknown_status_still_binds_stop_to_the_observed_generation() {
        let controller = Controller::default();
        let (generation, _) = controller.begin_start().unwrap();
        let locked = controller.0.lock().unwrap();
        let (observed, snapshot) = controller.control_snapshot();
        assert_eq!(observed, generation);
        assert!(snapshot.is_none());
        drop(locked);
        let mut runtime = crate::Runtime::default();
        let target = crate::engine::StopTarget {
            operation: None,
            microphone: observed.to_string(),
        };
        let plan = runtime.prepare_capture_stop(&target).unwrap();
        finish(
            &controller,
            controller
                .request_stop_of(Some(plan.microphone))
                .unwrap()
                .unwrap(),
        );
        let (newer, _) = controller.begin_start().unwrap();
        assert!(controller
            .request_stop_of(Some(plan.microphone))
            .unwrap()
            .is_none());
        assert!(controller.is_starting(newer));
        assert_eq!(controller.control_snapshot().0, newer);
    }

    #[test]
    fn scoped_stop_releases_standalone_capture_only_after_cleanup_and_blocks_late_permission() {
        let (controller, _meter, drops, _) = running();
        let generation = controller.control_snapshot().0;
        let mut runtime = crate::Runtime::default();
        let target = crate::engine::StopTarget {
            operation: None,
            microphone: generation.to_string(),
        };
        let plan = runtime.prepare_capture_stop(&target).unwrap();
        assert!(plan.live.is_none());
        let update = controller
            .request_stop_of(Some(plan.microphone))
            .unwrap()
            .unwrap();
        assert_eq!(
            crate::capture_state(controller.control_snapshot().1),
            crate::engine::CaptureState::Stopping
        );
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        assert!(controller.begin_start().is_err());
        assert!(controller
            .request_stop_of(Some(plan.microphone))
            .unwrap()
            .is_none());
        finish(&controller, update);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_eq!(
            crate::capture_state(controller.control_snapshot().1),
            crate::engine::CaptureState::Off
        );
        let (late, starts, late_drops) = fake(false);
        assert!(controller
            .complete_start(
                generation,
                Arc::new(Meter::default()),
                Ok(late),
                Instant::now()
            )
            .is_none());
        assert_eq!(starts.load(Ordering::SeqCst), 0);
        assert_eq!(late_drops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_controller_never_claims_capture_release_or_loses_observed_authority() {
        let controller = Controller::default();
        let (generation, _) = controller.begin_start().unwrap();
        let broken = controller.clone();
        let _ = std::thread::spawn(move || {
            let _lock = broken.0.lock().unwrap();
            panic!("fictional controller failure");
        })
        .join();
        let (observed, snapshot) = controller.control_snapshot();
        assert_eq!(observed, generation);
        assert_eq!(
            crate::capture_state(snapshot),
            crate::engine::CaptureState::Unknown
        );
        assert!(controller.request_stop_of(Some(observed)).is_err());
    }

    #[test]
    fn default_is_off_and_start_does_not_claim_listening_before_samples() {
        let controller = Controller::default();
        assert_eq!(controller.snapshot().unwrap().status, Status::Off);
        controller.begin_start().unwrap();
        assert!(controller.begin_start().is_err());
        assert_eq!(controller.snapshot().unwrap().status, Status::Starting);
    }

    #[test]
    fn stopped_session_rejects_microphone_reservation_before_permission() {
        let runtime = Arc::new(Mutex::new(crate::Runtime::default()));
        let ticket = runtime.lock().unwrap().begin_live_start().unwrap();
        let session = runtime.lock().unwrap().install_live_start(&ticket).unwrap();
        runtime.lock().unwrap().take_live_for_stop();
        let guard = ticket.guard();
        let owner = runtime.clone();
        let controller = Controller::default();
        let result = controller
            .reserve_start(Some(Box::new(move |generation| {
                owner
                    .lock()
                    .unwrap()
                    .reserve_live_microphone(&guard, session, generation)
            })))
            .unwrap();
        let Reservation::Cancelled(Some(update)) = result else {
            panic!("a stopped session must not enter the permission path");
        };
        finish(&controller, update);
        assert_eq!(controller.snapshot().unwrap().status, Status::Off);
        assert!(runtime.lock().unwrap().live.is_none());
    }

    #[test]
    fn stop_after_registration_retires_the_start_before_permission_returns() {
        use std::{sync::mpsc, thread};
        let runtime = Arc::new(Mutex::new(crate::Runtime::default()));
        let ticket = runtime.lock().unwrap().begin_live_start().unwrap();
        let session = runtime.lock().unwrap().install_live_start(&ticket).unwrap();
        let guard = ticket.guard();
        let controller = Controller::default();
        let starter = controller.clone();
        let owner = runtime.clone();
        let (entered_tx, entered) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let task = thread::spawn(move || {
            starter.reserve_start(Some(Box::new(move |generation| {
                let accepted = owner
                    .lock()
                    .unwrap()
                    .reserve_live_microphone(&guard, session, generation);
                entered_tx.send(generation).unwrap();
                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                accepted
            })))
        });
        let generation = entered.recv_timeout(Duration::from_secs(2)).unwrap();
        let live = runtime.lock().unwrap().take_live_for_stop().unwrap();
        assert_eq!(live.microphone, Some(generation));
        finish(
            &controller,
            controller
                .request_stop_of(live.microphone)
                .unwrap()
                .unwrap(),
        );
        runtime.lock().unwrap().engine.end();
        release.send(()).unwrap();
        assert!(
            matches!(task.join().unwrap().unwrap(), Reservation::Ready(id, _) if id == generation)
        );
        assert!(!controller.is_starting(generation));
        let (stream, starts, drops) = fake(false);
        assert!(controller
            .complete_start(
                generation,
                Arc::new(Meter::default()),
                Ok(stream),
                Instant::now(),
            )
            .is_none());
        assert_eq!(starts.load(Ordering::SeqCst), 0);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_eq!(controller.snapshot().unwrap().status, Status::Off);
    }

    #[test]
    fn window_and_timer_status_reads_skip_a_blocked_native_start() {
        use std::{sync::mpsc, thread};
        struct BlockedStart {
            entered: mpsc::Sender<()>,
            release: Mutex<mpsc::Receiver<()>>,
        }
        impl CaptureStream for BlockedStart {
            fn play(&self) -> Result<(), Failure> {
                self.entered.send(()).unwrap();
                self.release
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                Ok(())
            }
        }
        let controller = Controller::default();
        let (generation, _) = controller.begin_start().unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let starter = controller.clone();
        let start = thread::spawn(move || {
            starter.complete_start(
                generation,
                Arc::new(Meter::default()),
                Ok(Box::new(BlockedStart {
                    entered: entered_tx,
                    release: Mutex::new(release_rx),
                })),
                Instant::now(),
            )
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let reader = controller.clone();
        let (read_tx, read_rx) = mpsc::channel();
        let read = thread::spawn(move || {
            read_tx
                .send((
                    reader.try_status(),
                    reader.try_snapshot().is_none(),
                    reader.poll(Instant::now()).is_none(),
                ))
                .unwrap();
        });
        let result = read_rx.recv_timeout(Duration::from_secs(1));
        let stopper = controller.clone();
        let (stop_tx, stop_rx) = mpsc::channel();
        let stop = thread::spawn(move || {
            stop_tx.send(stopper.request_stop().unwrap()).unwrap();
        });
        assert!(matches!(stop_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        release_tx.send(()).unwrap();
        start.join().unwrap();
        read.join().unwrap();
        assert_eq!(result.unwrap(), (None, true, true));
        let update = stop_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        stop.join().unwrap();
        assert_eq!(update.snapshot.status, Status::Stopping);
        assert_eq!(controller.try_status(), Some(Status::Stopping));
        assert!(controller.begin_start().is_err());
        finish(&controller, update);
        assert_eq!(controller.try_status(), Some(Status::Off));
    }

    #[test]
    fn signal_activity_settles_without_losing_short_bursts() {
        let (controller, meter, _, now) = running();
        meter.observe([0.0; 32].into_iter());
        assert_eq!(
            controller.poll(now).unwrap().snapshot.activity,
            Activity::Quiet
        );
        meter.observe([0.2; 32].into_iter());
        meter.observe([0.0; 32].into_iter());
        assert_eq!(
            controller.poll(now).unwrap().snapshot.activity,
            Activity::Active
        );
        assert!(controller.poll(now + Duration::from_millis(300)).is_none());
        assert_eq!(
            controller
                .poll(now + ACTIVITY_HOLD)
                .unwrap()
                .snapshot
                .activity,
            Activity::Quiet
        );
    }

    #[test]
    fn meter_ignores_nonfinite_values_and_bounds_work() {
        let meter = Meter::default();
        meter.observe([f32::NAN, f32::INFINITY, f32::NEG_INFINITY].into_iter());
        assert_eq!(meter.blocks.load(Ordering::Acquire), 0);
        meter.observe(std::iter::repeat_n(0.0, MAX_METER_SAMPLES).chain(std::iter::once(1.0)));
        assert!(!meter.active.load(Ordering::Acquire));
        meter.observe([f32::MAX].into_iter());
        assert!(meter.active.load(Ordering::Acquire));
    }

    #[test]
    fn the_capture_callback_keeps_only_whether_audio_was_loud_and_allocates_nothing() {
        // Two different stretches of fictional speech, as a device would
        // deliver them, each followed by near silence.
        let first: Vec<f32> = (0..MAX_METER_SAMPLES * 2)
            .map(|i| (i as f32 * 0.37).sin() * 0.6)
            .collect();
        let second: Vec<f32> = (0..480)
            .map(|i| {
                if i % 7 == 0 {
                    f32::NAN
                } else {
                    -0.9 + i as f32 / 600.0
                }
            })
            .collect();
        let quiet = vec![0.001_f32; 480];
        let (controllers, meters): (Vec<_>, Vec<_>) = (0..2)
            .map(|_| {
                let (controller, meter, _, now) = running();
                ((controller, now), meter)
            })
            .unzip();
        // A live session's tap receives the same buffers in the callback.
        let (mut tap, _chunker) = crate::audio_tap::tap(48_000, 1, 3_000);

        // Exactly what the callback runs for each buffer.
        let allocations = allocations_during(|| {
            for (meter, speech) in meters.iter().zip([&first, &second]) {
                for buffer in [speech, &quiet] {
                    meter.observe(buffer.iter().copied());
                    tap.push_interleaved(buffer.iter().copied());
                }
            }
        });
        assert_eq!(allocations, 0, "the callback allocated");

        // Nothing distinguishes the two recordings afterwards: each meter
        // holds a buffer count, a loud flag and a failure flag, the same for
        // both, and the windows then receive the same status from each.
        let state = |meter: &Meter| {
            (
                meter.blocks.load(Ordering::Acquire),
                meter.active.load(Ordering::Acquire),
                meter.failed.load(Ordering::Acquire),
            )
        };
        assert_eq!(state(&meters[0]), (2, true, false));
        assert_eq!(state(&meters[0]), state(&meters[1]));
        let sent: Vec<_> = controllers
            .iter()
            .map(|(controller, now)| {
                serde_json::to_value(controller.poll(*now).unwrap().snapshot).unwrap()
            })
            .collect();
        assert_eq!(sent[0], sent[1]);
        assert_eq!(sent[0]["activity"], "active");
    }

    #[test]
    fn stop_cancels_late_permission_and_does_not_start_the_stream() {
        let controller = Controller::default();
        let (generation, _) = controller.begin_start().unwrap();
        finish(&controller, controller.request_stop().unwrap());
        let (stream, starts, drops) = fake(false);
        assert!(controller
            .complete_start(
                generation,
                Arc::new(Meter::default()),
                Ok(stream),
                Instant::now()
            )
            .is_none());
        assert_eq!(starts.load(Ordering::SeqCst), 0);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_eq!(controller.snapshot().unwrap().status, Status::Off);
    }

    #[test]
    fn the_status_the_windows_receive_has_no_samples_device_identifier_or_level() {
        let (controller, meter, _, now) = running();
        meter.observe([0.5; 32].into_iter());
        let update = controller.poll(now).expect("activity is reported");
        let sent = serde_json::to_value(&update.snapshot).unwrap();
        let fields = sent.as_object().unwrap();
        let mut names: Vec<&str> = fields.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "activity",
                "canStart",
                "deviceName",
                "message",
                "revision",
                "status"
            ]
        );
        // A coarse state and a display name: no list of samples, no nested
        // device description, and no number but the revision counter.
        assert_eq!(sent["status"], "listening");
        assert_eq!(sent["activity"], "active");
        assert_eq!(sent["deviceName"], "Garden USB microphone");
        for (name, value) in fields {
            assert!(!value.is_array() && !value.is_object(), "{name}");
            assert_eq!(value.is_number(), name == "revision", "{name}");
        }
    }

    #[test]
    fn stop_releases_capture_and_late_callbacks_cannot_reactivate_it() {
        let (controller, meter, drops, now) = running();
        assert_eq!(
            controller.snapshot().unwrap().device_name.as_deref(),
            Some("Garden USB microphone")
        );
        let stopping = controller.request_stop().unwrap();
        assert_eq!(
            stopping.snapshot.device_name.as_deref(),
            Some("Garden USB microphone")
        );
        finish(&controller, stopping);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert!(controller.snapshot().unwrap().device_name.is_none());
        meter.observe([0.5; 32].into_iter());
        assert!(controller.poll(now).is_none());
        assert_eq!(controller.snapshot().unwrap().status, Status::Off);
    }

    #[test]
    fn permission_and_device_start_failures_are_retryable_errors() {
        let controller = Controller::default();
        let (generation, _) = controller.begin_start().unwrap();
        let snapshot = controller
            .complete_start(
                generation,
                Arc::new(Meter::default()),
                Err(Failure::Permission),
                Instant::now(),
            )
            .unwrap()
            .snapshot;
        assert_eq!(snapshot.status, Status::Error);
        assert!(snapshot.device_name.is_none());
        assert!(snapshot.message.unwrap().contains("System Settings"));
        let (generation, _) = controller.begin_start().unwrap();
        let (stream, _, drops) = fake(true);
        let update = controller
            .complete_start(
                generation,
                Arc::new(Meter::default()),
                Ok(stream),
                Instant::now(),
            )
            .unwrap();
        assert_eq!(update.snapshot.status, Status::Error);
        assert!(update.snapshot.device_name.is_none());
        assert!(controller.begin_start().is_err());
        finish(&controller, update);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert!(controller.begin_start().is_ok());
    }

    #[test]
    fn device_error_and_missing_callbacks_release_capture() {
        for failed in [false, true] {
            let (controller, meter, drops, now) = running();
            // Lose a stream that was actually delivering audio, not just a
            // start that never received its first callback.
            meter.observe([0.5; 32].into_iter());
            let listening = controller.poll(now).unwrap().snapshot;
            assert_eq!(listening.status, Status::Listening);
            assert_eq!(listening.activity, Activity::Active);
            let lost_at = if failed {
                // Native errors must stop capture even before the watchdog.
                meter.observe([0.5; 32].into_iter());
                now + Duration::from_millis(200)
            } else {
                assert!(controller
                    .poll(now + INPUT_TIMEOUT - Duration::from_millis(1))
                    .is_some_and(|update| update.snapshot.status == Status::Listening));
                now + INPUT_TIMEOUT
            };
            if failed {
                meter.failed.store(true, Ordering::Release);
            }
            let update = controller.poll(lost_at).unwrap();
            assert_eq!(update.snapshot.status, Status::Error);
            assert!(update.snapshot.device_name.is_none());
            assert_eq!(update.snapshot.activity, Activity::Quiet);
            assert!(!update.snapshot.can_start);
            assert!(controller.begin_start().is_err());
            assert!(update
                .snapshot
                .message
                .as_deref()
                .unwrap()
                .contains(if failed {
                    "monitoring stopped"
                } else {
                    "stopped delivering audio"
                }));
            let error_revision = update.snapshot.revision;
            assert_eq!(drops.load(Ordering::SeqCst), 0);
            drop(update.retired);
            let released = controller.cleanup_finished().unwrap();
            assert_eq!(released.status, Status::Error);
            assert!(released.can_start);
            assert!(released.revision > error_revision);
            assert_eq!(drops.load(Ordering::SeqCst), 1);
            // Late data or errors from the retired stream do not reconnect it.
            meter.observe([0.5; 32].into_iter());
            meter.failed.store(true, Ordering::Release);
            assert!(controller.poll(lost_at + INPUT_TIMEOUT).is_none());
            assert_eq!(controller.snapshot().unwrap().status, Status::Error);

            // An explicit retry owns a new stream and ignores the old meter.
            let (generation, _) = controller.begin_start().unwrap();
            let next_meter = Arc::new(Meter::default());
            let (stream, starts, next_drops) = fake(false);
            let retry_at = lost_at + INPUT_TIMEOUT;
            controller.complete_start(generation, next_meter.clone(), Ok(stream), retry_at);
            next_meter.observe([0.0; 32].into_iter());
            let recovered = controller.poll(retry_at).unwrap().snapshot;
            assert_eq!(recovered.status, Status::Listening);
            assert_eq!(recovered.activity, Activity::Quiet);
            assert_eq!(starts.load(Ordering::SeqCst), 1);
            finish(&controller, controller.request_stop().unwrap());
            assert_eq!(next_drops.load(Ordering::SeqCst), 1);
            assert_eq!(controller.snapshot().unwrap().status, Status::Off);
        }
    }

    #[test]
    fn continuing_silent_callbacks_are_not_a_device_disconnect() {
        let (controller, meter, drops, now) = running();
        // Silence is still valid input. Only missing callbacks, not low signal,
        // should trigger the watchdog during a quiet part of a conversation.
        for seconds in 0..=10 {
            meter.observe([0.0; 32].into_iter());
            controller.poll(now + Duration::from_secs(seconds));
            let snapshot = controller.snapshot().unwrap();
            assert_eq!(snapshot.status, Status::Listening);
            assert_eq!(snapshot.activity, Activity::Quiet);
            assert_eq!(drops.load(Ordering::SeqCst), 0);
        }
        finish(&controller, controller.request_stop().unwrap());
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn device_labels_are_bounded_and_missing_names_stay_unknown() {
        assert_eq!(display_device_name(None), None);
        assert_eq!(display_device_name(Some(" \n\t")), None);
        assert_eq!(
            display_device_name(Some(" Garden\u{202e} USB\n ")),
            Some("Garden USB".into())
        );
        assert_eq!(
            display_device_name(Some(&"庭".repeat(200)))
                .unwrap()
                .chars()
                .count(),
            120
        );
    }

    struct SlowStream {
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
        drops: Arc<AtomicUsize>,
    }

    impl CaptureStream for SlowStream {
        fn play(&self) -> Result<(), Failure> {
            Ok(())
        }
    }

    impl Drop for SlowStream {
        fn drop(&mut self) {
            let _ = self.entered.send(());
            let _ = self
                .release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5));
            self.drops.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn slow_stop_and_error_cleanup_leave_status_responsive_and_prevent_restart() {
        use std::{sync::mpsc, thread};
        for device_error in [false, true] {
            let controller = Controller::default();
            let (generation, _) = controller.begin_start().unwrap();
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let drops = Arc::new(AtomicUsize::new(0));
            let meter = Arc::new(Meter::default());
            let now = Instant::now();
            controller.complete_start(
                generation,
                meter.clone(),
                Ok(Box::new(SlowStream {
                    entered: entered_tx,
                    release: Mutex::new(release_rx),
                    drops: drops.clone(),
                })),
                now,
            );
            meter.failed.store(device_error, Ordering::Release);

            let (update_tx, update_rx) = mpsc::channel();
            let poller = controller.clone();
            let poll_thread = thread::spawn(move || {
                let update = if device_error {
                    poller.poll(now).unwrap()
                } else {
                    poller.request_stop().unwrap()
                };
                update_tx.send(update).unwrap();
            });
            // Both the timer's error path and the stop request must return while
            // the fake native destructor is still deliberately blocked.
            let update = update_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            poll_thread.join().unwrap();
            assert_eq!(
                update.snapshot.status,
                if device_error {
                    Status::Error
                } else {
                    Status::Stopping
                }
            );
            let cleaner = controller.clone();
            let cleanup = thread::spawn(move || finish(&cleaner, update));
            entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            assert_eq!(drops.load(Ordering::SeqCst), 0);
            assert!(!controller.snapshot().unwrap().can_start);
            assert!(controller.begin_start().is_err());
            assert!(controller.poll(now).is_none());
            // Repeated stop, including during error cleanup, cannot claim Off.
            assert_eq!(
                controller.request_stop().unwrap().snapshot.status,
                Status::Stopping
            );
            assert_eq!(controller.snapshot().unwrap().status, Status::Stopping);
            release_tx.send(()).unwrap();
            cleanup.join().unwrap();
            assert_eq!(drops.load(Ordering::SeqCst), 1);
            assert_eq!(controller.snapshot().unwrap().status, Status::Off);
            assert!(controller.snapshot().unwrap().can_start);
            assert!(controller.begin_start().is_ok());
        }
    }

    #[test]
    fn a_late_stop_for_an_earlier_start_leaves_a_newer_capture_running() {
        let controller = Controller::default();
        let (old, _) = controller.begin_start().unwrap();
        finish(&controller, controller.request_stop().unwrap());
        let (current, _) = controller.begin_start().unwrap();
        let (stream, _, drops) = fake(false);
        let meter = Arc::new(Meter::default());
        controller.complete_start(current, meter, Ok(stream), Instant::now());
        assert_eq!(controller.try_is_live(old), Some(false));
        assert!(controller.request_stop_of(Some(old)).unwrap().is_none());
        assert!(controller.is_capturing(current));
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        let update = controller.request_stop_of(Some(current)).unwrap().unwrap();
        assert_eq!(controller.try_is_live(current), Some(false));
        finish(&controller, update);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_refused_permission_is_not_a_live_capture() {
        let controller = Controller::default();
        let (generation, _) = controller.begin_start().unwrap();
        assert_eq!(controller.try_is_live(generation), Some(true));
        controller.complete_start(
            generation,
            Arc::new(Meter::default()),
            Err(Failure::Permission),
            Instant::now(),
        );
        assert_eq!(controller.try_is_live(generation), Some(false));
        // Ending the live session afterwards keeps the reason visible.
        assert!(controller
            .request_stop_of(Some(generation))
            .unwrap()
            .is_none());
        let snapshot = controller.snapshot().unwrap();
        assert_eq!(snapshot.status, Status::Error);
        assert!(snapshot.message.is_some());
    }

    #[test]
    fn an_old_start_cannot_replace_a_newer_request() {
        let controller = Controller::default();
        let (old, _) = controller.begin_start().unwrap();
        finish(&controller, controller.request_stop().unwrap());
        let (new, _) = controller.begin_start().unwrap();
        controller.complete_start(
            old,
            Arc::new(Meter::default()),
            Err(Failure::Permission),
            Instant::now(),
        );
        assert!(controller.is_starting(new));
    }
}
