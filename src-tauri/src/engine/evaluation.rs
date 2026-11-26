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
pub use projection::{
    CaptureState, Issue, NoteSelection, NoteSummary, ProcessingSnapshot, ProcessingTracker,
    ProcessorSummary, Scope, SourceCapture, SourcePhase, SourceProblem, StartupState, StopTarget,
};

const RECENT_LINES: usize = 6;
const HISTORY_LINES: usize = 24;
const HISTORY_MS: u64 = 90_000;
const HISTORY_INPUT_BYTES: usize = 16_384;

/// What a lab decision had not seen when it was applied.
struct Lag {
    /// The newest transcript line the decision was evaluated through.
    through_segment: String,
    /// Lines that arrived after it before the decision was applied.
    lines: u64,
    /// The newest of those lines' `at_ms` minus the through line's `at_ms`:
    /// unseen speech on the session clock, not the reply's latency.
    ms: u64,
}

fn action_code(decision: &Decision) -> &'static str {
    match decision.action {
        Action::Show => "show",
        Action::Quiet => "quiet",
        Action::Resolved => "resolved",
        Action::Withdraw => "withdraw",
    }
}

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
    SignIn,
    Credentials,
    UsageLimit,
    Unreachable,
    /// The development settings name a model or effort this build lacks.
    Misconfigured,
    DevSettings,
    CallLimit,
    LabStopped,
    LabUnavailable,
    /// Anthropic refused the person's own key.
    KeyRejected,
    /// The person's own key was removed or the Keychain could not be read.
    KeyUnavailable,
    /// Anthropic is limiting requests for the person's own key (429).
    KeyRateLimited,
    /// The person's Anthropic account has no credit for more requests.
    Billing,
    /// The session's estimated spend cap was reached.
    SpendLimit,
    /// The session's request cap was reached, with the person's own key.
    RequestLimit,
}

/// The owner's rule for slow replies: one reply over the deadline is skipped
/// (no cue that time, its late result dropped); this many in a row stop cues
/// for the session. Every other failure stops at once.
pub const TIMEOUTS_TO_STOP: u8 = 2;

pub(super) struct State {
    worker: Worker,
    pending: Option<Pending>,
    // One coalesced speech notification, never a queue of copied requests.
    latest_speech_waiting: bool,
    permission: Permission,
    status: EvaluationStatus,
    outcome_at_ms: Option<u64>,
    timeouts_in_row: u8,
    min_gap_ms: u64,
    last_dispatch_ms: Option<u64>,
    requests_sent: u64,
    call_limit: Option<u64>,
    approval_by_setting: bool,
    misconfigured: bool,
    // The evaluated cue on screen: its id, words, and whether a held cue was
    // marked answered. Recorded as an earlier cue when it leaves.
    shown: Option<(String, String, bool)>,
    earlier: Vec<crate::cue_evaluator::EarlierCue>,
    lab: Option<std::sync::Arc<dyn crate::cue_evaluator::EvaluationLifecycle>>,
    lab_terminal: bool,
    shown_request: Option<(String, u64, u64)>,
}

