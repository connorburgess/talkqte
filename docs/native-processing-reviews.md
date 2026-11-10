# Native processing review ownership

This Rust prerequisite supports reliable control of future evaluated cues. It does not enable a provider, mount the proposed controls, or establish useful participation in meetings. Normal app engines still use phrase rules and cannot prepare an evaluator review.

## Implemented authority

`processing_reviews::Reviews` holds at most one pending engine review in memory. Preparing a valid scope returns a random opaque ID and replaces the previous pending review. Approval consumes only that ID and the stored Rust token; a caller cannot attach a different destination or source list to approval. Unknown, cancelled, superseded and replayed IDs fail without clearing a newer valid review or revoking an unchanged active grant. Cancelling a review does not disable an existing grant.

The engine token binds the engine instance, session, permission generation, trusted processor configuration and exact selected sources. The native store additionally binds the complete available note set through a digest. Source addition, removal, metadata changes or changed content with a reused revision invalidate the pending review. Reordering the same notes and editing manual notebook text do not. The store retains fingerprints, not another copy of note excerpts. Runtime synchronization, control changes and source publication discard invalid reviews; approval rechecks before consuming a token.

Stop now marks the live engine as stopping before native capture cleanup and queued transcript drain. It clears pending reviews, revokes processing and blocks fresh review, approval, Resume and new evaluation work while ingestion finishes. Repeating Stop is idempotent. Disable cannot reopen a draining session. Only completion for the same stopped session ends it; a late completion cannot end a replacement session or clear that session's stopping state. A new explicitly started session requires fresh approval.

The stopping flag describes the processing gate, **not confirmation that the microphone has released**. Capture confirmation remains owned by the microphone adapter. If cleanup fails or stalls, the processing gate stays closed; this change adds no automatic restart or fallback.

## Headless acceptance

Ten fictional regression tests cover:

- Latest-review ownership, single use, provider-separated source IDs and exact approved scope.
- Cancelled, foreign, unknown and oversized IDs leaving a newer review intact.
- Invalid, duplicate, unknown, wrong-revision and oversized selections failing as a whole.
- Source content, title, date, revision, provider, removal and addition invalidating review, including unselected sources.
- Reordering and manual edits preserving review; remove/restore invalidating it without revoking an unchanged grant.
- Engine replacement, session replay, pause and revocation retiring pending reviews.
- Stop rejecting fresh approval and Resume while preserving transcript drain and explicit restart.
- Ordinary app engines returning unavailable rather than constructing an adapter.
- Late cleanup leaving a replacement session and its review untouched.
- A gated evaluator reply arriving after Stop failing to restore a cue or processing during drain.

Run `cargo test --manifest-path src-tauri/Cargo.toml --locked`. The tests use fictional workers and production Rust gates; they open no device, load no model and contact no account or service.

## Remaining release dependency

The review store is not an IPC endpoint or a complete permission dialog. Next, project trusted processor/source disclosures into bounded native snapshots, maintain event revisions across sessions, and bind deferred UI controls to their originating session and scope. Register narrow main-window commands only with that disclosure/event contract; do not mount controls or activate a provider before it passes fictional acceptance. The notebook still lacks Cancel during model loading.

Real-device Stop, native accessibility, Granola selected-note account acceptance, signed installation and the comparison against no assistance remain separate gates. These tests establish reproducible control behavior, not cue quality, listening comprehension or production readiness.
