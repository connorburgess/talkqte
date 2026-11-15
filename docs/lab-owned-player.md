# Fixed fictional render-clock player

This development-only player consumes the existing approved fictional media.
It is a separate owned application named TalkQTE Lab Player, bundle identifier
`com.talkqte.lab-player`. It never impersonates QuickTime, uses no microphone or
network and exposes no playlist, seek, restart, adaptive append or synthesis.

## Build and approval

The sources are `scripts/lab-owned-player.swift`, `scripts/lab-player-state.c`
and its header. Compile with the macOS 14 deployment target, AppKit,
AVFoundation and CryptoKit, linking the C object and importing its header. The
application bundle executable must be `Contents/MacOS/lab-owned-player` and its
Info.plist must name TalkQTE Lab Player. Signing and runtime approval are separate.

`verifyLabPlayerBuild` requires an external private manifest and separate approved
manifest hash, executable hash and source commit. The exact receipt shape is
`{schema: 'talkqte.lab.player.build.v1', executable, bundlePath, sha256, commit,
signature: {identifier, authority, designatedRequirement}}`. Signature authority
is the sole approved TalkQTE Development identity, with a pinned leaf requirement.
The adapter checks canonical paths outside the checkout, exact bundle metadata,
strict/deep bundle seal, requirement and executable digest. It repeats these
checks immediately before spawn. Verification and execution are not atomic.
No approved signed player receipt is supplied by this change.

## API and first-take ordering

`createLabPlayer({runId, manifestFile, approved})` implements the prepared driver's
`prepare`, `play`, `stop` and `subscribe` methods, plus identity and separate final
`close`. Allocate one run identity before preparation; the native source launcher
must receive this same run identity and exact prepared player PID/start/bundle/
canonical executable. Native independently verifies that process at admission/use.
The integration wiring is a separate follow-up; this module does not expand the
native source allowlist itself.

Prepare validates the exact file hash, one audio/video track, duration, continuous
PCM timestamps/frame counts and bounded decoded memory (128 MiB, at most 105 s).
It decodes locally without persisting PCM. Video uses an audio-free composition,
so only the audio engine produces sound. Prepared means the engine is not playing,
the dedicated window exists and controls are installed, not observed window paint.
The fixed visual/container duration is 102.48 seconds. Audio is validated against
its own edited track time range (zero-origin required), not the longer asset.
The preserved MP4 has audio media duration about 101.0403 seconds and an edited
presentation duration about 101.019 seconds; its remaining visual tail is not
heard audio. The player neither pads audio nor mutates the file. Idempotent preparation accepts only the same
file; there is one playback generation and no restart after Stop or failure.

Prepare the player before native source selection. Then require the native
identity/session observation, expected broker session, exact recorder windows and
first accepted recording frame before Start. Actual speech triggers lazy native
hello/calibration; never wait for hello before playing. Native source identity,
recorder frame acceptance and measured audio start are distinct evidence.

## Render clock

Play scheduling is not a start acknowledgement. The Swift owner observes
`lastRenderTime` and `playerTime(forNodeTime:)` from the same node timestamp and
requires two positive advancing sample positions at the fixed 48 kHz rate. Both
samples must derive media-zero host anchors within five milliseconds. Invalid,
backward, inconsistent or stalled observations never establish start. Route,
output format or engine configuration changes terminate the operation.

A single bounded probe brackets a native `mach_continuous_time` sample with JS
`performance.now()` (Node/libuv uses continuous time). Audio node host ticks use
`mach_absolute_time`, which excludes sleep. Both the probe and start include a
coeval absolute-before/continuous/absolute-after clock bracket. Their offset
intervals must overlap; the Swift owner repeats this check throughout rendering.
A sleep/wake offset discontinuity fails terminally without rebasing or retry.

For absolute render ticks H, sample position S, rate R and timebase numerator
N/denominator D, media zero is `H*N/D - S*1e9/R`. Add the measured continuous-minus-
absolute offset, subtract the probed continuous tick, convert only that small
relative delta to milliseconds and add the JS bracket midpoint. Checked BigInt
rational arithmetic preserves large host tick precision; receipt time never
replaces the start anchor.

Uncertainty includes half the measured JS bracket, observed render-anchor spread,
the measured offset-bracket width and one microsecond for numeric quantization.
The JS monotonic reading is restricted to less than 2^32 milliseconds, bounding
its floating-point resolution within that allowance. Brackets above 100 ms,
stale/future start, offset discontinuity or total uncertainty above the allowed
bound fail. The broker independently adds calibration uncertainty and rejects
combined uncertainty above 100 ms. API rate/alignment behavior still needs device
acceptance; no stable-offset assumption across sleep is made.

API output latency and output device identity are reported separately. They are
estimates/route evidence, not a physical acoustic-arrival bound. No API event here
proves physical speaker audibility. Video is aligned to the observed audio host
timeline; actual visible alignment still needs recorded-frame inspection.

## Completion and cleanup

Natural completion requires `.dataPlayedBack`, the current observed frame count
reaching the entire decoded clip, a prior genuine start and no winning Stop/error.
The SDK also invokes completion on Stop; callback type alone is insufficient. A
C11 lock-free atomic store is the callback's only work. An atomic Stop/completion
claim resolves the race conservatively. Owner-queue code stops the node and engine
and requires observed engine nonrunning before reporting `audio_completed`.
Audio completion stops only the audio engine. The existing video keeps playing
through its tail. A separately registered end notification for that exact video
item, with its observed current time checked against the asset duration, reports
`video_completed`. The aggregate `completed` is admitted only after both signals;
Stop/error cannot synthesize either signal. The original 110-second watchdog
still bounds the full playback; no deadline is extended. Video completion and
received audio completion remain receipt evidence, not physical sound or paint.

