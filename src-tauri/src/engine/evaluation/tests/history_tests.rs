//! Fictional source/lifecycle probes. Injected replies establish engine behavior,
//! never semantic conflict detection or usefulness.
use super::*;

fn history() -> Harness {
    let mut h = Harness::unapproved(
        fictional_processor()
            .with_bounded_transcript_history()
            .unwrap(),
        Duration::from_secs(5),
    );
    approve(&mut h, ConversationScope::NewSpeechOnly);
    h
}
fn approve(h: &mut Harness, scope: ConversationScope) {
    let review = h.engine.review_processing(scope, &[]).unwrap();
    h.engine.approve_processing(review).unwrap();
}
fn segment(i: usize, at_ms: u64, text: &str) -> Segment {
    Segment {
        id: format!("line-{i}"),
        at_ms,
        speaker: "Speaker".into(),
        speaker_id: None,
        text: text.into(),
    }
}
fn ids(r: &Request) -> Vec<&str> {
    r.sources().iter().map(|s| s.id.as_str()).collect()
}
fn seeded(history_mode: bool, lines: Vec<Segment>, now: u64) -> Harness {
    let mut h = if history_mode {
        history()
    } else {
        Harness::new()
    };
    h.engine.state.transcript = lines;
    h.engine.state.elapsed_ms = now;
    h
}
fn pair_lines() -> Vec<Segment> {
    (1..=29)
        .map(|i| match i {
            8 => segment(i, 34_137, "Build night is Thursday at six."),
            28 => segment(i, 102_047, "See everyone Thursday at seven."),
            29 => segment(i, 104_657, "In the workshop. See you then."),
            _ => segment(
                i,
                10_000 + i as u64 * 3_300,
                "An unrelated workshop update.",
            ),
        })
        .collect()
}

#[test]
fn distant_pair_has_both_original_sources_only_with_explicit_history() {
    for (through, now) in [(28, 106_295), (29, 108_427)] {
        for enabled in [false, true] {
            let h = seeded(enabled, pair_lines()[..through].to_vec(), now);
            let r = h.engine.evaluation_request().unwrap().unwrap();
            assert_eq!(ids(&r).contains(&"transcript:line-8"), enabled);
            assert!(ids(&r).contains(&"transcript:line-28"));
            if enabled {
                let source = r
                    .sources()
                    .iter()
                    .find(|s| s.id == "transcript:line-8")
                    .unwrap();
                assert_eq!(source.text, "Build night is Thursday at six.");
                assert_eq!(source_time(source), Some(34_137));
                assert!(r.sources().len() <= HISTORY_LINES);
            }
        }
    }
}

#[test]
fn correction_and_explicit_acceptance_are_retained_verbatim_without_judgment() {
    let lines = vec![
        segment(1, 1_000, "Workshop starts at noon."),
        segment(2, 61_000, "Correction: workshop starts at one."),
        segment(3, 62_000, "Agreed, one is the final time."),
    ];
    let h = seeded(true, lines.clone(), 63_000);
    let r = h.engine.evaluation_request().unwrap().unwrap();
    for (source, line) in r.sources().iter().zip(&lines) {
        assert_eq!(source.text, line.text);
        assert!(matches_source(line, source));
    }
    assert_eq!(r.sources().len(), 3);
    assert!(
        h.engine.state.cue.is_none(),
        "selection is not semantic detection"
    );
}

