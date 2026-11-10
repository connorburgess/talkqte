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

/// Identifies the complete reviewed adapter configuration. This is not a
/// provider implementation or proof of its declared data-handling policy.
/// Deliberately not deserializable from IPC.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessorConfiguration {
    id: String,
    revision: u64,
    model: String,
    location: ProcessingLocation,
    policy_revision: String,
}

impl ProcessorConfiguration {
    pub fn new(
        id: String,
        revision: u64,
        model: String,
        location: ProcessingLocation,
        policy_revision: String,
    ) -> Result<Self, ProcessingError> {
        let valid =
            |s: &str| !s.trim().is_empty() && s.len() <= 256 && !s.chars().any(char::is_control);
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
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    processor: ProcessorConfiguration,
    owner: Arc<()>,
    pub(super) generation: u64,
    pub(super) grant: Option<Grant>,
}

pub(super) struct Grant {
    session: u64,
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
        if !self.state.live || self.state.status != Status::Running || self.state.cues_paused {
            return Err(ProcessingError::SessionInactive);
        }
        if notes.len() > crate::context::MAX_ITEMS {
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

    /// Commit a reviewed scope under the engine lock. This never starts capture
    /// or constructs a provider; a native UI/adapter remains a separate gate.
    pub fn approve_processing(&mut self, review: ProcessingReview) -> Result<(), ProcessingError> {
        let permission = &self
            .evaluation
            .as_ref()
            .ok_or(ProcessingError::Unavailable)?
            .permission;
        if !self.state.live || self.state.status != Status::Running || self.state.cues_paused {
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
        self.revoke_processing();
        self.evaluation.as_mut().unwrap().permission.grant = Some(Grant {
            session: review.session,
            processor: review.processor,
            after_ms: match review.conversation {
                ConversationScope::NewSpeechOnly => Some(self.state.elapsed_ms),
                ConversationScope::RecentAndNewSpeech => None,
            },
            notes,
        });
        if review.conversation == ConversationScope::RecentAndNewSpeech {
            self.submit_evaluation();
        }
        Ok(())
    }

    /// Disable evaluated processing, release grant/cue copies and cancel work.
    /// Transcript capture and ordinary notebook contents are not stopped here.
    pub fn revoke_processing(&mut self) {
        if self.evaluation.is_none() {
            return;
        }
        self.invalidate_evaluation();
        self.evaluation.as_mut().unwrap().permission.revoke();
        self.evaluated_cue = None;
        self.state.cue = None;
        self.unshown = None;
        self.changed();
    }

    pub fn has_processing_permission(&self) -> bool {
        self.state.status == Status::Running
            && self
                .evaluation
                .as_ref()
                .is_some_and(|state| state.permission.valid(self.generation, &self.notes))
    }

    pub(in crate::engine) fn reconcile_processing_permission(&mut self) {
        if self.evaluation.as_ref().is_some_and(|state| {
            state.permission.grant.is_some()
                && !state.permission.valid(self.generation, &self.notes)
        }) {
            self.revoke_processing();
        }
    }
}
