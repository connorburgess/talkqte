# Development lab run ownership

This follow-up wires the [broker](lab-broker.md) and selected subscription adapter
into one terminal run. It is internal orchestration, with no command that launches
an app, player or model automatically. A reviewed run must supply the native
owner's exact launcher and private per-process timing stream. Native signal
installation/activation and exact-file player control remain separate dependencies.

`createLabRun({settings,native,signal})` creates one provider and broker, pins the
provider/model/effort/cap/environment, and subscribes native and host Stop events
before startup. `settings` uses the explicit provider interface; offline stand-ins
remain explicit. There is no provider replacement, retry or run restart.

`ready` requires the authenticated native clock calibration and actual player-start
acknowledgement. Pass the latter through
`acknowledgePlaybackStart({monotonicMs,uncertaintyMs})`; it may arrive before native
calibration. Receipt time is not an actual playback acknowledgement. Calls before
readiness terminate the run without dispatch. The exposed `gate.run`, `request`
and `gate.waitIdle` wrap the same broker gate; use `request` inside the stream's
existing gate lease, not a second nested admission. Stream tasks retain semantic
validation ownership. `cuesAt` is available only during that ready run.

Stop aborts the root controller and shared gate immediately, independently of
native authentication. Native Stop/session/process failure, host INT/TERM,
startup failure and provider/broker terminal failure all take that path.
`stop()`/`close()` await both native release and provider cleanup. They are
idempotent. A missing release, failed cleanup or process exit without release is
`failed-cleanup`; signal delivery is never evidence of released capture. No new
operation can enter while cleanup remains outstanding.

## Native owner contract

The lifecycle requires `subscribe(handler)`, `start({descriptorPath,runId,metadata,signal})`
and `stop()`. Subscriptions return an unsubscribe function. Notifications are
content-free `stop-requested`, `session-ended`, `process-ended` or `failed`.
Start must settle on Stop/abort, including a failed startup. Stop must return
`{released:true}` only after true source release or a proven never-started source.
There is no default native implementation or UI fallback.

`createLabNativeOwner({executable,launch,stopAfterS})` supplies this contract around the
native owner's approved launcher. `launch({executable,environment,onTiming})`
must synchronously return the exact owned ChildProcess and bind `onTiming` to its
unique private timing stream before launch. It must not attach an existing PID or
substitute another executable. The owner retains that handle and immutable PID;
Stop uses only its `kill('SIGUSR2')` method after checking identity and live state.
The launcher remains responsible for its approved capture scope, timing-file
permissions and forwarding parse/read/overflow failures as failed timing evidence.
There is no generic process-control endpoint.

A positive integer `stopAfterS` is mandatory. The launcher must forward the
frozen `TALKQTE_DEV_STOP_AFTER_S` ordinary-Stop guard, independently of USR2. Its
exact finite duration belongs in the reviewed run plan; it starts after capture
is confirmed and neither its expiry nor request proves source release.

The wrapper also provides the frozen `TALKQTE_DEV_STOP_SIGNAL=usr2`,
`TALKQTE_DEV_LAB_RUN_ID`, explicit lab backend/provider/model/effort and descriptor
settings. Native must restrict the seam to the approved macOS debug features,
refuse an existing signal handler and install its one-way Stop latch before source
auto-start. A matching `dev_stop` event has `run_id` and one of these steps:

- `armed`: native handler and worker are installed; only now may JS signal.
- `latched` or `stopping`: Stop was received/requested; release remains unproven.
- `released`: ordinary source cleanup or canceled never-started startup actually
  settled with source admission permanently closed.
- `failed`: setup/cleanup failed; no clean release is inferred.

Before `armed`, JS retains Stop intent and sends no signal. Arming has a five-second
owned-spawn deadline; missing/foreign/duplicate arming fails closed without a kill
fallback. After the single signal, release has a separate six-second bound, covering native's five-second cleanup observation.
The lifecycle's twelve-second default release wait covers both bounds. Timing
loss, process error or process exit before release fails cleanup. Transcript and
cue text are not forwarded into lifecycle events or logs.

The existing timing stream is lossy and unacknowledged. Missing `armed` permits
no signal; missing `released` remains unconfirmed cleanup even if ordinary Stop,
source-end or process-exit events were observed. Never infer native release or
log delivery from signal success or elapsed time. Stand-ins cover both lost
frames; they do not establish that a real release event will be delivered.

The first native frame still cannot prove companion paint. Timed native model
observations and window-recorded frame acceptance remain separate checks.

## Offline evidence and remaining blocker

```sh
node --test scripts/cue-lab-run.test.mjs scripts/cue-lab-native-owner.test.mjs
```

Deterministic stand-ins cover pre-auth Stop, delayed provider creation/cleanup,
native/session/process/host cancellation, clock-plus-playback admission, the
armed-before-signal race, exact-run identity, missing release and cleanup failure.
They launch no app, player or model.

The next acceptance check requires the tested native Stop/activation dependency,
a reviewed exact executable/private timing-stream launcher and actual player
controls. Then run one separately reviewed fictional speech → real cue/silence →
visible companion take. No authenticated execution or real-app readiness is
established by these interface tests.