struct Pending {
    request: Request,
    permission_generation: u64,
    // For the development timing log: the request number and when it left.
    number: u64,
    sent: std::time::Instant,
    /// The session time it was sent: which lines were fresh is judged as of
    /// then when its reply comes back, so a line ageing out is no change.
    sent_at_ms: u64,
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
            timeouts_in_row: 0,
            min_gap_ms: 0,
            last_dispatch_ms: None,
            requests_sent: 0,
            call_limit: None,
            approval_by_setting: false,
            misconfigured: false,
            shown: None,
            earlier: Vec::new(),
            lab: None,
            lab_terminal: false,
            shown_request: None,
        });
        engine
    }

    /// The lab's settlement rules: the lab link, or the in-app connection.
    pub(crate) fn with_lab_lifecycle(
        mut self,
        lifecycle: std::sync::Arc<dyn crate::cue_evaluator::EvaluationLifecycle>,
    ) -> Self {
        self.evaluation.as_mut().expect("registered evaluator").lab = Some(lifecycle);
        self
    }

    pub(super) fn model_provider(&self) -> Option<String> {
        self.evaluation.as_ref().map(|s| {
            let name = &s.permission.processor.disclosure.name;
            if name.starts_with("Claude") {
                "Claude".into()
            } else if name.starts_with("OpenAI") {
                "OpenAI".into()
            } else if name.starts_with("Gemini") {
                "Gemini".into()
            } else {
                name.clone()
            }
        })
    }
    pub(super) fn is_lab_evaluator(&self) -> bool {
        self.evaluation.as_ref().is_some_and(|s| {
            matches!(
                s.permission.processor.id.as_str(),
                "lab-subscription"
                    | "lab-api"
                    | "lab-api-selected-prior-v2"
                    | "lab-api-selected-prior-attested-v1"
            )
        })
    }

    /// Any in-app own-key provider connection (Anthropic, OpenAI, or Gemini).
    pub(crate) fn is_own_key(&self) -> bool {
        self.evaluation.as_ref().is_some_and(|s| {
            matches!(
                s.permission.processor.id.as_str(),
                crate::anthropic_api::PROCESSOR_ID
                    | crate::openai_api::PROCESSOR_ID
                    | crate::gemini_api::PROCESSOR_ID
            )
        })
    }

    /// The lab backend that sends conversation text to the paid Anthropic
    /// API. A launch setting can never approve it; only a review can.
    #[cfg_attr(
        not(all(
            debug_assertions,
            feature = "lab-evaluator",
            feature = "native-audio-spike"
        )),
        allow(dead_code)
    )]
    pub(crate) fn is_lab_api(&self) -> bool {
        self.evaluation.as_ref().is_some_and(|s| {
            matches!(
                s.permission.processor.id.as_str(),
                "lab-api" | "lab-api-selected-prior-v2" | "lab-api-selected-prior-attested-v1"
            )
        })
    }

    /// Only accepted speech coalesces. All controls retain their cancellation
    /// path; ordinary Claude constructors never opt into this policy.
    pub(super) fn speech_changed(&mut self) {
        if self.evaluation.as_ref().is_some_and(|s| s.lab.is_some()) {
            self.evaluation_revision = self.evaluation_revision.wrapping_add(1);
        } else {
            self.invalidate_evaluation();
        }
    }

    #[cfg(any(test, feature = "lab-evaluator"))]
    #[allow(
        dead_code,
        reason = "native facade activation and API usage vary by build/test configuration"
    )]
    pub(crate) fn lab_cue_metadata(&self, id: &str) -> Option<(u64, u64)> {
        self.evaluation
            .as_ref()?
            .shown_request
            .as_ref()
            .filter(|(cue, _, _)| cue == id)
            .map(|(_, request, at)| (*request, *at))
    }

    /// A backend that cannot be used as configured: the reason stays shown,
    /// and no review can be prepared, so nothing can be approved or sent.
    #[cfg(any(test, all(debug_assertions, feature = "lab-evaluator")))]
    #[allow(
        dead_code,
        reason = "native facade activation and API usage vary by build/test configuration"
    )]
    pub(crate) fn lab_unavailable(mut self) -> Self {
        if let Some(state) = &mut self.evaluation {
            state.misconfigured = true;
            state.status = EvaluationStatus::Unavailable(EvaluationIssue::LabUnavailable);
        }
        self
    }

    pub fn misconfigured(mut self) -> Self {
        if let Some(state) = &mut self.evaluation {
            state.misconfigured = true;
            state.status = EvaluationStatus::Unavailable(EvaluationIssue::Misconfigured);
        }
        self
    }

    /// At least this long between two requests on the session clock. Newer
    /// speech waits, coalesced, until the gap has passed.
    pub fn with_min_gap_ms(mut self, gap: u64) -> Self {
        if let Some(state) = &mut self.evaluation {
            state.min_gap_ms = gap;
        }
        self
    }

    /// A session-wide ceiling; turning permission off/on never resets it.
    pub(crate) fn set_model_call_limit(&mut self, limit: u64) {
        if let Some(state) = &mut self.evaluation {
            state.call_limit = Some(limit);
        }
    }

    pub(crate) fn model_calls_exhausted(&self) -> bool {
        self.evaluation.as_ref().is_some_and(|state| {
            state
                .call_limit
                .is_some_and(|limit| state.requests_sent >= limit)
        })
    }

    #[cfg(all(
        debug_assertions,
        any(feature = "claude-cli", feature = "lab-evaluator"),
        feature = "native-audio-spike"
    ))]
    pub(crate) fn invalid_dev_model_settings(&mut self) {
        self.revoke_processing();
        if let Some(state) = &mut self.evaluation {
            state.misconfigured = true;
            state.status = EvaluationStatus::Unavailable(EvaluationIssue::DevSettings);
        }
    }

    /// Records the evaluated cue that has left the screen, with how it ended.
    fn note_ended_cue(&mut self, end: Option<crate::cue_evaluator::CueEnd>) {
        use crate::cue_evaluator::{CueEnd, EarlierCue, MAX_EARLIER_CUES};
        let on_screen = self.state.cue.as_ref().map(|cue| cue.id.clone());
        let Some(state) = &mut self.evaluation else {
            return;
        };
        let Some((id, text, resolved)) = state.shown.clone() else {
            return;
        };
        if end.is_none() && on_screen.as_deref() == Some(id.as_str()) {
            return;
        }
        let state_end = end.unwrap_or(if resolved {
            CueEnd::Resolved
        } else {
            CueEnd::Expired
        });
        state.shown = None;
        state.earlier.push(EarlierCue {
            text,
            state: state_end,
        });
        if state.earlier.len() > MAX_EARLIER_CUES {
            state.earlier.remove(0);
        }
    }

    /// None means this engine has no evaluator. Permission and capture state
    /// remain separate; Idle alone never means processing is enabled.
    pub fn evaluation_status(&self) -> Option<EvaluationStatus> {
        self.evaluation.as_ref().map(|state| state.status)
    }

    fn set_evaluation_status(&mut self, status: EvaluationStatus) {
        if let Some(state) = &mut self.evaluation {
            // A misconfigured backend keeps saying so; nothing clears it.
            let status = if state.misconfigured {
                state.status
            } else if state.lab_terminal && status == EvaluationStatus::Idle {
                EvaluationStatus::Unavailable(EvaluationIssue::LabStopped)
            } else {
                status
            };
            if state.status != status {
                state.status = status;
                state.outcome_at_ms = None;
                self.changed();
            }
        }
    }

    fn fail_evaluation(&mut self, failure: Failure) {
        // A lab request's own expiry is skipped before this point, once the
        // link has retired it. A lab link that ended with Expired reaches here
        // and stops the run as timed out.
        if failure == Failure::Expired && self.evaluation.as_ref().is_none_or(|s| s.lab.is_none()) {
            let state = self.evaluation.as_mut().expect("evaluation failed");
            state.timeouts_in_row = state.timeouts_in_row.saturating_add(1);
            if state.timeouts_in_row < TIMEOUTS_TO_STOP {
                // Skipped: no cue this time, and nothing else changes.
                return;
            }
        }
        let issue = match failure {
            Failure::InvalidInput => EvaluationIssue::InputLimit,
            Failure::InvalidDecision => EvaluationIssue::InvalidReply,
            Failure::Expired => EvaluationIssue::TimedOut,
            Failure::EvaluatorUnavailable | Failure::WorkerUnavailable => {
                EvaluationIssue::WorkerUnavailable
            }
            Failure::SignIn if self.is_own_key() => EvaluationIssue::KeyRejected,
            Failure::SignIn => EvaluationIssue::SignIn,
            Failure::Credentials if self.is_own_key() => EvaluationIssue::KeyUnavailable,
            Failure::SpendLimit => EvaluationIssue::SpendLimit,
            Failure::Credentials => EvaluationIssue::Credentials,
            Failure::UsageLimit if self.is_own_key() => EvaluationIssue::KeyRateLimited,
            Failure::Billing if self.is_own_key() => EvaluationIssue::Billing,
            Failure::UsageLimit | Failure::Billing => EvaluationIssue::UsageLimit,
            Failure::Unreachable => EvaluationIssue::Unreachable,
            // Only the lab can refuse, and there the request is skipped
            // before this point; anywhere else it is an invalid reply.
            Failure::Refused | Failure::OutputLimit => EvaluationIssue::InvalidReply,
            // Superseded work and controls are not provider outages.
            Failure::Busy | Failure::Cancelled | Failure::Stale
                if self.evaluation.as_ref().is_some_and(|s| s.lab.is_some()) =>
            {
                EvaluationIssue::WorkerUnavailable
            }
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
            if let Some(lab) = state.lab.as_ref().filter(|lab| lab.ends_run_on_control()) {
                if state.pending.is_some() || state.permission.grant.is_some() {
                    state.lab_terminal = true;
                    lab.cancel();
                }
            }
            state.latest_speech_waiting = false;
            state.worker.cancel_pending();
            if let Some(pending) = state.pending.take() {
                // Drain the cancelled ticket without waiting for the adapter.
                // Stop need not receive another clock tick to release the
                // caller's copies of the request and its source text.
                let _ = state.worker.poll(&pending.request);
                // Stop, pause, turning the connection off and newer speech
                // all end a request this way; the log says it was cancelled.
                if crate::timing_log::enabled() {
                    crate::timing_log::record(crate::timing_log::Event::EvaluationResult {
                        session: self.generation,
                        request: pending.number,
                        outcome: "cancelled",
                        latency_ms: u64::try_from(pending.sent.elapsed().as_millis())
                            .unwrap_or(u64::MAX),
                        failure: None,
                        action: None,
                        through_segment: None,
                        lag_lines: None,
                        lag_ms: None,
                        elapsed_ms: self.state.elapsed_ms,
                    });
                }
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
    /// An explicitly reviewed transcript-only configuration may also supply a
    /// bounded history suffix; fresh speech still gates every request.
    /// Never include manual notes, focus text, or identity settings. Fail closed
    /// on the worker's per-source and aggregate byte bounds without truncation.
    fn evaluation_request(&self) -> Result<Option<Request>, Failure> {
        self.evaluation_request_as_of(self.state.elapsed_ms)
    }

    /// The request as it would have been sent at `as_of_ms`: only which lines
    /// count as fresh depends on it; everything else is as it is now.
    fn evaluation_request_as_of(&self, as_of_ms: u64) -> Result<Option<Request>, Failure> {
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
                as_of_ms.saturating_sub(line.at_ms) < CUE_MS
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
                asked: cue.kind == super::ASKED,
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
        let make_request = |sources| {
            Request::new(
                self.generation,
                self.evaluation_revision,
                sources,
                existing.clone(),
            )?
            .with_listener(self.state.user_name.clone(), state.earlier.clone())
        };
        let mut request = make_request(sources)?;
        if permission.processor.bounded_history {
            // Mandatory cue evidence and the current fresh slice are never
            // truncated. This mode cannot approve notes, even indirectly.
            if request.sources().len() > HISTORY_LINES
                || !grant.notes.is_empty()
                || request.prompt_input()?.len() > HISTORY_INPUT_BYTES
            {
                return Err(Failure::InvalidInput);
            }
            if request.sources().iter().any(|source| {
                !self
                    .state
                    .transcript
                    .iter()
                    .rev()
                    .any(|line| matches_source(line, source))
            }) {
                return Ok(None);
            }
            // Optional history is a content-independent suffix. On pressure,
            // stop before the oldest optional line; keep mandatory evidence.
            for line in self
                .state
                .transcript
                .iter()
                .rev()
                .filter(|line| {
                    as_of_ms.saturating_sub(line.at_ms) < HISTORY_MS
                        && self.cues_after_ms.is_none_or(|after| line.at_ms > after)
                        && grant.after_ms.is_none_or(|after| line.at_ms > after)
                })
                .take(HISTORY_LINES)
            {
                if request
                    .sources()
                    .iter()
                    .any(|source| matches_source(line, source))
                {
                    continue;
                }
                if request.sources().len() == HISTORY_LINES {
                    break;
                }
                let mut trial = request.sources().to_vec();
                trial.push(transcript_source(line));
                trial.sort_by_key(source_time);
                // Existing per-source/count/content limits apply too. Optional
                // context pressure keeps the shorter suffix, never a partial line.
                let Ok(next) = make_request(trial) else { break };
                if next.prompt_input()?.len() > HISTORY_INPUT_BYTES {
                    break;
                }
                request = next;
            }
            let mut ordered = request.sources().to_vec();
            ordered.sort_by_key(source_time);
            request = make_request(ordered)?;
        }
        Ok(Some(request))
    }

    /// Returns true when `text` is only a trivial 1-2 word backchannel / filler
    /// acknowledgement and no question or listener name-mention rule applies.
    pub(super) fn should_skip_filler_evaluation(&self, text: &str, asked_matched: bool) -> bool {
        if asked_matched || text.contains('?') {
            return false;
        }
        is_trivial_filler_line(text, self.state.user_name.as_deref())
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
        if let Some(failure) = self
            .evaluation
            .as_ref()
            .and_then(|s| s.lab.as_ref())
            .and_then(|link| link.terminal())
        {
            if self.evaluation.as_ref().is_some_and(|s| !s.lab_terminal) {
                self.fail_evaluation(failure);
                if let Some(s) = &mut self.evaluation {
                    s.lab_terminal = true;
                }
            }
        }
        self.note_ended_cue(None);
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
        let now = self.state.elapsed_ms;
        if self.evaluation.as_ref().is_none_or(|state| {
            !state.latest_speech_waiting
                || state.worker.is_busy()
                || state
                    .last_dispatch_ms
                    .is_some_and(|at| now.saturating_sub(at) < state.min_gap_ms)
        }) {
            return;
        }
        if self.model_calls_exhausted() {
            self.revoke_processing();
            let issue = if self.is_own_key() {
                EvaluationIssue::RequestLimit
            } else {
                EvaluationIssue::CallLimit
            };
            self.set_evaluation_status(EvaluationStatus::Unavailable(issue));
            crate::timing_log::record(crate::timing_log::Event::EvaluationStopped {
                session: self.generation,
                failure: "call_limit",
                elapsed_ms: now,
            });
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
                    state.last_dispatch_ms = Some(now);
                    state.requests_sent += 1;
                    let number = state.requests_sent;
                    if crate::timing_log::enabled() {
                        let lines = request
                            .sources()
                            .iter()
                            .filter(|source| source_time(source).is_some())
                            .collect::<Vec<_>>();
                        crate::timing_log::record(crate::timing_log::Event::EvaluationRequested {
                            session: self.generation,
                            request: number,
                            through_segment: lines
                                .iter()
                                .max_by_key(|source| source_time(source))
                                .map(|source| {
                                    source
                                        .id
                                        .strip_prefix("transcript:")
                                        .unwrap_or(&source.id)
                                        .to_string()
                                })
                                .unwrap_or_default(),
                            lines: lines.len(),
                            has_cue: request.existing_cue().is_some(),
                            elapsed_ms: now,
                        });
                    }
                    state.pending = Some(Pending {
                        request,
                        permission_generation: state.permission.generation,
                        number,
                        sent: std::time::Instant::now(),
                        sent_at_ms: self.state.elapsed_ms,
                    });
                    self.set_evaluation_status(EvaluationStatus::Pending);
                }
                Err(Failure::Busy) => state.latest_speech_waiting = true,
                Err(error) => self.fail_evaluation(error),
            }
        }
    }

    fn poll_pending_evaluation(&mut self) {
        // Compared as of when it was sent: new speech, a changed cue, notes,
        // name or focus still make the reply stale, but a line passing the
        // fresh/history age boundary while the model answers does not.
        // Applying it still needs a cited
        // line that is fresh now.
        let (sent_at_ms, is_lab) = self
            .evaluation
            .as_ref()
            .and_then(|state| {
                state
                    .pending
                    .as_ref()
                    .map(|pending| (pending.sent_at_ms, state.lab.is_some()))
            })
            .unwrap_or((self.state.elapsed_ms, false));
        let (current, result) = if is_lab {
            let state = self.evaluation.as_mut().expect("evaluation checked");
            let pending = state.pending.as_ref().expect("pending checked");
            let permission_current = pending.permission_generation == state.permission.generation;
            if !permission_current {
                state.worker.cancel_pending();
            }
            let Some(result) = state.worker.poll_submitted() else {
                return;
            };
            let current = match self.evaluation_request_as_of(sent_at_ms) {
                Ok(request) => request,
                Err(error) => {
                    self.fail_evaluation(error);
                    return;
                }
            };
            (current, result)
        } else {
            let current = match self.evaluation_request_as_of(sent_at_ms) {
                Ok(request) => request,
                Err(error) => {
                    self.fail_evaluation(error);
                    return;
                }
            };
            let state = self.evaluation.as_mut().expect("evaluation checked");
            let pending = state.pending.as_ref().expect("pending checked");
            let permission_current = pending.permission_generation == state.permission.generation;
            if !permission_current || current.is_none() {
                state.worker.cancel_pending();
            }
            let Some(result) = state
                .worker
                .poll(current.as_ref().unwrap_or(&pending.request))
            else {
                return;
            };
            (current, result)
        };
        let state = self.evaluation.as_mut().expect("evaluation checked");
        let pending = state.pending.as_ref().expect("pending checked");
        let permission_current = pending.permission_generation == state.permission.generation;
        let submitted = state.pending.take().expect("pending checked");
        // A reply that completed before the deadline but was read after it is
        // never applied; only its action is logged.
        let late = if result == Err(Failure::Expired) {
            state.worker.take_late_decision()
        } else {
            None
        };
        self.set_evaluation_status(EvaluationStatus::Idle);
        // Lab only: a reply to a transcript that has since only grown is
        // still applied, with its lag logged. Ordinary mode cancels on new
        // speech and applies only an exact match.
        let lag = match (
            &current,
            self.evaluation.as_ref().is_some_and(|s| s.lab.is_some()),
        ) {
            (Some(current), true) if permission_current => {
                self.lab_lag(&submitted.request, current)
            }
            _ => None,
        };
        let applies =
            permission_current && (current.as_ref() == Some(&submitted.request) || lag.is_some());
        if let Some(link) = self.evaluation.as_ref().and_then(|s| s.lab.clone()) {
            use crate::cue_evaluator::Settlement;
            let verdict = match &result {
                Err(Failure::Expired) => Settlement::Expired,
                Err(Failure::Refused | Failure::OutputLimit) => Settlement::Retired,
                Err(_) => Settlement::Failed,
                Ok(_) if applies => Settlement::Current,
                Ok(_) => Settlement::StaleSuccess,
            };
            let settlement = link.settle(&submitted.request, verdict);
            if let Err(failure) = result.as_ref() {
                self.record_result(&submitted, &result, true, late.as_ref(), None);
                match settlement {
                    // The link retired only this request: a recorded "no
                    // decision in time", and the run continues. The session
                    // call limit and the broker's dispatch cap still bound it.
                    Ok(())
                        if matches!(
                            *failure,
                            Failure::Expired | Failure::Refused | Failure::OutputLimit
                        ) => {}
                    // An expiry the link could not retire ends the run.
                    Err(link_failure)
                        if matches!(
                            *failure,
                            Failure::Expired | Failure::Refused | Failure::OutputLimit
                        ) =>
                    {
                        self.fail_evaluation(link_failure)
                    }
                    _ => self.fail_evaluation(*failure),
                }
                return;
            }
            if let Err(failure) = settlement {
                self.fail_evaluation(failure);
                return;
            }
        }
        self.record_result(&submitted, &result, applies, late.as_ref(), lag.as_ref());
        if !applies
            && result
                .as_ref()
                .is_ok_and(|decision| decision.action == Action::Show)
        {
            self.drop_show(submitted.number, "stale_request");
        }
        if current.is_some() && applies {
            // Cited sources resolve against the input the reply was made from;
            // the guards above keep every one of them in the transcript.
            match result {
                Ok(decision) => {
                    self.apply_evaluation(&submitted.request, decision, submitted.number)
                }
                Err(error) => self.fail_evaluation(error),
            }
        }
    }

    /// How far the transcript moved on while a lab reply was pending, if the
    /// submitted input is still an append-only prefix of the current one:
    /// same session, existing cue, listener and earlier cues, and every
    /// submitted line still present with identical id, text and time. Any
    /// edit, removal or cue change makes the reply stale.
    fn lab_lag(&self, submitted: &Request, current: &Request) -> Option<Lag> {
        if submitted.session_id() != current.session_id()
            || submitted.existing_cue() != current.existing_cue()
            || submitted.user_name() != current.user_name()
            || submitted.earlier_cues() != current.earlier_cues()
            || submitted
                .sources()
                .iter()
                .any(|s| source_time(s).is_none() && !current.sources().contains(s))
        {
            return None;
        }
        let transcript = &self.state.transcript;
        let lines: Vec<_> = submitted
            .sources()
            .iter()
            .filter(|s| source_time(s).is_some())
            .collect();
        if !lines
            .iter()
            .all(|s| transcript.iter().any(|line| matches_source(line, s)))
        {
            return None;
        }
        let newest = lines.iter().max_by_key(|s| source_time(s))?;
        let at = transcript
            .iter()
            .position(|line| matches_source(line, newest))?;
        let newer = &transcript[at + 1..];
        Some(Lag {
            through_segment: transcript[at].id.clone(),
            lines: newer.len() as u64,
            ms: newer
                .last()
                .map_or(0, |line| line.at_ms.saturating_sub(transcript[at].at_ms)),
        })
    }

    /// The development timing log's record of a reply. Ids and codes only.
    /// A stale reply, or one read after the deadline, keeps its action code
    /// so the decision is not lost; it is never applied.
    fn record_result(
        &self,
        submitted: &Pending,
        result: &Result<Decision, Failure>,
        applies: bool,
        late: Option<&Decision>,
        lag: Option<&Lag>,
    ) {
        if !crate::timing_log::enabled() {
            return;
        }
        let action = match result {
            Ok(decision) if !applies => Some(action_code(decision)),
            Err(Failure::Expired) => late.map(action_code),
            _ => None,
        };
        let (outcome, failure) = match result {
            _ if !applies => ("stale", None),
            Ok(decision) => (action_code(decision), None),
            Err(Failure::Cancelled | Failure::Busy) => ("cancelled", None),
            Err(Failure::Stale) => ("stale", None),
            Err(Failure::Refused) => ("refused", None),
            Err(Failure::OutputLimit) => ("output_limit", None),
            Err(failure) => (
                "failed",
                Some(match failure {
                    Failure::Expired => "timeout",
                    Failure::InvalidDecision => "invalid_reply",
                    Failure::UsageLimit => "rate_limited",
                    Failure::Billing => "billing",
                    Failure::InvalidInput => "input_limit",
                    Failure::SignIn => "sign_in",
                    Failure::Credentials => "credentials",
                    _ => "unavailable",
                }),
            ),
        };
        crate::timing_log::record(crate::timing_log::Event::EvaluationResult {
            session: self.generation,
            request: submitted.number,
            outcome,
            latency_ms: u64::try_from(submitted.sent.elapsed().as_millis()).unwrap_or(u64::MAX),
            failure,
            action,
            through_segment: lag.map(|lag| lag.through_segment.clone()),
            lag_lines: lag.map(|lag| lag.lines),
            lag_ms: lag.map(|lag| lag.ms),
            elapsed_ms: self.state.elapsed_ms,
        });
    }

    fn apply_evaluation(&mut self, request: &Request, decision: Decision, number: u64) {
        // A reply in time ends any run of timeouts.
        if let Some(state) = &mut self.evaluation {
            state.timeouts_in_row = 0;
        }
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
            if decision.action == Action::Show {
                self.drop_show(number, "stale");
            }
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
                // A line that asked the user by name already raised "Asked
                // you"; a model cue from it would ask them twice.
                let from_asked_line = cited.iter().any(|source| {
                    source
                        .id
                        .strip_prefix("transcript:")
                        .is_some_and(|id| self.asked_lines.iter().any(|line| line == id))
                });
                // A fresh cited line that puts a question to the user by
                // name, but raised no "Asked you" (a cue was being read),
                // skips the pause, unless a cue citing it was dismissed.
                let asked_of_user = request.user_name().is_some_and(|name| {
                    cited.iter().any(|source| {
                        source_time(source).is_some_and(|at| now.saturating_sub(at) < CUE_MS)
                            && !self.dismissed_sources.contains(&source.id)
                            && super::asked_of(name, &source.text).is_some()
                    })
                });
                // The pause runs from when the last cue ended to now, not to
                // when the cited line started: a line said just before it
                // ended may still raise a cue once it is over.
                let dropped = if self.state.cue.is_some() {
                    Some("slot")
                } else if from_asked_line {
                    Some("asked")
                } else if now.saturating_sub(at_ms) >= CUE_MS {
                    Some("expired_source")
                } else if now < self.model_pause_until && !asked_of_user {
                    Some("cooldown")
                } else if matches!(self.state.sensitivity, Sensitivity::Focused) && !about_focus {
                    Some("focus")
                } else if self.last_shown.iter().any(|(key, shown)| {
                    *key == repeat_key && now.saturating_sub(*shown) < REPEAT_MS
                }) {
                    Some("repeat")
                } else {
                    None
                };
                if let Some(reason) = dropped {
                    self.drop_show(number, reason);
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
                    resolved_by: None,
                    note: None,
                    about_focus,
                });
                if crate::timing_log::enabled() {
                    crate::timing_log::record(crate::timing_log::Event::CueDecision {
                        session: self.generation,
                        cue: id.clone(),
                        kind: "Suggestion".into(),
                        source: "evaluated",
                        decider: "model",
                        request: Some(number),
                        // Ids only: the cue's words may come from the focus
                        // or the session name.
                        question: None,
                        source_id: Some(first.id.clone()),
                        elapsed_ms: now,
                    });
                }
                self.evaluation.as_mut().unwrap().shown_request = Some((id.clone(), number, now));
                self.evaluated_cue = Some((id.clone(), cited));
                self.note_ended_cue(None);
                if let Some(state) = &mut self.evaluation {
                    state.shown =
                        Some((id, self.state.cue.as_ref().unwrap().question.clone(), false));
                }
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
                // The model may say a question asked of the user was
                // answered, but not withdraw it: a topic change does not
                // take back a question someone put to them.
                if decision.action == Action::Withdraw && cue.kind == super::ASKED {
                    return;
                }
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
                    if let Some(shown) = self.evaluation.as_mut().and_then(|s| s.shown.as_mut()) {
                        shown.2 = true;
                    }
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
                    self.note_ended_cue(Some(if decision.action == Action::Resolved {
                        crate::cue_evaluator::CueEnd::Resolved
                    } else {
                        crate::cue_evaluator::CueEnd::Withdrawn
                    }));
                    self.cooldown_until = self.state.elapsed_ms.saturating_add(self.cooldown());
                    self.pause_model_after(self.state.elapsed_ms, false);
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

    /// A model's `show` that is not displayed, with a fixed reason and no
    /// cue text: `slot`, `asked` (it cites a line that raised "Asked you"),
    /// `expired_source`, `cooldown`, `focus`, `repeat`, `stale` when no
    /// cited line was fresh speech, or `stale_request` when the context
    /// changed while the model answered (new speech, the cue on screen,
    /// notes, name or focus).
    fn drop_show(&mut self, request: u64, reason: &'static str) {
        #[cfg(test)]
        {
            self.last_dropped = Some(reason);
        }
        if crate::timing_log::enabled() {
            crate::timing_log::record(crate::timing_log::Event::CueDropped {
                session: self.generation,
                request,
                reason,
                elapsed_ms: self.state.elapsed_ms,
            });
        }
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
            self.pause_model_after(self.state.elapsed_ms, false);
            return true;
        }
        false
    }

    pub(super) fn refresh_cue_speakers(&mut self, speaker_id: u32, resolved: &str) {
        let renamed_ids: std::collections::HashSet<String> = self
            .state
            .transcript
            .iter()
            .filter(|line| line.speaker_id == Some(speaker_id))
            .map(|line| format!("transcript:{}", line.id))
            .collect();
        if renamed_ids.is_empty() {
            return;
        }
        let update_sources = |sources: &mut [Source]| -> bool {
            let mut changed = false;
            for source in sources {
                if renamed_ids.contains(&source.id) {
                    if let Provenance::Transcript { speaker, .. } = &mut source.provenance {
                        *speaker = resolved.to_string();
                        changed = true;
                    }
                }
            }
            changed
        };
        if let Some((_, sources)) = &mut self.evaluated_cue {
            update_sources(sources);
        }
        if let Some(cue) = &mut self.state.cue {
            if !cue.sources.is_empty() && update_sources(&mut cue.sources) {
                cue.evidence = evidence(&cue.sources);
            }
            if let Some(resolved_by) = &mut cue.resolved_by {
                if !resolved_by.sources.is_empty() && update_sources(&mut resolved_by.sources) {
                    resolved_by.evidence = evidence(&resolved_by.sources);
                }
            }
        }
    }
}

