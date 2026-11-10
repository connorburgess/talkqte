//! Transcript-only lifecycle bridge. No app command constructs this engine;
//! the explicit Rust constructor is exercised with fictional adapters only.
use super::*;
use crate::cue_evaluator::{Action, Decision, Provenance, Request, Source, Worker};

const RECENT_LINES: usize = 6;

pub(super) struct State {
    worker: Worker,
    pending: Option<Request>,
}

impl Engine {
    /// Development boundary for a caller-supplied evaluator. This is not a
    /// processing permission or a provider selection. Native commands continue
    /// to construct `live()` and run phrase rules. Never runs both cue paths.
    pub fn live_with_evaluator(worker: Worker) -> Self {
        let mut engine = Self::live();
        engine.evaluation = Some(State {
            worker,
            pending: None,
        });
        engine
    }

    pub(super) fn invalidate_evaluation(&mut self) {
        self.evaluation_revision = self.evaluation_revision.wrapping_add(1);
        if let Some(state) = &mut self.evaluation {
            state.worker.cancel_pending();
            if let Some(pending) = state.pending.take() {
                // Drain the cancelled ticket without waiting for the adapter.
                // Stop need not receive another clock tick to release the
                // caller's copies of the request and its source text.
                let _ = state.worker.poll(&pending);
            }
        }
    }

