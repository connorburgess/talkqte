//! Stop-only handshake for one explicitly opted-in owned lab process.
//! No source/start/permission command, socket or model dispatch lives here.
use crate::{
    application_audio_host::Host,
    timing_log::{self, Event},
    AppState,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

const SIGNAL_ENV: &str = "TALKQTE_DEV_STOP_SIGNAL";
const RUN_ENV: &str = "TALKQTE_DEV_LAB_RUN_ID";
const POLL: Duration = Duration::from_millis(10);
const RELEASE_WAIT: Duration = Duration::from_secs(5);
static SOURCE_ONLY: AtomicBool = AtomicBool::new(false);
static REQUESTED: AtomicBool = AtomicBool::new(false);
static INSTALLED: OnceLock<()> = OnceLock::new();

pub(crate) fn source_only() -> bool {
    SOURCE_ONLY.load(Ordering::Acquire)
}

#[derive(Default)]
pub(crate) struct Drains {
    pending: std::collections::BTreeMap<u64, bool>,
    uncertain: bool,
}
impl Drains {
    pub(crate) fn begin(&mut self, session: u64, empty: bool) {
        if self.uncertain {
            return;
        }
        if !empty || self.pending.contains_key(&session) || self.pending.len() >= 64 {
            self.uncertain = true;
            return;
        }
        self.pending.insert(session, true);
    }
    pub(crate) fn acknowledge(&mut self, session: u64, empty: bool) {
        if empty && self.pending.get(&session) == Some(&true) {
            self.pending.remove(&session);
        } else {
            self.uncertain = true;
        }
    }
    pub(crate) fn settled(&self) -> bool {
        self.pending.is_empty() && !self.uncertain
    }
}

fn pristine_microphone(generation: u64, snapshot: Option<&crate::microphone::Snapshot>) -> bool {
    generation == 0
        && snapshot.is_some_and(|s| {
            s.revision == 0 && s.status == crate::microphone::Status::Off && s.can_start
        })
}
pub(crate) fn microphone_is_pristine(controller: &crate::microphone::Controller) -> bool {
    let (generation, snapshot) = controller.control_snapshot();
    pristine_microphone(generation, snapshot.as_ref())
}

pub(crate) fn requested() -> bool {
    REQUESTED.load(Ordering::Acquire)
}

extern "C" fn on_signal(_: libc::c_int) {
    // The raw handler does exactly one lock-free atomic store. All ordinary
    // Stop, allocation, event publication and waiting occurs on another thread.
    REQUESTED.store(true, Ordering::Release);
}

fn settings(lookup: impl Fn(&str) -> Option<String>) -> Result<Option<String>, &'static str> {
    let Some(signal) = lookup(SIGNAL_ENV) else {
        return Ok(None);
    };
    if signal != "usr2" {
        return Err("invalid development Stop signal setting");
    }
    let run = lookup(RUN_ENV).ok_or("missing development Stop run identity")?;
    if run.is_empty()
        || run.len() > 64
        || !run
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err("invalid development Stop run identity");
    }
    Ok(Some(run))
}

fn emit(run: &str, step: &'static str) {
    timing_log::record(Event::DevStop {
        run_id: run.into(),
        step,
    });
}

fn install_handler() -> Result<(), &'static str> {
    // Only called during serialized app setup. No other app component uses
    // SIGUSR2. Query first and refuse an existing disposition, including IGN.
    unsafe {
        let mut old: libc::sigaction = std::mem::zeroed();
        if libc::sigaction(libc::SIGUSR2, std::ptr::null(), &mut old) != 0 {
            return Err("cannot inspect development Stop disposition");
        }
        if old.sa_sigaction != libc::SIG_DFL {
            return Err("development Stop signal already owned");
        }
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_signal as *const () as libc::sighandler_t;
        libc::sigemptyset(&mut action.sa_mask);
        if libc::sigaction(libc::SIGUSR2, &action, std::ptr::null_mut()) != 0 {
            return Err("cannot install development Stop handler");
        }
    }
    Ok(())
}

