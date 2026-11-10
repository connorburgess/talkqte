//! Main-window processing authority. These commands neither construct an
//! evaluator nor start/stop capture. The control surface remains test-mounted.
use crate::{
    engine::{self, ProcessingError},
    AppState, Runtime,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExpectedScope {
    pub session: String,
    pub scope_revision: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Error {
    Unavailable,
    ScopeChanged,
    InvalidScope,
    SessionInactive,
}

impl From<ProcessingError> for Error {
    fn from(error: ProcessingError) -> Self {
        match error {
            ProcessingError::Unavailable => Self::Unavailable,
            ProcessingError::StaleReview => Self::ScopeChanged,
            ProcessingError::InvalidScope => Self::InvalidScope,
            ProcessingError::SessionInactive => Self::SessionInactive,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Review {
    pub id: String,
    pub session: String,
    pub scope_revision: u64,
    pub processor: engine::ProcessorSummary,
    pub scope: engine::Scope,
    pub notes: Vec<engine::NoteSummary>,
}

impl Runtime {
    fn require_processing_scope(&self, expected: &ExpectedScope) -> Result<(), Error> {
        if self.processing_status.scope_is_current(
            &self.engine,
            &expected.session,
            expected.scope_revision,
        ) {
            Ok(())
        } else {
            Err(Error::ScopeChanged)
        }
    }

    pub(crate) fn review_processing_scope(
        &mut self,
        expected: &ExpectedScope,
        scope: engine::Scope,
    ) -> Result<Review, Error> {
        self.require_processing_scope(expected)?;
        if scope.notes.len() > crate::context::MAX_ITEMS {
            return Err(Error::InvalidScope);
        }
        let selections: Vec<_> = scope
            .notes
            .iter()
            .map(|n| (n.provider, n.source_id.clone(), n.revision))
            .collect();
        let id = self
            .processing_reviews
            .prepare(&self.engine, scope.conversation, &selections)?;
        // The guard and prepare do not change the scope. This projection and
        // the opaque review therefore describe the same native state, under
        // the same Runtime lock, without trusting frontend disclosure strings.
        let snapshot = self
            .engine
            .processing_snapshot(engine::CaptureState::Unknown, expected.scope_revision);
        Ok(Review {
            id,
            session: snapshot.session,
            scope_revision: snapshot.scope_revision,
            processor: snapshot.processor.ok_or(Error::Unavailable)?,
            notes: snapshot
                .notes
                .into_iter()
                .filter(|n| scope.notes.contains(&n.source))
                .collect(),
            scope,
        })
    }

    pub(crate) fn approve_processing_scope(&mut self, id: &str) -> Result<(), Error> {
        validate_id(id)?;
        self.processing_reviews.approve(&mut self.engine, id)?;
        Ok(())
    }

    pub(crate) fn cancel_processing_review(&mut self, id: &str) -> Result<(), Error> {
        validate_id(id)?;
        self.processing_reviews.cancel(id);
        Ok(())
    }

    pub(crate) fn disable_processing(&mut self, expected: &ExpectedScope) -> Result<(), Error> {
        self.require_processing_scope(expected)?;
        self.processing_reviews.clear();
        self.engine.revoke_processing();
        Ok(())
    }

    pub(crate) fn pause_processing(
        &mut self,
        expected: &ExpectedScope,
        paused: bool,
    ) -> Result<(), Error> {
        self.require_processing_scope(expected)?;
        if !self.engine.has_processing_permission() {
            return Err(Error::SessionInactive);
        }
        self.engine
            .set_live_cues_paused(paused)
            .map_err(|_| Error::SessionInactive)?;
        self.processing_reviews.reconcile(&self.engine);
        Ok(())
    }
}

fn validate_id(id: &str) -> Result<(), Error> {
    if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(Error::ScopeChanged)
    }
}

fn change<T>(
    window: &tauri::WebviewWindow,
    app: &tauri::AppHandle,
    state: &tauri::State<AppState>,
    action: impl FnOnce(&mut Runtime) -> Result<T, Error>,
) -> Result<T, Error> {
    if window.label() != "main" {
        return Err(Error::Unavailable);
    }
    let mut runtime = state.0.lock().map_err(|_| Error::Unavailable)?;
    runtime.sync();
    let result = action(&mut runtime);
    let Runtime {
        engine,
        processing_reviews,
        ..
    } = &mut *runtime;
    processing_reviews.reconcile(engine);
    // Publish even on rejection so a caller can recover from changed sources
    // without automatically retrying an approval or control mutation.
    crate::publish(app, &mut runtime);
    drop(runtime);
    crate::companion::refresh(app);
    result
}

#[tauri::command]
pub(crate) fn review_processing_scope(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    expected: ExpectedScope,
    scope: engine::Scope,
) -> Result<Review, Error> {
    change(&window, &app, &state, |r| {
        r.review_processing_scope(&expected, scope)
    })
}

#[tauri::command]
pub(crate) fn approve_processing_scope(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    id: String,
) -> Result<(), Error> {
    change(&window, &app, &state, |r| r.approve_processing_scope(&id))
}

#[tauri::command]
pub(crate) fn cancel_processing_review(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    id: String,
) -> Result<(), Error> {
    change(&window, &app, &state, |r| r.cancel_processing_review(&id))
}

#[tauri::command]
pub(crate) fn revoke_processing(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    expected: ExpectedScope,
) -> Result<(), Error> {
    change(&window, &app, &state, |r| r.disable_processing(&expected))
}

#[tauri::command]
pub(crate) fn set_processing_paused(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    expected: ExpectedScope,
    paused: bool,
) -> Result<(), Error> {
    change(&window, &app, &state, |r| {
        r.pause_processing(&expected, paused)
    })
}
