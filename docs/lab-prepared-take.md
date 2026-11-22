# Prepared fictional take driver

`scripts/cue-lab-prepared-take.mjs` composes the approved prepared launcher,
native owner and run lifecycle with injected player, source-readiness and recorder
adapters. It has no CLI entry point or production player/recorder implementation.
Importing it performs no work. Calling it is an active run operation; real use
still needs a reviewed bounded plan and separately approved signed build receipt.

The preserved 102.48-second meeting is a single-author prepared generated
conversation. Playing it to the real app can test live evaluator cue/silence
decisions. It cannot demonstrate adaptive generated speech responding to cues.
This driver never regenerates media, asks a participant model, forces a cue,
injects transcript text into the app or infers companion paint from publication.

## Fixed saved-meeting model recording

`createFixedModelTake(options)` selects the strict prepared path for approved
fictional media (the existing 102.48-second file, or a per-run scenario from a
reviewed manifest, at most 104 s) on one of two routes. The Codex subscription
route takes `gpt-6.1-sol` at low or medium effort, one shared 20-dispatch
budget and a 110-second native ordinary Stop guard. The
[direct Anthropic API route](lab-providers.md#direct-anthropic-api-route)
takes a listed Anthropic model at low effort and one shared 40-dispatch
budget; the owner approves in the app after Listening and before playback,
within 180 seconds, and native Stop moves out to 320 seconds so the media
window after approval is unchanged. Neither route counts underlying provider
requests or enables a fallback. Provider
deadlines/output bounds remain explicit settings; the native evaluator's
eight-second request deadline includes admission wait and may expire earlier.

Prepare the exact owned player before constructing the launcher and recorder.
The strict path requires the same frozen `player.identity` capability on all
three adapters, checks it again before native launch/after preparation, and
requires the fixed player application in the source-v1 Listening tuple. The
authenticated hello and clock calibration must join that exact source session.
Listening remains a historical native guard-time observation, not an atomic
current-state or physical audibility claim.

Recorder readiness is bounded to at most three seconds and startup ownership is
retained through abort settlement. Before Start, the driver reserves the full
media duration, a one-second Start budget and at least one second for completion
inside the native guard measured conservatively from before owned spawn. It
checks the real render anchor and its uncertainty against that budget again.
An exhausted budget stops before playback. `guard`/`onGuard` expose numeric
request and actual-anchor receipts for the private manifest.
The frozen `clockCalibration` receipt retains the authenticated source session,
native sample, Node midpoint and measured uncertainty; it is available after
cleanup alongside `dispatchesUsed`. It does not anchor the recording clock.

Optional `observe` receives existing evidence stage envelopes for run, source,
recorder and speech boundaries. Speech end is a receipt, not an exact heard-sample
or video time. These hooks do not manufacture model-stage timing or paint.
Cleanup retains the existing single provider/broker owner, independently stops
the player, requires native release and recorder finalization before final player
retirement, and preserves failed cleanup. No additional capture-only recording
is required by this API; any runtime plan and observer approval remain separate.

## Composition and startup order

`createPreparedTake({launcher,settings,stopAfterS,media,source,player,recorder,...})`
returns `{done,stop(),phase}`. `launcher` is the prepared approved-build object
from the [owned launcher](lab-owned-launcher.md); the driver creates its exact
native owner and one [run lifecycle](lab-run-lifecycle.md). Settings pin the
provider/model/effort/dispatch-attempt cap; the finite ordinary Stop guard remains
mandatory. `media` is an explicit frozen fictional identity with absolute `path`,
SHA256 and `durationMs` (at most 105 seconds).

1. Subscribe player/recorder failure notifications before starting the lifecycle.
2. Player preparation must verify the requested media identity. Native starts
   through the approved launcher; exact-run `armed` only establishes the Stop seam.
3. Wait for **actual native Listening**, independently supplied by the source
   adapter, bound to that run id. Arming, process existence and a scheduled delay
   cannot substitute for Listening.
4. Await the exact-window recorder's actual started acknowledgement.
5. Start the prepared voiced file. Its actual audio-clock start acknowledgement
   supplies the lifecycle playback anchor; the driver does not generate one from
   request or callback receipt time.
6. The first heard speech lets the native evaluator authenticate lazily. The
   lifecycle calibrates the native clock. Speech therefore starts **before**
   `run.ready`; awaiting ready before playback would deadlock that bootstrap.
7. Await both complete playback and calibrated lifecycle readiness. Stop the
   run and player, await actual native release/provider cleanup, then stop the
   recorder and close timing observation. A successful `done` reports completed
   media, released native capture and used CLI dispatch attempts, not cue quality
   or paint acceptance.

## Injected adapter contract

These are trusted observation/control adapters, not booleans a caller may invent
to bypass readiness. Every asynchronous method must settle on abort after its
owned work has settled; Stop must be idempotent and safe before/during startup.
The driver retains pending ownership rather than declaring cleanup while work
continues. A noncooperative injected adapter can prevent settlement; interface
tests cannot establish a real adapter's bounded cleanup.

- `source.waitListening({runId,signal})` resolves `{runId,listening:true}` only
  from the exact owned source's real Listening observation. No source-start control
  or permission bypass is provided here.
- `player.subscribe(handler)` and `recorder.subscribe(handler)` return
  unsubscribe functions. Any notification means unexpected failure/Stop and
  terminates the run. Ordinary stop/unsubscribe notifications during cleanup do
  not re-enter cleanup.
- `player.prepare({media,signal})` resolves the verified exact `path`, `sha256`
  and `durationMs`. A matching return must reflect real verification, not merely
  echo the input.
- `recorder.start({media,runId,signal})` resolves `{started:true}` after recording
  only the approved fictional meeting and actual companion windows. Window
  selection, permission/prompt observation and capture readiness belong to that
  adapter and the approved plan.
- `player.play({media,signal,onStarted})` calls `onStarted` exactly once with
  `{sha256,monotonicMs,uncertaintyMs}` from actual output start, then resolves
  `{completed:true,sha256}` only after the complete file drains. The lifecycle
  validates the anchor and combined calibration uncertainty. Stop/partial playback
  is not completion. Neither process exit nor a scheduled timer proves output.
- `player.stop()` and `recorder.stop()` resolve `{stopped:true}` only after their
  own work has stopped. Recorder Stop occurs after player/native/provider cleanup
  attempts, preserving cleanup footage. `launcher.close()` closes observation;
  it is not app retirement or capture release.

The take deadline defaults to 135 seconds and is configurable up to 180 seconds.
Expiry, caller abort, host/native Stop, process exit, broker/provider failure or
adapter failure aborts the shared root. Lifecycle `run.signal` exposes its
existing root abort for post-ready propagation; it grants no extra controls.
The cached close promise is reserved before callbacks. Native release and provider
cleanup must settle before completion; missing release remains failed cleanup.
No fallback, resumed failed session or new dispatch is admitted.

## Shared bootstrap for an adaptive follow-up

`createLabPlaybackSession({...options,body})` reuses this ownership path. `body`
is `async ({run,runId,signal}) => ...` with required idempotent `body.close()`.
`runId` is the lifecycle-generated identity supplied to the exact native launch,
Listening observer and recorder; the body binds voice/player identity to it at
invocation, never to a preconfigured or invented mapping. It starts
only after bootstrap playback completes **and** lifecycle readiness. Root Stop
closes the body concurrently with run/player cleanup, retaining ownership until
the body, provider and native settle. It must use the same player, provider and
gate; it does not own a second lifecycle. `createPreparedTake` refuses a body.

An adaptive session must supply separately preregistered, labelled neutral voiced
calibration media. When a body is supplied, media must declare
`purpose:"neutral-calibration"` and a nonempty `displayLabel` of at most 120
characters without control characters. Narrative/unlabelled bootstrap is refused
before constructing a run. At actual playback start, the player must have rendered
that label and report the exact `displayLabel` in its `onStarted` observation;
configured label text alone is not evidence that it was displayed. These checks
do not judge semantic neutrality: approved content and hash preregistration remain
required. The prepared path is unchanged. It cannot silently seed scenario narrative into an empty stream
transcript. Actual incremental voice/player clocks and stream scheduling belong
to that separate driver; this helper fabricates no clock or transcript history.

## Offline checks and remaining runtime gaps

```sh
node --test scripts/cue-lab-prepared-take.test.mjs
```

Tests use an in-memory child/control stand-in, local socket native client and
injected provider/player/recorder. They cover real ordering across the broker's
hello/clock handshake, not actual app/audio/video output. They exercise identity
mismatch, missing/duplicate/uncertain playback acknowledgement, recorder failure,
pre-auth and post-ready Stop, delayed release/provider cleanup, missing release,
body failure and exactly-once cleanup including synchronous callback re-entry.

No approved native build receipt is yet provided. The current exact-file QuickTime
control and audio-clock acknowledgement, real Listening observation bridge,
exact-window recorder readiness/prompt adapter and visible companion/model
readiness remain runtime gaps. Existing program interfaces and CLI tools are not
automatically adapters for this contract. No AppleScript UI fallback, desktop/VM
recording, model call, playback or actual take is authorized by these tests.
