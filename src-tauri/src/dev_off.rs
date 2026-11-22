//! Withdraw-only development control for one opted-in owned lab process:
//! SIGUSR1 turns cue processing off the way **Disable processing** does.
//! It is accepted only beside the armed SIGUSR2 lab Stop (dev_stop.rs) for
//! the same run. Nothing here starts, restarts or approves anything.
//!
//! Order with the lab Stop: the first off signal and the Stop latch are
//! decided under one shared lock (`dev_stop::order`). If the Stop signal has
//! been received when the off worker takes it, the off writes `failed` and
//! touches nothing. Otherwise it withdraws and writes `done` before the Stop
//! worker can write `latched`. Rows therefore appear in decision order:
//! `dev_off` `latched` and its outcome are never split by `dev_stop`
//! `latched`, and a `done` always precedes the latch.
use crate::{
    timing_log::{self, Event},
    AppState,
};
use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, OnceLock, TryLockError,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

pub(crate) const SIGNAL_ENV: &str = "TALKQTE_DEV_OFF_SIGNAL";
const POLL: Duration = Duration::from_millis(10);
// The withdrawal needs the runtime lock. A holder that does not let go in
// this time leaves processing as it was and reports `failed`, so a stuck
// lock can never hold back the lab Stop behind the shared order lock.
const LOCK_WAIT: Duration = Duration::from_secs(1);
static RECEIVED: AtomicU32 = AtomicU32::new(0);
static INSTALLED: OnceLock<()> = OnceLock::new();

extern "C" fn on_signal(_: libc::c_int) {
    // One lock-free atomic add, as dev_stop's handler. Counting rather than
    // latching lets a second signal be recorded as a no-op.
    RECEIVED.fetch_add(1, Ordering::AcqRel);
}

/// The frozen launch setting. Present only with the armed lab Stop, and
/// only as the exact value `usr1`.
pub(crate) fn settings(value: Option<&str>, stop_armed: bool) -> Result<bool, &'static str> {
    match value {
        None => Ok(false),
        Some(_) if !stop_armed => Err("development off signal requires the armed lab Stop"),
        Some("usr1") => Ok(true),
        Some(_) => Err("invalid development off signal setting"),
    }
}

fn emit(run: &str, step: &'static str) {
    timing_log::record(Event::DevOff {
        run_id: run.into(),
        step,
    });
}

fn install_handler() -> Result<(), &'static str> {
    // Only called during serialized app setup, from dev_stop::install. No
    // other app component uses SIGUSR1; refuse any existing disposition.
    unsafe {
        let mut old: libc::sigaction = std::mem::zeroed();
        if libc::sigaction(libc::SIGUSR1, std::ptr::null(), &mut old) != 0 {
            return Err("cannot inspect development off disposition");
        }
        if old.sa_sigaction != libc::SIG_DFL {
            return Err("development off signal already owned");
        }
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_signal as *const () as libc::sighandler_t;
        libc::sigemptyset(&mut action.sa_mask);
        if libc::sigaction(libc::SIGUSR1, &action, std::ptr::null_mut()) != 0 {
            return Err("cannot install development off handler");
        }
    }
    Ok(())
}

/// One signal's outcome. The first acts once; every later one is recorded
/// and changes nothing.
fn handle(
    first: bool,
    stop_requested: impl FnOnce() -> bool,
    withdraw: impl FnOnce() -> bool,
    mut emit: impl FnMut(&'static str),
) {
    if !first {
        emit("repeated");
        return;
    }
    let _order = crate::dev_stop::order();
    emit("latched");
    // A received Stop wins even before its worker writes `latched`: the off
    // never runs after the Stop has been asked for.
    let done = !stop_requested() && withdraw();
    emit(if done { "done" } else { "failed" });
}

/// The same withdrawal as **Disable processing**, without a notebook scope
/// to compare: only while processing is on, so `done` always means a review
/// was withdrawn. Publishes like the notebook command.
fn withdraw(app: &tauri::AppHandle) -> bool {
    let state = app.state::<AppState>();
    let deadline = Instant::now() + LOCK_WAIT;
    let mut runtime = loop {
        match state.0.try_lock() {
            Ok(runtime) => break runtime,
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(POLL),
            Err(_) => return false,
        }
    };
    let on = runtime.withdraw_processing_for_lab();
    crate::publish(app, &mut runtime);
    drop(runtime);
    crate::companion::refresh(app);
    on
}

/// Starts the worker and installs the handler. Called by dev_stop::install
/// before the run is armed; returns the start the caller sends only after
/// writing `armed`, so no `dev_off` row can precede it.
pub(crate) fn install(app: &tauri::AppHandle, run: &str) -> Result<mpsc::Sender<()>, &'static str> {
    if INSTALLED.set(()).is_err() {
        return Err("development off signal already installed");
    }
    let handle = app.clone();
    let run = run.to_owned();
    let (start, started) = mpsc::channel();
    std::thread::Builder::new()
        .name("talkqte-dev-off".into())
        .spawn(move || {
            if started.recv().is_err() {
                return;
            }
            let mut handled = 0u32;
            loop {
                let received = RECEIVED.load(Ordering::Acquire);
                while handled != received {
                    handle_one(handled == 0, &handle, &run);
                    handled = handled.wrapping_add(1);
                }
                std::thread::sleep(POLL);
            }
        })
        .map_err(|_| "cannot start development off worker")?;
    install_handler()?;
    Ok(start)
}

