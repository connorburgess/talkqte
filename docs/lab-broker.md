# Development-only subscription broker

The local lab broker connects an explicitly enabled development evaluator to the
same [subscription provider](lab-providers.md) and attempted-dispatch budget as the
fictional meeting participants and judge. These JavaScript modules do not enable
a native backend, launch the app, grant processing permission, capture audio or
record a window. The corresponding Rust integration and a separately reviewed
run plan remain required before an actual-app experiment.

`openLabBroker({provider,maxCalls,signal})` accepts one already selected provider
session. It returns `descriptorPath`, a `ready` promise, `gate`, clock/playback
methods, in-memory observation access and `close()`. It starts no inference until
an admitted role requests it. Before the lazy native connection exists, the
orchestrator must independently abort/close this shared run on coordinated Stop;
it cannot rely on an unauthenticated native socket to notify it.
Every control, first failure or disconnect terminates that run, except a
[per-request evaluator deadline or late result](#request-outcomes-and-what-stays-terminal); reconnect, fallback and
budget reset are unavailable.

## Shared ownership

The operation gate provides:

- `run(task,{role,signal,deadlineMs})`: one lease covering provider work and role
  validation. Participant admission is nonqueueing. Exactly one evaluator may wait
  behind a participant, with its original deadline already running.
- `request({role,instructions,input,schema,signal})`: valid only inside that exact
  asynchronous lease, once per lease. Counts immediately before the shared
  provider dispatch. No nested gate or double-counting at lease acquisition.
- `waitIdle({signal})`: orchestrator waits here before its next participant turn;
  a waiting evaluator cannot be overtaken. Playing audio is not paused to force a
  cue to become current.
- `settle(task,{deadlineMs:1000})`: evaluator-only validation grace after an on-time
  provider operation has completed cleanup. It permits no additional provider
  request and never extends the model deadline.
- `close()`: terminal cancellation, provider settlement/cleanup, then release.

The streaming injection calls `gate.request({role,...request,signal})` inside the
stream's existing `gate.run`. Its task performs semantic validation before
returning. Broker evaluator tasks additionally await Rust's validation verdict.
An error cannot be swallowed to admit the next operation. Attempt caps do not
establish a hard count of underlying HTTP/model requests or revoke remote work.

## Local wire v1

One per-run directory outside the checkout (anchored to the module's checkout
root, not the caller's working directory) is mode `0700`; its Unix socket and
descriptor are `0600`. The descriptor schema is `talkqte.lab.descriptor.v1`, with
`runId`, absolute `socketPath` and a random 32-byte hexadecimal `nonce`. Pass only
the descriptor path to the development app, never the nonce in arguments or logs.
No provider credential passes through this protocol. No TCP listener exists.
The broker canonicalizes its new directory before deriving both paths. Native
requires the socket to be a lexical sibling of the canonical descriptor path the
launcher forwards, so a temporary-root alias such as macOS `/var` would otherwise
be refused before HELLO.

`startupDiagnostics` reports fixed booleans for connection, authenticated HELLO,
clock probe, clock sample and calibration, plus the first broker-observed
pre-calibration `cause` (for example `hello-rejected`, `closed-before-hello` or
`clock-deadline`) and the first gate `terminal` category. It never contains a
path, nonce, frame, provider output or raw error.

Frames are strict UTF-8 newline-delimited JSON, at most 64 KiB, with a bounded
16-frame processing queue and a one-second partial-frame deadline. Output is also
bounded. Unknown fields, invalid encoding, mismatched identity, overflow, duplicate
request or reconnect terminate the run. No raw frame/output logging is provided.

Every frame has `schema:"talkqte.lab.v1"`, `type`, `runId` and `sessionId`.
Session, request, context and snapshot revisions are canonical decimal strings
within `u64`, preserving exact values in JavaScript. Native elapsed milliseconds
are finite safe JSON numbers.

| Direction    | Type           | Additional fields                                                                                                                                                                                                                          |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App → broker | `hello`        | `nonce`, `expectedProvider`, `expectedModel`, `expectedEffort`                                                                                                                                                                             |
| Broker → app | `ready`        | exact `provider`, `model`, `effort`, `dispatchBudgetKind` (`apiRequests` for `anthropic-api`, else `cliDispatchAttempts`), `dispatchLimit`, `dispatchesUsed`; for `anthropic-api` only, integer `spendCapMicroUsd` and `spendUsedMicroUsd` |
| App → broker | `evaluate`     | `requestId`, `contextRevision`, `budgetMs` (1–10,000), `input` object                                                                                                                                                                      |
| Broker → app | `result`       | same request identity, validated `value`, `elapsedMs`, numeric `usage`                                                                                                                                                                     |
| App → broker | `settled`      | same request identity, `verdict` (`current`, `staleSuccess`, `expired`, `failed`), optional fixed `code` only on failure                                                                                                                   |
| App → broker | `cancel`       | fixed control `reason`, optional active request identity; `deadline` always carries it                                                                                                                                                     |
| Broker → app | `failed`       | request identity and fixed `code`                                                                                                                                                                                                          |
| Broker → app | `terminal`     | fixed `reason`, including while no evaluation is pending                                                                                                                                                                                   |
| Broker → app | `clock_probe`  | `probeId`                                                                                                                                                                                                                                  |
| App → broker | `clock_sample` | same `probeId`, `nativeSessionElapsedMs`                                                                                                                                                                                                   |
| App → broker | `cue_state`    | `observation` described below                                                                                                                                                                                                              |

The evaluator input is the JSON **object** parsed from Rust's
`Request::prompt_input()`: bounded transcript `events`, `existingCue`, optional
`userName` and `earlierCues`. It cannot contain generic instructions, schemas,
tools or executable names. The broker constructs the shared compact/glance prompt
and source-ID response schema. It validates action/cue/source membership and the
10-word cue bound. Rust independently validates its immutable request, source
references, processing permission, current session, cue identity and freshness
before applying a decision. In the lab arm, freshness is bounded: a reply in
time is still applied when the transcript it was evaluated on has only grown
since (same session and permission, the same existing cue, listener name and
earlier cues, and every submitted line still present with identical id, text and
time). Such a cue reflects speech up to the 8 s deadline before it appears and
can concern something newer speech already answered; the next request carries
it as the existing cue so the model can resolve or withdraw it. Any edited or
removed line, cue change or permission change makes the result stale: it is
discarded and acknowledged `staleSuccess`. Provider and schema errors remain
terminal, even when the original speech is stale.

`result` is sent only after provider cleanup. The evaluator lease stays held
until the request is settled or retired. `current` is a Rust validation verdict,
not proof that a cue was painted. Same-chunk settlement followed by the next
request preserves that ownership ordering.

### Request outcomes and what stays terminal

Each `evaluate` ends in exactly one of these ways. The first five retire only
that request; the run, provider and dispatch budget continue.

- **Settled `current` or `staleSuccess`:** native validated the result in time.
- **Settled `expired`:** the result reached native in time but was read after
  its deadline; it is never applied.
- **Broker deadline:** the request's `budgetMs` passed before a result. The
  broker aborts that provider call, waits for its process group to be confirmed
  gone and sends `failed` with code `deadline` for that request only.
- **Native deadline:** native sends `cancel` with reason `deadline` and the
  request identity, while the provider runs or while a sent result awaits
  settlement. The broker retires the request without a reply.
- **Provider refusal (direct API route only):** the model refused; the broker
  sends `failed` with code `refusal` for that request only. Native records a
  non-decision and sends nothing more for that request.

After a `result` is sent, native may settle or retire the request until one
second after the request's deadline (the broker allows a further 250 ms for
transit). Silence after that is terminal.

Before the first `evaluate`, there is no per-request retirement: a deadline that
expires during HELLO, `ready` or the clock probe ends the run. If native's engine
does not confirm an expiry within one second of a request's deadline, native ends
the run by closing the socket without a `cancel`; the broker treats that as a
disconnect.

Late frames are ignored for a request already retired by a deadline: a deadline
`cancel` that crosses the broker's own `failed`. A frame for any other unknown
request is a protocol failure. These stay terminal for the whole run: a
`settled` verdict of `failed`, a mismatched or duplicate settlement, every other
`cancel` reason (`stop`, `pause`, `revoke`, `replace`, `dismiss`, `exit`,
`eligibility_change`, `publication_failed`, `transport_failed`), every other
broker `failed` code, `terminal`, an unconfirmed provider process-group
retirement, a disconnect, and the dispatch cap.

The provider adapter's own deadline is terminal, so the broker refuses a
provider whose adapter deadline does not exceed the largest request budget plus
settlement (11,000 ms).

**Dispatch counting.** The broker counts a dispatch only when a provider call
actually starts (`cliDispatchAttempts`). A request retired while it was still
queued behind a settling one spends no dispatch, although native counted the
`evaluate`. Repeated timeouts after dispatch end the run at the dispatch cap;
native's own session call limit bounds the rest.

`evaluationSummary` reports content-free event counts, not a partition:
`requested` (evaluates seen), `dispatched` (provider calls started),
`retiredBeforeDispatch`, `resultsSent` with their fixed actions,
`deadlineByBroker`, `refusals`, `deadlineByNative` (a sent result can later be retired by
native) and settlement `verdicts`.

**Native timing fields.** In lab mode, native's `evaluation_result` log row
carries an optional `action` only on a `stale` result or a `failed` timeout whose
decision was not applied, and the trio `through_segment` (segment id),
`lag_lines` (lines that arrived after that line before the decision was applied)
and `lag_ms` (the newest of those lines' `at_ms` minus the through line's
`at_ms` on the session clock, 0 when `lag_lines` is 0) on every applied
decision. `lag_ms` measures how much speech the decision had not seen, not how
late the reply was. They never appear together. The
[evidence report](lab-evidence-report.md) shows them per evaluation and per cue.

## Observed cues and clocks

`observation` contains `snapshotRevision`, `nativeSessionElapsedMs`,
`publicationSucceeded:true`, `currentCue` and bounded `cleared` transitions.
A current model cue contains `cueId`, `text`, `kind`, `held`, `resolved`,
`decider:"model"`, `requestId`, `decisionAtNativeMs` and `publishedAtNativeMs`.
Clear transitions contain `cueId` and `clearedAtNativeMs`. These observations stay
in bounded memory; the broker writes no cue text or transcript log. They report
actual native publication, separately from visual paint acceptance.

After `ready`, the orchestrator explicitly invokes `calibrateClock()`; one probe
must receive a read-only current native clock sample within 100 ms round trip.
Busy, missing or late sampling is terminal, with no retry or cached-clock fallback.
The midpoint anchor retains half-round-trip uncertainty. Actual playback start is
supplied by `acknowledgePlaybackStart({monotonicMs,uncertaintyMs})` from the dedicated
player's acknowledgement; it may be saved before calibration. Never substitute
native session start or socket receipt for that sample. Combined uncertainty must
not exceed 100 ms. Evaluator dispatch requires both anchors.

`cuesAt(nowMs)` maps only the current observed cue into the meeting clock. Resolved
or cleared cards are omitted from actionable listener input; the raw resolved
flag remains in memory. A cue uncertain at the turn boundary is conservatively
omitted. Holding a card does not reset its publication time. No model proposal that
failed publication can appear here. Exact stream logs containing model-card text
must be disabled/redacted for this integration; redacted logs cannot claim strict
replay. Fictional spoken artifacts and authorized window recording are separate.

## Offline checks and remaining acceptance

```sh
node --test scripts/cue-lab-operation-gate.test.mjs scripts/cue-lab-broker.test.mjs
```

Stand-ins cover shared caps, lease/cancellation/cleanup ownership, admission
deadlines, settlement ordering/grace/failures, framing/authentication, idle-terminal
notification and observed cue clock mapping. No app, credentials, model service,
audio or capture is needed. They do not establish native integration or cue paint.

Next acceptance requires reviewed matching Rust wire/consent/coalescing hooks,
then a bounded fictional generated-speech → actual model decision → timely native
cue/silence run with supported player controls and window-only capture. Neither
this transport nor the provider smoke proves that chain. README remains unchanged
because this is internal development tooling.
