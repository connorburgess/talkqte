# Bounded cue evaluator

`src-tauri/src/cue_evaluator.rs` provides a replaceable Rust worker and decision contract. A development constructor now connects it to the Rust cue engine with transcript-only input; no app command enables that path. No model, provider adapter, credentials, network request, or automatic reasoning is supplied. The app continues to use its existing phrase rules.

This foundation supports timely context by rejecting late or obsolete proposals before they can reach the cue lifecycle. Structure and source-membership checks do not establish that a proposal is true, relevant, or useful to someone listening.

## Input and output

The caller constructs an immutable request with a session ID, eligibility revision, selected sources, and optional existing cue. Each source has a unique ID, revision, text, and provenance: transcript time/speaker or prior-note provider/date. Imported notes remain distinguishable from current speech. Source text is untrusted data, not instructions or permission to act.

Requests allow 1–32 sources, at most 4,096 bytes of text per source, and at most 32,768 bytes across source text, IDs, and metadata. IDs and provenance strings are limited to 128 characters. An existing cue has a bounded ID, at most 240 characters of text, and 1–4 distinct references to supplied sources. JSON encoding adds overhead; adapters must also bound their complete wire input and transport output.

A reply is at most 4,096 bytes of JSON with exactly five fields: `action`, `cue`, `sourceIds`, `reason`, and `observedUse`. Unknown fields, missing fields, invalid types, and duplicate object fields fail validation.

| Action | Requirements |
| --- | --- |
| `show` | No existing cue; nonempty cue text of at most 240 characters. |
| `quiet` | `cue: null`; a proposal to remain quiet, not an instruction to clear a visible cue. |
| `resolved` | An existing cue and `cue: null`; resolution remains distinct from observed use. |
| `withdraw` | An existing cue and `cue: null`; not an automatic failure label. |

Every decision cites 1–4 distinct supplied source IDs and has a nonempty reason of at most 300 characters. `observedUse` is `not_observed`, `possible`, or `unknown`; without an existing cue it must be `not_observed`. These are proposed observations, never usefulness or participation scores. A valid source ID proves membership, not that the cited words support the decision.

## Scheduling and lifecycle

One request may be outstanding. Submission and polling do not wait for inference; extra submissions return `Busy` and are not queued. There is no automatic retry, fallback, or replacement worker. The caller must specify a positive budget of at most ten seconds. That ceiling is not a latency target or a measured provider allowance: choose the remaining budget within the [end-to-end latency and freshness targets](budgets.md).

Polling compares the complete current request with the submitted request. A changed session, eligibility revision, source text/revision/provenance, or current cue rejects the result. Results that finish before the deadline but are not polled until after it are also rejected. The caller must poll and apply under the same lifecycle lock, update eligibility for topic/focus/control changes, and cancel on Stop, pause, or dismissal. Rust still owns hold, cooldown, expiry, cue selection, and permission decisions.

Cancellation or expiry returns promptly to the caller. An adapter that ignores cancellation still occupies its worker until it returns; no new evaluation overlaps it. Dropping the worker signals cancellation and does not wait. A worker that exits unexpectedly becomes unavailable instead of staying busy forever. Recovering it requires an explicit caller decision.

Adapters must check cancellation, cap transport buffers, terminate their own subprocess/request when appropriate, and avoid logging private content, including in panic messages. The Rust trait is not an OS sandbox and cannot forcibly stop an arbitrary implementation. Request and decision `Debug` output omit source text, IDs, speaker metadata, and cue/reason text; fixed failure codes contain no provider response.

## Acceptance and remaining work

Eight headless Rust tests use fictional evaluators and channels, without model calls. They exercise all four actions, input/output bounds, malformed and unsupported decisions, unknown or repeated references, changed context and cue identity, cancelled and expired results, an occupied worker, adapter failure, worker exit, and nonblocking teardown. The complete library suite passed 225 tests on 10 November 2026.

The transcript lifecycle bridge below is the next delivered slice. Imported-note reasoning and provider/app activation remain separate implementation work. Provider selection, explicit processing permission, model quality, actual latency/resource budgets, and comparison with no assistance remain separate gates. These offline tests establish neither semantic quality nor user outcomes.


## Transcript lifecycle bridge

`Engine::live_with_evaluator(worker)` constructs a development engine using one explicitly supplied worker instead of phrase rules. No native command uses this constructor. The app and its fictional browser preview retain their current behavior, with no provider selected or inference enabled.

For each newly accepted eligible transcript line, the engine attempts one evaluation with the last six complete, fresh lines and the visible cue's original references (at most four). The worker's byte bounds still apply; excessive input stays quiet rather than truncating speech or splitting work. Source IDs, times, speaker labels, and exact text come from the engine. Manual notes, imported excerpts, the session name, and focus text are excluded. Focused mode is enforced locally through the existing word-match policy.

New speech, pause/resume, dismissal, Stop/replay, focus, name, sensitivity, or imported-note changes cancel pending work. Clock ticks and appearance changes do not cancel a still-current request. Polling and application share the engine's lock with controls; results are checked against current session, eligibility, sources, cue identity, and freshness. New speech arriving while a cancelled adapter is still busy is skipped, with no backlog, timer retry, fallback, or replacement thread. This conservative policy may skip opportunities during continuous speech; provider latency and scheduling need measurement before activation.

A `show` proposal can use only the free cue slot. It respects cooldown, Focused mode, and a bounded two-minute exact-text repeat history. Each cited transcript excerpt is shown with its speaker and time. Its 18-second lifetime starts at the newest cited speech, not when the result arrives. This is structural grounding and lifecycle validation, not proof of source support or semantic deduplication.

`quiet` leaves the current cue alone, including when use is labelled possible. A sourced `resolved` result clears an unread cue; a held cue retains its words and shows the cited resolution. `withdraw` clears even a held cue whose premise is no longer valid, without calling that premise answered. Transcript eviction removes an affected cue and its copied evidence, including a held cue. Dismissal, cue pause, expiry, and Stop also release those copies. No evaluator reason, observed-use label, or unused suggestion becomes a note, export, or retained score.

Eight additional headless lifecycle tests use fictional delayed replies. They cover ordinary clock ticks, source disclosure and excluded inputs, quiet versus resolution while held, withdrawal, pause/resume without replay, dismissal/cooldown/repeats, Stop/new-session isolation, transcript eviction, stale sources, settings changes, malformed references, Focused filtering, and no rule fallback. No device, account, model, or network input is used.

Remaining implementation: selected prior-note requests and complete multi-source provenance in the cue presentation, revision/removal tests for those notes, and an explicitly scoped activation path after a processing/provider decision. Actual semantic quality, latency under ongoing speech, hardware operation, and useful participation while listening remain unvalidated.
