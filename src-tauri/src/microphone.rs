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

const MAX_METER_SAMPLES: usize = 4_096;
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
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            status: Status::Off,
            can_start: true,
            activity: Activity::Quiet,
            message: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Failure {
    Permission,
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
    }
}

// Retired streams must be released by a worker, never the timer or UI thread.
struct Update {
    snapshot: Snapshot,
    retired: Option<Box<dyn CaptureStream>>,
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
pub struct Controller(Arc<Mutex<State>>);

impl Controller {
    // Timer and window placement must never wait behind native stream startup.
    pub fn try_status(&self) -> Option<Status> {
        self.0.try_lock().ok().map(|state| state.snapshot.status)
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
        state.update(
            Status::Starting,
            Activity::Quiet,
            Some("Checking microphone access…"),
        );
        Ok((state.generation, state.snapshot.clone()))
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
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Microphone controls are unavailable.")?;
        state.generation += 1;
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
        Ok(Update {
            snapshot: state.snapshot.clone(),
            retired,
        })
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
    let controller = state.inner().clone();
    let preparer = controller.clone();
    let (generation, snapshot) =
        tauri::async_runtime::spawn_blocking(move || preparer.begin_start())
            .await
            .map_err(|_| "Could not start the microphone check.")??;
    publish(&app, &snapshot);
    // Only this explicit main-window command can request microphone access.
    // Neither device locks nor authorization callbacks run on the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        if !controller.is_starting(generation) {
            return;
        }
        native::request_permission(move |permission| {
            let controller = controller.clone();
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if !controller.is_starting(generation) {
                    return;
                }
                let meter = Arc::new(Meter::default());
                let stream = permission.and_then(|()| native::build_stream(meter.clone()));
                if let Some(update) =
                    controller.complete_start(generation, meter, stream, Instant::now())
                {
                    publish_and_cleanup(&app, controller, update);
                }
            });
        });
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_microphone(
    app: tauri::AppHandle,
    state: tauri::State<'_, Controller>,
) -> Result<(), String> {
    let controller = state.inner().clone();
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
    use std::sync::atomic::AtomicUsize;

    struct FakeStream {
        starts: Arc<AtomicUsize>,
        drops: Arc<AtomicUsize>,
        fail: bool,
    }
    impl CaptureStream for FakeStream {
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
    fn default_is_off_and_start_does_not_claim_listening_before_samples() {
        let controller = Controller::default();
        assert_eq!(controller.snapshot().unwrap().status, Status::Off);
        controller.begin_start().unwrap();
        assert!(controller.begin_start().is_err());
        assert_eq!(controller.snapshot().unwrap().status, Status::Starting);
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
                .send((reader.try_status(), reader.poll(Instant::now()).is_none()))
                .unwrap();
        });
        let result = read_rx.recv_timeout(Duration::from_secs(1));
        release_tx.send(()).unwrap();
        start.join().unwrap();
        read.join().unwrap();
        assert_eq!(result.unwrap(), (None, true));
        assert_eq!(controller.try_status(), Some(Status::Starting));
        finish(&controller, controller.request_stop().unwrap());
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
    fn stop_releases_capture_and_late_callbacks_cannot_reactivate_it() {
        let (controller, meter, drops, now) = running();
        finish(&controller, controller.request_stop().unwrap());
        assert_eq!(drops.load(Ordering::SeqCst), 1);
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
        assert!(controller.begin_start().is_err());
        finish(&controller, update);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert!(controller.begin_start().is_ok());
    }

    #[test]
    fn device_error_and_missing_callbacks_release_capture() {
        for failed in [false, true] {
            let (controller, meter, drops, now) = running();
            if failed {
                meter.failed.store(true, Ordering::Release);
            }
            let update = controller.poll(now + INPUT_TIMEOUT).unwrap();
            assert_eq!(update.snapshot.status, Status::Error);
            assert_eq!(update.snapshot.activity, Activity::Quiet);
            assert!(!update.snapshot.can_start);
            let error_revision = update.snapshot.revision;
            assert_eq!(drops.load(Ordering::SeqCst), 0);
            drop(update.retired);
            let released = controller.cleanup_finished().unwrap();
            assert_eq!(released.status, Status::Error);
            assert!(released.can_start);
            assert!(released.revision > error_revision);
            assert_eq!(drops.load(Ordering::SeqCst), 1);
            assert!(controller.poll(now + INPUT_TIMEOUT).is_none());
        }
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
