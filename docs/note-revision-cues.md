# Imported-note revisions and visible reminders

Implemented 10 November 2026. This is a source-lifecycle correction for the existing title-word reminder, not semantic note reasoning or evidence of useful participation.

Previously, a newer import could update the notebook's prior context while a held reminder continued quoting the previous excerpt. Native synchronization dropped the provider revision, and the engine checked only whether the note's key still existed.

The engine now receives the complete selected `ContextItem`, including its typed provider, source ID, revision, title, date, and excerpt. Copying notes into a replacement live engine preserves those fields. The context store still owns selection, validation, revision ordering, and the twenty-note bound; no provider call or additional import is introduced.

When the quoted item changes or is removed, the reminder clears in both snapshots, even if held or the fictional demo is paused. Its words are never silently replaced while someone is reading. A refreshed note remains marked as already shown for that session, so refreshing it does not generate a second interruption. A new session may show the refreshed item when the existing title-word rule matches new speech.

An unchanged or older import leaves the current reminder intact. A note from another provider with the same source ID is a different source. Unrelated transcript questions and manual notes remain unchanged. Imported text and unused cues remain excluded from Markdown export. Synchronizing an unchanged store also leaves a pending transcript evaluation intact; an actual context change still cancels it.

## Headless acceptance

All data is fictional. No account, model, microphone, or real meeting is used.

- A regression test first reproduced a held reminder retaining the old excerpt after refresh.
- Store-to-engine tests cover file and Granola sources, held and unread reminders, revision-only updates, changed excerpts, titles and dates, pause, both cue snapshots, stale disclosure commands, no automatic replacement or repeat, and the refreshed source in a later replacement engine.
- Duplicate/older imports and updates/removal of a different provider's equal ID preserve the held reminder. Imported-note updates leave an unrelated transcript question and manual notes alone.
- The delayed evaluator fixture verifies that unchanged context synchronization does not discard a valid transcript proposal. Changed selected context still rejects it.
- The complete Rust suite passes 238 library tests. This tests the native state boundary and serialized snapshots; it does not establish native window behavior or real-account import acceptance.

## Next readiness blocker

The next code slice is selected-note input to the development evaluator and complete disclosure of every cited source, with prior-note provider/date kept distinct from current conversation evidence. Require revision/removal rejection for delayed proposals and held cues, namespace source identities, and keep input and output bounded. No app command enables the evaluator, and no processing/provider permission is supplied by importing a note.

Real Granola selected-note import, native Stop/device/accessibility checks, signed clean installation and upgrades, actual evaluator latency during ongoing speech, and the comparison of useful participation and listening comprehension remain separate acceptance gates. This correction advances source reliability and deletion behavior; it does not close those release conditions.
