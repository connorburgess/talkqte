//! Scripted offline replies test display/permission boundaries, not a model's
//! ability to recognize brainstorming, answers, risk or useful context.
use super::*;

#[test]
fn copied_questions_are_suppressed_without_disabling_processing_or_creating_history() {
    for (speech, proposal) in [
        (
            "Who owns the garden delivery?",
            "Who owns the garden delivery?",
        ),
        (
            "So, WHO owns the garden delivery?",
            "Who owns the garden delivery?",
        ),
        (
            "Who owns the garden delivery",
            "Who owns the garden delivery?",
        ),
        (
            "A short update. When's the gate opening?",
            "When’s the gate opening?",
        ),
    ] {
        let mut h = Harness::new();
        h.line(speech);
        let input = h.request().prompt_input().unwrap();
        let input: serde_json::Value = serde_json::from_str(&input).unwrap();
        assert_eq!(input["events"][0]["speaker"], "Speaker");
        assert!(input.get("priorNotes").is_none());
        h.reply("show", Some(proposal), &["transcript:line-1"]);
        assert!(h.engine.state.cue.is_none());
        assert_eq!(h.engine.last_dropped, Some("spoken_question"));
        assert!(h.engine.has_processing_permission());
        assert!(h.engine.shown_cues.is_empty());
        // Rejecting a redundant proposal neither disables the provider nor
        // prevents a later, different useful clarification.
        h.line("The truck must leave now, but no driver is assigned.");
        h.request();
        h.reply(
            "show",
            Some("Who can drive the truck now?"),
            &["transcript:line-2"],
        );
        assert_eq!(
            h.engine.state.cue.as_ref().unwrap().question,
            "Who can drive the truck now?"
        );
    }
}

#[test]
fn a_later_cited_consequence_can_revisit_an_older_unresolved_question() {
    let mut h = Harness::new();
    h.line("Who owns the garden delivery?");
    h.request();
    h.reply("quiet", None, &["transcript:line-1"]);
    h.line("Before we close, the seedlings cannot ship without a named recipient.");
    h.request();
    h.reply(
        "show",
        Some("Who owns the garden delivery?"),
        &["transcript:line-1", "transcript:line-2"],
    );
    let cue = h.engine.state.cue.as_ref().unwrap();
    assert_eq!(cue.question, "Who owns the garden delivery?");
    assert_eq!(cue.sources.len(), 2);
    assert!(cue
        .sources
        .iter()
        .any(|source| source.text.contains("cannot ship")));
}

#[test]
fn new_uncited_speech_cannot_make_a_copied_question_new_evidence() {
    let mut h = Harness::new();
    h.line("Who owns the garden delivery?");
    h.request();
    h.reply("quiet", None, &["transcript:line-1"]);
    h.line("Before we close, the seedlings cannot ship without a named recipient.");
    h.request();
    h.reply(
        "show",
        Some("Who owns the garden delivery?"),
        &["transcript:line-1"],
    );
    assert!(h.engine.state.cue.is_none());
    assert_eq!(h.engine.last_dropped, Some("spoken_question"));
}

#[test]
fn lexical_similarity_does_not_remove_a_different_constraint_or_a_reminder() {
    for (speech, proposal) in [
        ("Can we ship Friday?", "Can we ship Thursday?"),
        ("Can we ship Friday?", "Can we not ship Friday?"),
        ("Do we need two drivers?", "Do we need three drivers?"),
        (
            "Who owns the garden delivery?",
            "Delivery still needs a recipient before dispatch.",
        ),
    ] {
        let mut h = Harness::new();
        h.line(speech);
        h.request();
        h.reply("show", Some(proposal), &["transcript:line-1"]);
        assert_eq!(h.engine.state.cue.as_ref().unwrap().question, proposal);
    }
}

#[test]
fn useful_reminder_uses_only_explicitly_approved_note_and_current_speech() {
    use crate::context::Provider;
    let mut h = Harness::new();
    h.engine.set_notes(vec![selected(Provider::File, "review")]);
    h.approve_notes();
    h.line("The garden leaflet draft arrives Thursday; we plan to print Friday.");
    let request = h.request();
    assert!(
        request.prompt_input().is_err(),
        "default path must not send prior notes"
    );
    h.reply(
        "show",
        Some("Prior review required two days before printing."),
        &["transcript:line-1", "prior:file:review"],
    );
    let cue = h.engine.state.cue.as_ref().unwrap();
    assert_eq!(cue.sources.len(), 2);
    assert_eq!(cue.sources[1].text, "Legal review takes two days.");
    assert!(matches!(
        cue.sources[1].provenance,
        Provenance::PriorNote { .. }
    ));
    // Removal still retires the cue and its copied source; quality policy
    // cannot keep a useful-looking reminder after permission/source changes.
    h.engine.set_notes(vec![]);
    assert!(h.engine.state.cue.is_none());
}

#[test]
fn authored_quality_cases_flow_through_the_current_request_and_lifecycle() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../scripts/fixtures/cue-usefulness.json"
    ))
    .unwrap();
    for case in cases["cases"].as_array().unwrap() {
        let mut h = Harness::new();
        let speech = case["speech"].as_array().unwrap();
        for (index, line) in speech.iter().enumerate() {
            h.line(line.as_str().unwrap());
            h.request();
            if index + 1 < speech.len() {
                h.reply("quiet", None, &[&format!("transcript:line-{}", index + 1)]);
            }
        }
        let decision = &case["decision"];
        let ids: Vec<&str> = decision["sourceIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect();
        h.reply(
            decision["action"].as_str().unwrap(),
            decision["cue"].as_str(),
            &ids,
        );
        assert_eq!(
            h.engine.state.cue.is_some(),
            decision["action"] == "show",
            "{}",
            case["id"]
        );
    }
}

#[test]
fn asked_you_is_not_suppressed_as_a_copied_question() {
    let mut h = Harness::named("Mira");
    h.line("Mira, can you open the garden gate?");
    h.request();
    let cue = h.engine.state.cue.as_ref().unwrap();
    assert_eq!(cue.kind, ASKED);
    h.reply("quiet", None, &["transcript:line-1"]);
    assert_eq!(h.engine.state.cue.as_ref().unwrap().kind, ASKED);
    h.line("Yes, I can open it at noon.");
    h.request();
    h.reply("resolved", None, &["transcript:line-2"]);
    assert!(h.engine.state.cue.is_none());
}
