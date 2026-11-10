//! Source-aware lifecycle bridge. No app command constructs this engine;
//! the explicit Rust constructor is exercised with fictional adapters only.
use super::*;
use crate::cue_evaluator::{Action, Decision, Failure, Provenance, Request, Source, Worker};

mod permission;
mod projection;
pub(super) use permission::context_fingerprint;
use permission::Permission;
pub use permission::{
    ConversationScope, ProcessingError, ProcessingLocation, ProcessingReview,
    ProcessorConfiguration, ProcessorDisclosure,
};
pub use projection::{CaptureState, ProcessingSnapshot, ProcessingTracker};

const RECENT_LINES: usize = 6;

/// Content-free operational state for a future native controller. An absent
/// cue is not evidence that an evaluator chose quiet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvaluationStatus {
    Idle,
    Pending,
    Decided(EvaluationOutcome),
    Unavailable(EvaluationIssue),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvaluationOutcome {
    Quiet,
    Shown,
    Resolved,
    Withdrawn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvaluationIssue {
    ScopeChanged,
    InputLimit,
    InvalidReply,
    TimedOut,
    WorkerUnavailable,
}

pub(super) struct State {
    worker: Worker,
    pending: Option<Pending>,
    // One coalesced speech notification, never a queue of copied requests.
    latest_speech_waiting: bool,
    permission: Permission,
    status: EvaluationStatus,
    outcome_at_ms: Option<u64>,
}

struct Pending {
    request: Request,
    permission_generation: u64,
}

impl Engine {
    /// Register a trusted Rust adapter without granting processing permission.
    /// A session must review/approve its scope separately. Native commands still
    /// construct `live()` and run phrase rules. Never runs both cue paths.
    pub fn live_with_evaluator(worker: Worker, processor: ProcessorConfiguration) -> Self {
        let mut engine = Self::live();
        engine.evaluation = Some(State {
            worker,
            pending: None,
            latest_speech_waiting: false,
            permission: Permission::new(processor),
            status: EvaluationStatus::Idle,
            outcome_at_ms: None,
        });
        engine
    }

    /// None means this engine has no evaluator. Permission and capture state
    /// remain separate; Idle alone never means processing is enabled.
    pub fn evaluation_status(&self) -> Option<EvaluationStatus> {
        self.evaluation.as_ref().map(|state| state.status)
    }

    fn set_evaluation_status(&mut self, status: EvaluationStatus) {
        if let Some(state) = &mut self.evaluation {
            if state.status != status {
                state.status = status;
                state.outcome_at_ms = None;
                self.changed();
            }
        }
    }

    fn fail_evaluation(&mut self, failure: Failure) {
        let issue = match failure {
            Failure::InvalidInput => EvaluationIssue::InputLimit,
            Failure::InvalidDecision => EvaluationIssue::InvalidReply,
            Failure::Expired => EvaluationIssue::TimedOut,
            Failure::EvaluatorUnavailable | Failure::WorkerUnavailable => {
                EvaluationIssue::WorkerUnavailable
            }
            // Superseded work and controls are not provider outages.
            Failure::Busy | Failure::Cancelled | Failure::Stale => return,
        };
        self.revoke_processing();
        self.set_evaluation_status(EvaluationStatus::Unavailable(issue));
    }

    fn record_evaluation_outcome(&mut self, request: &Request, outcome: EvaluationOutcome) {
        self.set_evaluation_status(EvaluationStatus::Decided(outcome));
        self.evaluation.as_mut().unwrap().outcome_at_ms =
            request.sources().iter().filter_map(source_time).max();
    }

    pub(super) fn invalidate_evaluation(&mut self) {
        self.evaluation_revision = self.evaluation_revision.wrapping_add(1);
        if let Some(state) = &mut self.evaluation {
            state.latest_speech_waiting = false;
            state.worker.cancel_pending();
            if let Some(pending) = state.pending.take() {
                // Drain the cancelled ticket without waiting for the adapter.
                // Stop need not receive another clock tick to release the
                // caller's copies of the request and its source text.
                let _ = state.worker.poll(&pending.request);
            }
        }
        // An error stays visible through new speech and controls until an
        // explicit revoke/approval or session replacement clears it.
        if !matches!(
            self.evaluation_status(),
            Some(EvaluationStatus::Unavailable(_))
        ) {
            self.set_evaluation_status(EvaluationStatus::Idle);
        }
    }

    /// The last six complete transcript lines plus the visible cue's original
    /// sources (at most four), optionally with exactly approved prior notes.
    /// Never include manual notes, focus text, or identity settings. Fail closed
    /// on the worker's per-source and aggregate byte bounds without truncation.
    fn evaluation_request(&self) -> Result<Option<Request>, Failure> {
        if self.state.status != Status::Running || self.state.cues_paused || self.live_stopping {
            return Ok(None);
        }
        let Some(state) = &self.evaluation else {
            return Ok(None);
        };
        let permission = &state.permission;
        if !permission.valid(self.generation, &self.notes) {
            return Ok(None);
        }
        let Some(grant) = &permission.grant else {
            return Ok(None);
        };
        let recent: Vec<_> = self
            .state
            .transcript
            .iter()
            .rev()
            .take(RECENT_LINES)
            .filter(|line| {
                self.state.elapsed_ms.saturating_sub(line.at_ms) < CUE_MS
                    && self.cues_after_ms.is_none_or(|after| line.at_ms > after)
                    && grant.after_ms.is_none_or(|after| line.at_ms > after)
            })
            .collect();
        if recent.is_empty() {
            return Ok(None);
        }
        let mut sources = Vec::new();
        let existing = if let Some(cue) = &self.state.cue {
            let Some((id, cited)) = &self.evaluated_cue else {
                return Ok(None);
            };
            if *id != cue.id || cue.resolved_by.is_some() {
                return Ok(None);
            }
            sources.extend(cited.iter().cloned());
            Some(crate::cue_evaluator::ExistingCue {
                id: cue.id.clone(),
                text: cue.question.clone(),
                source_ids: cited.iter().map(|source| source.id.clone()).collect(),
            })
        } else {
            None
        };
        for line in recent.into_iter().rev() {
            if !sources.iter().any(|source| matches_source(line, source)) {
                sources.push(transcript_source(line));
            }
        }
        for note in &grant.notes {
            if !sources.contains(note) {
                sources.push(note.clone());
            }
        }
        // Recheck retained cue sources too: disclosure is no exception to the
        // grant, including transcript captured before NewSpeechOnly approval.
        if sources.iter().any(|source| match source_time(source) {
            Some(at_ms) => grant.after_ms.is_some_and(|after| at_ms <= after),
            None => !grant.notes.contains(source),
        }) {
            return Ok(None);
        }
        Request::new(self.generation, self.evaluation_revision, sources, existing).map(Some)
    }

    /// Only newly accepted eligible speech requests work. Multiple notifications
    /// coalesce while a cancelled adapter returns; controls discard the marker.
    pub(super) fn submit_evaluation(&mut self) {
        if !self.has_processing_permission() {
            return;
        }
        if let Some(state) = &mut self.evaluation {
            state.latest_speech_waiting = true;
        }
        self.poll_evaluation();
    }

    /// Runs under the same engine borrow/lock as controls and transcript input.
    /// Clock ticks poll results and dispatch a waiting speech notification, never
    /// retry a completed/failed input or create work without new eligible speech.
    pub(super) fn poll_evaluation(&mut self) {
        self.reconcile_processing_permission();
        if self.evaluation.as_ref().is_some_and(|state| {
            state
                .outcome_at_ms
                .is_some_and(|at_ms| self.state.elapsed_ms.saturating_sub(at_ms) >= CUE_MS)
        }) {
            self.set_evaluation_status(EvaluationStatus::Idle);
        }
        if self
            .evaluation
            .as_ref()
            .is_some_and(|state| state.pending.is_some())
        {
            self.poll_pending_evaluation();
        }
        self.dispatch_latest_speech();
    }

    fn dispatch_latest_speech(&mut self) {
        if self
            .evaluation
            .as_ref()
            .is_none_or(|state| !state.latest_speech_waiting || state.worker.is_busy())
        {
            return;
        }
        // Build only when the worker can accept work, from current sources and
        // cue state. Invalid input revokes permission before any dispatch.
        let request = match self.evaluation_request() {
            Ok(request) => request,
            Err(error) => {
                self.fail_evaluation(error);
                return;
            }
        };
        let state = self.evaluation.as_mut().expect("evaluation checked");
        state.latest_speech_waiting = false;
        if let Some(request) = request {
            match state.worker.submit(request.clone()) {
                Ok(()) => {
                    state.pending = Some(Pending {
                        request,
                        permission_generation: state.permission.generation,
                    });
                    self.set_evaluation_status(EvaluationStatus::Pending);
                }
                Err(Failure::Busy) => state.latest_speech_waiting = true,
                Err(error) => self.fail_evaluation(error),
            }
        }
    }

    fn poll_pending_evaluation(&mut self) {
        let current = match self.evaluation_request() {
            Ok(request) => request,
            Err(error) => {
                self.fail_evaluation(error);
                return;
            }
        };
        let state = self.evaluation.as_mut().expect("evaluation checked");
        let pending = state.pending.as_ref().expect("pending checked");
        let permission_current = pending.permission_generation == state.permission.generation;
        if current.is_none() || !permission_current {
            state.worker.cancel_pending();
        }
        let Some(result) = state
            .worker
            .poll(current.as_ref().unwrap_or(&pending.request))
        else {
            return;
        };
        let submitted = state.pending.take().expect("pending checked");
        self.set_evaluation_status(EvaluationStatus::Idle);
        if let Some(current) = current {
            if permission_current && current == submitted.request {
                match result {
                    Ok(decision) => self.apply_evaluation(&current, decision),
                    Err(error) => self.fail_evaluation(error),
                }
            }
        }
    }

    fn apply_evaluation(&mut self, request: &Request, decision: Decision) {
        // Only worker-validated results reach here. Resolve references again
        // from this immutable request; provider reason/use labels never become
        // notes, scores, or a claim that the user used or benefited from a cue.
        let cited: Vec<_> = decision
            .source_ids
            .iter()
            .filter_map(|id| request.sources().iter().find(|source| source.id == *id))
            .cloned()
            .collect();
        let Some(first) = cited.first() else {
            return;
        };
        if decision.action != Action::Quiet
            && !cited.iter().filter_map(source_time).any(|at_ms| {
                self.state.elapsed_ms.saturating_sub(at_ms) < CUE_MS
                    && self.cues_after_ms.is_none_or(|after| at_ms > after)
            })
        {
            // Prior notes alone cannot raise a cue or establish that the
            // current conversation answered/corrected it. Require a fresh
            // cited speech anchor, not just fresh speech elsewhere in input.
            return;
        }
        match decision.action {
            Action::Quiet => {
                self.record_evaluation_outcome(request, EvaluationOutcome::Quiet);
                return;
            }
            Action::Show => {
                let Some(question) = decision.cue else {
                    return;
                };
                let at_ms = cited.iter().filter_map(source_time).max().unwrap_or(0);
                let now = self.state.elapsed_ms;
                let about_focus = cited.iter().any(|source| {
                    source_time(source).is_some() && self.focus_match(&source.text).is_some()
                });
                let repeat_key = format!("Evaluated:{}", question.to_lowercase());
                if self.state.cue.is_some()
                    || now.saturating_sub(at_ms) >= CUE_MS
                    || at_ms < self.cooldown_until
                    || (matches!(self.state.sensitivity, Sensitivity::Focused) && !about_focus)
                    || self.last_shown.iter().any(|(key, shown)| {
                        *key == repeat_key && now.saturating_sub(*shown) < REPEAT_MS
                    })
                {
                    return;
                }
                // Do not grant a fresh 18 seconds to a late response.
                self.cue_deadline = at_ms.saturating_add(CUE_MS);
                let id = format!(
                    "{}:evaluation-{}",
                    self.generation, self.evaluation_revision
                );
                self.state.cue = Some(Cue {
                    id: id.clone(),
                    kind: "Suggestion".into(),
                    question,
                    evidence: evidence(&cited),
                    sources: cited.clone(),
                    source_id: first.id.clone(),
                    remaining_ms: self.cue_deadline.saturating_sub(now),
                    total_ms: CUE_MS,
                    held: false,
                    expanded: false,
                    resolved_by: None,
                    note: None,
                    about_focus,
                });
                self.evaluated_cue = Some((id, cited));
                self.last_shown
                    .retain(|(_, at)| now.saturating_sub(*at) < REPEAT_MS);
                // Even a caller producing distinct suggestions cannot grow
                // history without bound. This mode never uses rule history.
                if self.last_shown.len() >= 128 {
                    self.last_shown.remove(0);
                }
                self.last_shown.push((repeat_key, now));
            }
            Action::Resolved | Action::Withdraw => {
                let Some(cue) = &mut self.state.cue else {
                    return;
                };
                if request.existing_cue().is_none_or(|old| old.id != cue.id) {
                    return;
                }
                if decision.action == Action::Resolved && cue.held {
                    // Keep the same words under the reader's eyes. Resolution
                    // is sourced separately; a quiet/possible-use result alone
                    // never labels the question answered.
                    cue.resolved_by = Some(Resolution {
                        source_id: first.id.clone(),
                        evidence: evidence(&cited),
                        sources: cited.clone(),
                    });
                    if let Some((_, originals)) = &mut self.evaluated_cue {
                        for source in cited {
                            if !originals.iter().any(|old| old.id == source.id) {
                                originals.push(source);
                            }
                        }
                    }
                } else {
                    // A withdrawn premise must not remain an actionable held
                    // suggestion. Clear it; never relabel withdrawal as answer.
                    self.state.cue = None;
                    self.evaluated_cue = None;
                    self.cooldown_until = self.state.elapsed_ms.saturating_add(self.cooldown());
                }
            }
        }
        self.record_evaluation_outcome(
            request,
            match decision.action {
                Action::Show => EvaluationOutcome::Shown,
                Action::Resolved => EvaluationOutcome::Resolved,
                Action::Withdraw => EvaluationOutcome::Withdrawn,
                Action::Quiet => unreachable!(),
            },
        );
        self.changed();
    }

    pub(super) fn reconcile_evaluated_sources(&mut self) -> bool {
        let Some((id, sources)) = &self.evaluated_cue else {
            return false;
        };
        if self.state.cue.as_ref().is_none_or(|cue| cue.id != *id) {
            self.evaluated_cue = None;
            return false;
        }
        if sources.iter().any(|source| {
            !self
                .state
                .transcript
                .iter()
                .any(|line| matches_source(line, source))
                && !self
                    .notes
                    .iter()
                    .any(|note| matches_note(&note.item, source))
        }) {
            // Eviction/removal releases even a held excerpt. No hidden copy
            // continues to support a cue after its source leaves the session.
            self.state.cue = None;
            self.evaluated_cue = None;
            self.cooldown_until = self.state.elapsed_ms.saturating_add(self.cooldown());
            return true;
        }
        false
    }
}

fn transcript_source(line: &Segment) -> Source {
    Source {
        id: format!("transcript:{}", line.id),
        revision: 0, // Ingestion is append-only; full text/provenance also compared.
        provenance: Provenance::Transcript {
            at_ms: line.at_ms,
            speaker: line.speaker.clone(),
        },
        text: line.text.clone(),
    }
}

fn source_time(source: &Source) -> Option<u64> {
    match source.provenance {
        Provenance::Transcript { at_ms, .. } => Some(at_ms),
        Provenance::PriorNote { .. } => None,
    }
}

fn matches_source(line: &Segment, source: &Source) -> bool {
    source.id.strip_prefix("transcript:") == Some(line.id.as_str())
        && source.revision == 0
        && source.text == line.text
        && matches!(&source.provenance, Provenance::Transcript { at_ms, speaker }
            if *at_ms == line.at_ms && *speaker == line.speaker)
}

fn note_source(item: &ContextItem) -> Source {
    Source {
        id: format!("prior:{}:{}", item.provider.id(), item.source_id),
        revision: item.revision,
        provenance: Provenance::PriorNote {
            provider: item.provider,
            date: item.source_date.clone(),
            title: item.title.clone(),
        },
        text: item.excerpt.clone(),
    }
}

fn matches_note(item: &ContextItem, source: &Source) -> bool {
    source
        .id
        .strip_prefix("prior:")
        .and_then(|id| id.strip_prefix(item.provider.id()))
        .and_then(|id| id.strip_prefix(':'))
        == Some(item.source_id.as_str())
        && source.revision == item.revision
        && source.text == item.excerpt
        && matches!(&source.provenance, Provenance::PriorNote { provider, date, title }
            if *provider == item.provider && *date == item.source_date && *title == item.title)
}

fn evidence(sources: &[Source]) -> String {
    sources
        .iter()
        .map(|source| match &source.provenance {
            Provenance::Transcript { at_ms, speaker } => {
                format!(
                    "{}:{:02} · {}\n{}",
                    at_ms / 60_000,
                    at_ms / 1_000 % 60,
                    speaker,
                    source.text
                )
            }
            Provenance::PriorNote {
                provider,
                date,
                title,
            } => format!(
                "Prior note · {} · {} · {}\n{}",
                provider.id(),
                date,
                title,
                source.text
            ),
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cue_evaluator::{Cancellation, Evaluator, Failure};
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };

    struct Fictional {
        requests: mpsc::Sender<Request>,
        replies: mpsc::Receiver<String>,
    }
    impl Evaluator for Fictional {
        fn evaluate(&mut self, request: &Request, _: &Cancellation) -> Result<String, Failure> {
            self.requests.send(request.clone()).unwrap();
            self.replies
                .recv()
                .map_err(|_| Failure::EvaluatorUnavailable)
        }
    }
    struct Harness {
        engine: Engine,
        requests: mpsc::Receiver<Request>,
        replies: mpsc::Sender<String>,
        next_line: usize,
    }
    impl Harness {
        fn new() -> Self {
            Self::with_budget(Duration::from_secs(5))
        }
        fn with_budget(budget: Duration) -> Self {
            let mut h = Self::unapproved(fictional_processor(), budget);
            let review = h
                .engine
                .review_processing(ConversationScope::NewSpeechOnly, &[])
                .unwrap();
            h.engine.approve_processing(review).unwrap();
            h
        }
        fn unapproved(processor: ProcessorConfiguration, budget: Duration) -> Self {
            let (requests_tx, requests) = mpsc::channel();
            let (replies, replies_rx) = mpsc::channel();
            let worker = Worker::start(
                Fictional {
                    requests: requests_tx,
                    replies: replies_rx,
                },
                budget,
            )
            .unwrap();
            let mut engine = Engine::live_with_evaluator(worker, processor);
            engine.start().unwrap();
            Self {
                engine,
                requests,
                replies,
                next_line: 0,
            }
        }
        fn approve_notes(&mut self) {
            let scope: Vec<_> = self
                .engine
                .notes
                .iter()
                .map(|note| {
                    (
                        note.item.provider,
                        note.item.source_id.clone(),
                        note.item.revision,
                    )
                })
                .collect();
            let review = self
                .engine
                .review_processing(ConversationScope::NewSpeechOnly, &scope)
                .unwrap();
            self.engine.approve_processing(review).unwrap();
        }
        fn line(&mut self, text: &str) {
            self.engine.advance(10);
            self.next_line += 1;
            self.engine
                .ingest(
                    self.engine.session(),
                    Segment {
                        id: format!("line-{}", self.next_line),
                        at_ms: self.engine.state.elapsed_ms,
                        speaker: "Maya".into(),
                        text: text.into(),
                    },
                )
                .unwrap();
        }
        fn request(&self) -> Request {
            self.requests
                .recv_timeout(Duration::from_secs(2))
                .expect("fictional request")
        }
        fn reply(&mut self, action: &str, cue: Option<&str>, ids: &[&str], observed: &str) {
            self.replies
                .send(
                    serde_json::json!({
                        "action": action, "cue": cue, "sourceIds": ids,
                        "reason": "Fictional decision reason", "observedUse": observed,
                    })
                    .to_string(),
                )
                .unwrap();
            self.settle();
        }
        fn settle(&mut self) {
            let until = Instant::now() + Duration::from_secs(2);
            while self.engine.evaluation.as_ref().unwrap().pending.is_some() {
                assert!(Instant::now() < until, "fictional reply did not settle");
                std::thread::sleep(Duration::from_millis(1));
                self.engine.advance(1);
            }
            // Let the worker finish its nonblocking mailbox send and park.
            std::thread::sleep(Duration::from_millis(2));
        }
        fn show(&mut self) -> String {
            self.line("The checklist handoff is still unclear.");
            let request = self.request();
            assert!(request.existing_cue().is_none());
            self.reply(
                "show",
                Some("Who owns the checklist?"),
                &["transcript:line-1"],
                "not_observed",
            );
            self.engine.state.cue.as_ref().unwrap().id.clone()
        }
    }

    fn fictional_processor() -> ProcessorConfiguration {
        ProcessorConfiguration::new(
            "fictional".into(),
            1,
            "fixture-v1".into(),
            ProcessingLocation::OnDevice,
            "fictional-policy-v1".into(),
            ProcessorDisclosure::new(
                "Fictional worker".into(),
                "Fictional in-memory test only.".into(),
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn registration_import_and_capture_do_not_grant_processing() {
        let mut h = Harness::unapproved(fictional_processor(), Duration::from_secs(5));
        h.engine
            .set_notes(vec![selected(crate::context::Provider::File, "one")]);
        h.engine
            .update_notes("An unsent manual draft.".into())
            .unwrap();
        h.line("Someone should take the checklist.");
        drain_without_another_request(&mut h);
        assert!(!h.engine.has_processing_permission());
        assert!(
            h.engine.state.cue.is_none(),
            "no silent phrase-rule fallback"
        );
        let review = h
            .engine
            .review_processing(ConversationScope::NewSpeechOnly, &[])
            .unwrap();
        h.engine.approve_processing(review).unwrap();
        drain_without_another_request(&mut h);
        h.line("Who will take the checklist?");
        let request = h.request();
        assert_eq!(request.sources().len(), 1);
        assert_eq!(request.sources()[0].id, "transcript:line-2");
        h.reply("quiet", None, &["transcript:line-2"], "not_observed");
        h.engine.revoke_processing();
        h.line("Someone should send the checklist soon.");
        drain_without_another_request(&mut h);
        assert_eq!(h.engine.state.status, Status::Running);
        assert_eq!(h.engine.state.transcript.len(), 3);
        assert_eq!(h.engine.state.notes, "An unsent manual draft.");
        assert!(h.engine.state.cue.is_none());
    }

    #[test]
    fn reviewed_recent_speech_and_exact_notes_are_the_only_permitted_sources() {
        use crate::context::Provider;
        let mut h = Harness::unapproved(fictional_processor(), Duration::from_secs(5));
        let file = selected(Provider::File, "one");
        let approved = selected(Provider::Granola, "one");
        h.engine.set_notes(vec![file, approved.clone()]);
        h.line("Can we send the garden guide Friday?");
        let review = h
            .engine
            .review_processing(
                ConversationScope::RecentAndNewSpeech,
                &[(Provider::Granola, "one".into(), 7)],
            )
            .unwrap();
        h.engine.approve_processing(review).unwrap();
        let request = h.request();
        assert_eq!(request.sources().len(), 2);
        assert_eq!(request.sources()[1], note_source(&approved));
        h.reply("quiet", None, &["transcript:line-1"], "not_observed");
        // Replacing an unapproved note and adding a note cannot widen approval.
        h.engine
            .set_notes(vec![approved, selected(Provider::File, "new")]);
        assert!(h.engine.has_processing_permission());
        h.line("The guide still needs review.");
        let request = h.request();
        assert_eq!(request.sources().len(), 3);
        assert!(!request
            .sources()
            .iter()
            .any(|s| s.id.starts_with("prior:file:")));
        h.reply("quiet", None, &["transcript:line-2"], "not_observed");
    }

    #[test]
    fn stale_review_cannot_approve_a_changed_note_or_revoked_session() {
        use crate::context::Provider;
        for change in [
            "revision", "text", "title", "date", "provider", "removed", "revoke", "replay",
        ] {
            let mut h = Harness::unapproved(fictional_processor(), Duration::from_secs(5));
            let mut note = selected(Provider::Granola, "one");
            h.engine.set_notes(vec![note.clone()]);
            let review = h
                .engine
                .review_processing(
                    ConversationScope::NewSpeechOnly,
                    &[(Provider::Granola, "one".into(), 7)],
                )
                .unwrap();
            match change {
                "revision" => note.revision += 1,
                "text" => note.excerpt = "An updated fictional plan.".into(),
                "title" => note.title = "An updated title".into(),
                "date" => note.source_date = "2026-11-02".into(),
                "provider" => note.provider = Provider::File,
                "revoke" => h.engine.revoke_processing(),
                "replay" => {
                    h.engine.end();
                    h.engine.start().unwrap();
                }
                _ => (),
            }
            h.engine.set_notes(if change == "removed" {
                vec![]
            } else {
                vec![note]
            });
            assert_eq!(
                h.engine.approve_processing(review),
                Err(ProcessingError::StaleReview),
                "{change}"
            );
            h.line("Who should review the garden guide?");
            drain_without_another_request(&mut h);
            assert!(!h.engine.has_processing_permission());
        }
    }

    #[test]
    fn review_cannot_move_to_another_adapter_configuration_or_engine() {
        for change in [
            "id",
            "revision",
            "model",
            "destination",
            "policy",
            "same-config",
        ] {
            let original = Harness::unapproved(fictional_processor(), Duration::from_secs(5));
            let review = original
                .engine
                .review_processing(ConversationScope::NewSpeechOnly, &[])
                .unwrap();
            let processor = ProcessorConfiguration::new(
                if change == "id" { "other" } else { "fictional" }.into(),
                if change == "revision" { 2 } else { 1 },
                if change == "model" {
                    "fixture-v2"
                } else {
                    "fixture-v1"
                }
                .into(),
                if change == "destination" {
                    ProcessingLocation::Hosted {
                        service: "Fictional service".into(),
                    }
                } else {
                    ProcessingLocation::OnDevice
                },
                if change == "policy" {
                    "policy-v2"
                } else {
                    "fictional-policy-v1"
                }
                .into(),
                ProcessorDisclosure::new(
                    "Fictional worker".into(),
                    "Fictional in-memory test only.".into(),
                )
                .unwrap(),
            )
            .unwrap();
            let mut replacement = Harness::unapproved(processor, Duration::from_secs(5));
            assert_eq!(original.engine.session(), replacement.engine.session());
            assert_eq!(
                replacement.engine.approve_processing(review),
                Err(ProcessingError::StaleReview),
                "{change}"
            );
            replacement.line("Who will take the checklist?");
            drain_without_another_request(&mut replacement);
        }
    }

    #[test]
    fn scope_is_atomic_and_superseded_reviews_cannot_restore_permission() {
        use crate::context::Provider;
        let mut h = Harness::unapproved(fictional_processor(), Duration::from_secs(5));
        h.engine.set_notes(vec![selected(Provider::Granola, "one")]);
        for scope in [
            vec![(Provider::Granola, "one".into(), 6)],
            vec![(Provider::File, "one".into(), 7)],
            vec![(Provider::Granola, "missing".into(), 7)],
            vec![(Provider::Granola, "one".into(), 7); 2],
            vec![(Provider::Granola, "one".into(), 7); 21],
        ] {
            assert_eq!(
                h.engine
                    .review_processing(ConversationScope::NewSpeechOnly, &scope)
                    .unwrap_err(),
                ProcessingError::InvalidScope
            );
        }
        let old = h
            .engine
            .review_processing(
                ConversationScope::NewSpeechOnly,
                &[(Provider::Granola, "one".into(), 7)],
            )
            .unwrap();
        let current = h
            .engine
            .review_processing(ConversationScope::NewSpeechOnly, &[])
            .unwrap();
        h.engine.approve_processing(current).unwrap();
        assert_eq!(
            h.engine.approve_processing(old),
            Err(ProcessingError::StaleReview)
        );
        h.line("Who should review the garden guide?");
        assert_eq!(h.request().sources().len(), 1);
        h.reply("quiet", None, &["transcript:line-1"], "not_observed");
    }

    #[test]
    fn revoke_and_reapprove_cannot_apply_old_reply_or_replay_waiting_input() {
        let mut h = Harness::new();
        h.line("Who will take the garden checklist?");
        h.request(); // Occupied, deliberately ignoring cancellation.
        h.line("The next handoff is still unclear.");
        h.engine.revoke_processing();
        let review = h
            .engine
            .review_processing(ConversationScope::NewSpeechOnly, &[])
            .unwrap();
        h.engine.approve_processing(review).unwrap();
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-1"],
            "not_observed",
        );
        drain_without_another_request(&mut h);
        assert!(h.engine.state.cue.is_none());
        h.line("A new garden handoff needs clarification.");
        let request = h.request();
        assert_eq!(request.sources().len(), 1);
        assert_eq!(request.sources()[0].id, "transcript:line-3");
        h.reply(
            "show",
            Some("Who owns the new handoff?"),
            &["transcript:line-3"],
            "not_observed",
        );
        let id = h.engine.state.cue.as_ref().unwrap().id.clone();
        h.engine.inspect_cue(&id, true).unwrap();
        h.engine.revoke_processing();
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.evaluated_cue.is_none());
        assert!(h.engine.evaluation.as_ref().unwrap().pending.is_none());
        assert_eq!(h.engine.state.status, Status::Running);
        assert_eq!(h.engine.state.transcript.len(), 3);
    }

    #[test]
    fn full_request_bounds_apply_after_valid_note_approval_without_partial_dispatch() {
        use crate::context::Provider;
        let mut h = Harness::unapproved(fictional_processor(), Duration::from_secs(5));
        let notes: Vec<_> = (0..15)
            .map(|i| {
                let mut note = selected(Provider::File, &format!("note-{i}"));
                note.excerpt = "Fictional ".repeat(200);
                note
            })
            .collect();
        let scope: Vec<_> = notes
            .iter()
            .map(|n| (n.provider, n.source_id.clone(), n.revision))
            .collect();
        h.engine.set_notes(notes);
        for _ in 0..6 {
            h.line(&"Garden discussion. ".repeat(50));
        }
        let review = h
            .engine
            .review_processing(ConversationScope::RecentAndNewSpeech, &scope)
            .unwrap();
        h.engine.approve_processing(review).unwrap();
        drain_without_another_request(&mut h);
        assert!(!h.engine.has_processing_permission());
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Unavailable(EvaluationIssue::InputLimit))
        );
        assert!(h.engine.evaluation.as_ref().unwrap().pending.is_none());
        assert!(h.engine.state.cue.is_none());
        h.line("A shorter new line cannot resume processing by itself.");
        drain_without_another_request(&mut h);
        let review = h
            .engine
            .review_processing(ConversationScope::RecentAndNewSpeech, &[])
            .unwrap();
        h.engine.approve_processing(review).unwrap();
        assert!(h
            .request()
            .sources()
            .iter()
            .all(|source| source_time(source).is_some()));
        h.reply("quiet", None, &["transcript:line-7"], "not_observed");
    }

    fn selected(provider: crate::context::Provider, id: &str) -> ContextItem {
        ContextItem {
            provider,
            source_id: id.into(),
            title: "Garden review".into(),
            source_date: "2026-11-01".into(),
            excerpt: "Legal review takes two days.".into(),
            revision: 7,
        }
    }

    #[test]
    fn mixed_sources_keep_distinct_identity_dates_revisions_and_exact_disclosure() {
        use crate::context::Provider;
        let mut h = Harness::new();
        let file = selected(Provider::File, "line-1");
        let mut granola = selected(Provider::Granola, "line-1");
        granola.source_date = "2026-11-02".into();
        granola.excerpt = "Leave one day for printing.".into();
        let unreferenced = selected(Provider::File, "not-cited");
        h.engine.set_notes(vec![file, granola, unreferenced]);
        h.approve_notes();
        h.engine
            .update_notes("Manual private draft.".into())
            .unwrap();
        h.line("Can we send the guide on Friday?");
        let request = h.request();
        assert_eq!(request.sources().len(), 4);
        assert_eq!(request.sources()[0].id, "transcript:line-1");
        assert_eq!(request.sources()[1].id, "prior:file:line-1");
        assert_eq!(request.sources()[2].id, "prior:granola:line-1");
        assert_eq!(request.sources()[1].revision, 7);
        assert!(!serde_json::to_string(&request)
            .unwrap()
            .contains("Manual private"));
        h.reply(
            "show",
            Some("Will the draft be ready Tuesday?"),
            &[
                "prior:granola:line-1",
                "transcript:line-1",
                "prior:file:line-1",
            ],
            "not_observed",
        );
        let payload = serde_json::to_value(h.engine.cue_snapshot()).unwrap();
        let sources = payload["cue"]["sources"].as_array().unwrap();
        assert_eq!(sources.len(), 3, "only cited sources reach the window");
        assert_eq!(sources[0]["provenance"]["provider"], "granola");
        assert_eq!(sources[0]["provenance"]["date"], "2026-11-02");
        assert_eq!(sources[0]["provenance"]["title"], "Garden review");
        assert_eq!(sources[0]["text"], "Leave one day for printing.");
        assert_eq!(sources[1]["provenance"]["kind"], "transcript");
        assert_eq!(sources[1]["provenance"]["speaker"], "Maya");
        assert_eq!(sources[2]["provenance"]["provider"], "file");
        assert!(!payload.to_string().contains("not-cited"));
        assert!(!h.engine.markdown().contains("Legal review"));
        assert!(!h.engine.markdown().contains("Will the draft"));
    }

    #[test]
    fn prior_notes_cannot_raise_or_resolve_a_cue_without_fresh_cited_speech() {
        use crate::context::Provider;
        let mut h = Harness::new();
        h.engine.set_notes(vec![selected(Provider::File, "one")]);
        h.approve_notes();
        h.engine.advance(1_000);
        assert!(
            h.requests.try_recv().is_err(),
            "import is not an evaluation trigger"
        );
        h.line("The checklist handoff is still unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["prior:file:one"],
            "not_observed",
        );
        assert!(
            h.engine.state.cue.is_none(),
            "uncited fresh speech is insufficient"
        );
        h.line("The checklist still needs an owner.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-2", "prior:file:one"],
            "not_observed",
        );
        let id = h.engine.state.cue.as_ref().unwrap().id.clone();
        h.engine.inspect_cue(&id, true).unwrap();
        for action in ["resolved", "withdraw"] {
            h.line("The review is still being discussed.");
            h.request();
            h.reply(action, None, &["prior:file:one"], "not_observed");
            let cue = h.engine.state.cue.as_ref().unwrap();
            assert_eq!(cue.id, id);
            assert!(cue.resolved_by.is_none());
        }
        h.engine.advance(CUE_MS);
        h.line("New discussion without a matching reference.");
        h.request();
        h.reply(
            "resolved",
            None,
            &["transcript:line-2", "prior:file:one"],
            "not_observed",
        );
        assert!(
            h.engine.state.cue.as_ref().unwrap().resolved_by.is_none(),
            "old held speech is not a fresh anchor"
        );
        let mut h = Harness::new();
        h.engine.set_sensitivity(Sensitivity::Focused);
        h.engine
            .set_focus(vec!["Legal supplier approval".into()])
            .unwrap();
        let mut focused_note = selected(Provider::File, "one");
        focused_note.excerpt = "Legal supplier approval takes two days.".into();
        h.engine.set_notes(vec![focused_note]);
        h.approve_notes();
        h.line("The checklist handoff is still unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-1", "prior:file:one"],
            "not_observed",
        );
        assert!(
            h.engine.state.cue.is_none(),
            "note wording cannot satisfy the live focus filter"
        );
    }

    #[test]
    fn note_revision_or_removal_discards_delayed_proposals_without_retry() {
        use crate::context::Provider;
        for removed in [false, true] {
            let mut h = Harness::new();
            let mut note = selected(Provider::Granola, "one");
            h.engine.set_notes(vec![note.clone()]);
            h.approve_notes();
            h.line("The review schedule is unclear.");
            h.request();
            note.revision += 1;
            h.engine
                .set_notes(if removed { vec![] } else { vec![note] });
            h.reply(
                "show",
                Some("When should review start?"),
                &["transcript:line-1", "prior:granola:one"],
                "not_observed",
            );
            h.engine.advance(1_000);
            assert!(h.engine.state.cue.is_none());
            assert!(h.engine.evaluated_cue.is_none());
            assert!(
                h.requests.try_recv().is_err(),
                "no retry after a context change"
            );
        }
    }

    #[test]
    fn changed_or_removed_notes_release_held_original_and_resolution_sources() {
        use crate::context::Provider;
        for resolution_source in [false, true] {
            for change in ["revision", "excerpt", "title", "date", "remove"] {
                let mut h = Harness::new();
                let mut note = selected(Provider::Granola, "one");
                h.engine.set_notes(vec![note.clone()]);
                h.approve_notes();
                h.line("The review schedule is unclear.");
                h.request();
                let mut ids = vec!["transcript:line-1"];
                if !resolution_source {
                    ids.push("prior:granola:one");
                }
                h.reply(
                    "show",
                    Some("When should review start?"),
                    &ids,
                    "not_observed",
                );
                let id = h.engine.state.cue.as_ref().unwrap().id.clone();
                h.engine.inspect_cue(&id, true).unwrap();
                if resolution_source {
                    h.line("Review starts Monday under the earlier plan.");
                    h.request();
                    h.reply(
                        "resolved",
                        None,
                        &["transcript:line-2", "prior:granola:one"],
                        "possible",
                    );
                    let cue = h.engine.state.cue.as_ref().unwrap();
                    assert_eq!(cue.id, id);
                    assert_eq!(cue.resolved_by.as_ref().unwrap().sources.len(), 2);
                }
                // Unchanged input and unrelated selected notes cannot pull
                // away evidence the user is reading.
                h.engine
                    .set_notes(vec![note.clone(), selected(Provider::File, "unrelated")]);
                assert_eq!(h.engine.state.cue.as_ref().unwrap().id, id);
                match change {
                    "revision" => note.revision += 1,
                    "excerpt" => note.excerpt = "The plan was corrected.".into(),
                    "title" => note.title = "Corrected review plan".into(),
                    "date" => note.source_date = "2026-11-03".into(),
                    _ => (),
                }
                let before = h.engine.state.revision;
                h.engine.set_notes(if change == "remove" {
                    vec![]
                } else {
                    vec![note]
                });
                assert!(h.engine.state.revision > before);
                assert!(
                    h.engine.state.cue.is_none(),
                    "{change}, resolution={resolution_source}"
                );
                assert!(h.engine.evaluated_cue.is_none());
                assert!(!serde_json::to_string(&h.engine.cue_snapshot())
                    .unwrap()
                    .contains("Legal review"));
                assert!(h.engine.inspect_cue(&id, true).is_err());
                assert!(!h.engine.has_processing_permission());
                h.line("Another garden review needs an owner.");
                drain_without_another_request(&mut h);
            }
        }
    }

    #[test]
    fn oversized_selected_context_fails_closed_and_namespaced_maximum_ids_fit() {
        use crate::context::Provider;
        for multibyte in [false, true] {
            let mut h = Harness::new();
            let notes = (0..if multibyte { 1 } else { 20 })
                .map(|i| {
                    let mut note = selected(Provider::File, &format!("note-{i}"));
                    note.excerpt = if multibyte {
                        "界".repeat(2_000)
                    } else {
                        "x".repeat(2_000)
                    };
                    note
                })
                .collect();
            h.engine.set_notes(notes);
            let scope: Vec<_> = h
                .engine
                .notes
                .iter()
                .map(|note| {
                    (
                        note.item.provider,
                        note.item.source_id.clone(),
                        note.item.revision,
                    )
                })
                .collect();
            h.engine.revoke_processing();
            assert_eq!(
                h.engine
                    .review_processing(ConversationScope::NewSpeechOnly, &scope)
                    .unwrap_err(),
                ProcessingError::InvalidScope
            );
            h.line("The review schedule is unclear.");
            assert!(h.engine.evaluation.as_ref().unwrap().pending.is_none());
            assert!(h.requests.try_recv().is_err());
            assert!(h.engine.state.cue.is_none());
        }
        let mut h = Harness::new();
        let mut note = selected(Provider::Granola, &"n".repeat(128));
        note.title = "t".repeat(crate::context::MAX_TITLE_CHARS);
        h.engine.set_notes(vec![note]);
        h.approve_notes();
        h.line("The review schedule is unclear.");
        assert_eq!(h.request().sources().len(), 2);
        h.reply("quiet", None, &["transcript:line-1"], "not_observed");
    }

    #[test]
    fn ticks_and_unchanged_imports_do_not_cancel_a_sourced_proposal_or_export_it() {
        let mut h = Harness::new();
        h.engine
            .update_notes("A private manual note".into())
            .unwrap();
        h.engine
            .set_focus(vec!["Review checklist ownership".into()])
            .unwrap();
        h.engine.set_user_name(Some("Robin".into())).unwrap();
        let imported = ContextItem {
            provider: crate::context::Provider::File,
            source_id: "one".into(),
            title: "Earlier launch review".into(),
            source_date: "2026-11-01".into(),
            excerpt: "Selected prior excerpt".into(),
            revision: 1,
        };
        h.engine.set_notes(vec![imported.clone()]);
        h.line("The checklist handoff is still unclear.");
        let request = h.request();
        let json = serde_json::to_string(&request).unwrap();
        for excluded in [
            "private manual",
            "Selected prior",
            "Review checklist",
            "Robin",
        ] {
            assert!(!json.contains(excluded));
        }
        h.engine.advance(2_000);
        h.engine.set_question_size(QuestionSize::Large);
        // A repeated/older import leaves the selected store unchanged. Its
        // synchronization must not silently cancel this valid response.
        h.engine.set_notes(vec![imported]);
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-1"],
            "not_observed",
        );
        let cue = h.engine.state.cue.as_ref().unwrap();
        assert!(cue.remaining_ms < CUE_MS - 1_999);
        assert!(cue.evidence.contains("Maya\nThe checklist handoff"));
        assert_eq!(cue.source_id, "transcript:line-1");
        assert!(cue.note.is_none());
        assert!(!h.engine.markdown().contains("Who owns"));
        assert!(!h.engine.markdown().contains("Fictional decision reason"));
        assert_eq!(h.engine.state.notes, "A private manual note");
    }

    #[test]
    fn quiet_and_possible_use_do_not_resolve_a_held_cue_but_sourced_resolution_does() {
        let mut h = Harness::new();
        let id = h.show();
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Decided(EvaluationOutcome::Shown))
        );
        h.line("Robin asks about the checklist.");
        h.request();
        // Hold can be selected while the result is in flight; apply reads it now.
        h.engine.inspect_cue(&id, true).unwrap();
        h.reply(
            "quiet",
            None,
            &["transcript:line-1", "transcript:line-2"],
            "possible",
        );
        assert!(h.engine.state.cue.as_ref().unwrap().resolved_by.is_none());
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Decided(EvaluationOutcome::Quiet))
        );
        h.line("Maya is responsible for that checklist.");
        h.request();
        h.reply(
            "resolved",
            None,
            &["transcript:line-2", "transcript:line-3"],
            "possible",
        );
        let cue = h.engine.state.cue.as_ref().unwrap();
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Decided(EvaluationOutcome::Resolved))
        );
        assert_eq!(cue.id, id);
        assert_eq!(cue.question, "Who owns the checklist?");
        assert!(cue.held && cue.expanded);
        let resolution = cue.resolved_by.as_ref().unwrap();
        assert!(resolution.evidence.contains("Robin asks"));
        assert!(resolution.evidence.contains("Maya is responsible"));
        h.engine.advance(CUE_MS * 2);
        assert!(h.engine.state.cue.is_some());
        assert!(h.engine.state.notes.is_empty());
    }

    #[test]
    fn pause_discards_late_results_and_resume_waits_for_new_speech() {
        let mut h = Harness::new();
        h.line("The checklist handoff is still unclear.");
        h.request();
        h.engine.set_live_cues_paused(true).unwrap();
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-1"],
            "not_observed",
        );
        assert!(h.engine.state.cue.is_none());
        h.line("Someone should send the checklist soon.");
        assert_eq!(h.engine.state.transcript.len(), 2);
        h.engine.set_live_cues_paused(false).unwrap();
        h.engine.advance(1_000);
        assert!(h.requests.try_recv().is_err());
        assert!(h.engine.state.cue.is_none());
        h.line("The new release handoff is unclear.");
        let request = h.request();
        assert_eq!(request.sources().len(), 1);
        assert_eq!(request.sources()[0].id, "transcript:line-3");
        h.reply(
            "show",
            Some("Who owns the release?"),
            &["transcript:line-3"],
            "not_observed",
        );
        assert!(h.engine.state.cue.is_some());
    }

    #[test]
    fn dismissal_wins_over_inflight_resolution_and_cooldown_and_repeats_still_apply() {
        let mut h = Harness::new();
        let id = h.show();
        h.line("The handoff might be settled.");
        h.request();
        h.engine.respond(&id, Response::Dismiss).unwrap();
        h.reply("resolved", None, &["transcript:line-2"], "unknown");
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.evaluated_cue.is_none());
        h.line("A different handoff is unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the release?"),
            &["transcript:line-3"],
            "not_observed",
        );
        assert!(h.engine.state.cue.is_none(), "cooldown must win");
        h.engine.advance(10_000);
        h.line("The checklist handoff remains unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-4"],
            "not_observed",
        );
        assert!(h.engine.state.cue.is_none(), "repeat must stay quiet");
        h.line("The release handoff remains unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the release?"),
            &["transcript:line-5"],
            "not_observed",
        );
        assert!(h.engine.state.cue.is_some());
    }

    // Pump the normal engine clock; no new speech is supplied to wake the worker.
    fn next_scheduled_request(h: &mut Harness) -> Request {
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            h.engine.advance(1);
            if let Ok(request) = h.requests.try_recv() {
                return request;
            }
            assert!(Instant::now() < until, "latest speech was never scheduled");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn latest_speech_catches_up_after_a_busy_worker_without_another_line() {
        let mut h = Harness::new();
        h.line("The garden checklist still needs an owner.");
        let obsolete = h.request();
        // Six seconds of fictional speech while the adapter ignores cancellation.
        for _ in 0..24 {
            h.engine.advance(240);
            h.line("The garden checklist handoff is still unclear.");
        }
        assert!(h.requests.try_recv().is_err(), "no overlapping evaluation");
        h.replies
            .send(
                serde_json::json!({
                    "action": "show", "cue": "An obsolete suggestion",
                    "sourceIds": ["transcript:line-1"],
                    "reason": "Fictional stale reply", "observedUse": "not_observed"
                })
                .to_string(),
            )
            .unwrap();
        let latest = next_scheduled_request(&mut h);
        assert_ne!(latest, obsolete);
        assert_eq!(latest.sources().len(), RECENT_LINES);
        assert_eq!(latest.sources().last().unwrap().id, "transcript:line-25");
        assert!(
            h.engine.state.cue.is_none(),
            "obsolete reply must not flash"
        );
        h.reply(
            "show",
            Some("Who will take the garden checklist?"),
            &["transcript:line-25"],
            "not_observed",
        );
        assert_eq!(
            h.engine.state.cue.as_ref().unwrap().sources[0].id,
            "transcript:line-25"
        );
        for _ in 0..20 {
            h.engine.advance(100);
        }
        assert!(
            h.requests.try_recv().is_err(),
            "no repeated evaluation of the same input"
        );
    }

    fn drain_without_another_request(h: &mut Harness) {
        let until = Instant::now() + Duration::from_secs(2);
        while h.engine.evaluation.as_ref().unwrap().worker.is_busy() {
            h.engine.advance(1);
            assert!(h.requests.try_recv().is_err(), "unexpected repeated work");
            assert!(Instant::now() < until, "fictional worker did not finish");
            std::thread::sleep(Duration::from_millis(1));
        }
        for _ in 0..20 {
            h.engine.advance(100);
        }
        assert!(
            h.requests.try_recv().is_err(),
            "clock must not invent speech"
        );
    }

    #[test]
    fn waiting_speech_is_discarded_by_controls_note_changes_and_freshness() {
        for change in [
            "pause",
            "stop",
            "new-session",
            "dismiss",
            "focus",
            "name",
            "sensitivity",
            "note-revision",
            "note-removal",
            "stale",
        ] {
            let mut h = Harness::new();
            let mut note = selected(crate::context::Provider::Granola, "review");
            h.engine.set_notes(vec![note.clone()]);
            h.approve_notes();
            let id = h.show();
            h.engine.inspect_cue(&id, true).unwrap();
            h.line("The next garden handoff is not clear.");
            h.request();
            h.line("There is more to clarify about the handoff.");
            match change {
                "pause" => {
                    h.engine.set_live_cues_paused(true).unwrap();
                    h.engine.set_live_cues_paused(false).unwrap();
                }
                "stop" => h.engine.end(),
                "new-session" => {
                    h.engine.end();
                    h.engine.start().unwrap();
                }
                "dismiss" => h.engine.respond(&id, Response::Dismiss).unwrap(),
                "focus" => h
                    .engine
                    .set_focus(vec!["Garden supplier approval".into()])
                    .unwrap(),
                "name" => h.engine.set_user_name(Some("Robin".into())).unwrap(),
                "sensitivity" => h.engine.set_sensitivity(Sensitivity::Focused),
                "note-revision" => {
                    note.revision += 1;
                    h.engine.set_notes(vec![note]);
                }
                "note-removal" => h.engine.set_notes(vec![]),
                "stale" => h.engine.advance(CUE_MS),
                _ => unreachable!(),
            }
            h.reply("resolved", None, &["transcript:line-2"], "possible");
            drain_without_another_request(&mut h);
            assert!(
                h.engine
                    .state
                    .cue
                    .as_ref()
                    .is_none_or(|cue| cue.resolved_by.is_none()),
                "cancelled resolution was applied after {change}"
            );
        }
    }

    #[test]
    fn failure_and_timeout_require_new_approval_even_after_new_speech() {
        for timeout in [false, true] {
            let mut h = Harness::with_budget(if timeout {
                Duration::from_millis(20)
            } else {
                Duration::from_secs(5)
            });
            h.line("The garden checklist needs an owner.");
            h.request();
            h.line("Who will take the garden checklist?");
            h.replies.send("{}".into()).unwrap(); // Cancelled first attempt.
            let latest = next_scheduled_request(&mut h);
            assert_eq!(latest.sources().last().unwrap().id, "transcript:line-2");
            let stale_review = h
                .engine
                .review_processing(ConversationScope::NewSpeechOnly, &[])
                .unwrap();
            if timeout {
                std::thread::sleep(Duration::from_millis(30));
                h.engine.advance(1); // Deadline expires while adapter remains occupied.
            }
            h.replies.send("{}".into()).unwrap(); // Malformed output must stay quiet.
            drain_without_another_request(&mut h);
            assert!(h.engine.state.cue.is_none());
            let unavailable = Some(EvaluationStatus::Unavailable(if timeout {
                EvaluationIssue::TimedOut
            } else {
                EvaluationIssue::InvalidReply
            }));
            assert_eq!(h.engine.evaluation_status(), unavailable);
            assert!(!h.engine.has_processing_permission());
            assert_eq!(
                h.engine.approve_processing(stale_review),
                Err(ProcessingError::StaleReview)
            );
            h.line("A new fictional topic begins.");
            h.engine.set_live_cues_paused(true).unwrap();
            h.engine.set_live_cues_paused(false).unwrap();
            drain_without_another_request(&mut h);
            assert_eq!(h.engine.evaluation_status(), unavailable);
            assert_eq!(h.engine.state.transcript.len(), 3);
            h.approve_notes();
            assert_eq!(h.engine.evaluation_status(), Some(EvaluationStatus::Idle));
            h.line("Fresh approval permits only new speech.");
            assert_eq!(
                h.request().sources().last().unwrap().id,
                "transcript:line-4"
            );
            h.reply("quiet", None, &["transcript:line-4"], "not_observed");
        }
    }

    #[test]
    fn quiet_is_an_explicit_fresh_decision_not_an_absent_cue() {
        assert_eq!(Engine::live().evaluation_status(), None);
        let mut h = Harness::new();
        assert_eq!(h.engine.evaluation_status(), Some(EvaluationStatus::Idle));
        h.line("The checklist has a confirmed owner.");
        h.request();
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Pending)
        );
        let revision = h.engine.state.revision;
        h.replies
            .send(
                serde_json::json!({
                    "action": "quiet", "cue": null, "sourceIds": ["transcript:line-1"],
                    "reason": "Fictional supported decision", "observedUse": "not_observed"
                })
                .to_string(),
            )
            .unwrap();
        let until = Instant::now() + Duration::from_secs(2);
        while h.engine.evaluation_status() == Some(EvaluationStatus::Pending) {
            assert!(Instant::now() < until);
            h.engine.poll_evaluation(); // No clock revision hides a missed status publication.
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(h.engine.state.revision > revision);
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Decided(EvaluationOutcome::Quiet))
        );
        assert!(h.engine.state.cue.is_none());
        h.engine.advance(CUE_MS);
        assert_eq!(h.engine.evaluation_status(), Some(EvaluationStatus::Idle));
        assert!(h.engine.has_processing_permission());
        assert!(h.requests.try_recv().is_err());
    }

    #[test]
    fn changed_context_clears_quiet_and_cancelled_replies_are_not_failures() {
        for change in ["speech", "notes", "pause", "revoke", "end"] {
            let mut h = Harness::new();
            h.line("Maya owns the checklist.");
            h.request();
            h.reply("quiet", None, &["transcript:line-1"], "not_observed");
            let revision = h.engine.state.revision;
            match change {
                "speech" => h.line("The next topic is the garden schedule."),
                "notes" => h
                    .engine
                    .set_notes(vec![selected(crate::context::Provider::File, "new")]),
                "pause" => h.engine.set_live_cues_paused(true).unwrap(),
                "revoke" => h.engine.revoke_processing(),
                "end" => h.engine.end(),
                _ => unreachable!(),
            }
            assert!(h.engine.state.revision > revision, "{change}");
            assert_ne!(
                h.engine.evaluation_status(),
                Some(EvaluationStatus::Decided(EvaluationOutcome::Quiet)),
                "{change}"
            );
            if change == "speech" {
                h.request();
                h.engine.set_live_cues_paused(true).unwrap();
                h.replies.send("invalid cancelled output".into()).unwrap();
            }
            drain_without_another_request(&mut h);
            assert_eq!(
                h.engine.evaluation_status(),
                Some(EvaluationStatus::Idle),
                "{change}"
            );
        }
    }

    #[test]
    fn provider_error_and_worker_exit_revoke_permission_without_affecting_capture() {
        struct Broken(bool);
        impl Evaluator for Broken {
            fn evaluate(&mut self, _: &Request, _: &Cancellation) -> Result<String, Failure> {
                assert!(!self.0, "fictional worker exit");
                Err(Failure::EvaluatorUnavailable)
            }
        }
        for exits in [false, true] {
            let worker = Worker::start(Broken(exits), Duration::from_secs(5)).unwrap();
            let mut h = Harness::new();
            h.engine = Engine::live_with_evaluator(worker, fictional_processor());
            h.engine.start().unwrap();
            h.approve_notes();
            h.engine
                .update_notes("Keep this manual note.".into())
                .unwrap();
            h.line("Someone should take the checklist.");
            h.settle();
            let unavailable = Some(EvaluationStatus::Unavailable(
                EvaluationIssue::WorkerUnavailable,
            ));
            assert_eq!(h.engine.evaluation_status(), unavailable);
            assert!(!h.engine.has_processing_permission());
            h.line("Capture continues without a provider restart.");
            assert_eq!(h.engine.state.transcript.len(), 2);
            assert_eq!(h.engine.state.status, Status::Running);
            assert_eq!(h.engine.state.notes, "Keep this manual note.");
            assert_eq!(h.engine.evaluation_status(), unavailable);
            assert!(h.engine.state.cue.is_none(), "no phrase-rule fallback");
            if exits {
                // An explicit reapproval cannot resurrect a stopped worker.
                h.approve_notes();
                h.line("No replacement worker is launched.");
                assert_eq!(h.engine.evaluation_status(), unavailable);
                assert!(!h.engine.has_processing_permission());
            }
            h.engine.end();
            h.engine.start().unwrap();
            assert_eq!(h.engine.evaluation_status(), Some(EvaluationStatus::Idle));
            assert!(!h.engine.has_processing_permission());
        }
    }

    #[test]
    fn sustained_input_replaces_waiting_work_and_never_applies_superseded_results() {
        // Controlled speech clock and explicit reply gates, not provider timings.
        for gap_ms in [250, 1_000, 3_000] {
            let mut h = Harness::new();
            h.line("The garden checklist still needs an owner.");
            let mut current = h.request();
            let mut submissions = 1;
            for _ in 0..3 {
                for _ in 0..8 {
                    h.engine.advance(gap_ms - 10);
                    h.line("We are still discussing the garden checklist.");
                }
                assert!(h.requests.try_recv().is_err(), "adapter must not overlap");
                let old_id = current.sources().last().unwrap().id.clone();
                h.replies
                    .send(
                        serde_json::json!({
                            "action": "show", "cue": "Who owns the garden checklist?",
                            "sourceIds": [old_id], "reason": "Fictional delayed reply",
                            "observedUse": "not_observed"
                        })
                        .to_string(),
                    )
                    .unwrap();
                current = next_scheduled_request(&mut h);
                submissions += 1;
                assert_eq!(
                    current.sources().last().unwrap().id,
                    format!("transcript:line-{}", h.next_line)
                );
                assert!(current.sources().len() <= RECENT_LINES);
                assert!(
                    h.engine.state.cue.is_none(),
                    "new speech invalidates old proposals"
                );
            }
            let latest_id = current.sources().last().unwrap().id.clone();
            h.reply(
                "show",
                Some("Who will take the garden checklist?"),
                &[&latest_id],
                "not_observed",
            );
            assert_eq!(
                h.engine.state.cue.as_ref().unwrap().sources[0].id,
                latest_id
            );
            assert_eq!(submissions, 4, "25 lines coalesce into four evaluations");
            drain_without_another_request(&mut h);
        }
    }

    #[test]
    fn stop_and_new_session_cannot_receive_the_previous_reply() {
        let mut h = Harness::new();
        h.line("The checklist handoff is still unclear.");
        let old = h.request();
        h.engine.end();
        assert!(h.engine.evaluation.as_ref().unwrap().pending.is_none());
        assert!(h.engine.evaluated_cue.is_none());
        h.engine.start().unwrap();
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-1"],
            "not_observed",
        );
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.state.transcript.is_empty());
        h.line("A new meeting begins.");
        assert!(!h.engine.has_processing_permission());
        assert!(h.requests.try_recv().is_err());
        let review = h
            .engine
            .review_processing(ConversationScope::RecentAndNewSpeech, &[])
            .unwrap();
        h.engine.approve_processing(review).unwrap();
        assert_ne!(old, h.request());
        h.reply("quiet", None, &["transcript:line-2"], "not_observed");
    }

    #[test]
    fn source_eviction_releases_held_copies_and_only_latest_speech_catches_up() {
        let mut h = Harness::new();
        let id = h.show();
        h.engine.inspect_cue(&id, true).unwrap();
        h.line("A later line.");
        h.request(); // Deliberately keep this evaluator occupied.
        for _ in 0..MAX_TRANSCRIPT_SEGMENTS {
            h.line("Another fictional line.");
        }
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.evaluated_cue.is_none());
        h.reply("resolved", None, &["transcript:line-2"], "not_observed");
        let latest = next_scheduled_request(&mut h);
        assert!(latest.existing_cue().is_none());
        assert_eq!(latest.sources().len(), RECENT_LINES);
        assert!(!latest
            .sources()
            .iter()
            .any(|source| source.id == "transcript:line-2"));
        assert!(h.engine.state.cue.is_none());
        let last_id = latest.sources().last().unwrap().id.clone();
        h.reply("quiet", None, &[&last_id], "not_observed");
        h.engine.advance(1_000);
        assert!(
            h.requests.try_recv().is_err(),
            "no replay of intermediate inputs"
        );
    }

    #[test]
    fn withdraw_clears_an_invalid_held_premise_without_calling_it_answered() {
        let mut h = Harness::new();
        let id = h.show();
        h.engine.inspect_cue(&id, true).unwrap();
        h.line("That checklist is no longer part of this release.");
        h.request();
        h.reply("withdraw", None, &["transcript:line-2"], "unknown");
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Decided(EvaluationOutcome::Withdrawn))
        );
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.state.notes.is_empty());
        assert!(h.engine.evaluated_cue.is_none());
    }

    #[test]
    fn stale_changed_invalid_and_unfocused_proposals_fail_quietly_without_rule_fallback() {
        for change in ["stale", "focus", "name", "notes", "invalid", "focused"] {
            let mut h = Harness::new();
            if change == "focused" {
                h.engine.set_sensitivity(Sensitivity::Focused);
                h.engine
                    .set_focus(vec!["Supplier review budget".into()])
                    .unwrap();
            }
            h.line("Someone should take the checklist soon.");
            h.request();
            assert!(
                h.engine.state.cue.is_none(),
                "rules must not run alongside evaluation"
            );
            match change {
                "stale" => h.engine.advance(CUE_MS),
                "focus" => h
                    .engine
                    .set_focus(vec!["Supplier review budget".into()])
                    .unwrap(),
                "name" => h.engine.set_user_name(Some("Robin".into())).unwrap(),
                "notes" => h.engine.set_notes(vec![ContextItem {
                    provider: crate::context::Provider::File,
                    source_id: "selected".into(),
                    title: "Earlier review".into(),
                    source_date: "2026-11-01".into(),
                    excerpt: "A newly selected fictional note.".into(),
                    revision: 1,
                }]),
                _ => (),
            }
            let id = if change == "invalid" {
                "invented"
            } else {
                "transcript:line-1"
            };
            h.reply(
                "show",
                Some("Who owns the checklist?"),
                &[id],
                "not_observed",
            );
            assert!(h.engine.state.cue.is_none(), "{change}");
            assert_eq!(
                h.engine.evaluation_status(),
                Some(if change == "invalid" {
                    EvaluationStatus::Unavailable(EvaluationIssue::InvalidReply)
                } else {
                    EvaluationStatus::Idle
                }),
                "{change}: suppression is not a quiet decision or an outage"
            );
            h.engine.advance(1_000);
            assert!(h.requests.try_recv().is_err(), "no timer retry");
        }
    }
}
