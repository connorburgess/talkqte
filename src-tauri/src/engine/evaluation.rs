//! Source-aware lifecycle bridge. No app command constructs this engine;
//! the explicit Rust constructor is exercised with fictional adapters only.
use super::*;
use crate::cue_evaluator::{Action, Decision, Provenance, Request, Source, Worker};

const RECENT_LINES: usize = 6;

pub(super) struct State {
    worker: Worker,
    pending: Option<Request>,
    selected_notes: bool,
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
            selected_notes: false,
        });
        engine
    }

    /// Development-only opt-in to the selected context store as well as speech.
    /// This caller choice is not a substitute for app processing permission.
    pub fn live_with_selected_note_evaluator(worker: Worker) -> Self {
        let mut engine = Self::live_with_evaluator(worker);
        engine.evaluation.as_mut().unwrap().selected_notes = true;
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
    /// sources (at most four), optionally with the selected prior-note store.
    /// Never include manual notes, focus text, or identity settings. Fail closed
    /// on the worker's per-source and aggregate byte bounds without truncation.
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
            if !sources.iter().any(|source| matches_source(line, source)) {
                sources.push(transcript_source(line));
            }
        }
        if self.evaluation.as_ref()?.selected_notes {
            for note in &self.notes {
                if !sources
                    .iter()
                    .any(|source| matches_note(&note.item, source))
                {
                    sources.push(note_source(&note.item));
                }
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
            Action::Quiet => return,
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
            Self::make(false)
        }
        fn with_selected_notes() -> Self {
            Self::make(true)
        }
        fn make(selected_notes: bool) -> Self {
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
            let mut engine = if selected_notes {
                Engine::live_with_selected_note_evaluator(worker)
            } else {
                Engine::live_with_evaluator(worker)
            };
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
                &["transcript:line-1"],
                "not_observed",
            );
            self.engine.state.cue.as_ref().unwrap().id.clone()
        }
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
        let mut h = Harness::with_selected_notes();
        let file = selected(Provider::File, "line-1");
        let mut granola = selected(Provider::Granola, "line-1");
        granola.source_date = "2026-11-02".into();
        granola.excerpt = "Leave one day for printing.".into();
        let unreferenced = selected(Provider::File, "not-cited");
        h.engine.set_notes(vec![file, granola, unreferenced]);
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
        let mut h = Harness::with_selected_notes();
        h.engine.set_notes(vec![selected(Provider::File, "one")]);
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
        let mut h = Harness::with_selected_notes();
        h.engine.set_sensitivity(Sensitivity::Focused);
        h.engine.set_focus(vec!["Legal review".into()]).unwrap();
        h.engine.set_notes(vec![selected(Provider::File, "one")]);
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
            let mut h = Harness::with_selected_notes();
            let mut note = selected(Provider::Granola, "one");
            h.engine.set_notes(vec![note.clone()]);
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
                let mut h = Harness::with_selected_notes();
                let mut note = selected(Provider::Granola, "one");
                h.engine.set_notes(vec![note.clone()]);
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
            }
        }
    }

    #[test]
    fn oversized_selected_context_fails_closed_and_namespaced_maximum_ids_fit() {
        use crate::context::Provider;
        for multibyte in [false, true] {
            let mut h = Harness::with_selected_notes();
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
            h.line("The review schedule is unclear.");
            assert!(h.engine.evaluation.as_ref().unwrap().pending.is_none());
            assert!(h.requests.try_recv().is_err());
            assert!(h.engine.state.cue.is_none());
        }
        let mut h = Harness::with_selected_notes();
        let mut note = selected(Provider::Granola, &"n".repeat(128));
        note.title = "t".repeat(crate::context::MAX_TITLE_CHARS);
        h.engine.set_notes(vec![note]);
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
        h.line("Maya is responsible for that checklist.");
        h.request();
        h.reply(
            "resolved",
            None,
            &["transcript:line-2", "transcript:line-3"],
            "possible",
        );
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
        assert_ne!(old, h.request());
        h.reply("quiet", None, &["transcript:line-2"], "not_observed");
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
        h.reply("resolved", None, &["transcript:line-2"], "not_observed");
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
        h.reply("withdraw", None, &["transcript:line-2"], "unknown");
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
            h.engine.advance(1_000);
            assert!(h.requests.try_recv().is_err(), "no timer retry");
        }
    }
}
