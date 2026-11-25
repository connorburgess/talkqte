//! In-app update commands and runtime controller.
//!
//! Enforces `updates.rs` deferral rules in Rust:
//! - Only the `main` notebook window can inspect or trigger updates.
//! - Lab runs never check for or install updates.
//! - Builds without a configured minisign public key report
//!   `"Updates are not configured in this build"` without network calls.
//! - Active live sessions, microphone checks, application audio capture, and
//!   voice dictation defer or refuse all update checks, offers, and installs.

use crate::{
    settings,
    updates::{self, Decision, Deferral, Hold, Offer},
    AppState,
};
use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

pub(crate) const CHANGED: &str = "updates:changed";
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const LAUNCH_CHECK_DELAY: Duration = Duration::from_secs(2);
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(150);

fn main_only<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "Only the notebook can manage updates.".into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Phase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Deferred,
    Downloading,
    Installing,
    Restarting,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HoldReason {
    LiveSession,
    Microphone,
    ApplicationAudio,
    Dictation,
}

impl From<Hold> for HoldReason {
    fn from(hold: Hold) -> Self {
        match hold {
            Hold::LiveSession => Self::LiveSession,
            Hold::Microphone => Self::Microphone,
            Hold::ApplicationAudio => Self::ApplicationAudio,
            Hold::Dictation => Self::Dictation,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvailableOffer {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
}

impl From<&Offer> for AvailableOffer {
    fn from(offer: &Offer) -> Self {
        Self {
            version: offer.version.clone(),
            notes: offer.notes.clone(),
            published: offer.published.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    pub current_version: String,
    pub configured: bool,
    pub check_at_launch: bool,
    pub lab_run: bool,
    pub phase: Phase,
    pub hold: Option<HoldReason>,
    pub available: Option<AvailableOffer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Inner {
    current_version: String,
    configured: bool,
    lab_run: bool,
    phase: Phase,
    last_hold: Option<Hold>,
    deferral: Deferral,
    offered: Option<Offer>,
    pending_update: Option<tauri_plugin_updater::Update>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    error: Option<String>,
    pending_launch_check: bool,
    operation_active: bool,
}

impl Inner {
    fn new(current_version: String, configured: bool, lab_run: bool) -> Self {
        Self {
            current_version,
            configured,
            lab_run,
            phase: Phase::Idle,
            last_hold: None,
            deferral: Deferral::default(),
            offered: None,
            pending_update: None,
            downloaded_bytes: None,
            total_bytes: None,
            error: None,
            pending_launch_check: false,
            operation_active: false,
        }
    }

    fn snapshot(&mut self, hold: Option<Hold>, check_at_launch: bool) -> UpdateStatus {
        self.last_hold = hold;
        let check_at_launch = !self.lab_run && check_at_launch;
        if let Some(active_hold) = hold {
            if let Some(offer) = self.offered.take() {
                let _ = self.deferral.consider(Some(offer), Some(active_hold));
            }
            let phase = if self.deferral.pending().is_some() {
                Phase::Deferred
            } else {
                Phase::Idle
            };
            return UpdateStatus {
                current_version: self.current_version.clone(),
                configured: self.configured,
                check_at_launch,
                lab_run: self.lab_run,
                phase,
                hold: Some(active_hold.into()),
                available: None,
                downloaded_bytes: None,
                total_bytes: None,
                error: None,
            };
        }

        if let Decision::Offer(offer) = self.deferral.released(None) {
            self.offered = Some(offer);
            if matches!(
                self.phase,
                Phase::Idle | Phase::Deferred | Phase::UpToDate | Phase::Error
            ) {
                self.phase = Phase::Available;
            }
        }

        let available = self
            .offered
            .as_ref()
            .or_else(|| self.deferral.pending())
            .map(AvailableOffer::from);
        if available.is_some() && matches!(self.phase, Phase::Deferred) {
            self.phase = Phase::Available;
        }

        UpdateStatus {
            current_version: self.current_version.clone(),
            configured: self.configured,
            check_at_launch,
            lab_run: self.lab_run,
            phase: self.phase,
            hold: None,
            available: if matches!(
                self.phase,
                Phase::Available
                    | Phase::Downloading
                    | Phase::Installing
                    | Phase::Restarting
                    | Phase::Error
            ) {
                available
            } else {
                None
            },
            downloaded_bytes: self.downloaded_bytes,
            total_bytes: self.total_bytes,
            error: self.error.clone(),
        }
    }
}

pub(crate) struct Controller(Mutex<Inner>);

impl Controller {
    pub(crate) fn new(current_version: String, configured: bool, lab_run: bool) -> Self {
        Self(Mutex::new(Inner::new(current_version, configured, lab_run)))
    }

    pub(crate) fn for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Self {
        let config = app.config();
        Self::new(
            app.package_info().version.to_string(),
            updates::is_configured(config),
            settings::lab_run(),
        )
    }

    pub(crate) fn is_configured(&self) -> bool {
        self.0.lock().is_ok_and(|inner| inner.configured)
    }

    pub(crate) fn is_lab_run(&self) -> bool {
        self.0.lock().map_or(true, |inner| inner.lab_run)
    }

    pub(crate) fn status(&self, hold: Option<Hold>, check_at_launch: bool) -> UpdateStatus {
        let Ok(mut inner) = self.0.lock() else {
            return UpdateStatus {
                current_version: env!("CARGO_PKG_VERSION").into(),
                configured: false,
                check_at_launch: false,
                lab_run: false,
                phase: Phase::Error,
                hold: hold.map(Into::into),
                available: None,
                downloaded_bytes: None,
                total_bytes: None,
                error: Some("Updates are unavailable.".into()),
            };
        };
        inner.snapshot(hold, check_at_launch)
    }

    /// Synchronizes hold transitions from the 200ms runtime loop.
    /// Returns an updated status to emit when visibility or hold changed, and
    /// whether a deferred launch check should now run.
    pub(crate) fn sync_hold(
        &self,
        hold: Option<Hold>,
        check_at_launch: bool,
    ) -> (Option<UpdateStatus>, bool) {
        let Ok(mut inner) = self.0.lock() else {
            return (None, false);
        };
        let hold_changed = inner.last_hold != hold;
        let should_launch = hold.is_none()
            && inner.pending_launch_check
            && !inner.operation_active
            && !inner.lab_run
            && inner.configured
            && check_at_launch;
        if should_launch {
            inner.pending_launch_check = false;
        }
        let releasing = hold.is_none()
            && inner.phase == Phase::Deferred
            && (inner.deferral.pending().is_some() || inner.offered.is_some());
        if hold_changed || releasing {
            let status = inner.snapshot(hold, check_at_launch);
            (Some(status), should_launch)
        } else {
            (None, should_launch)
        }
    }
}

pub(crate) fn current_hold<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Hold> {
    let mic = app
        .try_state::<crate::microphone::Controller>()
        .and_then(|c| c.try_status());
    let dictation = app
        .try_state::<crate::dictation::Controller>()
        .is_some_and(|c| c.is_active());
    let Some(state) = app.try_state::<AppState>() else {
        return Some(Hold::LiveSession);
    };
    let Ok(runtime) = state.0.lock() else {
        return Some(Hold::LiveSession);
    };
    runtime.update_hold(mic, dictation)
}

fn saved_check_at_launch<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.try_state::<settings::Store>()
        .is_some_and(|store| store.saved().check_for_updates_at_launch)
}

fn emit_status<R: tauri::Runtime>(app: &tauri::AppHandle<R>, status: &UpdateStatus) {
    let _ = app.emit_to("main", CHANGED, status);
}

pub(crate) fn refresh_with_hold(app: &tauri::AppHandle, hold: Option<Hold>) {
    let Some(controller) = app.try_state::<Controller>() else {
        return;
    };
    let check_at_launch = saved_check_at_launch(app);
    let (emit, trigger_launch) = controller.sync_hold(hold, check_at_launch);
    if let Some(status) = emit {
        emit_status(app, &status);
    }
    if trigger_launch {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = check_updates(&handle, false).await;
        });
    }
}

pub(crate) fn schedule_launch_check(app: &tauri::AppHandle) {
    let Some(controller) = app.try_state::<Controller>() else {
        return;
    };
    if controller.is_lab_run() || !controller.is_configured() || !saved_check_at_launch(app) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        std::thread::sleep(LAUNCH_CHECK_DELAY);
        let _ = check_updates(&handle, false).await;
    });
}

fn offer_from_update(update: &tauri_plugin_updater::Update) -> Offer {
    let published = update
        .raw_json
        .get("pub_date")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    Offer {
        version: update.version.clone(),
        notes: updates::sanitize_notes(update.body.as_deref()),
        published,
        url: update.download_url.to_string(),
        signature: update.signature.clone(),
    }
}

pub(crate) async fn check_updates<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    user_initiated: bool,
) -> Result<UpdateStatus, String> {
    let controller = app
        .try_state::<Controller>()
        .ok_or_else(|| "Updates are unavailable.".to_owned())?;
    if controller.is_lab_run() {
        return Err("Lab runs do not check for updates.".into());
    }
    if !controller.is_configured() {
        return Err(updates::NOT_CONFIGURED_MESSAGE.into());
    }

    let check_at_launch = saved_check_at_launch(app);
    let hold = current_hold(app);
    if let Some(active_hold) = hold {
        if !user_initiated {
            if let Ok(mut inner) = controller.0.lock() {
                inner.pending_launch_check = true;
                let status = inner.snapshot(Some(active_hold), check_at_launch);
                drop(inner);
                emit_status(app, &status);
                return Ok(status);
            }
        }
        return Err("Update paused until this session ends.".into());
    }

    {
        let mut inner = controller
            .0
            .lock()
            .map_err(|_| "Updates are unavailable.".to_owned())?;
        if inner.operation_active {
            return Err("An update check is already running.".into());
        }
        inner.operation_active = true;
        inner.pending_launch_check = false;
        inner.phase = Phase::Checking;
        inner.error = None;
        let status = inner.snapshot(None, check_at_launch);
        drop(inner);
        emit_status(app, &status);
    }

    let mut builder = app.updater_builder().timeout(CHECK_TIMEOUT);
    if let Some(pubkey) = updates::compile_time_pubkey() {
        builder = builder.pubkey(pubkey);
    }
    let result = match builder.build() {
        Ok(updater) => updater.check().await,
        Err(err) => Err(err),
    };

    let hold_after = current_hold(app);
    let check_at_launch = saved_check_at_launch(app);
    let mut inner = controller
        .0
        .lock()
        .map_err(|_| "Updates are unavailable.".to_owned())?;
    inner.operation_active = false;

    let mut return_err: Option<String> = None;
    match result {
        Ok(Some(update)) => {
            let offer = offer_from_update(&update);
            inner.pending_update = Some(update);
            inner.offered = None;
            inner.error = None;
            inner.downloaded_bytes = None;
            inner.total_bytes = None;
            match inner.deferral.consider(Some(offer), hold_after) {
                Decision::Offer(offer) => {
                    inner.offered = Some(offer);
                    inner.phase = Phase::Available;
                }
                Decision::Deferred(_) => inner.phase = Phase::Deferred,
                Decision::None => inner.phase = Phase::UpToDate,
            }
        }
        Ok(None) => {
            inner.pending_update = None;
            inner.offered = None;
            inner.deferral = Deferral::default();
            inner.downloaded_bytes = None;
            inner.total_bytes = None;
            inner.error = None;
            inner.phase = Phase::UpToDate;
        }
        Err(err) => {
            let message = updates::map_updater_error(&err);
            if user_initiated {
                inner.phase = Phase::Error;
                inner.error = Some(message.clone());
                return_err = Some(message);
            } else {
                inner.phase = if inner.deferral.pending().is_some() || inner.offered.is_some() {
                    if hold_after.is_some() {
                        Phase::Deferred
                    } else {
                        Phase::Available
                    }
                } else {
                    Phase::Idle
                };
                inner.error = None;
            }
        }
    }

    let status = inner.snapshot(hold_after, check_at_launch);
    drop(inner);
    emit_status(app, &status);
    if let Some(err) = return_err {
        return Err(err);
    }
    Ok(status)
}