pub(super) fn transcript_source(line: &Segment) -> Source {
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

fn normalize_turn_token(word: &str) -> String {
    word.replace(['’', '‘'], "'")
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
}

fn is_trivial_filler_line(text: &str, user_name: Option<&str>) -> bool {
    const SINGLE_FILLER_WORDS: &[&str] = &[
        "yeah", "yea", "yep", "yup", "yes", "no", "nope", "nah", "ok", "okay", "so", "right",
        "sure", "alright", "uh", "um", "umm", "er", "erm", "ah", "oh", "hmm", "hm", "mm", "mmm",
        "huh", "uh-huh", "uhuh", "mm-hmm", "mmhmm", "mhm", "uh-uh", "nuh-uh", "well", "gotcha",
        "thanks",
    ];
    const TWO_WORD_FILLERS: &[(&str, &str)] = &[
        ("all", "right"),
        ("got", "it"),
        ("i", "see"),
        ("thank", "you"),
        ("sounds", "good"),
        ("makes", "sense"),
        ("fair", "enough"),
        ("no", "problem"),
        ("no", "worries"),
    ];

    let tokens: Vec<String> = text
        .split_whitespace()
        .map(normalize_turn_token)
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() || tokens.len() > 2 {
        return false;
    }
    if let Some(name) = user_name {
        let mentions_name = name
            .split_whitespace()
            .map(normalize_turn_token)
            .filter(|word| !word.is_empty())
            .any(|word| tokens.iter().any(|token| token == &word));
        if mentions_name {
            return false;
        }
    }
    match tokens.as_slice() {
        [one] => SINGLE_FILLER_WORDS.contains(&one.as_str()),
        [first, second] => {
            (SINGLE_FILLER_WORDS.contains(&first.as_str())
                && SINGLE_FILLER_WORDS.contains(&second.as_str()))
                || TWO_WORD_FILLERS
                    .iter()
                    .any(|(a, b)| first == *a && second == *b)
        }
        _ => false,
    }
}

#[cfg(test)]
mod lab_tests;

#[cfg(test)]
mod tests {
    mod history_tests;
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
            let reply = self
                .replies
                .recv()
                .map_err(|_| Failure::EvaluatorUnavailable)?;
            // A fictional lab provider declining this one request.
            if reply == REFUSED {
                return Err(Failure::Refused);
            }
            if reply == OUTPUT_LIMIT {
                return Err(Failure::OutputLimit);
            }
            Ok(reply)
        }
    }
    pub(super) const REFUSED: &str = "\u{0}refused";
    pub(super) const OUTPUT_LIMIT: &str = "\u{0}output-limit";
    pub(super) struct Harness {
        pub(super) engine: Engine,
        pub(super) requests: mpsc::Receiver<Request>,
        pub(super) replies: mpsc::Sender<String>,
        next_line: usize,
    }
    impl Harness {
        pub(super) fn new() -> Self {
            Self::with_budget(Duration::from_secs(5))
        }
        pub(super) fn with_budget(budget: Duration) -> Self {
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
        /// Approved after the user's name is set, as a person would.
        fn named(name: &str) -> Self {
            let mut h = Self::unapproved(fictional_processor(), Duration::from_secs(5));
            h.engine.set_user_name(Some(name.into())).unwrap();
            let review = h
                .engine
                .review_processing(ConversationScope::NewSpeechOnly, &[])
                .unwrap();
            h.engine.approve_processing(review).unwrap();
            h
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
        pub(super) fn line(&mut self, text: &str) {
            self.engine.advance(10);
            self.next_line += 1;
            self.engine
                .ingest(
                    self.engine.session(),
                    Segment {
                        id: format!("line-{}", self.next_line),
                        at_ms: self.engine.state.elapsed_ms,
                        speaker: "Maya".into(),
                        speaker_id: None,
                        text: text.into(),
                    },
                )
                .unwrap();
        }
        /// A line said at `at_ms` that reaches the engine at `arrives_ms`, as a
        /// streamed final does, a second or more after it began.
        fn said(&mut self, at_ms: u64, arrives_ms: u64, text: &str) {
            self.until(arrives_ms);
            self.next_line += 1;
            self.engine
                .ingest(
                    self.engine.session(),
                    Segment {
                        id: format!("line-{}", self.next_line),
                        at_ms,
                        speaker: "Speaker".into(),
                        speaker_id: None,
                        text: text.into(),
                    },
                )
                .unwrap();
        }
        /// Moves the session clock forward to `at_ms`, if it is not past it.
        fn until(&mut self, at_ms: u64) {
            // Settling a reply moves the clock a few milliseconds on its own.
            let now = self.engine.state.elapsed_ms;
            self.engine.advance(at_ms.saturating_sub(now));
        }
        pub(super) fn request(&self) -> Request {
            self.requests
                .recv_timeout(Duration::from_secs(2))
                .expect("fictional request")
        }
        fn reply(&mut self, action: &str, cue: Option<&str>, ids: &[&str]) {
            self.replies
                .send(
                    serde_json::json!({
                        "action": action, "cue": cue, "sourceIds": ids,
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
            );
            self.engine.state.cue.as_ref().unwrap().id.clone()
        }
    }

    #[test]
    fn session_cap_stops_before_extra_dispatch_and_cannot_be_reset_by_review() {
        let mut h = Harness::new();
        h.engine.set_model_call_limit(1);
        let stale = h
            .engine
            .review_processing(ConversationScope::NewSpeechOnly, &[])
            .unwrap();
        h.line("Who owns the fictional checklist?");
        h.request();
        h.reply("quiet", None, &["transcript:line-1"]);
        assert!(h.engine.approve_processing(stale).is_err());
        h.engine.revoke_processing();
        assert!(h
            .engine
            .review_processing(ConversationScope::NewSpeechOnly, &[])
            .is_err());
        // A fresh harness exercises automatic stopping while permission is on.
        let mut h = Harness::new();
        h.engine.set_model_call_limit(1);
        h.line("Who owns the fictional checklist?");
        h.request();
        h.reply("quiet", None, &["transcript:line-1"]);
        h.line("When is the fictional handoff?");
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Unavailable(EvaluationIssue::CallLimit))
        );
        assert!(!h.engine.has_processing_permission());
        assert!(h.requests.try_recv().is_err());
        assert_eq!(h.engine.evaluation.as_ref().unwrap().requests_sent, 1);
        assert_eq!(h.engine.processing_issue(), Some(Issue::CallLimit));
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
        h.reply("quiet", None, &["transcript:line-2"]);
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
        h.reply("quiet", None, &["transcript:line-1"]);
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
        h.reply("quiet", None, &["transcript:line-2"]);
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
        h.reply("quiet", None, &["transcript:line-1"]);
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
        );
        let id = h.engine.state.cue.as_ref().unwrap().id.clone();
        h.engine.inspect_cue(&id).unwrap();
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
        h.reply("quiet", None, &["transcript:line-7"]);
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
        h.reply("show", Some("Who owns the checklist?"), &["prior:file:one"]);
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
        );
        let id = h.engine.state.cue.as_ref().unwrap().id.clone();
        h.engine.inspect_cue(&id).unwrap();
        for action in ["resolved", "withdraw"] {
            h.line("The review is still being discussed.");
            h.request();
            h.reply(action, None, &["prior:file:one"]);
            let cue = h.engine.state.cue.as_ref().unwrap();
            assert_eq!(cue.id, id);
            assert!(cue.resolved_by.is_none());
        }
        h.engine.advance(CUE_MS);
        h.line("New discussion without a matching reference.");
        h.request();
        h.reply("resolved", None, &["transcript:line-2", "prior:file:one"]);
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
                h.reply("show", Some("When should review start?"), &ids);
                let id = h.engine.state.cue.as_ref().unwrap().id.clone();
                h.engine.inspect_cue(&id).unwrap();
                if resolution_source {
                    h.line("Review starts Monday under the earlier plan.");
                    h.request();
                    h.reply(
                        "resolved",
                        None,
                        &["transcript:line-2", "prior:granola:one"],
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
                assert!(h.engine.inspect_cue(&id).is_err());
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
        h.reply("quiet", None, &["transcript:line-1"]);
    }

    #[test]
    fn a_kept_meeting_records_a_model_cue_with_its_line_but_no_speaker_label() {
        let mut h = Harness::new();
        h.line("The checklist handoff is still unassigned.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-1"],
        );
        let cue = h.engine.state.cue.as_ref().unwrap();
        // The cue on screen shows the speaker and time; the record must not.
        assert!(cue.evidence.contains("Maya"));
        h.engine.set_keep_meeting(true);
        let kept = h.engine.markdown();
        assert!(kept.contains(
            ": Who owns the checklist? (from: \"The checklist handoff is still unassigned.\")"
        ));
        assert!(!kept.contains("Maya"), "{kept}");
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
        for excluded in ["private manual", "Selected prior", "Review checklist"] {
            assert!(!json.contains(excluded));
        }
        // The listener's session name is sent on purpose, as the lab does.
        assert_eq!(request.user_name(), Some("Robin"));
        h.engine.advance(2_000);
        h.engine.set_question_size(QuestionSize::Large);
        // A repeated/older import leaves the selected store unchanged. Its
        // synchronization must not silently cancel this valid response.
        h.engine.set_notes(vec![imported]);
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-1"],
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
        h.engine.inspect_cue(&id).unwrap();
        h.reply("quiet", None, &["transcript:line-1", "transcript:line-2"]);
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
        );
        let cue = h.engine.state.cue.as_ref().unwrap();
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Decided(EvaluationOutcome::Resolved))
        );
        assert_eq!(cue.id, id);
        assert_eq!(cue.question, "Who owns the checklist?");
        assert!(cue.held);
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
        h.reply("resolved", None, &["transcript:line-2"]);
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.evaluated_cue.is_none());
        h.line("A different handoff is unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the release?"),
            &["transcript:line-3"],
        );
        assert!(h.engine.state.cue.is_none(), "cooldown must win");
        h.engine.advance(10_000);
        h.line("The checklist handoff remains unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-4"],
        );
        assert!(h.engine.state.cue.is_none(), "repeat must stay quiet");
        h.line("The release handoff remains unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the release?"),
            &["transcript:line-5"],
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
                    "sourceIds": ["transcript:line-1"]
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
            h.engine.inspect_cue(&id).unwrap();
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
            h.reply("resolved", None, &["transcript:line-2"]);
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
    fn requests_list_earlier_cues_and_how_each_ended() {
        use crate::cue_evaluator::CueEnd;
        let mut h = Harness::new();
        h.line("Someone should book the hall.");
        assert!(h.request().earlier_cues().is_empty());
        h.reply(
            "show",
            Some("Who will book the hall?"),
            &["transcript:line-1"],
        );
        h.line("Actually the hall is already booked.");
        let request = h.request();
        assert!(request.existing_cue().is_some());
        h.reply("withdraw", None, &["transcript:line-2"]);
        h.engine.advance(20_000);
        h.line("We still need someone for the raffle.");
        let request = h.request();
        assert_eq!(request.earlier_cues().len(), 1);
        assert_eq!(request.earlier_cues()[0].text, "Who will book the hall?");
        assert_eq!(request.earlier_cues()[0].state, CueEnd::Withdrawn);
        h.reply(
            "show",
            Some("Who will run the raffle?"),
            &["transcript:line-3"],
        );
        // A cue left to expire is listed as expired.
        h.engine.advance(20_000);
        h.line("The raffle prizes arrived.");
        let request = h.request();
        assert_eq!(request.earlier_cues().len(), 2);
        assert_eq!(request.earlier_cues()[1].state, CueEnd::Expired);
        // The prompt the model reads carries them, as the lab sends them.
        assert!(request
            .prompt_input()
            .unwrap()
            .contains(r#""earlierCues":[{"text":"Who will book the hall?","state":"withdrawn"}"#));
    }

    #[test]
    fn turning_the_connection_back_on_starts_afresh() {
        // Timeout outcomes are recorded directly, as in
        // a_single_timeout_is_skipped_and_two_in_a_row_stop_cues: a 20 ms
        // worker budget also raced the first, in-time reply on a loaded
        // machine. The worker's own deadline is covered by
        // expired_or_completed_but_unread_results_never_display.
        let mut h = Harness::new();
        h.line("Someone should send Dana the lease.");
        h.request();
        h.reply(
            "show",
            Some("Who will send Dana the lease?"),
            &["transcript:line-1"],
        );
        assert!(h.engine.state.cue.is_some());
        // One timeout, then the person turns processing off and on again.
        h.line("Anyway.");
        h.request();
        h.reply("quiet", None, &["transcript:line-2"]);
        h.engine.fail_evaluation(Failure::Expired);
        assert!(h.engine.has_processing_permission());
        h.engine.revoke_processing();
        h.approve_notes();
        // The cue shown before approval is not sent, and the count restarts:
        // one timeout after re-approval is skipped, not a stop.
        h.line("A new topic begins.");
        let request = h.request();
        assert!(request.earlier_cues().is_empty());
        h.engine.fail_evaluation(Failure::Expired);
        assert!(h.engine.has_processing_permission());
        h.reply("quiet", None, &["transcript:line-3"]);
    }

    #[test]
    fn newer_speech_waits_for_the_minimum_gap_between_requests() {
        let mut h = Harness::new();
        h.engine = std::mem::replace(&mut h.engine, Engine::live()).with_min_gap_ms(2_000);
        h.line("Someone should book the hall.");
        h.request();
        h.reply("quiet", None, &["transcript:line-1"]);
        h.line("The hall is free on Saturday.");
        // Too soon: nothing is sent, and the line waits.
        h.engine.advance(500);
        assert!(h.requests.try_recv().is_err());
        h.engine.advance(1_600);
        let request = h.request();
        assert_eq!(request.sources().last().unwrap().id, "transcript:line-2");
    }

    #[test]
    fn ordinary_mode_still_drops_a_reply_to_an_older_transcript() {
        // The lab's append-only prefix rule does not apply here: new speech
        // cancels the pending request and its reply is never shown.
        let mut h = Harness::new();
        h.line("Who owns the garden checklist?");
        h.request();
        h.line("Maya owns it; that is settled.");
        h.replies
            .send(
                serde_json::json!({"action": "show", "cue": "Who owns the checklist?",
                    "sourceIds": ["transcript:line-1"]})
                .to_string(),
            )
            .unwrap();
        // Only the newest transcript is evaluated next; the old reply is gone.
        let until = Instant::now() + Duration::from_secs(2);
        let latest = loop {
            h.engine.advance(1);
            if let Ok(request) = h.requests.try_recv() {
                break request;
            }
            assert!(Instant::now() < until, "latest speech was not evaluated");
            std::thread::sleep(Duration::from_millis(1));
        };
        assert!(latest.sources().iter().any(|s| s.id == "transcript:line-2"));
        assert!(h.engine.state.cue.is_none());
        h.reply("quiet", None, &["transcript:line-2"]);
        assert!(h.engine.state.cue.is_none());
    }

    #[test]
    fn a_single_timeout_is_skipped_and_two_in_a_row_stop_cues() {
        let mut h = Harness::new();
        // Exercise policy outcomes without racing worker startup against a
        // 20 ms wall-clock deadline. The worker's exact deadline boundary and
        // late-result rejection are covered by
        // expired_or_completed_but_unread_results_never_display.
        h.engine.fail_evaluation(Failure::Expired);
        // Skipped: permission and status survive, and no cue appears.
        assert!(h.engine.has_processing_permission());
        assert_eq!(h.engine.evaluation_status(), Some(EvaluationStatus::Idle));
        assert!(h.engine.state.cue.is_none());

        // A real validated reply resets the run of timeouts.
        h.line("Maya might take the garden checklist.");
        h.request();
        h.reply("quiet", None, &["transcript:line-1"]);
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Decided(EvaluationOutcome::Quiet))
        );
        h.engine.fail_evaluation(Failure::Expired);
        assert!(h.engine.has_processing_permission());
        assert!(h.engine.state.cue.is_none());

        // Two consecutive timeout outcomes stop cues with the plain reason.
        h.engine.fail_evaluation(Failure::Expired);
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Unavailable(EvaluationIssue::TimedOut))
        );
        assert!(!h.engine.has_processing_permission());
        h.line("Still nobody has said yes.");
        assert!(h.requests.try_recv().is_err(), "no work after cues stop");
        assert!(h.engine.state.cue.is_none());
    }

    #[test]
    fn an_unusable_reply_requires_new_approval_even_after_new_speech() {
        let mut h = Harness::new();
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
        h.replies.send("{}".into()).unwrap(); // Malformed output must stay quiet.
        drain_without_another_request(&mut h);
        assert!(h.engine.state.cue.is_none());
        let unavailable = Some(EvaluationStatus::Unavailable(EvaluationIssue::InvalidReply));
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
        h.reply("quiet", None, &["transcript:line-4"]);
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
                    "action": "quiet", "cue": null, "sourceIds": ["transcript:line-1"]
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
            h.reply("quiet", None, &["transcript:line-1"]);
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
    fn each_backend_failure_stops_cues_with_its_own_reason() {
        use crate::engine::ModelLink;
        struct Fails(Failure);
        impl Evaluator for Fails {
            fn evaluate(&mut self, _: &Request, _: &Cancellation) -> Result<String, Failure> {
                Err(self.0)
            }
        }
        for (failure, issue, shown) in [
            (
                Failure::SignIn,
                EvaluationIssue::SignIn,
                Issue::Authentication,
            ),
            (
                Failure::Credentials,
                EvaluationIssue::Credentials,
                Issue::Credentials,
            ),
            (
                Failure::UsageLimit,
                EvaluationIssue::UsageLimit,
                Issue::Allowance,
            ),
            (
                Failure::Unreachable,
                EvaluationIssue::Unreachable,
                Issue::Unreachable,
            ),
        ] {
            let worker = Worker::start(Fails(failure), Duration::from_secs(5)).unwrap();
            let mut h = Harness::new();
            h.engine = Engine::live_with_evaluator(worker, fictional_processor());
            h.engine.start().unwrap();
            h.approve_notes();
            h.line("Someone should take the checklist.");
            h.settle();
            assert_eq!(
                h.engine.evaluation_status(),
                Some(EvaluationStatus::Unavailable(issue)),
                "{failure:?}"
            );
            // Stopped at once, not skipped like a single timeout.
            assert!(!h.engine.has_processing_permission(), "{failure:?}");
            let snapshot = h.engine.cue_snapshot();
            assert_eq!(snapshot.model, Some(ModelLink::Stopped));
            assert_eq!(snapshot.model_issue, Some(shown));
            assert_eq!(h.engine.processing_issue(), Some(shown));
            // Capture carries on.
            h.line("Capture continues.");
            assert_eq!(h.engine.state.transcript.len(), 2);
        }
    }

    #[test]
    fn a_backend_without_notes_refuses_a_review_that_selects_one() {
        let processor = fictional_processor().without_notes();
        let mut h = Harness::unapproved(processor, Duration::from_secs(5));
        let note = ContextItem {
            provider: crate::context::Provider::File,
            source_id: "one".into(),
            title: "Earlier launch review".into(),
            source_date: "2026-11-01".into(),
            excerpt: "Selected prior excerpt".into(),
            revision: 1,
        };
        h.engine.set_notes(vec![note]);
        assert_eq!(
            h.engine
                .review_processing(
                    ConversationScope::NewSpeechOnly,
                    &[(crate::context::Provider::File, "one".into(), 1)],
                )
                .err(),
            Some(ProcessingError::InvalidScope)
        );
        // Conversation alone is still allowed.
        assert!(h
            .engine
            .review_processing(ConversationScope::NewSpeechOnly, &[])
            .is_ok());
        let summary = h
            .engine
            .processing_snapshot(CaptureState::Running, 0)
            .processor
            .unwrap();
        assert!(!summary.accepts_notes);
    }

    #[test]
    fn a_misconfigured_backend_says_so_and_cannot_be_approved() {
        let mut h = Harness::unapproved(fictional_processor(), Duration::from_secs(5));
        h.engine = std::mem::replace(&mut h.engine, Engine::live()).misconfigured();
        assert_eq!(
            h.engine
                .review_processing(ConversationScope::NewSpeechOnly, &[])
                .err(),
            Some(ProcessingError::Unavailable)
        );
        h.engine.revoke_processing();
        h.line("Someone should take the checklist.");
        assert_eq!(h.engine.processing_issue(), Some(Issue::Misconfigured));
        assert!(h.requests.try_recv().is_err(), "nothing was sent");
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
                            "sourceIds": [old_id]
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
        h.reply("quiet", None, &["transcript:line-2"]);
    }

    #[test]
    fn source_eviction_releases_held_copies_and_only_latest_speech_catches_up() {
        let mut h = Harness::new();
        let id = h.show();
        h.engine.inspect_cue(&id).unwrap();
        h.line("A later line.");
        h.request(); // Deliberately keep this evaluator occupied.
        for _ in 0..MAX_TRANSCRIPT_SEGMENTS {
            h.line("Another fictional line.");
        }
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.evaluated_cue.is_none());
        h.reply("resolved", None, &["transcript:line-2"]);
        let latest = next_scheduled_request(&mut h);
        assert!(latest.existing_cue().is_none());
        assert_eq!(latest.sources().len(), RECENT_LINES);
        assert!(!latest
            .sources()
            .iter()
            .any(|source| source.id == "transcript:line-2"));
        assert!(h.engine.state.cue.is_none());
        let last_id = latest.sources().last().unwrap().id.clone();
        h.reply("quiet", None, &[&last_id]);
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
        h.engine.inspect_cue(&id).unwrap();
        h.line("That checklist is no longer part of this release.");
        h.request();
        h.reply("withdraw", None, &["transcript:line-2"]);
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Decided(EvaluationOutcome::Withdrawn))
        );
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.state.notes.is_empty());
        assert!(h.engine.evaluated_cue.is_none());
    }

    #[test]
    fn asked_you_fires_with_a_model_connected_and_the_model_cannot_replace_or_repeat_it() {
        let mut h = Harness::named("Curtis");
        h.line("The raffle tickets are printed.");
        h.request();
        // As in lab run B12, with fictional words: the question arrives while
        // the model is still working on the line before.
        h.line("Three for ten sells better, Curtis, didn't you run the booth before?");
        let asked = h.engine.state.cue.clone().expect("asked of the user");
        assert_eq!(asked.kind, super::super::ASKED);
        assert!(
            asked.sources.is_empty(),
            "the phrase rule's cue, not the model's"
        );
        // A show already on its way cannot take the slot.
        h.reply(
            "show",
            Some("Did you run the booth before?"),
            &["transcript:line-1"],
        );
        assert_eq!(h.engine.state.cue.as_ref().unwrap().id, asked.id);
        // With a model connected it lasts 20 s from the line, not 45 s.
        assert_eq!(asked.total_ms, 20_000);
        // The model is still asked, with the cue on screen marked as asked.
        let request = next_scheduled_request(&mut h);
        let existing = request.existing_cue().expect("the cue on screen");
        assert!(existing.asked);
        assert_eq!(existing.id, asked.id);
        assert_eq!(existing.source_ids, ["transcript:line-2"]);
        assert!(request
            .prompt_input()
            .unwrap()
            .contains(r#""sourceIds":["transcript:line-2"],"kind":"asked"}"#));
        // It cannot withdraw it.
        h.reply("withdraw", None, &["transcript:line-2"]);
        assert_eq!(h.engine.state.cue.as_ref().unwrap().id, asked.id);
        // It can say it was answered; then the cue goes.
        h.line("Yes, two years running.");
        assert!(h.request().existing_cue().unwrap().asked);
        h.reply("resolved", None, &["transcript:line-3"]);
        assert!(h.engine.state.cue.is_none());
        // It does not come back as the model's cue from that line.
        h.engine.advance(10_000);
        h.line("Prices are on the sign.");
        h.request();
        h.reply(
            "show",
            Some("Did you run the booth before?"),
            &["transcript:line-2", "transcript:line-4"],
        );
        assert!(h.engine.state.cue.is_none());
    }

    #[test]
    fn a_resolved_split_question_cannot_return_from_its_first_line_and_fresh_speech() {
        let mut h = Harness::named("Maya");
        h.line("Could you, Maya,");
        h.request();
        h.reply("quiet", None, &["transcript:line-1"]);
        h.line("field the complaints?");
        assert_eq!(
            h.engine.state.cue.as_ref().unwrap().kind,
            super::super::ASKED
        );
        h.request();
        h.reply("quiet", None, &["transcript:line-2"]);
        h.line("Yes, I will handle them.");
        h.request();
        h.reply("resolved", None, &["transcript:line-3"]);
        assert!(h.engine.state.cue.is_none());
        h.engine.advance(10_000);
        h.line("The room is booked.");
        h.request();
        h.reply(
            "show",
            Some("Could you field the complaints?"),
            &["transcript:line-1", "transcript:line-4"],
        );
        assert!(
            h.engine.state.cue.is_none(),
            "the shown question must not repeat"
        );
    }

    #[test]
    fn a_split_question_blocked_by_a_held_cue_does_not_suppress_a_later_model_cue() {
        let mut h = Harness::named("Maya");
        let held = h.show();
        h.engine.inspect_cue(&held).unwrap();
        h.line("Could you, Maya,");
        h.request();
        h.reply("quiet", None, &["transcript:line-2"]);
        h.line("field the complaints?");
        assert_eq!(h.engine.state.cue.as_ref().unwrap().id, held);
        h.request();
        h.reply("quiet", None, &["transcript:line-3"]);
        h.engine.respond(&held, Response::Dismiss).unwrap();
        h.engine.advance(10_000);
        h.line("The room is booked.");
        h.request();
        h.reply(
            "show",
            Some("Could you field the complaints?"),
            &["transcript:line-2", "transcript:line-4"],
        );
        assert_eq!(
            h.engine.state.cue.as_ref().unwrap().question,
            "Could you field the complaints?",
            "a question never displayed may still be suggested"
        );
    }

    #[test]
    fn asked_lifetime_uses_the_sessions_processing_permission_not_registration() {
        for mode in ["unapproved", "approved", "revoked"] {
            let mut h = if mode == "unapproved" {
                let mut h = Harness::unapproved(fictional_processor(), Duration::from_secs(5));
                h.engine.set_user_name(Some("Maya".into())).unwrap();
                h
            } else {
                Harness::named("Maya")
            };
            if mode == "revoked" {
                h.engine.revoke_processing();
            }
            h.line("Maya, can you check the room?");
            assert_eq!(
                h.engine.state.cue.as_ref().unwrap().total_ms,
                if mode == "approved" { 20_000 } else { 45_000 },
                "{mode}"
            );
            if mode == "approved" {
                h.request();
                h.reply("quiet", None, &["transcript:line-1"]);
            } else {
                assert!(h.requests.try_recv().is_err());
            }
            h.engine.advance(21_000);
            assert_eq!(h.engine.state.cue.is_some(), mode != "approved", "{mode}");
        }
    }

    #[test]
    fn asked_you_takes_the_slot_from_an_unread_model_cue_but_not_a_held_one() {
        let mut h = Harness::named("Curtis");
        h.show();
        h.line("Curtis, can you check the float?");
        let cue = h.engine.state.cue.as_ref().unwrap();
        assert_eq!(cue.kind, super::super::ASKED);
        assert_eq!(
            h.engine.evaluated_cue.as_ref().unwrap().0,
            cue.id,
            "now the asked cue"
        );
        // A model cue being read stays.
        let mut h = Harness::named("Curtis");
        let id = h.show();
        h.engine.inspect_cue(&id).unwrap();
        h.line("Curtis, can you check the float?");
        assert_eq!(h.engine.state.cue.as_ref().unwrap().id, id);
    }

    /// Lab run B12's timeline, in session milliseconds, with fictional
    /// words: a cue from a line at 34.47 s expires at 52.47 s; the next
    /// question was said at 50.82 s and reached the engine at 54.42 s; the
    /// model's show for it came back at 57.34 s.
    fn b12_until_the_question(h: &mut Harness, dismissed: bool) {
        h.said(34_470, 36_000, "Drop the prizes at the usual place.");
        h.request();
        h.reply(
            "show",
            Some("Where is the usual place?"),
            &["transcript:line-1"],
        );
        let first = h.engine.state.cue.as_ref().unwrap().id.clone();
        if dismissed {
            h.until(52_000);
            h.engine.respond(&first, Response::Dismiss).unwrap();
        } else {
            h.until(52_471);
            assert!(h.engine.state.cue.is_none(), "expired");
        }
        h.said(
            50_820,
            54_420,
            "Three for ten sells better, didn't you run the booth before?",
        );
        h.request();
        h.until(57_340);
    }

    #[test]
    fn after_a_cue_expires_a_question_said_just_before_shows_after_a_short_pause() {
        let mut h = Harness::new();
        b12_until_the_question(&mut h, false);
        h.reply(
            "show",
            Some("Did you run the booth?"),
            &["transcript:line-2"],
        );
        // Before: dropped until 62.47 s, because the line began before the
        // 10 s cooldown ended; shown only at 71.75 s.
        let cue = h.engine.state.cue.as_ref().expect("shown at request 13");
        assert_eq!(cue.question, "Did you run the booth?");
        // Its lifetime still runs from when the line was said.
        assert_eq!(h.engine.cue_deadline, 50_820 + CUE_MS);
    }

    #[test]
    fn after_a_dismissal_the_full_pause_holds_from_when_it_was_dismissed() {
        let mut h = Harness::new();
        b12_until_the_question(&mut h, true);
        h.reply(
            "show",
            Some("Did you run the booth?"),
            &["transcript:line-2"],
        );
        assert!(h.engine.state.cue.is_none());
        assert_eq!(h.engine.last_dropped, Some("cooldown"));
        // A line said 50 ms before the pause ended, answered after it: shown.
        h.said(61_950, 64_000, "The caterer wants the menu Friday.");
        h.request();
        h.until(66_680);
        h.reply("show", Some("Who sends the menu?"), &["transcript:line-3"]);
        assert!(h.engine.state.cue.is_some());
    }

    #[test]
    fn a_model_cue_citing_a_question_to_the_user_by_name_skips_the_pause_once() {
        // With the name set, B12's question raises "Asked you" itself.
        let mut h = Harness::named("Curtis");
        h.said(34_470, 36_000, "Drop the prizes at the usual place.");
        h.request();
        h.reply(
            "show",
            Some("Where is the usual place?"),
            &["transcript:line-1"],
        );
        h.until(52_471);
        h.said(
            50_820,
            54_420,
            "Three for ten sells better, Curtis, didn't you run the booth before?",
        );
        assert_eq!(
            h.engine.state.cue.as_ref().unwrap().kind,
            super::super::ASKED
        );
        // When a cue being read kept "Asked you" off the screen, the model's
        // cue from that line skips the pause after it, once.
        let mut h = Harness::named("Curtis");
        h.said(40_000, 41_000, "Drop the prizes at the usual place.");
        h.request();
        h.reply(
            "show",
            Some("Where is the usual place?"),
            &["transcript:line-1"],
        );
        let first = h.engine.state.cue.as_ref().unwrap().id.clone();
        h.engine.inspect_cue(&first).unwrap();
        h.said(
            50_820,
            54_420,
            "Three for ten sells better, Curtis, didn't you run the booth before?",
        );
        assert_eq!(h.engine.state.cue.as_ref().unwrap().id, first, "held");
        h.request();
        h.reply("quiet", None, &["transcript:line-2"]);
        h.until(55_000);
        h.engine.respond(&first, Response::Dismiss).unwrap();
        h.said(55_500, 56_500, "Prices go on the sign.");
        h.request();
        h.until(57_340);
        h.reply(
            "show",
            Some("Did you run the booth?"),
            &["transcript:line-2", "transcript:line-3"],
        );
        let shown = h.engine.state.cue.clone().expect("skips the full pause");
        h.engine.respond(&shown.id, Response::Dismiss).unwrap();
        h.said(58_000, 59_000, "Tickets are five each.");
        h.request();
        h.until(59_780);
        h.reply(
            "show",
            Some("Did you run the booth before?"),
            &["transcript:line-2", "transcript:line-4"],
        );
        assert!(h.engine.state.cue.is_none(), "not again once dismissed");
        assert_eq!(h.engine.last_dropped, Some("cooldown"));
    }

    #[test]
    fn a_line_passing_18_s_while_the_model_answers_does_not_make_the_reply_stale() {
        let mut h = Harness::new();
        h.said(1_000, 2_000, "The hall is booked for the fair.");
        h.request();
        h.reply("quiet", None, &["transcript:line-1"]);
        h.said(15_000, 18_500, "Who is bringing the urn?");
        let request = h.request();
        assert_eq!(
            request.sources().len(),
            2,
            "both lines were fresh when sent"
        );
        // Line 1 passes 18 s before the reply comes back.
        h.until(19_500);
        h.reply("show", Some("Who brings the urn?"), &["transcript:line-2"]);
        assert!(h.engine.state.cue.is_some(), "{:?}", h.engine.last_dropped);
        // New speech while it answers still makes a reply stale (the lab
        // path's log of it is in lab_tests).
        let mut h = Harness::new();
        h.said(1_000, 2_000, "Who is bringing the urn?");
        h.request();
        h.said(2_500, 3_000, "And the cups.");
        h.reply("show", Some("Who brings the urn?"), &["transcript:line-1"]);
        assert!(h.engine.state.cue.is_none());
    }

    /// Lab scenario B13's fictional conversation, with each line's end on
    /// the media clock (start = end of the line before, or its labelled
    /// start), reaching the engine 1.5 s after it ends, a model answering
    /// 1.9 s after each request, the lab's 2 s gap between requests, and the
    /// listener named Curtis. The fake model shows a cue for the open
    /// question (l13) and the time conflict (l23), marks a cue on screen
    /// resolved when the next line answers it, and is otherwise quiet.
    #[test]
    fn b13_timeline_cues_every_moment_on_time() {
        const LINES: [(u64, u64, &str); 24] = [
            (
                6_000,
                7_675,
                "Okay, um, this was meant to be the schedule check-in.",
            ),
            (7_975, 9_059, "Long day, but yeah."),
            (
                9_785,
                12_605,
                "Curtis, did the registration confirmation come through?",
            ),
            (12_905, 17_330, "Uh, yeah, Monday. It's fine."),
            (
                18_803,
                21_643,
                "Good, Curtis said the kids were panicking about it.",
            ),
            (
                22_545,
                26_932,
                "Right. Build night's still Thursday at six, shop room.",
            ),
            (
                27_232,
                32_592,
                "That chat, though. Forty messages arguing tank versus mecanum.",
            ),
            (
                33_978,
                37_058,
                "Curtis, can you take the chat and post one calm message?",
            ),
            (37_358, 39_260, "Sure. We'll test both Thursday."),
            (
                40_537,
                46_205,
                "Fine by me. Joan, Curtis and I already leaned tank anyway.",
            ),
            (
                46_505,
                50_484,
                "Hang on, let me check who changed the shared design login.",
            ),
            (
                57_206,
                59_273,
                "Okay. Changed Tuesday night, from a student laptop.",
            ),
            (
                60_345,
                63_105,
                "Does anyone even know who has that password now?",
            ),
            (
                63_405,
                66_992,
                "I'll reset it and keep it in the mentor folder.",
            ),
            (67_292, 69_090, "Works. Mentors only from now on."),
            (
                70_251,
                73_531,
                "Tell the kids once, like Curtis suggested. Jack, tonight?",
            ),
            (73_831, 74_360, "Yeah, after dinner."),
            (
                75_846,
                78_970,
                "If it locks anyone out, could you, Curtis, field the complaints?",
            ),
            (79_270, 80_808, "Yep, happy to."),
            (81_108, 84_700, "Speaking of dinner, I ate cereal at four."),
            (85_000, 85_496, "Ha. Mm-hm, same energy."),
            (
                85_796,
                89_754,
                "My cat knocked coffee onto the robot manual today.",
            ),
            (
                91_347,
                94_467,
                "Okay. See everyone Thursday at seven, shop room.",
            ),
            (94_767, 95_496, "See you then."),
        ];
        const ARRIVAL_MS: u64 = 1_500;
        const MODEL_MS: u64 = 1_900;
        // The fake model, from the newest line in the request.
        fn decide(request: &Request) -> (&'static str, Option<&'static str>, String) {
            let newest = request
                .sources()
                .iter()
                .filter_map(|source| source.id.strip_prefix("transcript:line-"))
                .filter_map(|n| n.parse::<usize>().ok())
                .max()
                .unwrap();
            let id = format!("transcript:line-{newest}");
            match (request.existing_cue().is_some(), newest) {
                // Curtis answers l3, l8 and l18; Jack answers l13.
                (true, 4 | 9 | 14 | 19) => ("resolved", None, id),
                (false, 13) => ("show", Some("Who has the design password now?"), id),
                // Seen again with "See you then." after it, if l24 arrives
                // before the first reply and makes it stale.
                (false, 23 | 24) => (
                    "show",
                    Some("Build night: six or seven?"),
                    "transcript:line-23".into(),
                ),
                _ => ("quiet", None, id),
            }
        }
        let mut h = Harness::named("Curtis");
        let engine = std::mem::replace(&mut h.engine, Engine::live());
        h.engine = engine.with_min_gap_ms(2_000);
        // When each cue first appeared, by id: (line it came from, kind, at).
        let mut shown: Vec<(String, String, u64)> = Vec::new();
        let mut on_screen_at_line: Vec<Option<String>> = Vec::new();
        let mut pending: Option<(Request, u64)> = None;
        let mut next = 0;
        let end = 97_604 + 10_000;
        let note = |h: &Harness, shown: &mut Vec<(String, String, u64)>| {
            if let Some(cue) = &h.engine.state.cue {
                if !shown.iter().any(|(id, _, _)| *id == cue.id) {
                    shown.push((cue.id.clone(), cue.kind.clone(), h.engine.state.elapsed_ms));
                }
            }
        };
        loop {
            let line_at = LINES.get(next).map(|(_, end, _)| end + ARRIVAL_MS);
            let reply_at = pending.as_ref().map(|(_, at)| *at);
            match (line_at, reply_at) {
                (Some(at), reply) if reply.is_none_or(|reply| at <= reply) => {
                    on_screen_at_line.push(h.engine.state.cue.as_ref().map(|c| c.kind.clone()));
                    let (start, _, text) = LINES[next];
                    h.said(start, at, text);
                    next += 1;
                }
                (_, Some(at)) => {
                    h.until(at);
                    let (request, _) = pending.take().unwrap();
                    let (action, cue, id) = decide(&request);
                    h.reply(action, cue, &[id.as_str()]);
                }
                _ => break,
            }
            note(&h, &mut shown);
            if pending.is_none() {
                // A request goes out now or, after the gap, on a clock tick.
                let next_line_at = LINES.get(next).map_or(end, |(_, end, _)| end + ARRIVAL_MS);
                let until = (h.engine.state.elapsed_ms + 2_100).min(next_line_at);
                loop {
                    if let Ok(request) = h.requests.recv_timeout(Duration::from_millis(20)) {
                        pending = Some((request, h.engine.state.elapsed_ms + MODEL_MS));
                        break;
                    }
                    if h.engine.state.elapsed_ms >= until {
                        break;
                    }
                    h.engine.advance(100);
                    note(&h, &mut shown);
                }
            }
        }
        h.until(end);
        eprintln!("B13 cues (session ms):");
        for (id, kind, at) in &shown {
            eprintln!("  {at:>6}  {kind:<10} {id}");
        }
        for (index, kind) in on_screen_at_line.iter().enumerate() {
            if [5, 10, 16].contains(&(index + 1)) {
                eprintln!(
                    "  near-miss l{}: on screen when it arrived: {kind:?}",
                    index + 1
                );
            }
        }
        let first = |kind: &str, after: u64| {
            shown
                .iter()
                .find(|(_, k, at)| k == kind && *at >= after)
                .map(|(_, _, at)| *at)
        };
        // Each moment, measured from when its line ended.
        let asked_3 = first(ASKED, 12_605).expect("l3 asked");
        let asked_8 = first(ASKED, 37_058).expect("l8 asked");
        let open_13 = first("Suggestion", 63_105).expect("l13 shown");
        let asked_18 = first(ASKED, 78_970).expect("l18 asked");
        let conflict_23 = first("Suggestion", 94_467).expect("l23 shown");
        eprintln!(
            "  lateness after the line ended: l3 {} l8 {} l13 {} l18 {} l23 {}",
            asked_3 - 12_605,
            asked_8 - 37_058,
            open_13 - 63_105,
            asked_18 - 78_970,
            conflict_23 - 94_467
        );
        for late in [asked_3 - 12_605, asked_8 - 37_058, asked_18 - 78_970] {
            assert!(late <= ARRIVAL_MS + 200, "Asked you on arrival");
        }
        for late in [open_13 - 63_105, conflict_23 - 94_467] {
            assert!(
                late <= ARRIVAL_MS + MODEL_MS + 2_200,
                "model cue within a request"
            );
        }
        // The near-misses raised no "Asked you" of their own.
        assert_eq!(shown.iter().filter(|(_, kind, _)| kind == ASKED).count(), 3);
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
            h.reply("show", Some("Who owns the checklist?"), &[id]);
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

    #[test]
    fn trivial_filler_lines_skip_llm_calls_unless_question_or_name_applies() {
        let mut h = Harness::named("Jordan");
        // Trivial 1-2 word acknowledgements do not fire an LLM call on arrival.
        for filler in [
            "Yeah.",
            "Okay.",
            "No.",
            "So",
            "Uh-huh.",
            "Right.",
            "Mm-hmm.",
            "Sure.",
            "Yeah, okay.",
            "Mm hmm.",
            "All right.",
            "Got it.",
            "Sounds good.",
        ] {
            h.line(filler);
            assert!(
                h.requests.try_recv().is_err(),
                "filler line should not fire cue request: {filler}"
            );
            assert_eq!(h.engine.evaluation_status(), Some(EvaluationStatus::Idle));
        }
        // Filler lines are still kept in the transcript so a subsequent
        // substantive turn sees full context and triggers normally.
        h.line("Who owns the fictional Atlas checklist?");
        let req = h.request();
        let texts: Vec<&str> = req.sources().iter().map(|s| s.text.as_str()).collect();
        assert_eq!(
            texts.last().copied(),
            Some("Who owns the fictional Atlas checklist?")
        );
        assert!(texts.contains(&"Sounds good."));
        h.reply("quiet", None, &[&req.sources().last().unwrap().id]);

        // Question mark overrides filler gating even for 1-2 word lines.
        for question in ["Yeah?", "Right?", "Okay?", "No?", "So?"] {
            h.line(question);
            let q_req = h.request();
            assert_eq!(q_req.sources().last().unwrap().text, question);
            h.reply("quiet", None, &[&q_req.sources().last().unwrap().id]);
        }

        // Listener name mention overrides filler gating even on 1-2 word lines.
        for named in ["Jordan.", "Yeah, Jordan.", "Okay Jordan."] {
            h.line(named);
            let n_req = h.request();
            assert_eq!(n_req.sources().last().unwrap().text, named);
            h.reply("quiet", None, &[&n_req.sources().last().unwrap().id]);
        }

        // Substantive 1-2 word lines and 3+ word lines continue to trigger normally.
        for substantive in ["Done.", "Friday.", "I will.", "Yeah, I will send it."] {
            h.line(substantive);
            let s_req = h.request();
            assert_eq!(s_req.sources().last().unwrap().text, substantive);
            h.reply("quiet", None, &[&s_req.sources().last().unwrap().id]);
        }
    }

    #[test]
    fn split_name_question_ending_on_short_line_still_triggers_evaluation() {
        let mut h = Harness::named("Maya");
        h.line("Could you, Maya,");
        let first = h.request();
        h.reply("quiet", None, &[&first.sources().last().unwrap().id]);
        // Even if the second line had only a filler word with '?' or completed
        // an Asked-you split question, ask_of_user + '?' ensures evaluation fires.
        h.line("check?");
        assert_eq!(
            h.engine.state.cue.as_ref().unwrap().kind,
            super::super::ASKED
        );
        let second = h.request();
        assert_eq!(second.sources().last().unwrap().text, "check?");
        h.reply("quiet", None, &[&second.sources().last().unwrap().id]);
    }
}