fn supported_source(settings: Option<&crate::application_audio_host::DevSettings>) -> bool {
    settings
        .is_some_and(|s| s.application == "QuickTime Player" && matches!(s.stop_after, Ok(Some(_))))
}

pub(crate) fn install(
    app: &tauri::AppHandle,
    host: Host,
    source: Option<&crate::application_audio_host::DevSettings>,
) -> Result<(), &'static str> {
    let signal_setting =
        std::env::var_os(SIGNAL_ENV).map(|value| value.into_string().unwrap_or_default());
    let run_setting =
        std::env::var_os(RUN_ENV).map(|value| value.into_string().unwrap_or_default());
    let run = match settings(|key| {
        if key == SIGNAL_ENV {
            signal_setting.clone()
        } else {
            run_setting.clone()
        }
    }) {
        Ok(None) => return Ok(()),
        Ok(Some(run)) => run,
        Err(error) => {
            // Never echo a malformed identity, and never reread the environment.
            if let Ok(Some(run)) = settings(|key| {
                if key == SIGNAL_ENV {
                    Some("usr2".into())
                } else {
                    run_setting.clone()
                }
            }) {
                emit(&run, "failed");
            }
            return Err(error);
        }
    };
    let fail = |error| {
        emit(&run, "failed");
        error
    };
    if !timing_log::enabled() {
        return Err(fail("development Stop requires its private timing channel"));
    }
    // Freeze source-only admission before inspecting state. Any concurrent
    // microphone reservation must fail its existing second admission check.
    SOURCE_ONLY.store(true, Ordering::Release);
    if !supported_source(source) {
        return Err(fail(
            "development Stop requires the exact QuickTime source and finite ordinary Stop guard",
        ));
    }
    if !microphone_is_pristine(&app.state::<crate::microphone::Controller>()) {
        return Err(fail(
            "development Stop requires a pristine unused microphone",
        ));
    }
    let idle = app.state::<AppState>().0.try_lock().is_ok_and(|runtime| {
        runtime.live.is_none()
            && runtime.live_start.lab_stop_settled()
            && runtime.lab_stop_drains.settled()
    });
    if !idle {
        return Err(fail(
            "development Stop requires settled initial source ownership",
        ));
    }
    if INSTALLED.set(()).is_err() {
        return Err(fail("development Stop already installed"));
    }
    let handle = app.clone();
    let worker_run = run.clone();
    let (ready, start) = mpsc::channel();
    std::thread::Builder::new()
        .name("talkqte-dev-stop".into())
        .spawn(move || {
            if start.recv().is_err() {
                return;
            }
            while !requested() {
                std::thread::sleep(POLL);
            }
            emit(&worker_run, "latched");
            crate::lab_evaluator::cancel_active(crate::lab_evaluator::ControlReason::Stop);
            emit(&worker_run, "stopping");
            stop_owned(&handle, &host, &worker_run);
        })
        .map_err(|_| fail("cannot start development Stop worker"))?;
    install_handler().map_err(fail)?;
    ready
        .send(())
        .map_err(|_| fail("development Stop worker unavailable"))?;
    // Called before the host can spawn the source autostart thread. The owner
    // must observe this exact-run event before sending SIGUSR2.
    emit(&run, "armed");
    Ok(())
}