#[tauri::command]
pub(crate) fn update_status<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    controller: tauri::State<Controller>,
) -> Result<UpdateStatus, String> {
    main_only(&window)?;
    let hold = current_hold(&app);
    let check_at_launch = saved_check_at_launch(&app);
    Ok(controller.status(hold, check_at_launch))
}

#[tauri::command]
pub(crate) fn set_check_for_updates_at_launch<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
    store: tauri::State<settings::Store>,
    controller: tauri::State<Controller>,
    enabled: bool,
) -> Result<UpdateStatus, String> {
    main_only(&window)?;
    if controller.is_lab_run() {
        return Err("Lab runs do not save update settings.".into());
    }
    store.record(|settings| settings.check_for_updates_at_launch = enabled);
    let hold = current_hold(&app);
    let status = controller.status(hold, store.saved().check_for_updates_at_launch);
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub(crate) async fn check_for_updates<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<UpdateStatus, String> {
    main_only(&window)?;
    check_updates(&app, true).await
}

#[tauri::command]
pub(crate) async fn download_and_install_update<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    app: tauri::AppHandle<R>,
) -> Result<UpdateStatus, String> {
    main_only(&window)?;
    let controller = app
        .try_state::<Controller>()
        .ok_or_else(|| "Updates are unavailable.".to_owned())?;
    if controller.is_lab_run() {
        return Err("Lab runs do not install updates.".into());
    }
    if !controller.is_configured() {
        return Err(updates::NOT_CONFIGURED_MESSAGE.into());
    }
    if current_hold(&app).is_some() {
        return Err("Update paused until this session ends.".into());
    }

    let update = {
        let mut inner = controller
            .0
            .lock()
            .map_err(|_| "Updates are unavailable.".to_owned())?;
        if inner.operation_active {
            return Err("An update is already in progress.".into());
        }
        let Some(update) = inner.pending_update.clone() else {
            return Err("No update is ready to install.".into());
        };
        inner.operation_active = true;
        inner.phase = Phase::Downloading;
        inner.downloaded_bytes = Some(0);
        inner.total_bytes = None;
        inner.error = None;
        let status = inner.snapshot(None, saved_check_at_launch(&app));
        drop(inner);
        emit_status(&app, &status);
        update
    };

    let progress_app = app.clone();
    let progress_state = Mutex::new((0_u64, Instant::now()));
    let download_result = update
        .download(
            |chunk_length, content_length| {
                let Ok(mut progress) = progress_state.lock() else {
                    return;
                };
                progress.0 = progress.0.saturating_add(chunk_length as u64);
                let downloaded = progress.0;
                let should_emit = progress.1.elapsed() >= PROGRESS_EMIT_INTERVAL;
                if should_emit {
                    progress.1 = Instant::now();
                }
                drop(progress);

                if let Some(ctrl) = progress_app.try_state::<Controller>() {
                    if let Ok(mut inner) = ctrl.0.lock() {
                        inner.downloaded_bytes = Some(downloaded);
                        inner.total_bytes = content_length;
                        if should_emit {
                            let status = inner.snapshot(
                                current_hold(&progress_app),
                                saved_check_at_launch(&progress_app),
                            );
                            drop(inner);
                            emit_status(&progress_app, &status);
                        }
                    }
                }
            },
            || {},
        )
        .await;

    let bytes = match download_result {
        Ok(bytes) => bytes,
        Err(err) => {
            let message = updates::map_updater_error(&err);
            if let Ok(mut inner) = controller.0.lock() {
                inner.operation_active = false;
                inner.phase = Phase::Error;
                inner.downloaded_bytes = None;
                inner.total_bytes = None;
                inner.error = Some(message.clone());
                let status = inner.snapshot(current_hold(&app), saved_check_at_launch(&app));
                drop(inner);
                emit_status(&app, &status);
            }
            return Err(message);
        }
    };

    if let Some(active_hold) = current_hold(&app) {
        if let Ok(mut inner) = controller.0.lock() {
            inner.operation_active = false;
            inner.phase = Phase::Deferred;
            inner.downloaded_bytes = None;
            inner.total_bytes = None;
            inner.error = None;
            let status = inner.snapshot(Some(active_hold), saved_check_at_launch(&app));
            drop(inner);
            emit_status(&app, &status);
        }
        return Err("Update paused until this session ends.".into());
    }

    if let Ok(mut inner) = controller.0.lock() {
        inner.phase = Phase::Installing;
        let status = inner.snapshot(None, saved_check_at_launch(&app));
        drop(inner);
        emit_status(&app, &status);
    }

    let install_result = tauri::async_runtime::spawn_blocking(move || update.install(&bytes))
        .await
        .map_err(|_| "Could not finish installing the update.".to_owned())
        .and_then(|res| res.map_err(|err| updates::map_updater_error(&err)));

    if let Err(message) = install_result {
        if let Ok(mut inner) = controller.0.lock() {
            inner.operation_active = false;
            inner.phase = Phase::Error;
            inner.downloaded_bytes = None;
            inner.total_bytes = None;
            inner.error = Some(message.clone());
            let status = inner.snapshot(current_hold(&app), saved_check_at_launch(&app));
            drop(inner);
            emit_status(&app, &status);
        }
        return Err(message);
    }

    if let Some(active_hold) = current_hold(&app) {
        if let Ok(mut inner) = controller.0.lock() {
            inner.operation_active = false;
            inner.phase = Phase::Deferred;
            let status = inner.snapshot(Some(active_hold), saved_check_at_launch(&app));
            drop(inner);
            emit_status(&app, &status);
        }
        return Err("Update paused until this session ends.".into());
    }

    let final_status = {
        let mut inner = controller
            .0
            .lock()
            .map_err(|_| "Updates are unavailable.".to_owned())?;
        inner.operation_active = false;
        inner.phase = Phase::Restarting;
        inner.snapshot(None, saved_check_at_launch(&app))
    };
    emit_status(&app, &final_status);
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deferred_offer_stays_hidden_while_held_and_releases_when_clear() {
        let controller = Controller::new("0.1.0".into(), true, false);
        let offer = Offer {
            version: "0.2.0".into(),
            notes: Some("Fixes and polish.".into()),
            published: Some("2026-12-01T09:00:00Z".into()),
            url: "https://downloads.example.invalid/TalkQTE.app.tar.gz".into(),
            signature: "sig".into(),
        };
        {
            let mut inner = controller.0.lock().unwrap();
            assert_eq!(
                inner
                    .deferral
                    .consider(Some(offer), Some(Hold::LiveSession)),
                Decision::Deferred(Hold::LiveSession)
            );
            inner.phase = Phase::Deferred;
        }

        // While live session, mic, or dictation holds, the offer stays hidden.
        for hold in [
            Hold::LiveSession,
            Hold::Microphone,
            Hold::ApplicationAudio,
            Hold::Dictation,
        ] {
            let status = controller.status(Some(hold), true);
            assert_eq!(status.phase, Phase::Deferred);
            assert_eq!(status.hold, Some(hold.into()));
            assert_eq!(status.available, None);
        }

        // Once nothing is listening, sync_hold releases the held offer.
        let (emitted, trigger_launch) = controller.sync_hold(None, true);
        assert!(!trigger_launch);
        let released = emitted.expect("releasing should emit status");
        assert_eq!(released.phase, Phase::Available);
        assert_eq!(released.hold, None);
        assert_eq!(
            released.available.as_ref().map(|a| a.version.as_str()),
            Some("0.2.0")
        );

        // Subsequent idle status polls keep showing the released offer.
        let polled = controller.status(None, true);
        assert_eq!(polled.phase, Phase::Available);
        assert_eq!(
            polled.available.as_ref().map(|a| a.version.as_str()),
            Some("0.2.0")
        );

        // Starting another hold hides the offer again until clear.
        let reheld = controller.status(Some(Hold::Dictation), true);
        assert_eq!(reheld.phase, Phase::Deferred);
        assert_eq!(reheld.hold, Some(Hold::Dictation.into()));
        assert_eq!(reheld.available, None);

        let (re_emitted, _) = controller.sync_hold(None, true);
        let re_released = re_emitted.expect("re-releasing should emit status");
        assert_eq!(re_released.phase, Phase::Available);
        assert_eq!(
            re_released.available.as_ref().map(|a| a.version.as_str()),
            Some("0.2.0")
        );
    }

    #[test]
    fn lab_runs_ignore_launch_check_preference() {
        let controller = Controller::new("0.1.0".into(), true, true);
        let status = controller.status(None, true);
        assert!(status.lab_run);
        assert!(!status.check_at_launch);
    }
}
