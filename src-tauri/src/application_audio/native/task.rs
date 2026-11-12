use super::{Control, Driver, Owner, Stage, Status};
use std::sync::{atomic::Ordering, Arc, Mutex};
use std::thread::{self, Thread};
use std::time::Duration;

/// Metadata only. An abandoned task is not proof of native release, even if its
/// last observed stage was Running or Stopping. Stop closes delivery immediately;
/// native cleanup can still be pending. Elapsed time never proves release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TaskSnapshot {
    pub status: Status,
    pub stop_requested: bool,
    pub abandoned: bool,
}

struct State {
    status: Status,
    abandoned: bool,
    retry: bool,
    in_retry: bool,
}

struct Shared {
    control: Option<Control>,
    wake: Thread,
    state: Mutex<State>,
}

impl Shared {
    fn stop(&self) {
        if let Some(control) = &self.control {
            control.0.cancelled.store(true, Ordering::Release);
        }
        self.wake.unpark();
    }
}

/// Sendable host control, with no native objects. Dropping it requests Stop but
/// does not drop or join the owner task. Wrap in Arc if several host users share
/// it: the last handle then requests Stop on drop.
pub struct TaskControl(Arc<Shared>);

impl TaskControl {
    /// Closes delivery without taking the status lock or waiting for the worker.
    pub fn stop(&self) {
        self.0.stop();
    }

    pub fn snapshot(&self) -> TaskSnapshot {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        TaskSnapshot {
            status: state.status,
            stop_requested: self.0.control.as_ref().is_some_and(Control::is_cancelled),
            abandoned: state.abandoned,
        }
    }

    /// Accept at most one explicit retry of an observed, completed cleanup
    /// failure. Requests made before a failure are rejected, never saved for it.
    /// Acceptance does not guarantee recovery: inspect subsequent snapshots.
    pub fn retry_cleanup(&self) -> bool {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.abandoned
            || state.retry
            || state.in_retry
            || !matches!(state.status.stage, Stage::StopFailed | Stage::RemoveFailed)
        {
            return false;
        }
        state.retry = true;
        self.0.wake.unpark();
        true
    }
}

impl Drop for TaskControl {
    fn drop(&mut self) {
        self.stop();
    }
}

// This is the loop for the existing native owner, not another capture driver.
// Generic only so completion-order tests can use the same loop without devices.
pub(super) struct Task<D: Driver> {
    owner: Owner<D>,
    shared: Arc<Shared>,
}

impl<D: Driver> Task<D> {
    pub(super) fn new(owner: Owner<D>) -> (Self, TaskControl) {
        let shared = Arc::new(Shared {
            control: owner
                .resources
                .as_ref()
                .map(|(_, lease)| lease.control.clone()),
            wake: thread::current(),
            state: Mutex::new(State {
                status: owner.status,
                abandoned: false,
                retry: false,
                in_retry: false,
            }),
        });
        (
            Self {
                owner,
                shared: shared.clone(),
            },
            TaskControl(shared),
        )
    }

    pub(super) fn step(&mut self) -> Status {
        let status = self.owner.poll();
        let retry = {
            let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            state.status = status;
            let retry = std::mem::take(&mut state.retry);
            state.in_retry = retry;
            retry
        };
        // Native calls never hold the shared status/command mutex. Keep in_retry
        // set through the call so a stale failed snapshot cannot queue a second.
        if retry {
            self.owner.retry_cleanup();
        }
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.status = self.owner.status;
        state.in_retry = false;
        // A request accepted after the first lock is left for the next pass.
        state.status
    }

    pub(super) fn run(mut self) -> Status {
        loop {
            let status = self.step();
            if status.stage == Stage::Released {
                return status;
            }
            // Native completions publish atomics. Poll even if the source is
            // silent; host Stop/retry unparks early. This is not a latency bound.
            thread::park_timeout(Duration::from_millis(20));
        }
    }
}

impl<D: Driver> Drop for Task<D> {
    fn drop(&mut self) {
        if self.owner.status.stage != Stage::Released {
            self.shared.stop();
            let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
            state.status = self.owner.status;
            state.abandoned = true;
            // Owner::drop subsequently quarantines its resources/reservation.
            // Unwinding cannot masquerade as successful native cleanup.
        }
    }
}
