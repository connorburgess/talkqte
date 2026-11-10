//! Provider-independent cue evaluation. No provider or app command starts this
//! worker yet. The caller supplies selected, bounded sources; the evaluator has
//! no engine, capture, file, or export handle. Validation establishes structure
//! and source membership, not semantic truth or usefulness.

use serde::{Deserialize, Serialize};
use std::{
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError},
        Arc,
    },
    time::{Duration, Instant},
};

pub const MAX_SOURCES: usize = 32;
pub const MAX_SOURCE_BYTES: usize = 4_096;
pub const MAX_CONTEXT_BYTES: usize = 32_768;
pub const MAX_REPLY_BYTES: usize = 4_096;
pub const MAX_BUDGET: Duration = Duration::from_secs(10);

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Provenance {
    Transcript {
        at_ms: u64,
        speaker: String,
    },
    PriorNote {
        provider: crate::context::Provider,
        date: String,
    },
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct Source {
    /// Unique within this request; the caller namespaces different inputs.
    pub id: String,
    pub revision: u64,
    pub provenance: Provenance,
    pub text: String,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingCue {
    pub id: String,
    pub text: String,
    pub source_ids: Vec<String>,
}

/// Immutable input. The context revision must change for topic, focus, pause,
/// dismissal, source or other eligibility changes; it is not a timer revision.
/// Compare the current request again while holding the lifecycle lock at poll.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    session: u64,
    context_revision: u64,
    sources: Vec<Source>,
    existing_cue: Option<ExistingCue>,
}

// Never expose meeting text, source IDs, cue text, or speaker metadata in logs.
impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Request")
            .field("source_count", &self.sources.len())
            .field("has_existing_cue", &self.existing_cue.is_some())
            .finish_non_exhaustive()
    }
}

fn bounded_text(text: &str, chars: usize) -> bool {
    !text.trim().is_empty()
        && text.chars().count() <= chars
        && !text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}

impl Request {
    pub fn new(
        session: u64,
        context_revision: u64,
        sources: Vec<Source>,
        existing_cue: Option<ExistingCue>,
    ) -> Result<Self, Failure> {
        if sources.is_empty() || sources.len() > MAX_SOURCES {
            return Err(Failure::InvalidInput);
        }
        let mut bytes = 0usize;
        for (index, source) in sources.iter().enumerate() {
            let metadata = match &source.provenance {
                Provenance::Transcript { speaker, .. } => speaker,
                Provenance::PriorNote { date, .. } => date,
            };
            if !bounded_text(&source.id, 128)
                || !bounded_text(metadata, 128)
                || source.text.trim().is_empty()
                || source.text.len() > MAX_SOURCE_BYTES
                || sources[..index]
                    .iter()
                    .any(|earlier| earlier.id == source.id)
            {
                return Err(Failure::InvalidInput);
            }
            bytes += source.text.len() + source.id.len() + metadata.len();
        }
        if bytes > MAX_CONTEXT_BYTES {
            return Err(Failure::InvalidInput);
        }
        let request = Self {
            session,
            context_revision,
            sources,
            existing_cue,
        };
        if let Some(cue) = &request.existing_cue {
            if !bounded_text(&cue.id, 128)
                || !bounded_text(&cue.text, 240)
                || !request.has_sources(&cue.source_ids)
            {
                return Err(Failure::InvalidInput);
            }
        }
        Ok(request)
    }

    pub fn sources(&self) -> &[Source] {
        &self.sources
    }
    pub fn existing_cue(&self) -> Option<&ExistingCue> {
        self.existing_cue.as_ref()
    }

