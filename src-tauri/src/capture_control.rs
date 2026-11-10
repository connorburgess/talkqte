//! Stop authority is independent of source/processing permissions. It follows
//! one live startup through capture, plus one exact microphone generation.
use crate::{engine::StopTarget, AppState, Live, Runtime};
use serde::Serialize;
use tauri::Manager;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Error {
    Unavailable,
    CaptureChanged,
}

pub(crate) struct StopPlan {
    pub live: Option<Live>,
    pub microphone: u64,
}

impl Runtime {
    pub(crate) fn prepare_capture_stop(&mut self, target: &StopTarget) -> Result<StopPlan, Error> {
        let microphone = target
            .microphone
            .parse::<u64>()
            .map_err(|_| Error::CaptureChanged)?;
        if target.microphone != microphone.to_string()
            || target
                .operation
                .as_ref()
                .is_some_and(|id| id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(Error::CaptureChanged);
        }
        let (operation, _) = self.live_start.control().map_err(|_| Error::Unavailable)?;
        if operation != target.operation
            || self
                .live
                .as_ref()
                .is_some_and(|live| live.operation != operation)
        {
            return Err(Error::CaptureChanged);
        }
        self.live_start.cancel();
        // Taking a live session revokes processing before any transcript drain.
        // No live handle means standalone monitoring or a cancelled model load;
        // neither may mutate an unrelated demo/engine or its processing review.
        let live = if self.live.is_some() {
            self.take_live_for_stop()
        } else {
            None
        };
        let microphone = live
            .as_ref()
            .and_then(|live| live.microphone)
            .unwrap_or(microphone);
        Ok(StopPlan { live, microphone })
    }
}