`play()` returns separate frozen `audioCompletion`, `videoCompletion` and duration
metadata. Read-only `diagnostics` retains these even across later cleanup failure,
along with the first fixed failure category/stage, bounded decoded frame and
track/asset duration values, allowlisted exit signal/code and stderr byte count.
No stderr contents or arbitrary error description is retained. Preparation stages
are fixed (`media-identity`, `track-timeline`, `audio-decode`, `audio-duration`,
`pcm-buffer`, `video-composition`, `engine-prepare`, `window-prepare`); later
fixed phases describe start/render/tail. A missing exact failed stage remains
unknown for exits without a valid failure frame. The original failed take and
its generic diagnostics are not retroactively reclassified as a proven guard.

The first runtime attempt exposed the incompatible whole-asset audio duration
assumption. Offline regression uses the original numeric track/edit durations
and a harmless protocol child to test that audio completion cannot close the
video tail. Compile-only checks do not establish device playback or decode
success; the corrected signed binary requires separate reviewed approval.

`stop()` latches before queued Start, halts audio/video and reports engine state.
It deliberately retains the player process/window identity while native capture
is being released. After confirmed native release and recorder finalization,
`close({nativeReleased:true})` sends the one final retire command and requires
owned exit zero plus group absence. Missing release cannot authorize retirement.
Timeout, forced group termination, held pipes or surviving descendants remain
failed/unconfirmed cleanup. No process exit establishes native source release.
Callback storage and PCM remain alive until process exit; no formal hardware or
callback teardown fence is claimed beyond the observed/API states.

## Verification limits

Clock tests exercise checked host/sample arithmetic and failure cases. Harmless
Node protocol fixtures exercise exact identity, one start, malformed/oversized
output, absent start, premature completion, Stop and held-pipe cleanup. The
fixture produces no audio or video and cannot establish playback evidence.
Verifier tests mock OS signature checks. Compilation checks do not launch the
player, establish a signed bundle, verify a device route, prove visible video or
confirm live capture/transcription/model cues. Those remain separately coordinated
runtime acceptance using the saved media, with no regeneration or forced cue.


## Standard PCM and preparation progress

The engine connection uses standard noninterleaved native-endian Float32 at
48 kHz/stereo. The reader's interleaved output is copied as raw four-byte sample
words into separate left/right planes, preserving frame count, sample bits and
track durations. It does not resample, mix, pad or change media. Plane/channel
sizes and standard format are checked before connecting the engine. The prior
attempt's existing OS log identified a format-not-supported exception during
engine connection before window construction; this correction still needs
separate device acceptance.

Preparation emits at most twelve fixed progress records from launch through
media/track/decode/PCM/composition, engine connection/preparation, window/seek and
verified window visibility. Progress is ordered, bounded and retained separately
as `diagnostics.preparationProgress` with receipt timing; duplicate, unknown or
out-of-order stages fail. A progress record never establishes readiness, paint,
audio start or permission state. The terminal category (deadline, cancellation,
protocol or a fixed player failure) remains independent of the last reached stage.
A progress event before a framework call only identifies that boundary; it does
not prove the call completed. No raw error text or stderr is retained.

The native pure-memory channel/frame/bit-preservation regression is compiled via
`-D LAB_PLAYER_PCM_TESTS`; it bypasses the application entrypoint. During this
compile-only correction it was not executed. Node protocol regressions verify
progress/deadline/first-failure ownership and refuse interleaved prepared metadata.
None of these establishes live device playback. All existing timeouts are unchanged.


## Bounded stdin exchange

The control worker uses one `Darwin.read` into a fixed 4096-byte buffer and
processes every short read immediately. Only EINTR is retried; EOF, other read
errors, malformed/duplicate/wrong-identity JSON and unterminated/oversized frames
terminate input. Existing 16 KiB frame and 100 ms clock-probe limits remain.
At most four commands (probe, Start, Stop, retire) and 64 KiB total ingress are
accepted; no arbitrary command or retry channel is introduced. A validated Stop
latches the existing atomic flag before parsed diagnostics/owner-queue dispatch.
All state mutation/framework control remains on the owner queue.

At most ten fixed transport diagnostic records distinguish first read, parsed
command, owner application and EOF/error. Output JSON lines are serialized
between control/owner threads; no audio callback writes or locks. Snapshot
counters and clock-probe queued/parsed/applied/sample flags remain separate from
the first terminal failure. Queued means the JS writable accepted a write, not
peer receipt. Stop acknowledgements and bounded transport diagnostics remain
readable after failure; that never converts failed cleanup into successful run
acceptance or proves native source release.

The prior attempt reached `prepared` but did not complete the subsequent 100 ms
clock probe. Length-filling FileHandle stdin behavior is a source-supported
suspect, not an observed syscall-level cause on that macOS run. The new
compile-time `LAB_PLAYER_INPUT_TESTS` subprocess invokes only the same reader,
with no LabPlayer/NSApplication/engine creation. On macOS, deterministic tests
actually execute that non-audio fixture with open stdin, short/fragmented/
coalesced commands, EINTR, EOF/error and frame overflow. The actual application
and PCM-memory harness remain unexecuted by this transport change. Other
platforms explicitly skip this native fixture; protocol tests remain portable.
