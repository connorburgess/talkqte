# Bounded cue evaluator

`src-tauri/src/cue_evaluator.rs` provides a replaceable Rust worker and decision contract. It is not connected to app commands or the cue engine yet. No model, provider adapter, credentials, network request, or automatic reasoning is supplied. The app continues to use its existing phrase rules.

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

Next implementation: construct requests from the engine's authorized context and apply proposals through its existing lifecycle, testing pause, dismissal, held cues, source removal, and Stop with a fictional adapter first. Provider selection, explicit processing permission, model quality, actual latency/resource budgets, and comparison with no assistance remain separate gates. These offline tests establish neither semantic quality nor user outcomes.
