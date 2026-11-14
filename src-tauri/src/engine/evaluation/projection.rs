//! Metadata-only native processing status. Projection never approves sources,
//! starts a worker, or infers microphone release from the engine lifecycle.
use super::*;
use crate::context::Provider;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureState {
    Unknown,
    Off,
    Starting,
    Running,
    Stopping,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StartupState {
    #[default]
    Idle,
    Loading,
    Cancelling,
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopTarget {
    pub operation: Option<String>,
    pub microphone: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Off,
    Active,
    Paused,
    Unavailable,
    Stopping,
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Issue {
    ScopeChanged,
    InputLimit,
    Worker,
    Authentication,
    Credentials,
    Allowance,
    Unreachable,
    TimedOut,
    InvalidReply,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LastDecision {
    Quiet,
    Cue,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteSelection {
    pub provider: Provider,
    pub source_id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    #[serde(flatten)]
    pub source: NoteSelection,
    pub title: String,
    pub source_date: String,
}

impl From<&ContextItem> for NoteSummary {
    fn from(item: &ContextItem) -> Self {
        Self {
            source: NoteSelection {
                provider: item.provider,
                source_id: item.source_id.clone(),
                revision: item.revision,
            },
            title: item.title.clone(),
            source_date: item.source_date.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub conversation: ConversationScope,
    pub notes: Vec<NoteSelection>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Location {
    OnDevice,
    Hosted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessorSummary {
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub model: String,
    pub location: Location,
    pub destination: String,
    pub data_policy: String,
}

impl From<&ProcessorConfiguration> for ProcessorSummary {
    fn from(config: &ProcessorConfiguration) -> Self {
        let (location, destination) = match &config.location {
            ProcessingLocation::OnDevice => (Location::OnDevice, "This device".into()),
            ProcessingLocation::Hosted { service } => (Location::Hosted, service.clone()),
        };
        Self {
            id: config.id.clone(),
            revision: config.revision,
            name: config.disclosure.name.clone(),
            model: config.model.clone(),
            location,
            destination,
            data_policy: config.disclosure.data_policy.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingSnapshot {
    pub revision: u64,
    pub session: String,
    pub scope_revision: u64,
    pub phase: Phase,
    pub capture: CaptureState,
    pub stop_target: StopTarget,
    pub startup: StartupState,
    pub processor: Option<ProcessorSummary>,
    pub notes: Vec<NoteSummary>,
    pub approved: Option<Scope>,
    pub issue: Option<Issue>,
    pub last_decision: Option<LastDecision>,
    /// Conversation lines are being sent to the processor right now.
    pub sending: bool,
    /// The microphone alone, when a selected-application source also exists.
    /// `capture` then combines the two and never understates either.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub microphone: Option<CaptureState>,
    /// The selected-application source. Present only in a development build
    /// with the `native-audio-spike` feature; absent from default builds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceCapture>,
}

/// The selected-application source's phase. Off only when nothing was
/// started or native cleanup was confirmed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourcePhase {
    /// Nothing was started, or native cleanup was confirmed.
    Off,
    /// Asking the OS for applications; its own prompt may be showing.
    Listing,
    /// One application is under review. Nothing is captured.
    Reviewing,
    Starting,
    Listening,
    /// Stop was requested and native cleanup has not been confirmed.
    Stopping,
    /// The OS reported that Stop or output removal failed. The application
    /// may still be captured until an explicit retry succeeds.
    CleanupFailed,
    /// The worker ended without confirming cleanup. The application may still
    /// be captured and nothing in TalkQTE can stop it; whether quitting does
    /// has not been checked.
    Abandoned,
}

impl SourcePhase {
    pub fn may_be_capturing(self) -> bool {
        matches!(
            self,
            Self::Starting
                | Self::Listening
                | Self::Stopping
                | Self::CleanupFailed
                | Self::Abandoned
        )
    }
}

/// Why the source's last attempt ended, or what is wrong now. Labels only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceProblem {
    NoLiveSession,
    SessionHasSource,
    ClockRefused,
    PermissionDenied,
    SourceUnavailable,
    ListFailed,
    StartFailed,
    StreamFailed,
    StopFailed,
    RemoveFailed,
    Unavailable,
    /// A source-only session was asked for while another session or the demo
    /// was running. Nothing was started.
    SessionBusy,
}

/// What the notebook needs to describe the source truthfully. Metadata only:
/// the application's display name, never audio, transcript or native ids.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCapture {
    pub phase: SourcePhase,
    pub may_be_capturing: bool,
    /// Stopping has lasted long enough to say so; no answer has arrived.
    pub stalled: bool,
    /// One explicit cleanup retry can be requested now.
    pub can_retry: bool,
    pub application: Option<String>,
    pub problem: Option<SourceProblem>,
    /// Identifies the review or operation, for the source's own Stop.
    pub operation: Option<String>,
    /// The live session was started for this source alone; no microphone.
    pub source_session: bool,
}

struct ScopeKey {
    owner: Arc<()>,
    session: u64,
    permission: Option<u64>,
    context: [u8; 32],
    status: Status,
    paused: bool,
    stopping: bool,
}

impl ScopeKey {
    fn for_engine(engine: &Engine) -> Self {
        Self {
            owner: engine.identity.clone(),
            session: engine.session(),
            permission: engine.evaluation.as_ref().map(|s| s.permission.generation),
            context: engine.processing_context_fingerprint(),
            status: engine.state.status,
            paused: engine.state.cues_paused,
            stopping: engine.is_live_stopping(),
        }
    }
}

impl PartialEq for ScopeKey {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.owner, &other.owner)
            && self.session == other.session
            && self.permission == other.permission
            && self.context == other.context
            && self.status == other.status
            && self.paused == other.paused
            && self.stopping == other.stopping
    }
}

/// Owned by Runtime, not replaced with the engine. Only the latest snapshot and
/// non-serializable identity/digest are kept; no event history or content copies.
#[derive(Default)]
pub struct ProcessingTracker {
    previous: Option<(ScopeKey, ProcessingSnapshot)>,
}

impl ProcessingTracker {
    /// Validate the originating UI scope against current native authority,
    /// including changes not yet published. Do not consume an event revision.
    pub(crate) fn scope_is_current(&self, engine: &Engine, session: &str, revision: u64) -> bool {
        self.previous.as_ref().is_some_and(|(key, snapshot)| {
            snapshot.session == session
                && snapshot.scope_revision == revision
                && *key == ScopeKey::for_engine(engine)
        })
    }

    /// Called under the native runtime lock. The boolean marks an event-worthy
    /// change; polling the clock or reading unchanged status emits nothing.
    pub fn update(&mut self, engine: &Engine, capture: CaptureState) -> (ProcessingSnapshot, bool) {
        self.update_with_capture_control(engine, capture, StopTarget::default(), StartupState::Idle)
    }

    pub fn update_with_capture_control(
        &mut self,
        engine: &Engine,
        capture: CaptureState,
        target: StopTarget,
        startup: StartupState,
    ) -> (ProcessingSnapshot, bool) {
        self.update_with_source(engine, capture, target, startup, None)
    }

    /// As `update_with_capture_control`, with a selected-application source.
    /// `capture` must already combine the microphone and the source; the
    /// microphone alone and the source are reported beside it.
    pub fn update_with_source(
        &mut self,
        engine: &Engine,
        capture: CaptureState,
        target: StopTarget,
        startup: StartupState,
        source: Option<(CaptureState, SourceCapture)>,
    ) -> (ProcessingSnapshot, bool) {
        let key = ScopeKey::for_engine(engine);
        let (mut revision, mut scope_revision) =
            self.previous.as_ref().map_or((0, 0), |(old, s)| {
                (
                    s.revision,
                    s.scope_revision
                        .checked_add(u64::from(*old != key))
                        .expect("processing scope revision exhausted"),
                )
            });
        if self.previous.is_none() {
            scope_revision = 1;
        }
        let mut next = engine.processing_snapshot(capture, scope_revision);
        next.stop_target = target;
        next.startup = startup;
        (next.microphone, next.source) = source.map_or((None, None), |(m, s)| (Some(m), Some(s)));
        next.revision = revision;
        let changed = self.previous.as_ref().is_none_or(|(_, s)| *s != next);
        if changed {
            revision = revision
                .checked_add(1)
                .expect("processing revision exhausted");
            next.revision = revision;
        }
        self.previous = Some((key, next.clone()));
        (next, changed)
    }
}

impl Engine {
    pub(crate) fn processing_snapshot(
        &self,
        capture: CaptureState,
        scope_revision: u64,
    ) -> ProcessingSnapshot {
        let mut notes: Vec<_> = self
            .notes
            .iter()
            .map(|n| NoteSummary::from(&n.item))
            .collect();
        notes.sort_by(|a, b| {
            (a.source.provider.id(), &a.source.source_id)
                .cmp(&(b.source.provider.id(), &b.source.source_id))
        });
        let issue = match self.evaluation_status() {
            Some(EvaluationStatus::Unavailable(EvaluationIssue::ScopeChanged)) => {
                Some(Issue::ScopeChanged)
            }
            Some(EvaluationStatus::Unavailable(EvaluationIssue::InputLimit)) => {
                Some(Issue::InputLimit)
            }
            Some(EvaluationStatus::Unavailable(EvaluationIssue::SignIn)) => {
                Some(Issue::Authentication)
            }
            Some(EvaluationStatus::Unavailable(EvaluationIssue::Credentials)) => {
                Some(Issue::Credentials)
            }
            Some(EvaluationStatus::Unavailable(EvaluationIssue::UsageLimit)) => {
                Some(Issue::Allowance)
            }
            Some(EvaluationStatus::Unavailable(EvaluationIssue::Unreachable)) => {
                Some(Issue::Unreachable)
            }
            Some(EvaluationStatus::Unavailable(EvaluationIssue::TimedOut)) => Some(Issue::TimedOut),
            Some(EvaluationStatus::Unavailable(EvaluationIssue::InvalidReply)) => {
                Some(Issue::InvalidReply)
            }
            Some(EvaluationStatus::Unavailable(_)) => Some(Issue::Worker),
            _ => None,
        };
        let approved = if self.has_processing_permission() {
            let grant = self
                .evaluation
                .as_ref()
                .and_then(|s| s.permission.grant.as_ref())
                .unwrap();
            Some(Scope {
                conversation: if grant.after_ms.is_some() {
                    ConversationScope::NewSpeechOnly
                } else {
                    ConversationScope::RecentAndNewSpeech
                },
                notes: notes
                    .iter()
                    .filter(|n| {
                        grant.notes.iter().any(|s| {
                            s.id == format!(
                                "prior:{}:{}",
                                n.source.provider.id(),
                                n.source.source_id
                            ) && s.revision == n.source.revision
                        })
                    })
                    .map(|n| n.source.clone())
                    .collect(),
            })
        } else {
            None
        };
        let phase = if self.is_live_stopping() {
            Phase::Stopping
        } else if self.state.status == Status::Ended {
            Phase::Ended
        } else if self.evaluation.is_none() || issue.is_some() {
            Phase::Unavailable
        } else if approved.is_some() {
            if self.state.cues_paused {
                Phase::Paused
            } else {
                Phase::Active
            }
        } else {
            Phase::Off
        };
        let last_decision = if phase == Phase::Active {
            match self.evaluation_status() {
                Some(EvaluationStatus::Decided(EvaluationOutcome::Quiet)) => {
                    Some(LastDecision::Quiet)
                }
                Some(EvaluationStatus::Decided(EvaluationOutcome::Shown)) => {
                    Some(LastDecision::Cue)
                }
                _ => None,
            }
        } else {
            None
        };
        let sending =
            phase == Phase::Active && self.evaluation_status() == Some(EvaluationStatus::Pending);
        ProcessingSnapshot {
            sending,
            revision: 0,
            session: self.session().to_string(),
            scope_revision,
            phase,
            capture,
            stop_target: StopTarget::default(),
            startup: StartupState::Idle,
            processor: self
                .evaluation
                .as_ref()
                .map(|s| ProcessorSummary::from(&s.permission.processor)),
            notes,
            approved,
            issue,
            last_decision,
            microphone: None,
            source: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cue_evaluator::{Cancellation, Evaluator};
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::{Duration, Instant},
    };

    struct Fictional(Arc<AtomicUsize>, bool);
    impl Evaluator for Fictional {
        fn evaluate(&mut self, request: &Request, _: &Cancellation) -> Result<String, Failure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            if self.1 {
                return Err(Failure::EvaluatorUnavailable);
            }
            Ok(
                serde_json::json!({"action":"quiet","cue":null,"sourceIds":[request.sources()[0].id]})
                .to_string(),
            )
        }
    }
    fn config(location: ProcessingLocation) -> ProcessorConfiguration {
        ProcessorConfiguration::new(
            "fictional".into(),
            1,
            "fixture".into(),
            location,
            "private-policy-version".into(),
            ProcessorDisclosure::new(
                "Garden evaluator".into(),
                "Fictional policy; no real provider is connected.".into(),
            )
            .unwrap(),
        )
        .unwrap()
    }
    fn engine(fail: bool) -> (Engine, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut e = Engine::live_with_evaluator(
            Worker::start(Fictional(calls.clone(), fail), Duration::from_secs(2)).unwrap(),
            config(ProcessingLocation::Hosted {
                service: "Example service".into(),
            }),
        );
        e.start().unwrap();
        (e, calls)
    }
    fn note(provider: Provider, id: &str) -> ContextItem {
        ContextItem {
            provider,
            source_id: id.into(),
            revision: 1,
            title: "Garden guide".into(),
            source_date: "2026-11-01".into(),
            excerpt: "PRIVATE_EXCERPT_SENTINEL".into(),
        }
    }
    fn approve(e: &mut Engine, notes: &[ContextItem]) {
        let review = e
            .review_processing(
                ConversationScope::NewSpeechOnly,
                &notes
                    .iter()
                    .map(|n| (n.provider, n.source_id.clone(), n.revision))
                    .collect::<Vec<_>>(),
            )
            .unwrap();
        e.approve_processing(review).unwrap();
    }
    fn line(e: &mut Engine) {
        e.advance(1);
        e.ingest(
            e.session(),
            Segment {
                id: format!("line-{}", e.state.elapsed_ms),
                at_ms: e.state.elapsed_ms,
                speaker: "PRIVATE_SPEAKER_SENTINEL".into(),
                text: "PRIVATE_TRANSCRIPT_SENTINEL".into(),
            },
        )
        .unwrap();
    }
    fn settle(e: &mut Engine) {
        let until = Instant::now() + Duration::from_secs(2);
        while e.evaluation_status() == Some(EvaluationStatus::Pending) && Instant::now() < until {
            // Keep the virtual freshness clock near wall time on busy CI hosts.
            std::thread::sleep(Duration::from_millis(1));
            e.advance(1);
        }
        assert_ne!(e.evaluation_status(), Some(EvaluationStatus::Pending));
    }

    #[test]
    fn native_disclosures_are_bounded_and_destinations_come_from_registration() {
        for (name, policy) in [
            (" ".into(), "Policy".into()),
            ("Name\n".into(), "Policy".into()),
            ("n".repeat(257), "Policy".into()),
            ("Name".into(), "p".repeat(2049)),
            ("Name".into(), "".into()),
        ] {
            assert_eq!(
                ProcessorDisclosure::new(name, policy),
                Err(ProcessingError::InvalidScope)
            );
        }
        assert!(ProcessorDisclosure::new("n".repeat(256), "p".repeat(2048)).is_ok());
        for (location, expected) in [
            (ProcessingLocation::OnDevice, "This device"),
            (
                ProcessingLocation::Hosted {
                    service: "Example service".into(),
                },
                "Example service",
            ),
        ] {
            let summary = ProcessorSummary::from(&config(location));
            assert_eq!(summary.destination, expected);
            assert_eq!(summary.name, "Garden evaluator");
            assert!(summary.data_policy.starts_with("Fictional policy"));
        }
    }

    #[test]
    fn normal_app_has_no_processor_or_quiet_claim_and_end_does_not_prove_capture_off() {
        let mut e = Engine::live();
        e.start().unwrap();
        let mut t = ProcessingTracker::default();
        for capture in [
            CaptureState::Unknown,
            CaptureState::Off,
            CaptureState::Starting,
            CaptureState::Running,
            CaptureState::Stopping,
        ] {
            let (s, _) = t.update(&e, capture);
            assert_eq!(s.capture, capture);
            assert_eq!(s.phase, Phase::Unavailable);
            assert!(s.processor.is_none() && s.approved.is_none() && s.last_decision.is_none());
        }
        e.end();
        let (s, _) = t.update(&e, CaptureState::Running);
        assert_eq!(s.phase, Phase::Ended);
        assert_eq!(s.capture, CaptureState::Running);
    }

    #[test]
    fn approval_snapshot_contains_exact_source_metadata_without_content_or_private_policy_keys() {
        let (mut e, calls) = engine(false);
        let a = note(Provider::File, "same:id");
        let b = note(Provider::Granola, "same:id");
        e.set_notes(vec![a.clone(), b]);
        e.update_notes("PRIVATE_MANUAL_SENTINEL".into()).unwrap();
        e.state.user_name = Some("PRIVATE_NAME_SENTINEL".into());
        e.state.focus = vec!["PRIVATE_FOCUS_SENTINEL".into()];
        let mut t = ProcessingTracker::default();
        let (off, _) = t.update(&e, CaptureState::Running);
        assert_eq!(off.phase, Phase::Off);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        approve(&mut e, std::slice::from_ref(&a));
        line(&mut e);
        settle(&mut e);
        let (s, _) = t.update(&e, CaptureState::Running);
        assert_eq!(s.phase, Phase::Active);
        assert_eq!(s.last_decision, Some(LastDecision::Quiet));
        assert_eq!(
            s.approved.as_ref().unwrap().notes,
            vec![NoteSummary::from(&a).source]
        );
        assert_eq!(
            s.approved.as_ref().unwrap().conversation,
            ConversationScope::NewSpeechOnly
        );
        assert_eq!(s.notes.len(), 2);
        let serialized = serde_json::to_string(&s).unwrap();
        assert!(!serialized.contains("PRIVATE_") && !serialized.contains("private-policy-version"));
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["notes"][0]["sourceId"], "same:id");
        assert_eq!(json["processor"]["location"], "hosted");
        assert_eq!(json["lastDecision"], "quiet");
    }

    #[test]
    fn an_application_source_is_reported_beside_the_microphone_and_absent_otherwise() {
        let (e, _) = engine(false);
        let mut t = ProcessingTracker::default();
        // Without a source, as in every default build: neither field exists.
        let (plain, _) = t.update(&e, CaptureState::Off);
        let json = serde_json::to_value(&plain).unwrap();
        assert!(json.get("microphone").is_none() && json.get("source").is_none());

        let failed = SourceCapture {
            phase: SourcePhase::CleanupFailed,
            may_be_capturing: true,
            stalled: false,
            can_retry: true,
            application: Some("Fictional player".into()),
            problem: Some(SourceProblem::StopFailed),
            operation: Some("fictional-operation".into()),
            source_session: false,
        };
        let (with, changed) = t.update_with_source(
            &e,
            CaptureState::Stopping,
            StopTarget::default(),
            StartupState::Idle,
            Some((CaptureState::Off, failed.clone())),
        );
        assert!(changed && with.revision > plain.revision);
        let json = serde_json::to_value(&with).unwrap();
        // The combined state keeps saying stopping; the microphone alone is
        // off, so a control that concerns only the microphone can say so.
        assert_eq!(json["capture"], "stopping");
        assert_eq!(json["microphone"], "off");
        assert_eq!(json["source"]["phase"], "cleanupFailed");
        assert_eq!(json["source"]["mayBeCapturing"], true);
        assert_eq!(json["source"]["canRetry"], true);
        assert_eq!(json["source"]["application"], "Fictional player");
        assert_eq!(json["source"]["problem"], "stopFailed");
        // Unchanged source, unchanged snapshot: no new event.
        let (_, again) = t.update_with_source(
            &e,
            CaptureState::Stopping,
            StopTarget::default(),
            StartupState::Idle,
            Some((CaptureState::Off, failed.clone())),
        );
        assert!(!again);
        // A change in the source alone is an event.
        let abandoned = SourceCapture {
            phase: SourcePhase::Abandoned,
            can_retry: false,
            problem: None,
            ..failed
        };
        let (_, moved) = t.update_with_source(
            &e,
            CaptureState::Stopping,
            StopTarget::default(),
            StartupState::Idle,
            Some((CaptureState::Off, abandoned)),
        );
        assert!(moved);
    }

    #[test]
    fn revisions_follow_scope_changes_not_ticks_manual_notes_or_note_order() {
        let (mut e, _) = engine(false);
        let a = note(Provider::File, "one");
        e.set_notes(vec![a.clone()]);
        approve(&mut e, std::slice::from_ref(&a));
        let mut t = ProcessingTracker::default();
        let (first, _) = t.update(&e, CaptureState::Running);
        e.advance(100);
        e.update_notes("Optional manual draft".into()).unwrap();
        assert_eq!(t.update(&e, CaptureState::Running), (first.clone(), false));
        let mut b = note(Provider::Granola, "two");
        e.set_notes(vec![a.clone(), b.clone()]);
        let (added, changed) = t.update(&e, CaptureState::Running);
        assert!(
            changed
                && added.scope_revision > first.scope_revision
                && added.revision > first.revision
        );
        assert_eq!(added.approved, first.approved);
        e.set_notes(vec![b.clone(), a.clone()]);
        assert_eq!(t.update(&e, CaptureState::Running), (added.clone(), false));
        b.excerpt = "Revised fictional context with the same revision.".into();
        e.set_notes(vec![a, b]);
        let (edited, changed) = t.update(&e, CaptureState::Running);
        assert!(changed && edited.scope_revision > added.scope_revision);
        assert_eq!(edited.notes, added.notes);
        assert_eq!(edited.approved, first.approved);
        let (unknown, changed) = t.update(&e, CaptureState::Unknown);
        assert!(changed && unknown.revision > edited.revision);
        assert_eq!(unknown.scope_revision, edited.scope_revision);
    }

    #[test]
    fn changed_approved_sources_report_scope_failure_until_explicit_reapproval() {
        let (mut e, calls) = engine(false);
        let mut a = note(Provider::File, "one");
        e.set_notes(vec![a.clone()]);
        approve(&mut e, std::slice::from_ref(&a));
        let mut t = ProcessingTracker::default();
        let (before, _) = t.update(&e, CaptureState::Running);
        a.excerpt = "Changed fictional text.".into();
        e.set_notes(vec![a.clone()]);
        line(&mut e);
        let (s, _) = t.update(&e, CaptureState::Running);
        assert_eq!(s.phase, Phase::Unavailable);
        assert_eq!(s.issue, Some(Issue::ScopeChanged));
        assert!(
            s.approved.is_none()
                && s.last_decision.is_none()
                && s.scope_revision > before.scope_revision
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        approve(&mut e, &[a]);
        let (next, _) = t.update(&e, CaptureState::Running);
        assert_eq!(next.phase, Phase::Active);
        assert!(next.issue.is_none());
    }

    #[test]
    fn pause_stop_drain_and_replacement_keep_distinct_monotonic_status() {
        let (mut e, _) = engine(false);
        approve(&mut e, &[]);
        let mut t = ProcessingTracker::default();
        let (active, _) = t.update(&e, CaptureState::Running);
        e.set_live_cues_paused(true).unwrap();
        let (paused, _) = t.update(&e, CaptureState::Running);
        assert_eq!(paused.phase, Phase::Paused);
        assert_eq!(paused.approved, active.approved);
        assert!(paused.scope_revision > active.scope_revision);
        e.begin_live_stop();
        let (stopping, _) = t.update(&e, CaptureState::Running);
        assert_eq!(stopping.phase, Phase::Stopping);
        assert!(stopping.approved.is_none());
        let (draining, _) = t.update(&e, CaptureState::Off);
        assert_eq!(draining.phase, Phase::Stopping);
        assert_eq!(draining.capture, CaptureState::Off);
        assert!(e.finish_live_stop(e.session()));
        let (ended, _) = t.update(&e, CaptureState::Off);
        let (other, _) = engine(false);
        assert_eq!(other.session(), e.session());
        let (new, changed) = t.update(&other, CaptureState::Starting);
        assert!(
            changed && new.revision > ended.revision && new.scope_revision > ended.scope_revision
        );
        assert_eq!(new.phase, Phase::Off);
        assert!(new.approved.is_none());
    }

    #[test]
    fn quiet_pending_and_worker_failure_are_not_inferred_from_an_empty_cue() {
        for fail in [false, true] {
            let (mut e, _) = engine(fail);
            approve(&mut e, &[]);
            let mut t = ProcessingTracker::default();
            let (idle, _) = t.update(&e, CaptureState::Running);
            assert!(idle.last_decision.is_none());
            line(&mut e);
            let (pending, _) = t.update(&e, CaptureState::Running);
            assert!(pending.last_decision.is_none());
            settle(&mut e);
            let (done, _) = t.update(&e, CaptureState::Running);
            assert!(done.revision > idle.revision);
            if fail {
                assert_eq!(done.phase, Phase::Unavailable);
                assert_eq!(done.issue, Some(Issue::Worker));
                assert!(done.approved.is_none() && done.last_decision.is_none());
            } else {
                assert_eq!(done.last_decision, Some(LastDecision::Quiet));
            }
            e.set_live_cues_paused(true).unwrap();
            e.set_live_cues_paused(false).unwrap();
            let (resumed, _) = t.update(&e, CaptureState::Running);
            assert!(resumed.last_decision.is_none());
            if fail {
                assert_eq!(resumed.issue, Some(Issue::Worker));
            }
        }
    }
}
