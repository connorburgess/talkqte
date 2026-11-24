# Selected context and processing approval

The offline handoff uses the existing `File` and `Granola` source types. It adds
no Tactiq parser, account connection, live transcript source or provider
activation. A selected imported snapshot is prior context; importing it does
not grant permission to send it to a cue processor.

## Bounded runtime acceptance

`src-tauri/src/context_runtime/selected_snapshot_tests.rs` exercises the real
file parser, selected `ContextStore` merge, Runtime synchronization, native
processing review/approval methods, evaluator worker, and cue disclosure.
Its processor is a channel-controlled fictional evaluator, with no microphone,
account, model subprocess or network request.

The scenarios use two fictional notes: A describes a two-day review requirement
for a welcome pack, and B describes an unrelated orchard visit. Only A is
selected for import. A scripted current conversation asks about sending the
pack on Friday. The evaluator's authored response asks whether the draft can
be ready Wednesday; it is a test proposal, not evidence of reasoning quality.

The acceptance assertions are:

- An offered but unselected B is rejected by the store. Importing A, preparing
  a review, and accepting speech before approval produce no evaluator calls.
- Explicit approval of A with **new speech only** sends exactly A and the new
  conversation line; pre-approval speech stays out. A displayed proposal cites
  both sources, with A's provider, source date, title, revision and excerpt.
- Changing or removing A invalidates a pending native review. During a worker
  call it revokes the grant, signals cancellation and rejects the late reply,
  even when the scripted evaluator returns a proposal anyway. A fresh grant
  and new speech can subsequently produce a current proposal.
- Changing or removing A clears a displayed cue held open for reading. The
  single-note removal command uses `Runtime::remove_imported_note`, which
  removes the stored copy, retires refresh findings, synchronizes the engine
  and returns whether windows need the changed cue published.
- Native Stop and processing revocation reject a late proposal while leaving
  the imported copy intact. Stop still permits transcript drain. A new session
  requires fresh approval before processing can resume.
- An older imported revision cannot roll back a known newer A or cancel a
  still-current approved reply.

These tests establish a cross-boundary regression contract when they pass;
adding them does not establish native IPC, account behavior, semantic
relevance, timing under a real provider, or usefulness while listening.

## Kept meetings

Since 24 November 2026 a kept meeting can be imported as prior context with
provider `meeting` ([kept meetings](meeting-history.md#past-meetings-as-prior-context)).
It uses the same store, review and cancellation as a file note, and the
native serializer labels it `meeting`. The JS validator in
`scripts/cue-selected-snapshot.mjs` accepts only `file` and `granola`, so a
lab selected-context run would refuse it; lab runs never read kept meetings,
so none can reach it.

## Concrete next readiness blocker

The real CLI and lab processor configurations still use `without_notes()`.
They cannot approve or send prior context. Enabling notes for an actual
processor requires a separate change reviewing that processor's input contract,
source citation handling, data disclosure and exact session grant, followed by
an explicitly authorized fictional comparison with and without selected
context. That comparison must check useful additions, irrelevant or outdated
context, already-resolved constraints, latency and listening cost. This offline
change neither selects a production provider nor enables that comparison.

Granola workspace binding, selected-note refresh and real-account acceptance
remain unresolved. Tactiq authentication/plan access, identity/revision mapping
and selected import acceptance remain separate adapter gates. Reuse the
existing [permission boundary](cue-evaluator.md#session-processing-permission)
and [integration readiness](product-readiness.md#integration-readiness); a
successful import is not processing approval or a live stream.