    fn has_sources(&self, ids: &[String]) -> bool {
        !ids.is_empty()
            && ids.len() <= 4
            && ids.iter().enumerate().all(|(i, id)| {
                !ids[..i].contains(id) && self.sources.iter().any(|source| source.id == *id)
            })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Show,
    Quiet,
    Resolved,
    Withdraw,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservedUse {
    NotObserved,
    Possible,
    Unknown,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawDecision {
    action: Action,
    // Value keeps this field required; an absent Option would deserialize as None.
    cue: serde_json::Value,
    source_ids: Vec<String>,
    reason: String,
    observed_use: ObservedUse,
}

/// A checked proposal, never an instruction to the app. Rust still decides
/// whether to display it and how hold, dismissal, pause and cooldown apply.
#[derive(PartialEq, Eq)]
pub struct Decision {
    pub action: Action,
    pub cue: Option<String>,
    pub source_ids: Vec<String>,
    pub reason: String,
    pub observed_use: ObservedUse,
}

impl fmt::Debug for Decision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Decision")
            .field("action", &self.action)
            .field("source_count", &self.source_ids.len())
            .finish_non_exhaustive()
    }
}

fn validate(text: &str, request: &Request) -> Result<Decision, Failure> {
    if text.len() > MAX_REPLY_BYTES {
        return Err(Failure::InvalidDecision);
    }
    let raw: RawDecision = serde_json::from_str(text).map_err(|_| Failure::InvalidDecision)?;
    let cue = match (&raw.action, raw.cue) {
        (Action::Show, serde_json::Value::String(cue))
            if request.existing_cue.is_none() && bounded_text(&cue, 240) =>
        {
            Some(cue)
        }
        (Action::Quiet | Action::Resolved | Action::Withdraw, serde_json::Value::Null) => None,
        _ => return Err(Failure::InvalidDecision),
    };
    if !request.has_sources(&raw.source_ids)
        || !bounded_text(&raw.reason, 300)
        || (matches!(raw.action, Action::Resolved | Action::Withdraw)
            && request.existing_cue.is_none())
        || (request.existing_cue.is_none() && raw.observed_use != ObservedUse::NotObserved)
    {
        return Err(Failure::InvalidDecision);
    }
    Ok(Decision {
        action: raw.action,
        cue,
        source_ids: raw.source_ids,
        reason: raw.reason,
        observed_use: raw.observed_use,
    })
}

/// Fixed failure codes contain no provider messages or meeting content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    InvalidInput,
    InvalidDecision,
    Busy,
    Cancelled,
    Expired,
    Stale,
    EvaluatorUnavailable,
    WorkerUnavailable,
}

pub struct Cancellation {
    stopped: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

impl Cancellation {
    pub fn is_cancelled(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
            || self.cancelled.load(Ordering::Acquire)
            || Instant::now() >= self.deadline
    }
}

/// Runs only on the worker. An adapter must bound its transport/output and
/// cooperate with cancellation. This trait is not an OS sandbox for providers.
/// No credentials, retry loop, fallback provider, or model runtime is supplied.
pub trait Evaluator: Send + 'static {
    fn evaluate(&mut self, request: &Request, cancel: &Cancellation) -> Result<String, Failure>;
}

