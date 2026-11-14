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
The fixed duration is 102.48 seconds. Idempotent preparation accepts only the same
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

A single bounded probe brackets a native mach clock sample with JS
`performance.now()`. For host ticks H, sample position S, rate R and timebase
numerator N/denominator D, media zero in nanoseconds is
`H*N/D - S*1e9/R`. JS computes the difference from the probed host tick with checked
BigInt rational arithmetic before converting the small relative delta to a Number.
It adds that delta to the bracket midpoint; receipt time does not replace start.

The reported uncertainty includes half the measured bracket, observed anchor
spread and a one-millisecond numeric/monotonic-rate mapping allowance. The mapping
assumes the macOS host clock and Node monotonic clock have a stable rate over the
bounded operation; runtime verification of that assumption remains acceptance
work. Brackets above 100 ms, stale/future start or total uncertainty above the
allowed bound fail. The broker independently adds calibration uncertainty and
rejects combined uncertainty above 100 ms.

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
and requires observed engine nonrunning before reporting completion.

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