fn stop_owned(app: &tauri::AppHandle, host: &Host, run: &str) {
    let handle = app.clone();
    let owned_host = host.clone();
    let (admitted, admission) = mpsc::channel();
    let (done, completion) = mpsc::channel();
    // All possibly waiting ordinary Stop work runs separately from the
    // deadline observer. A timed-out cleanup can continue, but never emits a
    // later released event or turns timeout into proof of release.
    if std::thread::Builder::new()
        .name("talkqte-dev-stop-drain".into())
        .spawn(move || {
            let Ok(fence) = owned_host.close_for_lab_stop() else {
                let _ = done.send(false);
                return;
            };
            let _ = admitted.send(fence);
            let state = handle.state::<AppState>();
            let live = match state.0.lock() {
                Ok(mut runtime) => {
                    let live = runtime.take_live_for_stop();
                    crate::publish(&handle, &mut runtime);
                    live
                }
                Err(_) => {
                    let _ = done.send(false);
                    return;
                }
            };
            if let Some(live) = live {
                crate::finish_live(&handle, live, true);
            }
            let _ = done.send(true);
        })
        .is_err()
    {
        emit(run, "failed");
        return;
    }
    let deadline = Instant::now() + RELEASE_WAIT;
    let mut fence = None;
    let mut fenced = false;
    let mut drained = false;
    loop {
        if fence.is_none() {
            match admission.try_recv() {
                Ok(value) => fence = Some(value),
                Err(mpsc::TryRecvError::Disconnected) => {
                    emit(run, "failed");
                    return;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if let Some(fence) = fence.as_ref().filter(|_| !fenced) {
            match fence.try_recv() {
                Ok(()) => fenced = true,
                Err(mpsc::TryRecvError::Disconnected) => {
                    emit(run, "failed");
                    return;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if !drained {
            match completion.try_recv() {
                Ok(true) => drained = true,
                Ok(false) | Err(mpsc::TryRecvError::Disconnected) => {
                    emit(run, "failed");
                    return;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        let startup_idle = app.state::<AppState>().0.try_lock().is_ok_and(|runtime| {
            runtime.live_start.lab_stop_settled()
                && runtime.live.is_none()
                && runtime.lab_stop_drains.settled()
        });
        if Instant::now() >= deadline {
            emit(run, "failed");
            return;
        }
        if fenced
            && drained
            && startup_idle
            && microphone_is_pristine(&app.state::<crate::microphone::Controller>())
            && host.lab_stop_released()
        {
            emit(run, "released");
            return;
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frozen_opt_in_and_opaque_identity_are_required() {
        assert_eq!(settings(|_| None), Ok(None));
        for run in ["", "fictional/path", "private words", &"x".repeat(65)] {
            assert!(
                settings(|key| Some(if key == SIGNAL_ENV { "usr2" } else { run }.into())).is_err()
            );
        }
        assert_eq!(
            settings(|key| Some(
                if key == SIGNAL_ENV {
                    "usr2"
                } else {
                    "fictional-run_1"
                }
                .into()
            )),
            Ok(Some("fictional-run_1".into()))
        );
        assert!(settings(|_| Some("invalid".into())).is_err());
    }
    #[test]
    fn arming_requires_the_exact_frozen_source_and_finite_guard() {
        use crate::application_audio_host::DevSettings;
        assert!(!supported_source(None));
        for application in ["QuickTime Player", "fictional-other-player"] {
            for stop_after in [Ok(None), Err(()), Ok(Some(Duration::from_secs(1)))] {
                let settings = DevSettings {
                    application: application.into(),
                    stop_after,
                };
                assert_eq!(
                    supported_source(Some(&settings)),
                    application == "QuickTime Player" && matches!(settings.stop_after, Ok(Some(_)))
                );
            }
        }
    }
    #[test]
    fn signal_disposition_and_sticky_latch_are_isolated() {
        let result = crate::test_isolation::run(
            "dev_stop::tests::signal_child",
            &[
                ("TALKQTE_DEV_CUE_BACKEND", "lab-subscription"),
                ("TALKQTE_DEV_LAB_PROVIDER", "codex"),
                ("TALKQTE_DEV_LAB_MODEL", "gpt-6.1-sol"),
                ("TALKQTE_DEV_LAB_EFFORT", "medium"),
                (
                    "TALKQTE_DEV_LAB_DESCRIPTOR",
                    "/fictional-lab/never-opened/descriptor.json",
                ),
            ],
            &[],
        );
        assert!(result.left.is_empty(), "pre-auth Stop wrote a file");
    }
    #[test]
    #[ignore = "isolated signal disposition test process"]
    fn signal_child() {
        unsafe {
            libc::signal(libc::SIGUSR2, libc::SIG_IGN);
        }
        assert!(install_handler().is_err());
        let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
        unsafe {
            libc::sigaction(libc::SIGUSR2, std::ptr::null(), &mut current);
        }
        assert_eq!(current.sa_sigaction, libc::SIG_IGN);
        unsafe {
            libc::signal(libc::SIGUSR2, libc::SIG_DFL);
        }
        install_handler().unwrap();
        crate::lab_evaluator::initialize_from_environment();
        SOURCE_ONLY.store(true, Ordering::Release);
        let mut runtime = crate::Runtime::default();
        assert!(!runtime.microphone_may_start());
        let ticket = runtime.begin_live_start().unwrap();
        let session = runtime.install_live_start(&ticket).unwrap();
        assert!(!runtime.engine.has_processing_permission());
        assert!(!runtime.reserve_live_microphone(&ticket.guard(), session, 7));
        assert!(!runtime.live_start.lab_stop_settled());
        assert!(!requested());
        unsafe {
            libc::raise(libc::SIGUSR2);
            libc::raise(libc::SIGUSR2);
        }
        assert!(requested());
        assert!(!runtime.reserve_live_microphone(&ticket.guard(), session, 7));
        crate::lab_evaluator::cancel_active(crate::lab_evaluator::ControlReason::Stop);
        drop(runtime.take_live_for_stop());
        assert!(
            !runtime.live_start.lab_stop_settled(),
            "cancelled loading must settle"
        );
        assert!(runtime.install_live_start(&ticket).is_err());
        drop(ticket);
        assert!(runtime.live_start.lab_stop_settled());
        runtime.engine.finish_live_stop(session);
        assert!(runtime.begin_live_start().is_err());
        assert!(crate::Runtime::default().begin_live_start().is_err());
    }
    #[test]
    fn overlapping_stop_and_replacement_keep_exact_earlier_drain_pending() {
        let mut runtime = crate::Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        runtime.install_live_start(&ticket).unwrap();
        drop(ticket);
        let first = runtime.take_live_for_stop().unwrap();
        assert!(runtime.live.is_none());
        assert!(!runtime.lab_stop_drains.settled());
        assert!(runtime.take_live_for_stop().is_none());
        assert!(
            !runtime.lab_stop_drains.settled(),
            "a later Stop owns no earlier handle"
        );
        runtime.engine.finish_live_stop(first.session);
        let next = runtime.begin_live_start().unwrap();
        runtime.install_live_start(&next).unwrap();
        drop(next);
        let second = runtime.take_live_for_stop().unwrap();
        let runtime = std::sync::Arc::new(std::sync::Mutex::new(runtime));
        let owned = runtime.clone();
        let (release, wait) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            wait.recv().unwrap();
            owned
                .lock()
                .unwrap()
                .lab_stop_drains
                .acknowledge(first.session, true);
            drop(first);
        });
        assert!(!runtime.lock().unwrap().lab_stop_drains.settled());
        release.send(()).unwrap();
        worker.join().unwrap();
        let mut runtime = runtime.lock().unwrap();
        assert!(
            !runtime.lab_stop_drains.settled(),
            "earlier completion cannot acknowledge replacement"
        );
        runtime.lab_stop_drains.acknowledge(second.session, true);
        drop(second);
        assert!(runtime.lab_stop_drains.settled());
    }

    #[test]
    fn unsupported_and_unknown_drain_ownership_never_becomes_release() {
        let mut runtime = crate::Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        let session = runtime.install_live_start(&ticket).unwrap();
        drop(ticket);
        runtime.live.as_mut().unwrap().microphone = Some(7);
        let mut live = runtime.take_live_for_stop().unwrap();
        live.microphone = None; // As an ordinary Stop plan can do after requesting teardown.
        runtime.lab_stop_drains.acknowledge(session, true);
        drop(live);
        assert!(
            !runtime.lab_stop_drains.settled(),
            "erasing a generation cannot erase unsupported ownership"
        );
        let mut drains = Drains::default();
        drains.acknowledge(99, true);
        assert!(
            !drains.settled(),
            "an unknown handle cannot manufacture proof"
        );
    }
}