struct Job {
    id: u64,
    request: Request,
    cancel: Cancellation,
}
struct Pending {
    id: u64,
    request: Request,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

struct WorkerExit(Arc<AtomicBool>);
impl Drop for WorkerExit {
    fn drop(&mut self) {
        // Also retire the worker if an adapter unwinds. Never report a dead
        // worker as merely busy or launch a replacement automatically.
        self.0.store(true, Ordering::Release);
    }
}

/// One evaluation at a time, with no waiting backlog or automatic retries.
/// Expiry/cancellation releases the caller immediately. An uncooperative
/// evaluator still occupies this worker until it returns; it is never replaced
/// with another thread to conceal a stall. Drop cancels without waiting.
pub struct Worker {
    jobs: Option<SyncSender<Job>>,
    replies: Receiver<(u64, Result<Decision, Failure>)>,
    stopped: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    pending: Option<Pending>,
    next_id: u64,
    budget: Duration,
}

impl Worker {
    pub fn start<E: Evaluator>(mut evaluator: E, budget: Duration) -> Result<Self, Failure> {
        if budget.is_zero() || budget > MAX_BUDGET {
            return Err(Failure::InvalidInput);
        }
        let (jobs, input) = mpsc::sync_channel::<Job>(1);
        let (output, replies) = mpsc::sync_channel(1);
        let stopped = Arc::new(AtomicBool::new(false));
        let active = Arc::new(AtomicBool::new(false));
        let finished = active.clone();
        let worker_stopped = stopped.clone();
        std::thread::Builder::new()
            .name("talkqte-cue-evaluator".into())
            .spawn(move || {
                let _exit = WorkerExit(worker_stopped);
                while let Ok(job) = input.recv() {
                    let result = if job.cancel.is_cancelled() {
                        Err(Failure::Cancelled)
                    } else {
                        evaluator
                            .evaluate(&job.request, &job.cancel)
                            .map_err(|_| Failure::EvaluatorUnavailable)
                            .and_then(|text| {
                                if job.cancel.is_cancelled() {
                                    Err(Failure::Cancelled)
                                } else {
                                    validate(&text, &job.request)
                                }
                            })
                    };
                    // A bounded mailbox never blocks cancellation or caller teardown.
                    let _ = output.try_send((job.id, result));
                    finished.store(false, Ordering::Release);
                }
            })
            .map_err(|_| Failure::WorkerUnavailable)?;
        Ok(Self {
            jobs: Some(jobs),
            replies,
            stopped,
            active,
            pending: None,
            next_id: 0,
            budget,
        })
    }

