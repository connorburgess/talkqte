//! A narrow backstop for copied spoken questions, not semantic deduplication.
//! It uses only this request's approved transcript, never guessed speakers or
//! a new history lookup. Later cited speech can support revisiting an issue;
//! whether it actually does remains the evaluator's responsibility.
use super::{is_trivial_filler_line, source_time, Request, Source};

fn words(text: &str) -> Vec<String> {
    let text = text.replace(['’', '‘'], "'").to_lowercase();
    let mut words: Vec<_> = text
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect();
    // Only conversational lead-ins, never negation, pronouns, quantities or
    // dates. A changed constraint must not be mistaken for the same question.
    let start = words
        .iter()
        .take_while(|word| matches!(word.as_str(), "so" | "well" | "okay" | "ok" | "and"))
        .count();
    words.drain(..start);
    words
}

pub(super) fn without_new_evidence(request: &Request, cited: &[Source], cue: &str) -> bool {
    let question = words(cue);
    if question.len() < 2
        || !question.first().is_some_and(|word| {
            super::super::QUESTION_OPENERS.contains(&word.as_str())
                || super::super::WH_WORDS.contains(&word.as_str())
        })
    {
        return false;
    }
    let latest_question = request
        .sources()
        .iter()
        .filter_map(|source| {
            let at = source_time(source)?;
            source
                .text
                .split(['?', '.', '!', ';', '\n'])
                .any(|sentence| words(sentence) == question)
                .then_some(at)
        })
        .max();
    let Some(asked_at) = latest_question else {
        return false;
    };
    !cited.iter().any(|source| {
        source_time(source).is_some_and(|at| at > asked_at)
            && !is_trivial_filler_line(&source.text, request.user_name())
    })
}