#[tauri::command]
pub(crate) async fn stop_capture(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    target: StopTarget,
) -> Result<(), Error> {
    if window.label() != "main" {
        return Err(Error::Unavailable);
    }
    let plan = {
        let mut runtime = state.0.lock().map_err(|_| Error::Unavailable)?;
        runtime.sync();
        let plan = runtime.prepare_capture_stop(&target);
        crate::publish(&app, &mut runtime);
        plan?
    };
    crate::companion::refresh(&app);
    // Device work and transcript delivery must never hold Runtime. The exact
    // generation is checked again by the adapter after this async boundary.
    tauri::async_runtime::spawn_blocking(move || {
        let controller = app.state::<crate::microphone::Controller>().inner().clone();
        let requested = crate::microphone::stop_exact(&app, controller, plan.microphone);
        if let Some(mut live) = plan.live {
            live.microphone = None; // This request already attempted its release.
            crate::finish_live(&app, live, true);
        }
        requested.map_err(|_| Error::Unavailable)
    })
    .await
    .map_err(|_| Error::Unavailable)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{CaptureState, StartupState};
    use std::{sync::mpsc, thread, time::Duration};

    fn target(runtime: &Runtime, microphone: u64) -> StopTarget {
        StopTarget {
            operation: runtime.live_start.control().unwrap().0,
            microphone: microphone.to_string(),
        }
    }

    #[test]
    fn scoped_stop_cancels_a_gated_loader_and_old_request_cannot_cancel_retry() {
        let mut runtime = Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        let old = target(&runtime, 0);
        let (entered_tx, entered) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            ticket.load(|| {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(()) // Synthetic loader; never opens a device or model.
            })
        });
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(runtime.prepare_capture_stop(&old).unwrap().live.is_none());
        assert!(runtime.prepare_capture_stop(&old).unwrap().live.is_none());
        assert_eq!(
            runtime.live_start.control().unwrap().1,
            StartupState::Cancelling
        );
        assert!(runtime.begin_live_start().is_err());
        release.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert_eq!(runtime.live_start.control().unwrap().1, StartupState::Idle);
        let retry = runtime.begin_live_start().unwrap();
        assert!(matches!(
            runtime.prepare_capture_stop(&old),
            Err(Error::CaptureChanged)
        ));
        assert!(runtime.install_live_start(&retry).is_ok());
    }

    #[test]
    fn startup_target_survives_install_capture_and_note_changes_without_reaching_next_session() {
        let mut runtime = Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        let early = target(&runtime, 0);
        let session = runtime.install_live_start(&ticket).unwrap();
        assert!(runtime.reserve_live_microphone(&ticket.guard(), session, 17));
        drop(ticket);
        runtime
            .engine
            .update_notes("Fictional manual note.".into())
            .unwrap();
        runtime.engine.set_notes(vec![crate::context::ContextItem {
            provider: crate::context::Provider::File,
            source_id: "garden".into(),
            revision: 2,
            title: "Fictional garden plan".into(),
            source_date: "2026-11-01".into(),
            excerpt: "The guide needs two days of review.".into(),
        }]);
        let stopped = runtime.prepare_capture_stop(&early).unwrap();
        assert_eq!(stopped.microphone, 17);
        assert_eq!(stopped.live.unwrap().session, session);
        assert!(runtime.engine.is_live_stopping());
        assert!(runtime.prepare_capture_stop(&early).unwrap().live.is_none());
        runtime.engine.finish_live_stop(session);
        let next = runtime.begin_live_start().unwrap();
        let current = runtime.install_live_start(&next).unwrap();
        assert!(runtime.reserve_live_microphone(&next.guard(), current, 20));
        assert!(matches!(
            runtime.prepare_capture_stop(&early),
            Err(Error::CaptureChanged)
        ));
        runtime.engine.finish_live_stop(session);
        assert_eq!(runtime.live.as_ref().unwrap().microphone, Some(20));
        assert!(!runtime.engine.is_live_stopping());
    }

    #[test]
    fn malformed_and_foreign_stop_targets_do_not_cancel_the_current_start() {
        let mut runtime = Runtime::default();
        let ticket = runtime.begin_live_start().unwrap();
        let valid = target(&runtime, 0);
        for microphone in ["", "-1", "01", "18446744073709551616"] {
            let mut bad = valid.clone();
            bad.microphone = microphone.into();
            assert!(matches!(
                runtime.prepare_capture_stop(&bad),
                Err(Error::CaptureChanged)
            ));
        }
        let mut foreign = Runtime::default();
        let _other = foreign.begin_live_start().unwrap();
        assert!(matches!(
            runtime.prepare_capture_stop(&target(&foreign, 0)),
            Err(Error::CaptureChanged)
        ));
        assert!(runtime.install_live_start(&ticket).is_ok());
        assert!(serde_json::from_value::<StopTarget>(
            serde_json::json!({"operation":null,"microphone":"0","scopeRevision":1})
        )
        .is_err());
    }

    #[test]
    fn standalone_stop_does_not_end_an_independent_demo_and_retains_exact_microphone() {
        let mut runtime = Runtime::default();
        runtime.engine.start().unwrap();
        let session = runtime.engine.session();
        let plan = runtime.prepare_capture_stop(&target(&runtime, 8)).unwrap();
        assert!(plan.live.is_none());
        assert_eq!(plan.microphone, 8);
        assert_eq!(runtime.engine.session(), session);
        assert_eq!(runtime.engine.state.status, crate::engine::Status::Running);
    }

    #[test]
    fn capture_authority_and_startup_events_advance_without_changing_permission_scope() {
        let mut runtime = Runtime::default();
        let initial = target(&runtime, 0);
        let (before, _) = runtime.processing_status.update_with_capture_control(
            &runtime.engine,
            CaptureState::Off,
            initial,
            StartupState::Idle,
        );
        let ticket = runtime.begin_live_start().unwrap();
        let pending = target(&runtime, 0);
        let (loading, changed) = runtime.processing_status.update_with_capture_control(
            &runtime.engine,
            CaptureState::Off,
            pending.clone(),
            StartupState::Loading,
        );
        assert!(changed);
        assert_eq!(before.scope_revision, loading.scope_revision);
        assert!(loading.revision > before.revision);
        assert_eq!(loading.capture, CaptureState::Off);
        assert_eq!(loading.startup, StartupState::Loading);
        runtime.prepare_capture_stop(&pending).unwrap();
        let (cancelled, changed) = runtime.processing_status.update_with_capture_control(
            &runtime.engine,
            CaptureState::Off,
            pending,
            runtime.live_start.control().unwrap().1,
        );
        assert!(changed);
        assert!(cancelled.revision > loading.revision);
        assert_eq!(cancelled.startup, StartupState::Cancelling);
        assert_eq!(cancelled.scope_revision, before.scope_revision);
        drop(ticket);
    }
}