    pub fn submit(&mut self, request: Request) -> Result<(), Failure> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(Failure::WorkerUnavailable);
        }
        if self.pending.is_some() || self.active.load(Ordering::Acquire) {
            return Err(Failure::Busy);
        }
        // Discard a cancelled/expired attempt's late completion before reuse.
        while self.replies.try_recv().is_ok() {}
        let id = self
            .next_id
            .checked_add(1)
            .ok_or(Failure::WorkerUnavailable)?;
        self.next_id = id;
        let deadline = Instant::now() + self.budget;
        let cancelled = Arc::new(AtomicBool::new(false));
        let job = Job {
            id,
            request: request.clone(),
            cancel: Cancellation {
                stopped: self.stopped.clone(),
                cancelled: cancelled.clone(),
                deadline,
            },
        };
        self.active.store(true, Ordering::Release);
        if self
            .jobs
            .as_ref()
            .ok_or(Failure::WorkerUnavailable)?
            .try_send(job)
            .is_err()
        {
            self.active.store(false, Ordering::Release);
            return Err(Failure::WorkerUnavailable);
        }
        self.pending = Some(Pending {
            id,
            request,
            cancelled,
            deadline,
        });
        Ok(())
    }

    pub fn cancel_pending(&mut self) {
        if let Some(pending) = &self.pending {
            pending.cancelled.store(true, Ordering::Release);
        }
    }

    /// Poll and apply under the same lifecycle lock. `current` must reflect the
    /// active session, eligibility revision, cue identity and selected sources.
    /// Whole-input comparison catches changed/removed text even if a producer
    /// accidentally reuses a revision. Stop/pause/dismiss must cancel the work.
    pub fn poll(&mut self, current: &Request) -> Option<Result<Decision, Failure>> {
        self.poll_at(current, Instant::now())
    }

    fn poll_at(&mut self, current: &Request, now: Instant) -> Option<Result<Decision, Failure>> {
        let pending = self.pending.as_ref()?;
        let invalid = if pending.cancelled.load(Ordering::Acquire) {
            Some(Failure::Cancelled)
        } else if pending.request != *current {
            Some(Failure::Stale)
        } else if now >= pending.deadline {
            Some(Failure::Expired)
        } else {
            None
        };
        if let Some(error) = invalid {
            self.cancel_pending();
            self.pending = None;
            return Some(Err(error));
        }
        match self.replies.try_recv() {
            Ok((id, result)) => {
                let expected = self.pending.take().expect("pending checked");
                Some(if id == expected.id {
                    result
                } else {
                    Err(Failure::Stale)
                })
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                self.stopped.store(true, Ordering::Release);
                self.pending = None;
                Some(Err(Failure::WorkerUnavailable))
            }
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.cancel_pending();
        self.jobs.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;

    fn request(existing: bool) -> Request {
        Request::new(
            7,
            12,
            vec![
                Source {
                    id: "e1".into(),
                    revision: 1,
                    provenance: Provenance::Transcript {
                        at_ms: 1_000,
                        speaker: "Unknown".into(),
                    },
                    text: "Someone should send the garden checklist.".into(),
                },
                Source {
                    id: "e2".into(),
                    revision: 1,
                    provenance: Provenance::Transcript {
                        at_ms: 3_000,
                        speaker: "Robin".into(),
                    },
                    text: "I will send the checklist.".into(),
                },
            ],
            existing.then(|| ExistingCue {
                id: "cue-1".into(),
                text: "Who will send the garden checklist?".into(),
                source_ids: vec!["e1".into()],
            }),
        )
        .unwrap()
    }

    fn reply(action: &str) -> String {
        json!({"action":action,"cue": if action == "show" {json!("Who will send the garden checklist?")} else {json!(null)},
            "sourceIds":["e1","e2"], "reason":"The supplied lines support this fictional decision.",
            "observedUse":"not_observed"}).to_string()
    }

    struct Fixed(Result<String, Failure>);
    impl Evaluator for Fixed {
        fn evaluate(&mut self, _: &Request, _: &Cancellation) -> Result<String, Failure> {
            self.0.clone()
        }
    }

    fn finish(worker: &mut Worker, current: &Request) -> Result<Decision, Failure> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(result) = worker.poll(current) {
                return result;
            }
            assert!(
                Instant::now() < deadline,
                "fictional worker failed to complete"
            );
            std::thread::yield_now();
        }
    }

    struct Held {
        started: mpsc::Sender<()>,
        release: Receiver<()>,
        calls: Arc<AtomicUsize>,
    }
    impl Evaluator for Held {
        fn evaluate(&mut self, _: &Request, cancel: &Cancellation) -> Result<String, Failure> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.started.send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(3)).unwrap();
            // Return a valid reply even after cancellation, exercising the
            // boundary against an adapter that did not stop its own operation.
            let _ = cancel.is_cancelled();
            Ok(reply("quiet"))
        }
    }
    type HeldWorker = (Worker, Receiver<()>, mpsc::Sender<()>, Arc<AtomicUsize>);
    fn held_worker() -> HeldWorker {
        let (started, receipt) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker = Worker::start(
            Held {
                started,
                release: wait,
                calls: calls.clone(),
            },
            MAX_BUDGET,
        )
        .unwrap();
        (worker, receipt, release, calls)
    }
    fn wait_idle(worker: &Worker) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while worker.active.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
    }

    #[test]
    fn all_decisions_are_proposals_with_explicit_evidence_and_observed_use() {
        for (action, existing, expected) in [
            ("show", false, Action::Show),
            ("quiet", false, Action::Quiet),
            ("resolved", true, Action::Resolved),
            ("withdraw", true, Action::Withdraw),
        ] {
            let input = request(existing);
            let mut worker = Worker::start(Fixed(Ok(reply(action))), MAX_BUDGET).unwrap();
            worker.submit(input.clone()).unwrap();
            let result = finish(&mut worker, &input).unwrap();
            assert_eq!(result.action, expected);
            assert_eq!(result.source_ids, ["e1", "e2"]);
            assert_eq!(result.observed_use, ObservedUse::NotObserved);
            assert_eq!(result.cue.is_some(), action == "show");
        }
        let mut value: serde_json::Value = serde_json::from_str(&reply("quiet")).unwrap();
        value["observedUse"] = json!("possible");
        assert_eq!(
            validate(&value.to_string(), &request(true)).unwrap().action,
            Action::Quiet
        );
        assert_eq!(
            validate(&value.to_string(), &request(false)),
            Err(Failure::InvalidDecision)
        );
    }

    #[test]
    fn malformed_or_unsupported_output_cannot_become_a_cue() {
        let valid: serde_json::Value = serde_json::from_str(&reply("show")).unwrap();
        let mut bad = vec![
            "not JSON".into(),
            "[]".into(),
            "x".repeat(MAX_REPLY_BYTES + 1),
            reply("resolved"),
            reply("withdraw"),
        ];
        for (key, value) in [
            ("sourceIds", json!(["missing"])),
            ("sourceIds", json!(["e1", "e1"])),
            ("sourceIds", json!([])),
            ("cue", json!(null)),
            ("cue", json!(" ")),
            ("cue", json!("x".repeat(241))),
            ("reason", json!("x".repeat(301))),
            ("reason", json!("")),
            ("action", json!("execute")),
            ("observedUse", json!("useful")),
            ("capture", json!(true)),
            ("cue", json!("hidden\u{001b} instruction")),
        ] {
            let mut value_with_error = valid.clone();
            value_with_error[key] = value;
            bad.push(value_with_error.to_string());
        }
        let mut missing_cue = valid;
        missing_cue.as_object_mut().unwrap().remove("cue");
        bad.push(missing_cue.to_string());
        bad.push(reply("quiet").replacen("{", "{\"action\":\"show\",", 1));
        for raw in bad {
            assert_eq!(
                validate(&raw, &request(false)),
                Err(Failure::InvalidDecision)
            );
        }
        assert_eq!(
            validate(&reply("show"), &request(true)),
            Err(Failure::InvalidDecision),
            "an evaluator cannot replace a visible cue"
        );
    }

    #[test]
    fn requests_bound_selected_context_and_keep_note_provenance() {
        let original = request(false);
        let make = |sources| Request::new(1, 1, sources, None);
        assert_eq!(make(vec![]).unwrap_err(), Failure::InvalidInput);
        assert_eq!(
            make(vec![original.sources[0].clone(); 2]).unwrap_err(),
            Failure::InvalidInput
        );
        let mut large = original.sources.clone();
        large[0].text = "x".repeat(MAX_SOURCE_BYTES + 1);
        assert_eq!(make(large).unwrap_err(), Failure::InvalidInput);
        for (count, size) in [(MAX_SOURCES + 1, 1), (MAX_SOURCES, MAX_SOURCE_BYTES)] {
            let sources = (0..count)
                .map(|i| Source {
                    id: format!("e{i}"),
                    text: "x".repeat(size),
                    ..original.sources[0].clone()
                })
                .collect();
            assert_eq!(make(sources).unwrap_err(), Failure::InvalidInput);
        }
        let mut cue = request(true).existing_cue.unwrap();
        cue.source_ids = vec!["unselected-note".into()];
        assert_eq!(
            Request::new(1, 1, original.sources.clone(), Some(cue)).unwrap_err(),
            Failure::InvalidInput
        );
        let note = Source {
            id: "granola:fictional-note".into(),
            revision: 4,
            provenance: Provenance::PriorNote {
                provider: crate::context::Provider::Granola,
                date: "2026-11-01".into(),
            },
            text: "Earlier garden notes, not current speech.".into(),
        };
        let input = make(vec![note]).unwrap();
        let encoded = serde_json::to_value(&input).unwrap();
        assert_eq!(encoded["sources"][0]["provenance"]["kind"], "priorNote");
        assert_eq!(encoded["sources"][0]["provenance"]["date"], "2026-11-01");
        assert!(!format!("{input:?}").contains("garden"));
        assert!(
            !format!("{:?}", validate(&reply("show"), &original).unwrap()).contains("checklist")
        );
    }

    #[test]
    fn changed_session_sources_cue_or_context_rejects_a_late_result() {
        for change in 0..7 {
            let original = request(true);
            let (mut worker, started, release, _) = held_worker();
            worker.submit(original.clone()).unwrap();
            started.recv_timeout(Duration::from_secs(2)).unwrap();
            let mut current = original.clone();
            match change {
                0 => current.session += 1,
                1 => current.context_revision += 1,
                2 => current.sources[0].revision += 1,
                3 => current.sources[0].text = "Corrected fictional line.".into(),
                4 => {
                    current.sources.pop();
                }
                5 => current.existing_cue = None,
                _ => current.existing_cue.as_mut().unwrap().id = "replacement-cue".into(),
            }
            assert_eq!(worker.poll(&current), Some(Err(Failure::Stale)));
            release.send(()).unwrap();
            wait_idle(&worker);
            assert!(
                worker.poll(&current).is_none(),
                "no result can revive after invalidation"
            );
        }
    }

    #[test]
    fn cancellation_has_no_backlog_retry_or_replacement_thread() {
        let input = request(false);
        let (mut worker, started, release, calls) = held_worker();
        worker.submit(input.clone()).unwrap();
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        for _ in 0..100 {
            assert_eq!(worker.submit(input.clone()), Err(Failure::Busy));
        }
        worker.cancel_pending();
        assert_eq!(worker.poll(&input), Some(Err(Failure::Cancelled)));
        assert_eq!(
            worker.submit(input.clone()),
            Err(Failure::Busy),
            "cancel cannot spawn overlapping evaluations"
        );
        release.send(()).unwrap();
        wait_idle(&worker);
        worker.submit(input.clone()).unwrap();
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            worker.poll(&input).is_none(),
            "old completion cannot satisfy a newer request"
        );
        release.send(()).unwrap();
        assert_eq!(finish(&mut worker, &input).unwrap().action, Action::Quiet);
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn expired_or_completed_but_unread_results_never_display() {
        let input = request(false);
        for complete_first in [false, true] {
            let (mut worker, started, release, calls) = held_worker();
            worker.submit(input.clone()).unwrap();
            started.recv_timeout(Duration::from_secs(2)).unwrap();
            if complete_first {
                release.send(()).unwrap();
                wait_idle(&worker);
            }
            let deadline = worker.pending.as_ref().unwrap().deadline;
            assert_eq!(
                worker.poll_at(&input, deadline),
                Some(Err(Failure::Expired))
            );
            if !complete_first {
                release.send(()).unwrap();
                wait_idle(&worker);
            }
            assert!(worker.poll(&input).is_none());
            assert_eq!(calls.load(Ordering::Relaxed), 1);
        }
    }

    #[test]
    fn failure_is_quiet_and_drop_does_not_wait_for_an_adapter() {
        let input = request(false);
        let mut worker = Worker::start(Fixed(Err(Failure::InvalidInput)), MAX_BUDGET).unwrap();
        worker.submit(input.clone()).unwrap();
        assert_eq!(
            finish(&mut worker, &input),
            Err(Failure::EvaluatorUnavailable)
        );
        assert!(worker.poll(&input).is_none());
        let (mut worker, started, release, calls) = held_worker();
        worker.submit(input).unwrap();
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let active = worker.active.clone();
        drop(worker);
        assert!(
            active.load(Ordering::Acquire),
            "drop returns before the held adapter"
        );
        release.send(()).unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn a_failed_worker_stays_unavailable_without_an_automatic_restart() {
        struct Broken;
        impl Evaluator for Broken {
            fn evaluate(&mut self, _: &Request, _: &Cancellation) -> Result<String, Failure> {
                panic!("fictional adapter failure");
            }
        }
        let input = request(false);
        let mut worker = Worker::start(Broken, MAX_BUDGET).unwrap();
        worker.submit(input.clone()).unwrap();
        assert_eq!(finish(&mut worker, &input), Err(Failure::WorkerUnavailable));
        assert_eq!(worker.submit(input), Err(Failure::WorkerUnavailable));
        assert!(Worker::start(Fixed(Ok(reply("quiet"))), Duration::ZERO).is_err());
        assert!(Worker::start(
            Fixed(Ok(reply("quiet"))),
            MAX_BUDGET + Duration::from_millis(1)
        )
        .is_err());
    }
}