#[test]
fn history_has_strict_age_and_line_bounds_and_still_needs_fresh_speech() {
    let h = seeded(
        true,
        vec![
            segment(1, 10_000, "Old unrelated update."),
            segment(2, 10_001, "Inside history boundary."),
            segment(3, 99_000, "Fresh update."),
        ],
        100_000,
    );
    assert_eq!(
        ids(&h.engine.evaluation_request().unwrap().unwrap()),
        ["transcript:line-2", "transcript:line-3"]
    );
    let mut h = seeded(
        true,
        (1..=30)
            .map(|i| segment(i, i as u64 * 1000, "Unrelated update."))
            .collect(),
        31_000,
    );
    let r = h.engine.evaluation_request().unwrap().unwrap();
    assert_eq!(r.sources().len(), 24);
    assert_eq!(r.sources()[0].id, "transcript:line-7");
    assert!(r
        .sources()
        .windows(2)
        .all(|s| source_time(&s[0]) <= source_time(&s[1])));
    h.engine.state.elapsed_ms = 48_000;
    assert!(
        h.engine.evaluation_request().unwrap().is_none(),
        "old history cannot trigger work"
    );
}

#[test]
fn byte_pressure_preserves_all_mandatory_fresh_lines_without_truncating() {
    // Valid <=1000-char engine segments; Unicode/escaping affects serialized bytes.
    let text = "界\"\\".repeat(300);
    let lines: Vec<_> = (1..=24)
        .map(|i| segment(i, i as u64 * 1000, &text))
        .collect();
    let h = seeded(true, lines.clone(), 25_000);
    let r = h.engine.evaluation_request().unwrap().unwrap();
    assert!(r.prompt_input().unwrap().len() <= HISTORY_INPUT_BYTES);
    assert!(r.sources().len() < 24);
    for line in &lines[18..] {
        assert!(r.sources().iter().any(|s| matches_source(line, s)));
    }
    assert!(r.sources().iter().all(|s| s.text == text));
    let oldest = r.sources().iter().filter_map(source_time).min().unwrap();
    assert!(lines
        .iter()
        .filter(|l| l.at_ms >= oldest)
        .all(|l| r.sources().iter().any(|s| matches_source(l, s))));
}

#[test]
fn mandatory_wire_overflow_is_refused_instead_of_dropping_fresh_evidence() {
    let text = "界".repeat(1000);
    let h = seeded(
        true,
        (1..=6)
            .map(|i| segment(i, i as u64 * 1000, &text))
            .collect(),
        7_000,
    );
    assert!(matches!(
        h.engine.evaluation_request(),
        Err(Failure::InvalidInput)
    ));
    let h = seeded(
        false,
        (1..=6)
            .map(|i| segment(i, i as u64 * 1000, &text))
            .collect(),
        7_000,
    );
    assert_eq!(
        h.engine
            .evaluation_request()
            .unwrap()
            .unwrap()
            .sources()
            .len(),
        6,
        "default mode retains its existing content accounting, not the new wire cap"
    );
}

#[test]
fn existing_source_limits_and_listener_envelope_are_counted() {
    let h = seeded(true, vec![segment(1, 1000, &"a".repeat(4097))], 2000);
    assert!(matches!(
        h.engine.evaluation_request(),
        Err(Failure::InvalidInput)
    ));
    let text = "界".repeat(880); // six lines just under the wire cap before history
    let mut h = seeded(
        true,
        (1..=6)
            .map(|i| segment(i, i as u64 * 1000, &text))
            .collect(),
        7000,
    );
    h.engine.state.user_name = Some("界".repeat(128));
    h.engine.evaluation.as_mut().unwrap().earlier = (0..4)
        .map(|_| crate::cue_evaluator::EarlierCue {
            text: "界".repeat(240),
            state: crate::cue_evaluator::CueEnd::Expired,
        })
        .collect();
    assert!(
        matches!(h.engine.evaluation_request(), Err(Failure::InvalidInput)),
        "wire cap includes name and earlier-cue JSON, not only transcript"
    );
}

