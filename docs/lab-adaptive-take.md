# Injected adaptive speech scheduler

`createAdaptiveBody` in `scripts/cue-lab-adaptive-take.mjs` supplies the adaptive
body for `createLabPlaybackSession` from the [prepared driver](lab-prepared-take.md).
It has no CLI, default provider, voice synthesizer, player or recorder. Importing
it performs no work. Real runtime use remains unsupported until those adapters
are implemented, reviewed and verified with the native source.

## One owner and one stream

Construct the body before startup and supply it to the shared playback session.
That session owns actual Listening observation, recorder readiness, bootstrap
playback, authenticated clock calibration, Stop and all native/provider/player
cleanup. The body receives its authoritative lifecycle-generated `runId`, the
same `run` and the shared abort `signal`. Its idempotent `close` hook closes the
stream and local voice adapter; it never closes the provider or starts a second
lifecycle. Use the same player for bootstrap and incremental speech so the
driver's player Stop releases either operation.

The bootstrap must be separately preregistered, labelled neutral voiced
calibration media with `purpose:"neutral-calibration"` and a bounded
`displayLabel`. The shared driver requires the player's actual start observation
to confirm that exact displayed label; neutrality still depends on the reviewed
content/hash, not the metadata claim. It plays after actual Listening and recorder readiness but
before waiting for lazy native authentication. Body execution waits for both
bootstrap completion and calibrated readiness. A narrative prefix cannot silently
seed the stream: the existing stream requires an initially empty transcript.
Calibration speech is outside the scenario transcript and blind judge; native
evaluation still sees its actual heard audio and is not forced to stay quiet.

Inject `clock.now()` and `clock.playbackStart()`. The latter returns the exact
`{monotonicMs,uncertaintyMs}` observation the same player supplied to bootstrap
`onStarted`. `now` uses that monotonic domain and never goes backwards. Body entry,
request time, callback receipt and a scheduled start cannot replace this anchor.
Clock uncertainty must be at most 100 ms; the lifecycle independently enforces
combined native calibration uncertainty. Times sent to the stream are integer
milliseconds relative to the actual bootstrap start, not an assumed zero native
session origin.

## Generation and heard acknowledgements

The body calls `openStream` with the existing shared `run.gate` and a runner that
forwards directly to `run.request`. There is no outer or nested lease, separate
participant provider, budget reset or retry. `maxCalls` bounds participant attempts;
the authoritative shared gate additionally counts evaluator attempts. These are
CLI dispatch attempts, not a proven bound on internal provider requests. Configure
the body deadline no greater than the pinned run/provider deadline; the provider
retains its own bound. Each body operation also has a finite `operationMs`, and
the enclosing playback session owns the total take deadline.

For every operation, wait for shared gate idleness, including Rust validation
settlement. Read current time and current actual `run.cuesAt(nowMs)` immediately
before synchronous stream admission, with no asynchronous work between snapshot
and admission. The current gate does not queue participant operations. Branch B
never reads or supplies cues; judge input is cue-free. The broker already omits
resolved-visible cards and retains original publication age. No generated cue
proposal or cleared historical card is injected.

At most one returned line exists. Synthesize and play it outside the model gate,
allowing native evaluation during speech. Do not generate another line until an
exact matching actual start and complete playback have been acknowledged. Append
only that returned id/speaker/text with actual elapsed start/duration; queued or
partial speech never enters history. Respect `pauseBeforeMs`. Record resource
waits and stream-reported generation elapsed time honestly; there is no claim of
continuous speech during generation or synthesis pauses.

A silent listener reply advances state once to cast. The step ceiling bounds
transitions. Normal end still plays the final line before one blind judge receives
the completed scenario transcript and preregistered criteria. Failure or Stop
skips that judge. Full stream request logging is disabled because listener inputs
contain private runtime cue text; metadata observation cannot claim strict replay.
The body returns the completed fictional transcript/verdicts to its owner in
memory; callers must explicitly arrange any separately approved artifact export.

## Injected local voice and player contracts

`voice.synthesizeLine({runId,lineId,speaker,text,signal,deadlineAt})` returns
`{runId,lineId,speaker,textSha256,clipSha256,path,durationMs,sampleRate,channels}`.
The absolute external clip is immutable and belongs to those exact words and
speaker. SHA256 uses UTF-8 text. Duration is positive, no greater than the operation
bound; audio is mono with a declared sample rate. `voice.close()` is idempotent
and joins all owned synthesis/probe work. The scheduler verifies metadata and
identity, not file contents: a real adapter must hash/validate the actual PCM.

The intended local adapter pins an explicitly installed system voice and rate,
owns bounded subprocess/file work and terminates on failure. It is not included
here. Existing batch synthesis may retry to fit a slot and fall back to tones;
existing hosted TTS requires separate paid-service authorization. Neither behavior
is inherited by this body. No silent, tone, alternate-voice or hosted fallback is
permitted for an adaptive speech take.

`player.playLine({clip,notBeforeMonotonicMs,signal,deadlineAt,onStarted})` invokes
`onStarted({runId,lineId,clipSha256,monotonicMs,uncertaintyMs})` exactly once from
actual audio output start. It resolves only on full drain with
`{completed:true,runId,lineId,clipSha256,startedMonotonicMs,endedMonotonicMs,framesPlayed,sampleRate}`.
Played frames must match clip duration within one millisecond; elapsed playback
must span that duration with at most 100 ms completion uncertainty. Foreign,
duplicate, future, partial and mismatched evidence is terminal. Scheduled times,
successful enqueue, file duration or process exit alone are insufficient. The
adapter must have one active clip, no lookahead queue, and settle on abort after
owned work stops. The shared driver's player Stop owns its cleanup.

Abort/deadline rejects promptly and discards late replies. `body.close()` retains
underlying operation ownership until settlement and voice/stream cleanup; the
driver also retains player/native/provider ownership. Noncooperative injected
adapters can prevent cleanup settlement and are not supported runtime adapters.
No timeout result claims that an unconfirmed resource has stopped.

## Offline evidence and next acceptance

```sh
node --test scripts/cue-lab-adaptive-take.test.mjs
```

Stand-ins exercise the actual stream and shared gate, evaluator settlement and
fresh listener cues, silence, frame/identity/time rejection, partial/late playback,
deadline/cancellation, cap continuity and final-line judge ordering. Shared-driver
composition uses an in-memory child and local broker client to verify voiced
bootstrap before lazy authentication, prefix completion before generation and
zero generation on pre-auth Stop. No actual process, audio, player, app or model
is launched by these tests.

Next dependencies are an implemented local per-line voice adapter and a verified
capturable incremental player. Fixed QuickTime MP4 cannot append; the browser's
current append path can be silent and reports scheduled playback. A narrowly scoped
owned native window with local PCM output is a candidate, requiring explicit
source identity/launcher integration and real native audio-capture verification.
Actual Listening, output, transcription, evaluator cue/silence, companion paint
and release still need the separately reviewed bounded fictional take. This
internal scheduler changes no public app journey or release capability.

The current prepared fixed-source path refuses an adaptive body, and the direct
API adapter accepts cue-evaluator requests only, not cast/listener/judge work.
This injected scheduler does not create either integration. Its subscription
dispatch accounting, operation deadlines and cleanup ownership remain unchanged;
no API, source, player or artifact migration is selected by adding its module.
