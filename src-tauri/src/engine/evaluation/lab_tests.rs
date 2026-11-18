//! Controlled offline providers; no native activation or subscription process.
use super::tests::{Harness, OUTPUT_LIMIT, REFUSED};
use super::*;
use crate::cue_evaluator::{EvaluationLifecycle, Settlement};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
#[derive(Default)]
struct Lifecycle {
    cancelled: AtomicUsize,
    terminal: AtomicBool,
    // The link itself ended on a deadline, not one request.
    expired: AtomicBool,
    reject_ack: AtomicBool,
    verdicts: Mutex<Vec<Settlement>>,
}
impl EvaluationLifecycle for Lifecycle {
    fn terminal(&self) -> Option<Failure> {
        if self.expired.load(Ordering::Acquire) {
            return Some(Failure::Expired);
        }
        self.terminal
            .load(Ordering::Acquire)
            .then_some(Failure::WorkerUnavailable)
    }
    fn cancel(&self) {
        self.cancelled.fetch_add(1, Ordering::AcqRel);
        self.terminal.store(true, Ordering::Release);
    }
    fn settle(&self, _: &Request, v: Settlement) -> Result<(), Failure> {
        self.verdicts.lock().unwrap().push(v);
        if self.reject_ack.load(Ordering::Acquire) {
            Err(Failure::WorkerUnavailable)
        } else {
            Ok(())
        }
    }
}
fn lab(h: &mut Harness) -> Arc<Lifecycle> {
    let link = Arc::new(Lifecycle::default());
    h.engine.evaluation.as_mut().unwrap().lab = Some(link.clone());
    link
}
fn until(h: &mut Harness, mut predicate: impl FnMut(&Engine) -> bool) {
    let limit = Instant::now() + Duration::from_secs(2);
    while !predicate(&h.engine) {
        assert!(Instant::now() < limit, "offline worker did not settle");
        h.engine.advance(1);
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn reply(h: &Harness, action: &str, cue: Option<&str>) {
    h.replies
        .send(
            serde_json::json!({"action":action,"cue":cue,"sourceIds":["transcript:line-1"]})
                .to_string(),
        )
        .unwrap();
}
#[test]
fn continuous_speech_keeps_original_running_applies_its_prefix_reply_and_dispatches_latest() {
    let mut h = Harness::new();
    let link = lab(&mut h);
    h.line("Who owns the fictional checklist?");
    let original = h.request();
    for _ in 0..19 {
        h.line("The fictional handoff is being discussed.");
    }
    assert_eq!(link.cancelled.load(Ordering::Acquire), 0);
    assert_eq!(h.engine.evaluation.as_ref().unwrap().requests_sent, 1);
    assert!(h.requests.try_recv().is_err());
    // Speech only grew while it was pending, so the reply still applies.
    reply(&h, "show", Some("Who owns the checklist?"));
    until(&mut h, |e| e.state.cue.is_some());
    assert_eq!(*link.verdicts.lock().unwrap(), vec![Settlement::Current]);
    // Newer speech is checked next, with the lagged cue as the existing cue.
    until(&mut h, |e| {
        e.evaluation.as_ref().unwrap().requests_sent == 2
    });
    let latest = h.request();
    assert_ne!(latest, original);
    assert!(latest
        .sources()
        .iter()
        .any(|s| s.id == "transcript:line-20"));
    assert!(latest.existing_cue().is_some());
    reply(&h, "quiet", None);
    until(&mut h, |e| e.evaluation.as_ref().unwrap().pending.is_none());
    assert_eq!(link.cancelled.load(Ordering::Acquire), 0);
    h.engine.advance(100);
    assert!(h.requests.try_recv().is_err());
}
#[test]
fn a_lagged_cue_is_shown_and_the_next_reply_can_resolve_it() {
    let mut h = Harness::new();
    let link = lab(&mut h);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.line("Maya owns the checklist; that question is answered.");
    reply(&h, "show", Some("Who owns the checklist?"));
    until(&mut h, |e| e.state.cue.is_some());
    until(&mut h, |e| {
        e.evaluation.as_ref().unwrap().requests_sent == 2
    });
    let next = h.request();
    assert!(next.existing_cue().is_some());
    assert!(next.sources().iter().any(|s| s.id == "transcript:line-2"));
    h.replies
        .send(
            serde_json::json!({"action":"resolved","cue":null,"sourceIds":["transcript:line-2"]})
                .to_string(),
        )
        .unwrap();
    until(&mut h, |e| {
        e.evaluation_status() == Some(EvaluationStatus::Decided(EvaluationOutcome::Resolved))
    });
    assert_eq!(
        *link.verdicts.lock().unwrap(),
        vec![Settlement::Current, Settlement::Current]
    );
}
#[test]
fn an_edited_or_removed_line_makes_the_reply_stale() {
    for remove in [false, true] {
        let mut h = Harness::new();
        let link = lab(&mut h);
        h.line("Who owns the fictional checklist?");
        h.request();
        h.line("The meeting continues.");
        if remove {
            h.engine.state.transcript.remove(0);
        } else {
            h.engine.state.transcript[0].text = "Who owns the fictional budget?".into();
        }
        reply(&h, "show", Some("Who owns the checklist?"));
        until(&mut h, |_| !link.verdicts.lock().unwrap().is_empty());
        assert!(h.engine.state.cue.is_none());
        assert_eq!(
            *link.verdicts.lock().unwrap(),
            vec![Settlement::StaleSuccess]
        );
        h.engine.revoke_processing();
        reply(&h, "quiet", None);
    }
}
#[test]
fn prefix_lag_is_measured_and_a_changed_existing_cue_is_stale() {
    let mut h = Harness::new();
    lab(&mut h);
    h.line("Who owns the fictional checklist?");
    let submitted = h.request();
    h.line("Still discussing it.");
    h.line("And the venue.");
    let current = h.engine.evaluation_request().unwrap().unwrap();
    let lag = h.engine.lab_lag(&submitted, &current).unwrap();
    assert_eq!(lag.through_segment, "line-1");
    assert_eq!(lag.lines, 2);
    assert_eq!(lag.ms, 20);
    // The same lines with a different existing cue never apply.
    let with_cue = Request::new(
        current.session_id(),
        current.context_revision(),
        current.sources().to_vec(),
        Some(crate::cue_evaluator::ExistingCue {
            id: "fictional-cue".into(),
            text: "Who owns the checklist?".into(),
            source_ids: vec!["transcript:line-1".into()],
            asked: false,
        }),
    )
    .unwrap();
    assert!(h.engine.lab_lag(&submitted, &with_cue).is_none());
    h.replies.send("{}".into()).unwrap();
}
#[test]
fn a_prefix_reply_past_the_deadline_is_never_applied() {
    let mut h = Harness::with_budget(Duration::from_millis(100));
    let link = lab(&mut h);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.line("The meeting continues.");
    expire(&mut h, &link);
    assert!(h.engine.state.cue.is_none());
    assert_eq!(*link.verdicts.lock().unwrap(), vec![Settlement::Expired]);
}
#[test]
fn malformed_stale_reply_is_terminal_before_latest_dispatch() {
    let mut h = Harness::new();
    let link = lab(&mut h);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.line("Maya owns it now.");
    h.replies.send("not a decision".into()).unwrap();
    until(&mut h, |e| {
        matches!(
            e.evaluation_status(),
            Some(EvaluationStatus::Unavailable(_))
        )
    });
    assert_eq!(
        h.engine.evaluation_status(),
        Some(EvaluationStatus::Unavailable(EvaluationIssue::InvalidReply))
    );
    assert_eq!(*link.verdicts.lock().unwrap(), vec![Settlement::Failed]);
    assert!(!h.engine.has_processing_permission());
    assert!(h.requests.try_recv().is_err());
    assert_eq!(h.engine.evaluation.as_ref().unwrap().requests_sent, 1);
}
// Times out the pending request, then frees the fictional evaluator so the
// worker can accept the next one. Its late reply is never applied.
fn expire(h: &mut Harness, link: &Lifecycle) {
    let before = link.verdicts.lock().unwrap().len();
    until(h, |_| link.verdicts.lock().unwrap().len() > before);
    assert_eq!(
        link.verdicts.lock().unwrap().last(),
        Some(&Settlement::Expired)
    );
    // The timed-out call has returned once the worker is idle or has already
    // taken the waiting speech; waiting for idle alone races that dispatch.
    let sent = h.engine.evaluation.as_ref().unwrap().requests_sent;
    reply(h, "show", Some("Who owns the checklist?"));
    until(h, |e| {
        let state = e.evaluation.as_ref().unwrap();
        !state.worker.is_busy() || state.requests_sent > sent
    });
}
#[test]
fn lab_timeout_is_no_decision_in_time_and_the_run_continues() {
    let mut h = Harness::with_budget(Duration::from_millis(200));
    let link = lab(&mut h);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.line("The meeting continues.");
    expire(&mut h, &link);
    // Skipped, not ended: permission survives and no cue appears.
    assert!(h.engine.has_processing_permission());
    assert!(!matches!(
        h.engine.evaluation_status(),
        Some(EvaluationStatus::Unavailable(_))
    ));
    assert!(h.engine.state.cue.is_none());
    assert_eq!(link.cancelled.load(Ordering::Acquire), 0);
    // The waiting speech is dispatched and a reply in time is applied.
    until(&mut h, |e| {
        e.evaluation.as_ref().unwrap().requests_sent == 2
    });
    let latest = h.request();
    assert!(latest.sources().iter().any(|s| s.id == "transcript:line-2"));
    h.replies.send(serde_json::json!({"action":"show","cue":"Who owns the checklist?","sourceIds":["transcript:line-2"]}).to_string()).unwrap();
    until(&mut h, |e| e.state.cue.is_some());
    assert_eq!(
        *link.verdicts.lock().unwrap(),
        vec![Settlement::Expired, Settlement::Current]
    );
    // Stop still ends the strict run after a skipped timeout.
    h.line("Another fictional line.");
    h.engine.begin_live_stop();
    assert!(link.cancelled.load(Ordering::Acquire) > 0);
    assert!(!h.engine.has_processing_permission());
}
#[test]
fn repeated_lab_timeouts_end_at_the_call_limit() {
    let mut h = Harness::with_budget(Duration::from_millis(100));
    let link = lab(&mut h);
    h.engine.set_model_call_limit(2);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.line("Still discussing it.");
    expire(&mut h, &link);
    until(&mut h, |e| {
        e.evaluation.as_ref().unwrap().requests_sent == 2
    });
    h.request();
    h.line("Nobody has said yes yet.");
    expire(&mut h, &link);
    until(&mut h, |e| !e.has_processing_permission());
    assert_eq!(
        h.engine.evaluation_status(),
        Some(EvaluationStatus::Unavailable(EvaluationIssue::CallLimit))
    );
    assert_eq!(h.engine.evaluation.as_ref().unwrap().requests_sent, 2);
    assert!(h.requests.try_recv().is_err());
    assert!(h.engine.state.cue.is_none());
}
#[test]
fn an_expiry_the_link_cannot_retire_ends_the_run() {
    let mut h = Harness::with_budget(Duration::from_millis(50));
    let link = lab(&mut h);
    link.reject_ack.store(true, Ordering::Release);
    h.line("Who owns the fictional checklist?");
    h.request();
    until(&mut h, |e| !e.has_processing_permission());
    assert_eq!(*link.verdicts.lock().unwrap(), vec![Settlement::Expired]);
    assert_eq!(
        h.engine.evaluation_status(),
        Some(EvaluationStatus::Unavailable(
            EvaluationIssue::WorkerUnavailable
        ))
    );
    reply(&h, "quiet", None);
}
#[test]
fn failed_settlement_prevents_publication_and_idle_failure_revokes_permission() {
    let mut h = Harness::new();
    let link = lab(&mut h);
    link.reject_ack.store(true, Ordering::Release);
    h.line("Who owns the fictional checklist?");
    h.request();
    reply(&h, "show", Some("Who owns the checklist?"));
    until(&mut h, |e| !e.has_processing_permission());
    assert!(h.engine.state.cue.is_none());
    let mut h = Harness::new();
    let link = lab(&mut h);
    link.terminal.store(true, Ordering::Release);
    h.engine.advance(1);
    assert!(!h.engine.has_processing_permission());
    assert!(h.requests.try_recv().is_err());
}
#[test]
fn pause_cancels_immediately_and_resume_cannot_restart_strict_run() {
    let mut h = Harness::new();
    let link = lab(&mut h);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.engine.set_live_cues_paused(true).unwrap();
    assert_eq!(link.cancelled.load(Ordering::Acquire), 1);
    h.engine.set_live_cues_paused(false).unwrap();
    h.line("New speech after resume.");
    assert!(!h.engine.has_processing_permission());
    assert!(h.requests.try_recv().is_err());
    assert!(h
        .engine
        .review_processing(ConversationScope::RecentAndNewSpeech, &[])
        .is_err());
    reply(&h, "quiet", None);
}
#[test]
fn clock_expiry_does_not_resubmit_unchanged_or_expired_context() {
    let mut h = Harness::new();
    let link = lab(&mut h);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.engine.advance(20_000);
    reply(&h, "show", Some("Who owns the checklist?"));
    until(&mut h, |e| e.evaluation.as_ref().unwrap().pending.is_none());
    assert!(h.engine.state.cue.is_none());
    assert_eq!(link.cancelled.load(Ordering::Acquire), 0);
    assert!(h.requests.try_recv().is_err());
}

#[test]
fn coalesced_stale_success_still_consumes_secondary_cap_and_cannot_reapprove() {
    let mut h = Harness::new();
    lab(&mut h);
    h.engine.set_model_call_limit(1);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.line("Maya owns it now.");
    reply(&h, "quiet", None);
    until(&mut h, |e| !e.has_processing_permission());
    assert_eq!(
        h.engine.evaluation_status(),
        Some(EvaluationStatus::Unavailable(EvaluationIssue::CallLimit))
    );
    assert_eq!(h.engine.evaluation.as_ref().unwrap().requests_sent, 1);
    assert!(h.requests.try_recv().is_err());
    assert!(h
        .engine
        .review_processing(ConversationScope::RecentAndNewSpeech, &[])
        .is_err());
}
#[test]
fn stop_and_revoke_terminate_pending_lab_without_a_tick_or_restart() {
    for stop in [true, false] {
        let mut h = Harness::new();
        let link = lab(&mut h);
        h.line("Who owns the fictional checklist?");
        h.request();
        if stop {
            h.engine.begin_live_stop();
        } else {
            h.engine.revoke_processing();
        }
        assert!(!h.engine.has_processing_permission());
        assert!(link.cancelled.load(Ordering::Acquire) > 0);
        reply(&h, "show", Some("Who owns the checklist?"));
        h.engine.advance(5);
        assert!(h.engine.state.cue.is_none());
        assert!(h.requests.try_recv().is_err());
    }
}
#[test]
fn a_link_ended_by_a_deadline_shows_a_timed_out_stop() {
    // An unconfirmed expiry, a lost settlement, a broker terminal "deadline"
    // or an expiry during the handshake all end the link with Expired. That
    // is a stopped run with a reason, not one request's skipped timeout.
    for pending in [true, false] {
        let mut h = Harness::new();
        let link = lab(&mut h);
        h.line("Who owns the fictional checklist?");
        if pending {
            h.request();
        } else {
            reply(&h, "quiet", None);
            h.request();
            until(&mut h, |e| e.evaluation.as_ref().unwrap().pending.is_none());
        }
        link.expired.store(true, Ordering::Release);
        h.engine.advance(1);
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Unavailable(EvaluationIssue::TimedOut))
        );
        assert!(!h.engine.has_processing_permission());
        h.line("The meeting continues.");
        h.engine.advance(100);
        assert_eq!(
            h.engine.evaluation_status(),
            Some(EvaluationStatus::Unavailable(EvaluationIssue::TimedOut))
        );
        assert!(h.requests.try_recv().is_err());
        if pending {
            reply(&h, "quiet", None);
        }
    }
}
#[test]
fn a_prefix_reply_completed_in_time_but_read_after_the_deadline_is_not_applied() {
    let budget = Duration::from_millis(300);
    let mut h = Harness::with_budget(budget);
    let link = lab(&mut h);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.line("The meeting continues.");
    // A valid reply to a transcript that has only grown reaches the worker's
    // channel before the deadline, but the engine does not poll until after.
    let deadline = h
        .engine
        .evaluation
        .as_ref()
        .unwrap()
        .worker
        .pending_deadline()
        .unwrap();
    reply(&h, "show", Some("Who owns the checklist?"));
    while !h
        .engine
        .evaluation
        .as_ref()
        .unwrap()
        .worker
        .adapter_finished()
    {
        assert!(Instant::now() < deadline, "reply did not arrive in time");
        std::thread::yield_now();
    }
    assert!(
        Instant::now() < deadline,
        "reply arrived after the deadline"
    );
    std::thread::sleep(
        deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(50),
    );
    h.engine.advance(1);
    assert_eq!(*link.verdicts.lock().unwrap(), vec![Settlement::Expired]);
    assert!(h.engine.state.cue.is_none());
    assert!(h.engine.has_processing_permission());
}
#[test]
fn a_refusal_or_output_limit_is_a_non_decision_and_the_run_continues() {
    for sentinel in [REFUSED, OUTPUT_LIMIT] {
        refused_and_continued(sentinel);
    }
}
fn refused_and_continued(sentinel: &str) {
    let mut h = Harness::new();
    let link = lab(&mut h);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.line("Still discussing the checklist.");
    h.replies.send(sentinel.into()).unwrap();
    until(&mut h, |_| !link.verdicts.lock().unwrap().is_empty());
    assert_eq!(*link.verdicts.lock().unwrap(), vec![Settlement::Retired]);
    assert!(h.engine.has_processing_permission());
    assert!(h.engine.state.cue.is_none());
    assert!(!matches!(
        h.engine.evaluation_status(),
        Some(EvaluationStatus::Unavailable(_))
    ));
    assert_eq!(link.cancelled.load(Ordering::Acquire), 0);
    // The waiting speech is evaluated next and a reply in time is applied.
    until(&mut h, |e| {
        e.evaluation.as_ref().unwrap().requests_sent == 2
    });
    h.request();
    reply(&h, "quiet", None);
    until(&mut h, |_| link.verdicts.lock().unwrap().len() == 2);
    assert_eq!(link.verdicts.lock().unwrap()[1], Settlement::Current);
}
#[test]
fn a_refusal_the_link_cannot_retire_ends_the_run() {
    let mut h = Harness::new();
    let link = lab(&mut h);
    link.reject_ack.store(true, Ordering::Release);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.replies.send(REFUSED.into()).unwrap();
    until(&mut h, |e| !e.has_processing_permission());
    assert_eq!(*link.verdicts.lock().unwrap(), vec![Settlement::Retired]);
}