#[test]
fn history_configuration_is_disclosed_and_old_review_and_grant_do_not_cover_it() {
    let mut h = Harness::new();
    let review = h
        .engine
        .review_processing(ConversationScope::NewSpeechOnly, &[])
        .unwrap();
    let config = h
        .engine
        .evaluation
        .as_ref()
        .unwrap()
        .permission
        .processor
        .clone()
        .with_bounded_transcript_history()
        .unwrap();
    let summary = ProcessorSummary::from(&config);
    assert!(summary.data_policy.contains("24 segments"));
    assert!(summary.data_policy.contains("90 seconds"));
    assert!(summary.data_policy.contains("16384-byte"));
    assert!(!summary.accepts_notes);
    h.engine.evaluation.as_mut().unwrap().permission.processor = config;
    assert!(!h.engine.has_processing_permission());
    assert_eq!(
        h.engine.approve_processing(review),
        Err(ProcessingError::StaleReview)
    );
    approve(&mut h, ConversationScope::NewSpeechOnly);
    assert!(h.engine.has_processing_permission());
}

#[test]
fn history_cannot_select_prior_notes_or_exceed_disclosure_bounds() {
    let h = history();
    assert!(matches!(
        h.engine.review_processing(
            ConversationScope::NewSpeechOnly,
            &[(crate::context::Provider::Granola, "fictional".into(), 1)]
        ),
        Err(ProcessingError::InvalidScope)
    ));
    let mut config = fictional_processor();
    config.disclosure.data_policy = "p".repeat(2048);
    assert!(matches!(
        config.with_bounded_transcript_history(),
        Err(ProcessingError::InvalidScope)
    ));
}

#[test]
fn history_respects_new_speech_grant_and_pause_dismiss_cutoffs() {
    let mut h = history();
    h.engine.state.transcript = vec![
        segment(1, 1000, "Before approval."),
        segment(2, 2000, "At approval."),
        segment(3, 2001, "After approval."),
        segment(4, 3001, "After resume."),
    ];
    h.engine.state.elapsed_ms = 2000;
    approve(&mut h, ConversationScope::NewSpeechOnly);
    h.engine.state.elapsed_ms = 4000;
    assert_eq!(
        ids(&h.engine.evaluation_request().unwrap().unwrap()),
        ["transcript:line-3", "transcript:line-4"]
    );
    h.engine.cues_after_ms = Some(3000);
    assert_eq!(
        ids(&h.engine.evaluation_request().unwrap().unwrap()),
        ["transcript:line-4"]
    );
    h.engine.set_live_cues_paused(true).unwrap();
    assert!(h.engine.evaluation_request().unwrap().is_none());
}

#[test]
fn send_time_history_equality_and_apply_time_freshness_are_separate() {
    let mut h = history();
    h.said(1000, 2000, "The workshop starts at noon.");
    h.request();
    h.reply("quiet", None, &["transcript:line-1"]);
    h.said(90_000, 90_999, "See everyone at one.");
    let r = h.request();
    assert_eq!(r.sources().len(), 2);
    h.until(92_000);
    assert_eq!(
        h.engine.evaluation_request_as_of(90_999).unwrap().unwrap(),
        r
    );
    assert_eq!(
        h.engine
            .evaluation_request()
            .unwrap()
            .unwrap()
            .sources()
            .len(),
        1
    );
    h.reply(
        "show",
        Some("Which workshop start time?"),
        &["transcript:line-1", "transcript:line-2"],
    );
    assert!(
        h.engine.state.cue.is_some(),
        "history crossing90s during reply is not stale"
    );
    assert_eq!(h.engine.cue_deadline, 108_000);
}

#[test]
fn old_only_or_expired_cited_anchor_cannot_publish_even_with_fresh_input() {
    for expired in [false, true] {
        let mut h = history();
        h.said(1000, 2000, "The workshop starts at noon.");
        h.request();
        h.reply("quiet", None, &["transcript:line-1"]);
        h.said(60_000, 61_000, "See everyone at one.");
        h.request();
        if expired {
            h.until(78_000);
        }
        let ids = if expired {
            vec!["transcript:line-1", "transcript:line-2"]
        } else {
            vec!["transcript:line-1"]
        };
        h.reply("show", Some("Which start time?"), &ids);
        assert!(h.engine.state.cue.is_none());
        assert_eq!(h.engine.last_dropped, Some("stale"));
    }
}