    /// The last six complete transcript lines plus the visible cue's original
    /// sources (at most four). Never include notes, focus text, identity settings,
    /// or arbitrary caller-supplied content. Fail closed on aggregate size.
    fn evaluation_request(&self) -> Option<Request> {
        if self.state.status != Status::Running || self.state.cues_paused {
            return None;
        }
        let recent: Vec<_> = self
            .state
            .transcript
            .iter()
            .rev()
            .take(RECENT_LINES)
            .filter(|line| {
                self.state.elapsed_ms.saturating_sub(line.at_ms) < CUE_MS
                    && self.cues_after_ms.is_none_or(|after| line.at_ms > after)
            })
            .collect();
        if recent.is_empty() {
            return None;
        }
        let mut sources = Vec::new();
        let existing = if let Some(cue) = &self.state.cue {
            let (id, cited) = self.evaluated_cue.as_ref()?;
            if *id != cue.id || cue.resolved_by.is_some() {
                return None;
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
            if !sources.iter().any(|source| source.id == line.id) {
                sources.push(transcript_source(line));
            }
        }
        Request::new(self.generation, self.evaluation_revision, sources, existing).ok()
    }

    /// Called only for newly accepted eligible speech. Busy work is skipped,
    /// never queued for replay, retried on a clock tick, or sent to a fallback.
    pub(super) fn submit_evaluation(&mut self) {
        self.poll_evaluation();
        let Some(request) = self.evaluation_request() else {
            return;
        };
        let Some(state) = &mut self.evaluation else {
            return;
        };
        if state.worker.submit(request.clone()).is_ok() {
            state.pending = Some(request);
        }
    }

    /// Runs under the same engine borrow/lock as controls and transcript input.
    /// A timer tick changes display time, not eligibility; passage past the
    /// source's freshness window still invalidates a result at application.
    pub(super) fn poll_evaluation(&mut self) {
        if self
            .evaluation
            .as_ref()
            .is_none_or(|state| state.pending.is_none())
        {
            return;
        }
        let current = self.evaluation_request();
        let Some(state) = &mut self.evaluation else {
            return;
        };
        let Some(pending) = &state.pending else {
            return;
        };
        if current.is_none() {
            state.worker.cancel_pending();
        }
        let Some(result) = state.worker.poll(current.as_ref().unwrap_or(pending)) else {
            return;
        };
        let submitted = state.pending.take().expect("pending checked");
        if let (Some(current), Ok(decision)) = (current, result) {
            if current == submitted {
                self.apply_evaluation(&current, decision);
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
        match decision.action {
            Action::Quiet => return,
            Action::Show => {
                let Some(question) = decision.cue else {
                    return;
                };
                let at_ms = cited.iter().filter_map(source_time).max().unwrap_or(0);
                let now = self.state.elapsed_ms;
                let about_focus = cited
                    .iter()
                    .any(|source| self.focus_match(&source.text).is_some());
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
        self.changed();
    }

    pub(super) fn reconcile_evaluated_sources(&mut self) {
        let Some((id, sources)) = &self.evaluated_cue else {
            return;
        };
        if self.state.cue.as_ref().is_none_or(|cue| cue.id != *id) {
            self.evaluated_cue = None;
            return;
        }
        if sources.iter().any(|source| {
            !self
                .state
                .transcript
                .iter()
                .any(|line| matches_source(line, source))
        }) {
            // Eviction/removal releases even a held excerpt. No hidden copy
            // continues to support a cue after its source leaves the session.
            self.state.cue = None;
            self.evaluated_cue = None;
            self.cooldown_until = self.state.elapsed_ms.saturating_add(self.cooldown());
        }
    }
}

fn transcript_source(line: &Segment) -> Source {
    Source {
        id: line.id.clone(),
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
    source.id == line.id
        && source.text == line.text
        && matches!(&source.provenance, Provenance::Transcript { at_ms, speaker }
            if *at_ms == line.at_ms && *speaker == line.speaker)
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
            // This bridge never supplies prior-note sources.
            Provenance::PriorNote { .. } => String::new(),
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
            let (requests_tx, requests) = mpsc::channel();
            let (replies, replies_rx) = mpsc::channel();
            let worker = Worker::start(
                Fictional {
                    requests: requests_tx,
                    replies: replies_rx,
                },
                Duration::from_secs(5),
            )
            .unwrap();
            let mut engine = Engine::live_with_evaluator(worker);
            engine.start().unwrap();
            Self {
                engine,
                requests,
                replies,
                next_line: 0,
            }
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
                &["line-1"],
                "not_observed",
            );
            self.engine.state.cue.as_ref().unwrap().id.clone()
        }
    }

    #[test]
    fn clock_ticks_do_not_cancel_a_valid_sourced_proposal_or_export_it() {
        let mut h = Harness::new();
        h.engine
            .update_notes("A private manual note".into())
            .unwrap();
        h.engine
            .set_focus(vec!["Review checklist ownership".into()])
            .unwrap();
        h.engine.set_user_name(Some("Robin".into())).unwrap();
        h.engine.set_notes(vec![(
            "file:one".into(),
            "Earlier launch review".into(),
            "2026-11-01".into(),
            "file".into(),
            "Selected prior excerpt".into(),
        )]);
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
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["line-1"],
            "not_observed",
        );
        let cue = h.engine.state.cue.as_ref().unwrap();
        assert!(cue.remaining_ms < CUE_MS - 1_999);
        assert!(cue.evidence.contains("Maya\nThe checklist handoff"));
        assert_eq!(cue.source_id, "line-1");
        assert!(cue.note.is_none());
        assert!(!h.engine.markdown().contains("Who owns"));
        assert!(!h.engine.markdown().contains("Fictional decision reason"));
        assert_eq!(h.engine.state.notes, "A private manual note");
    }

    #[test]
    fn quiet_and_possible_use_do_not_resolve_a_held_cue_but_sourced_resolution_does() {
        let mut h = Harness::new();
        let id = h.show();
        h.line("Robin asks about the checklist.");
        h.request();
        // Hold can be selected while the result is in flight; apply reads it now.
        h.engine.inspect_cue(&id, true).unwrap();
        h.reply("quiet", None, &["line-1", "line-2"], "possible");
        assert!(h.engine.state.cue.as_ref().unwrap().resolved_by.is_none());
        h.line("Maya is responsible for that checklist.");
        h.request();
        h.reply("resolved", None, &["line-2", "line-3"], "possible");
        let cue = h.engine.state.cue.as_ref().unwrap();
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
            &["line-1"],
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
        assert_eq!(request.sources()[0].id, "line-3");
        h.reply(
            "show",
            Some("Who owns the release?"),
            &["line-3"],
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
        h.reply("resolved", None, &["line-2"], "unknown");
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.evaluated_cue.is_none());
        h.line("A different handoff is unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the release?"),
            &["line-3"],
            "not_observed",
        );
        assert!(h.engine.state.cue.is_none(), "cooldown must win");
        h.engine.advance(10_000);
        h.line("The checklist handoff remains unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["line-4"],
            "not_observed",
        );
        assert!(h.engine.state.cue.is_none(), "repeat must stay quiet");
        h.line("The release handoff remains unclear.");
        h.request();
        h.reply(
            "show",
            Some("Who owns the release?"),
            &["line-5"],
            "not_observed",
        );
        assert!(h.engine.state.cue.is_some());
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
            &["line-1"],
            "not_observed",
        );
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.state.transcript.is_empty());
        h.line("A new meeting begins.");
        assert_ne!(old, h.request());
        h.reply("quiet", None, &["line-2"], "not_observed");
    }

    #[test]
    fn source_eviction_releases_even_a_held_cue_and_no_backlog_replays() {
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
        h.reply("resolved", None, &["line-2"], "not_observed");
        h.engine.advance(1_000);
        assert!(h.requests.try_recv().is_err());
        assert!(h.engine.state.cue.is_none());
    }

    #[test]
    fn withdraw_clears_an_invalid_held_premise_without_calling_it_answered() {
        let mut h = Harness::new();
        let id = h.show();
        h.engine.inspect_cue(&id, true).unwrap();
        h.line("That checklist is no longer part of this release.");
        h.request();
        h.reply("withdraw", None, &["line-2"], "unknown");
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
                "notes" => h.engine.set_notes(vec![]),
                _ => (),
            }
            let id = if change == "invalid" {
                "invented"
            } else {
                "line-1"
            };
            h.reply(
                "show",
                Some("Who owns the checklist?"),
                &[id],
                "not_observed",
            );
            assert!(h.engine.state.cue.is_none(), "{change}");
            h.engine.advance(1_000);
            assert!(h.requests.try_recv().is_err(), "no timer retry");
        }
    }
}