fn handle_one(first: bool, app: &tauri::AppHandle, run: &str) {
    handle(
        first,
        crate::dev_stop::requested,
        || withdraw(app),
        |step| emit(run, step),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn setting_needs_the_armed_stop_and_the_exact_value() {
        assert_eq!(settings(None, false), Ok(false));
        assert_eq!(settings(None, true), Ok(false));
        assert_eq!(settings(Some("usr1"), true), Ok(true));
        for value in ["usr1", "", "usr2"] {
            assert!(settings(Some(value), false).is_err(), "{value}");
        }
        for value in ["", "usr2", "USR1", "usr1 ", "1"] {
            assert!(settings(Some(value), true).is_err(), "{value}");
        }
    }

    fn run(first: bool, stop: bool, withdrawn: bool) -> (Vec<&'static str>, bool) {
        let mut rows = Vec::new();
        let mut called = false;
        handle(
            first,
            || stop,
            || {
                called = true;
                withdrawn
            },
            |step| rows.push(step),
        );
        (rows, called)
    }

    #[test]
    fn first_signal_withdraws_once_and_later_ones_only_record() {
        assert_eq!(run(true, false, true), (vec!["latched", "done"], true));
        // Nothing to withdraw, or the runtime lock not obtained: no `done`.
        assert_eq!(run(true, false, false), (vec!["latched", "failed"], true));
        assert_eq!(run(false, false, true), (vec!["repeated"], false));
        assert_eq!(run(false, true, true), (vec!["repeated"], false));
    }

    #[test]
    fn a_received_stop_wins_and_nothing_is_touched() {
        assert_eq!(run(true, true, true), (vec!["latched", "failed"], false));
    }

    #[test]
    fn the_stop_latch_waits_for_a_withdrawal_in_progress() {
        // The Stop arrives while the off is withdrawing: its `latched` row
        // follows the off's outcome rather than splitting it.
        let rows = Arc::new(Mutex::new(Vec::new()));
        let (arrived, arrival) = mpsc::channel();
        let stop_rows = rows.clone();
        let stop = std::thread::spawn(move || {
            arrival.recv().unwrap();
            crate::dev_stop::latch(|| stop_rows.lock().unwrap().push("stop latched"));
        });
        let off_rows = rows.clone();
        handle(
            true,
            || false,
            || {
                arrived.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(50));
                true
            },
            |step| off_rows.lock().unwrap().push(step),
        );
        stop.join().unwrap();
        assert_eq!(*rows.lock().unwrap(), ["latched", "done", "stop latched"]);
    }

    #[test]
    fn signal_disposition_and_count_are_isolated() {
        let result = crate::test_isolation::run("dev_off::tests::signal_child", &[], &[]);
        assert!(result.left.is_empty(), "off signal test wrote a file");
    }

    #[test]
    #[ignore = "isolated signal disposition test process"]
    fn signal_child() {
        unsafe {
            libc::signal(libc::SIGUSR1, libc::SIG_IGN);
        }
        assert!(install_handler().is_err());
        let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
        unsafe {
            libc::sigaction(libc::SIGUSR1, std::ptr::null(), &mut current);
        }
        assert_eq!(
            current.sa_sigaction,
            libc::SIG_IGN,
            "refusal changed nothing"
        );
        unsafe {
            libc::signal(libc::SIGUSR1, libc::SIG_DFL);
        }
        install_handler().unwrap();
        assert!(install_handler().is_err(), "a second install is refused");
        assert_eq!(RECEIVED.load(Ordering::Acquire), 0);
        unsafe {
            libc::raise(libc::SIGUSR1);
            libc::raise(libc::SIGUSR1);
        }
        // Each delivered signal is counted, so the second is recorded too;
        // neither touches the lab Stop latch.
        assert_eq!(RECEIVED.load(Ordering::Acquire), 2);
        assert!(!crate::dev_stop::requested());
    }
}
