//! In-memory permission only. Configurations come from trusted Rust adapter
//! registration, never an executable, URL or credential supplied by a webview.
use super::*;
use sha2::{Digest, Sha256};
use std::{fmt, sync::Arc};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProcessingLocation {
    OnDevice,
    Hosted { service: String },
}

/// Bounded display text supplied by trusted native adapter registration. It
/// describes the adapter's declared policy, not independent verification of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessorDisclosure {
    pub(super) name: String,
    pub(super) data_policy: String,
}

impl ProcessorDisclosure {
    pub fn new(name: String, data_policy: String) -> Result<Self, ProcessingError> {
        if !valid_label(&name, 256) || !valid_label(&data_policy, 2_048) {
            return Err(ProcessingError::InvalidScope);
        }
        Ok(Self { name, data_policy })
    }
}

fn valid_label(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

/// Identifies the complete reviewed adapter configuration. This is not a
/// provider implementation or proof of its declared data-handling policy.
/// Deliberately not deserializable from IPC.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessorConfiguration {
    pub(super) id: String,
    pub(super) revision: u64,
    pub(super) model: String,
    pub(super) location: ProcessingLocation,
    policy_revision: String,
    pub(super) disclosure: ProcessorDisclosure,
    /// The effort asked of the model, for the development timing log.
    effort: Option<String>,
    /// Whether this backend may be sent approved prior notes.
    pub(super) accepts_notes: bool,
    /// Where the session's audio goes for transcription once this review is
    /// approved, when a cloud transcription service is selected. Part of the
    /// reviewed configuration, so the review names it as a destination.
    pub(super) audio_destination: Option<String>,
    /// Opt-in transcript-only projection, bound to this reviewed configuration.
    pub(super) bounded_history: bool,
}

impl ProcessorConfiguration {
    pub fn new(
        id: String,
        revision: u64,
        model: String,
        location: ProcessingLocation,
        policy_revision: String,
        disclosure: ProcessorDisclosure,
    ) -> Result<Self, ProcessingError> {
        let valid = |s: &str| valid_label(s, 256);
        if !valid(&id)
            || !valid(&model)
            || !valid(&policy_revision)
            || matches!(&location, ProcessingLocation::Hosted { service } if !valid(service))
        {
            return Err(ProcessingError::InvalidScope);
        }
        Ok(Self {
            id,
            revision,
            model,
            location,
            policy_revision,
            disclosure,
            effort: None,
            accepts_notes: true,
            audio_destination: None,
            bounded_history: false,
        })
    }

    /// A backend that is never sent prior notes: a review that selects one
    /// is refused, so the review cannot say a note will be sent.
    pub fn without_notes(mut self) -> Self {
        self.accepts_notes = false;
        self
    }

    /// Opt into bounded transcript history for a transcript-only adapter.
    /// This changes the complete reviewed configuration and its disclosure;
    /// existing grants/reviews cannot authorize it. No app flag calls this.
    pub fn with_bounded_transcript_history(mut self) -> Result<Self, ProcessingError> {
        const DISCLOSURE: &str = " Transcript context: up to 24 segments from the last 90 seconds, subject to a 16384-byte serialized input limit and the approved speech scope. Visible cue evidence may be older. No prior notes.";
        if !self.bounded_history {
            self.disclosure.data_policy.push_str(DISCLOSURE);
        }
        if !valid_label(&self.disclosure.data_policy, 2_048) {
            return Err(ProcessingError::InvalidScope);
        }
        self.bounded_history = true;
        self.accepts_notes = false;
        Ok(self)
    }

    /// Names the service the session's audio is sent to for transcription
    /// once this processor's review is approved.
    pub fn with_audio_destination(mut self, destination: String) -> Self {
        self.audio_destination = Some(destination);
        self
    }