#[test]
fn stop_reset_and_revocation_regrant_discard_an_inflight_history_reply() {
    for reset in [false, true] {
        let mut h = history();
        h.line("Who owns the checklist?");
        let old = h.request();
        if reset {
            h.engine.end();
            h.engine.start().unwrap();
        } else {
            h.engine.revoke_processing();
        }
        assert!(h.engine.evaluation_request().unwrap().is_none());
        approve(&mut h, ConversationScope::NewSpeechOnly);
        h.reply(
            "show",
            Some("Who owns the checklist?"),
            &["transcript:line-1"],
        );
        assert!(h.engine.state.cue.is_none());
        h.line("Who owns the release?");
        let next = h.request();
        assert_ne!(old, next);
        h.reply(
            "show",
            Some("Who owns the release?"),
            &["transcript:line-2"],
        );
        assert!(h.engine.state.cue.is_some());
        if reset {
            assert_eq!(h.engine.state.transcript.len(), 1);
        }
    }
}

#[test]
fn changed_or_removed_historical_source_makes_inflight_reply_stale() {
    for remove in [false, true] {
        let mut h = history();
        h.said(1000, 2000, "The workshop starts at noon.");
        h.request();
        h.reply("quiet", None, &["transcript:line-1"]);
        h.said(60_000, 61_000, "See everyone at one.");
        h.request();
        if remove {
            h.engine.state.transcript.remove(0);
        } else {
            h.engine.state.transcript[0].text = "Corrected transcript content.".into();
        }
        h.reply(
            "show",
            Some("Which start time?"),
            &["transcript:line-1", "transcript:line-2"],
        );
        assert!(h.engine.state.cue.is_none());
        assert!(h.engine.evaluated_cue.is_none());
    }
}

#[test]
fn new_speech_still_invalidates_ordinary_history_reply() {
    let mut h = history();
    h.line("Who owns the checklist?");
    h.request();
    h.line("The handoff is now settled.");
    h.reply(
        "show",
        Some("Who owns the checklist?"),
        &["transcript:line-1"],
    );
    assert!(h.engine.state.cue.is_none());
    assert!(h.engine.evaluated_cue.is_none());
}

#[test]
fn held_model_evidence_stays_mandatory_outside_history_without_displacing_asked_you() {
    let mut h = history();
    h.engine.set_user_name(Some("Maya".into())).unwrap();
    approve(&mut h, ConversationScope::NewSpeechOnly);
    h.said(1000, 2000, "The workshop location is unclear.");
    h.request();
    h.reply(
        "show",
        Some("Where is the workshop?"),
        &["transcript:line-1"],
    );
    let held = h.engine.state.cue.as_ref().unwrap().id.clone();
    h.engine.inspect_cue(&held).unwrap();
    h.said(100_000, 101_000, "Maya, can you check the workshop?");
    let r = h.request();
    assert!(
        ids(&r).contains(&"transcript:line-1"),
        "held evidence older than90s retained"
    );
    assert_eq!(r.existing_cue().unwrap().id, held);
    h.reply("quiet", None, &["transcript:line-2"]);
    assert_eq!(h.engine.state.cue.as_ref().unwrap().id, held);
    h.engine.respond(&held, Response::Dismiss).unwrap();
    h.said(102_000, 103_000, "Maya, will you bring the checklist?");
    let r = h.request();
    assert!(r.existing_cue().unwrap().asked);
    assert_eq!(
        h.engine.state.cue.as_ref().unwrap().kind,
        super::super::super::ASKED
    );
    let asked = h.engine.state.cue.as_ref().unwrap().id.clone();
    h.reply("quiet", None, &["transcript:line-3"]);
    assert_eq!(
        h.engine.state.cue.as_ref().unwrap().id,
        asked,
        "model cannot replace Asked you"
    );
}

