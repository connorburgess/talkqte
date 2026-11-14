//! Controlled offline providers; no native activation or subscription process.
use super::tests::Harness;
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
    reject_ack: AtomicBool,
    verdicts: Mutex<Vec<Settlement>>,
}
impl EvaluationLifecycle for Lifecycle {
    fn terminal(&self) -> Option<Failure> {
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
fn continuous_speech_keeps_original_running_discards_stale_and_only_dispatches_latest() {
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
    reply(&h, "show", Some("Who owns the checklist?"));
    until(&mut h, |e| {
        e.evaluation.as_ref().unwrap().requests_sent == 2
    });
    let latest = h.request();
    assert_ne!(latest, original);
    assert!(latest
        .sources()
        .iter()
        .any(|s| s.id == "transcript:line-20"));
    assert!(!latest.sources().iter().any(|s| s.id == "transcript:line-1"));
    assert!(h.engine.state.cue.is_none());
    assert_eq!(
        *link.verdicts.lock().unwrap(),
        vec![Settlement::StaleSuccess]
    );
    h.replies.send(serde_json::json!({"action":"show","cue":"What is the agreed handoff?","sourceIds":["transcript:line-20"]}).to_string()).unwrap();
    until(&mut h, |e| e.state.cue.is_some());
    assert_eq!(link.cancelled.load(Ordering::Acquire), 0);
    assert_eq!(h.engine.evaluation.as_ref().unwrap().requests_sent, 2);
    assert_eq!(
        link.verdicts.lock().unwrap().last(),
        Some(&Settlement::Current)
    );
    h.engine.advance(100);
    assert!(h.requests.try_recv().is_err());
}
#[test]
fn newer_answer_cannot_be_overridden_by_stale_show_or_quiet() {
    for action in ["show", "quiet"] {
        let mut h = Harness::new();
        let link = lab(&mut h);
        h.line("Who owns the fictional checklist?");
        h.request();
        h.line("Maya owns the checklist; that question is answered.");
        reply(
            &h,
            action,
            (action == "show").then_some("Who owns the checklist?"),
        );
        until(&mut h, |e| {
            e.evaluation.as_ref().unwrap().requests_sent == 2
        });
        h.request();
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
#[test]
fn first_lab_timeout_stops_even_after_new_speech() {
    let mut h = Harness::with_budget(Duration::from_millis(5));
    lab(&mut h);
    h.line("Who owns the fictional checklist?");
    h.request();
    h.line("The meeting continues.");
    until(&mut h, |e| {
        matches!(
            e.evaluation_status(),
            Some(EvaluationStatus::Unavailable(_))
        )
    });
    assert_eq!(
        h.engine.evaluation_status(),
        Some(EvaluationStatus::Unavailable(EvaluationIssue::TimedOut))
    );
    assert!(h.requests.try_recv().is_err());
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