    /// Names the effort a model backend asks for, so the development log
    /// can say which settings a run used.
    pub fn with_effort(mut self, effort: String) -> Self {
        self.effort = Some(effort);
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConversationScope {
    NewSpeechOnly,
    RecentAndNewSpeech,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessingError {
    Unavailable,
    SessionInactive,
    InvalidScope,
    StaleReview,
}

/// Opaque, single-use review. Note fingerprints bind exact content and metadata
/// without retaining another excerpt copy in an outstanding review. Neither
/// this token nor a grant is persisted or serialized.
pub struct ProcessingReview {
    owner: Arc<()>,
    session: u64,
    generation: u64,
    processor: ProcessorConfiguration,
    conversation: ConversationScope,
    notes: Vec<[u8; 32]>,
}

impl fmt::Debug for ProcessingReview {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProcessingReview").finish_non_exhaustive()
    }
}

pub(super) struct Permission {
    pub(super) processor: ProcessorConfiguration,
    owner: Arc<()>,
    pub(super) generation: u64,
    pub(super) grant: Option<Grant>,
}

pub(super) struct Grant {
    session: u64,
    /// The session time the grant was made. Cloud transcription never sends
    /// audio captured before it.
    approved_at_ms: u64,
    processor: ProcessorConfiguration,
    pub(super) after_ms: Option<u64>,
    pub(super) notes: Vec<Source>,
}

impl Permission {
    pub(super) fn new(processor: ProcessorConfiguration) -> Self {
        Self {
            processor,
            owner: Arc::new(()),
            generation: 0,
            grant: None,
        }
    }

    pub(super) fn revoke(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("permission generation exhausted");
        self.grant = None;
    }

    pub(super) fn valid(&self, session: u64, notes: &[NoteTerms]) -> bool {
        self.grant.as_ref().is_some_and(|grant| {
            grant.session == session
                && grant.processor == self.processor
                && notes_match(&grant.notes, notes)
        })
    }
}

fn notes_match(approved: &[Source], notes: &[NoteTerms]) -> bool {
    approved
        .iter()
        .all(|source| notes.iter().any(|note| matches_note(&note.item, source)))
}

fn fingerprint(source: &Source) -> [u8; 32] {
    // Source contains only serializable strings, integers and tagged enums.
    Sha256::digest(serde_json::to_vec(source).expect("source serialization")).into()
}

// Recomputed only when the validated context changes, never on every native
// clock/status poll. Order alone is not a different processing scope.
pub(in crate::engine) fn context_fingerprint(notes: &[NoteTerms]) -> [u8; 32] {
    let mut fingerprints: Vec<_> = notes
        .iter()
        .map(|note| fingerprint(&note_source(&note.item)))
        .collect();
    fingerprints.sort_unstable();
    Sha256::digest(fingerprints.concat()).into()
}

impl Engine {
    /// Prepare exact sources from the current selected store. Unknown IDs,
    /// revisions, duplicates and oversized scope fail as a whole, never a
    /// partial grant. An imported note is not automatically approved here.
    pub fn review_processing(
        &self,
        conversation: ConversationScope,
        notes: &[(crate::context::Provider, String, u64)],
    ) -> Result<ProcessingReview, ProcessingError> {
        let state = self
            .evaluation
            .as_ref()
            .ok_or(ProcessingError::Unavailable)?;
        if !self.state.live
            || self.state.status != Status::Running
            || self.state.cues_paused
            || self.live_stopping
        {
            return Err(ProcessingError::SessionInactive);
        }
        if state.misconfigured || state.lab_terminal || self.model_calls_exhausted() {
            return Err(ProcessingError::Unavailable);
        }
        if notes.len() > crate::context::MAX_ITEMS
            || (!notes.is_empty() && !state.permission.processor.accepts_notes)
        {
            return Err(ProcessingError::InvalidScope);
        }
        let mut sources = Vec::new();
        for (provider, id, revision) in notes {
            let note = self
                .notes
                .iter()
                .find(|note| {
                    note.item.provider == *provider
                        && note.item.source_id == *id
                        && note.item.revision == *revision
                })
                .ok_or(ProcessingError::InvalidScope)?;
            sources.push(note_source(&note.item));
        }
        if !sources.is_empty() {
            Request::new(self.generation, 0, sources.clone(), None)
                .map_err(|_| ProcessingError::InvalidScope)?;
        }
        Ok(ProcessingReview {
            owner: Arc::clone(&state.permission.owner),
            session: self.generation,
            generation: state.permission.generation,
            processor: state.permission.processor.clone(),
            conversation,
            notes: sources.iter().map(fingerprint).collect(),
        })
    }

    fn reviewed_sources(&self, review: &ProcessingReview) -> Result<Vec<Source>, ProcessingError> {
        let permission = &self
            .evaluation
            .as_ref()
            .ok_or(ProcessingError::Unavailable)?
            .permission;
        if !self.state.live
            || self.state.status != Status::Running
            || self.state.cues_paused
            || self.live_stopping
        {
            return Err(ProcessingError::SessionInactive);
        }
        if !Arc::ptr_eq(&review.owner, &permission.owner)
            || review.session != self.generation
            || review.generation != permission.generation
            || review.processor != permission.processor
        {
            return Err(ProcessingError::StaleReview);
        }
        let mut notes = Vec::new();
        for expected in &review.notes {
            let source = self
                .notes
                .iter()
                .map(|note| note_source(&note.item))
                .find(|source| fingerprint(source) == *expected)
                .ok_or(ProcessingError::StaleReview)?;
            notes.push(source);
        }
        Ok(notes)
    }

    /// Native review ownership can discard invalid tokens without consuming a
    /// valid one or granting permission as a side effect of checking it.
    pub(crate) fn processing_review_is_current(&self, review: &ProcessingReview) -> bool {
        self.reviewed_sources(review).is_ok()
    }

    /// Bind a pending review to the available source set, including content
    /// changes with a reused revision. Reordering alone is not a scope change.
    /// Only a digest leaves this module; no extra excerpt copy is retained.
    pub(crate) fn processing_context_fingerprint(&self) -> [u8; 32] {
        self.processing_context_digest
    }

    /// Commit a reviewed scope under the engine lock. This never starts capture
    /// or constructs a provider; a native UI/adapter remains a separate gate.
    pub fn approve_processing(&mut self, review: ProcessingReview) -> Result<(), ProcessingError> {
        self.approve_processing_with_origin(review, false)
    }

    pub(crate) fn approve_processing_with_origin(
        &mut self,
        review: ProcessingReview,
        by_setting: bool,
    ) -> Result<(), ProcessingError> {
        // Existing launch settings acknowledge only the current fresh slice.
        // History requires an explicit review; no old setting can widen it.
        if by_setting && review.processor.bounded_history {
            return Err(ProcessingError::InvalidScope);
        }
        if self.model_calls_exhausted() {
            return Err(ProcessingError::Unavailable);
        }
        let notes = self.reviewed_sources(&review)?;
        self.revoke_processing();
        if self.evaluation.as_ref().is_some_and(|s| s.lab_terminal) {
            return Err(ProcessingError::Unavailable);
        }
        self.evaluation.as_mut().unwrap().permission.grant = Some(Grant {
            session: review.session,
            approved_at_ms: self.state.elapsed_ms,
            processor: review.processor,
            after_ms: match review.conversation {
                ConversationScope::NewSpeechOnly => Some(self.state.elapsed_ms),
                ConversationScope::RecentAndNewSpeech => None,
            },
            notes,
        });
        // A new grant starts afresh: no run of timeouts, and no earlier cues
        // drawn from speech the new grant may not cover.
        if let Some(state) = &mut self.evaluation {
            state.approval_by_setting = by_setting;
            state.timeouts_in_row = 0;
            state.shown = None;
            state.earlier.clear();
        }
        self.record_connection("on");
        if review.conversation == ConversationScope::RecentAndNewSpeech {
            self.submit_evaluation();
        }
        Ok(())
    }

    /// The development timing log's record of the connection turning on or
    /// off. Names the backend and its settings, never an account or path.
    fn record_connection(&self, state: &'static str) {
        if !crate::timing_log::enabled() {
            return;
        }
        let Some(evaluation) = &self.evaluation else {
            return;
        };
        let processor = &evaluation.permission.processor;
        crate::timing_log::record(crate::timing_log::Event::Evaluator {
            session: self.generation,
            state,
            approval: if evaluation.approval_by_setting {
                "launchSetting"
            } else {
                "review"
            },
            backend: processor.id.clone(),
            model: processor.model.clone(),
            effort: processor.effort.clone(),
            elapsed_ms: self.state.elapsed_ms,
        });
    }

    /// Disable evaluated processing, release grant/cue copies and cancel work.
    /// Transcript capture and ordinary notebook contents are not stopped here.
    pub fn revoke_processing(&mut self) {
        if self.evaluation.is_none() {
            return;
        }
        let was_on = self
            .evaluation
            .as_ref()
            .is_some_and(|state| state.permission.grant.is_some());
        self.invalidate_evaluation();
        self.evaluation.as_mut().unwrap().permission.revoke();
        if was_on {
            self.record_connection("off");
        }
        self.set_evaluation_status(EvaluationStatus::Idle);
        self.evaluated_cue = None;
        self.state.cue = None;
        self.unshown = None;
        self.changed();
    }

    pub fn has_processing_permission(&self) -> bool {
        !self.live_stopping
            && self.state.status == Status::Running
            && self.evaluation.as_ref().is_some_and(|state| {
                !state.lab_terminal && state.permission.valid(self.generation, &self.notes)
            })
    }

    /// Cloud transcription's gate for `session`'s stream: the session time of
    /// a grant the person made in that session's own review, while it holds.
    /// A grant from a launch setting never opens it, so audio is never sent
    /// without a review shown in the app, and a later session's grant never
    /// opens an earlier session's stream.
    pub fn audio_approval(&self, session: u64) -> Option<u64> {
        if session != self.generation || !self.has_processing_permission() {
            return None;
        }
        let state = self.evaluation.as_ref()?;
        if state.approval_by_setting {
            return None;
        }
        state
            .permission
            .grant
            .as_ref()
            .map(|grant| grant.approved_at_ms)
    }

    /// Why an open cloud stream must stop sending now, if it must: the lab
    /// run ended, or the review was withdrawn. A Stop in progress keeps it
    /// sending, so the last captured audio is transcribed.
    pub fn audio_withdrawal(&self, session: u64) -> Option<&'static str> {
        if session != self.generation {
            return Some("withdrawn");
        }
        if self.audio_approval(session).is_some() || self.live_stopping {
            return None;
        }
        if self
            .evaluation
            .as_ref()
            .is_some_and(|state| state.lab_terminal)
        {
            return Some("lab_ended");
        }
        Some("withdrawn")
    }

    pub(in crate::engine) fn reconcile_processing_permission(&mut self) {
        if self.evaluation.as_ref().is_some_and(|state| {
            state.permission.grant.is_some()
                && !state.permission.valid(self.generation, &self.notes)
        }) {
            self.revoke_processing();
            self.set_evaluation_status(EvaluationStatus::Unavailable(
                EvaluationIssue::ScopeChanged,
            ));
        }
    }
}