#[derive(Default)]
struct OfflineLink(std::sync::Mutex<Vec<crate::cue_evaluator::Settlement>>);
impl crate::cue_evaluator::EvaluationLifecycle for OfflineLink {
    fn terminal(&self) -> Option<Failure> {
        None
    }
    fn cancel(&self) {}
    fn settle(
        &self,
        _: &Request,
        verdict: crate::cue_evaluator::Settlement,
    ) -> Result<(), Failure> {
        self.0.lock().unwrap().push(verdict);
        Ok(())
    }
}

#[test]
fn append_only_lab_history_accepts_new_speech_but_not_mutation_or_real_buffer_eviction() {
    use crate::cue_evaluator::Settlement;
    for change in [0, 1, 2] {
        let mut h = history();
        let link = std::sync::Arc::new(OfflineLink::default());
        h.engine.evaluation.as_mut().unwrap().lab = Some(link.clone());
        h.line("Who owns the checklist?");
        let original = h.request();
        match change {
            0 => h.line("The checklist is still being discussed."),
            1 => h.engine.state.transcript[0].text = "Corrected source content.".into(),
            2 => {
                for _ in 0..MAX_TRANSCRIPT_SEGMENTS {
                    h.line("An unrelated workshop update.");
                }
            }
            _ => unreachable!(),
        }
        if change == 2 {
            assert_eq!(h.engine.state.transcript.len(), MAX_TRANSCRIPT_SEGMENTS);
            assert!(!h
                .engine
                .state
                .transcript
                .iter()
                .any(|l| matches_source(l, &original.sources()[0])));
        }
        h.replies
            .send(
                serde_json::json!({"action":"show","cue":"Who owns the checklist?",
            "sourceIds":["transcript:line-1"]})
                .to_string(),
            )
            .unwrap();
        let limit = Instant::now() + Duration::from_secs(2);
        while link.0.lock().unwrap().is_empty() {
            assert!(Instant::now() < limit);
            h.engine.advance(1);
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(
            link.0.lock().unwrap()[0],
            if change == 0 {
                Settlement::Current
            } else {
                Settlement::StaleSuccess
            }
        );
        assert_eq!(h.engine.state.cue.is_some(), change == 0);
    }
}

#[test]
fn an_oversized_mandatory_request_never_reaches_the_worker_and_revokes_permission() {
    let text = "界".repeat(1000);
    let mut h = seeded(
        true,
        (1..=6)
            .map(|i| segment(i, i as u64 * 1000, &text))
            .collect(),
        7000,
    );
    h.engine.submit_evaluation();
    assert!(h.requests.try_recv().is_err());
    assert!(!h.engine.has_processing_permission());
    assert_eq!(
        h.engine.evaluation_status(),
        Some(EvaluationStatus::Unavailable(EvaluationIssue::InputLimit))
    );
}

#[test]
fn existing_launch_consent_cannot_authorize_expanded_history() {
    let mut h = Harness::unapproved(
        fictional_processor()
            .with_bounded_transcript_history()
            .unwrap(),
        Duration::from_secs(5),
    );
    let review = h
        .engine
        .review_processing(ConversationScope::NewSpeechOnly, &[])
        .unwrap();
    assert_eq!(
        h.engine.approve_processing_with_origin(review, true),
        Err(ProcessingError::InvalidScope)
    );
    assert!(!h.engine.has_processing_permission());
    approve(&mut h, ConversationScope::NewSpeechOnly);
    assert!(h.engine.has_processing_permission());
}

#[test]
fn default_projection_stays_last_six_then_fresh_filter() {
    let h = seeded(
        false,
        (1..=12)
            .map(|i| segment(i, i as u64 * 1000, "Ordinary update."))
            .collect(),
        13_000,
    );
    let r = h.engine.evaluation_request().unwrap().unwrap();
    assert_eq!(r.sources().len(), 6);
    assert_eq!(r.sources()[0].id, "transcript:line-7");
    let r = h.engine.evaluation_request_as_of(28_000).unwrap().unwrap();
    assert_eq!(ids(&r), ["transcript:line-11", "transcript:line-12"]);
}
