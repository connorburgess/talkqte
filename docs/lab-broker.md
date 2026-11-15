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
Every control, first failure or disconnect terminates
that run; reconnect, fallback and budget reset are unavailable.

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

One per-run directory outside the checkout is mode `0700`; its Unix socket and
descriptor are `0600`. The descriptor schema is `talkqte.lab.descriptor.v1`, with
`runId`, absolute `socketPath` and a random 32-byte hexadecimal `nonce`. Pass only
the descriptor path to the development app, never the nonce in arguments or logs.
No provider credential passes through this protocol. No TCP listener exists.

Frames are strict UTF-8 newline-delimited JSON, at most 64 KiB, with a bounded
16-frame processing queue and a one-second partial-frame deadline. Output is also
bounded. Unknown fields, invalid encoding, mismatched identity, overflow, duplicate
request or reconnect terminate the run. No raw frame/output logging is provided.

Every frame has `schema:"talkqte.lab.v1"`, `type`, `runId` and `sessionId`.
Session, request, context and snapshot revisions are canonical decimal strings
within `u64`, preserving exact values in JavaScript. Native elapsed milliseconds
are finite safe JSON numbers.

| Direction    | Type           | Additional fields                                                                                                  |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| App → broker | `hello`        | `nonce`, `expectedProvider`, `expectedModel`, `expectedEffort`                                                     |
| Broker → app | `ready`        | exact `provider`, `model`, `effort`, `dispatchBudgetKind:"cliDispatchAttempts"`, `dispatchLimit`, `dispatchesUsed` |
| App → broker | `evaluate`     | `requestId`, `contextRevision`, `budgetMs` (1–10,000), `input` object                                              |
| Broker → app | `result`       | same request identity, validated `value`, `elapsedMs`, numeric `usage`                                             |
| App → broker | `settled`      | same request identity, `verdict` (`current`, `staleSuccess`, `failed`), optional fixed `code` only on failure      |
| App → broker | `cancel`       | fixed control `reason`, optional active request identity                                                           |
| Broker → app | `failed`       | request identity and fixed `code`                                                                                  |
| Broker → app | `terminal`     | fixed `reason`, including while no evaluation is pending                                                           |
| Broker → app | `clock_probe`  | `probeId`                                                                                                          |
| App → broker | `clock_sample` | same `probeId`, `nativeSessionElapsedMs`                                                                           |
| App → broker | `cue_state`    | `observation` described below                                                                                      |

The evaluator input is the JSON **object** parsed from Rust's
`Request::prompt_input()`: bounded transcript `events`, `existingCue`, optional
`userName` and `earlierCues`. It cannot contain generic instructions, schemas,
tools or executable names. The broker constructs the shared compact/glance prompt
and source-ID response schema. It validates action/cue/source membership and the
10-word cue bound. Rust independently validates its immutable request, source
references, processing permission, current session/revision, cue identity and
freshness before applying a decision. A valid stale result is discarded and
acknowledged `staleSuccess`; provider/schema errors remain terminal first.

`result` is sent only after provider cleanup. The global lease remains held until
the matching `settled` verdict arrives within one second. A failure, mismatch,
duplicate or lost acknowledgement stops every role. `current` is a Rust validation
verdict, not proof that a cue was painted. Same-chunk settlement followed by the
next request preserves that ownership ordering.

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
