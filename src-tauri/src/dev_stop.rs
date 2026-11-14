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
static REQUESTED: AtomicBool = AtomicBool::new(false);
static INSTALLED: OnceLock<()> = OnceLock::new();

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

pub(crate) fn install(app: &tauri::AppHandle, host: Host) -> Result<(), &'static str> {
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
        let startup_idle =
            app.state::<AppState>().0.try_lock().is_ok_and(|runtime| {
                runtime.live_start.lab_stop_settled() && runtime.live.is_none()
            });
        if Instant::now() >= deadline {
            emit(run, "failed");
            return;
        }
        if fenced && drained && startup_idle && host.lab_stop_released() {
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
        let mut runtime = crate::Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        let session = runtime.install_live_start(&ticket).unwrap();
        assert!(!runtime.engine.has_processing_permission());
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
}
