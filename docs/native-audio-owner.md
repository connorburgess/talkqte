# Development-only native audio ownership

12 November 2026. The `native-audio-spike` Cargo feature adds a macOS
ScreenCaptureKit owner in `application_audio::native`. It is off by default and
has no Tauri command, selection UI, enumeration or transcription
connection. A bounded sample handler is connected only inside this experiment. No native capture was run for this change. The app still provides
only its existing microphone paths.

This advances the [source-only experiment](system-audio-plan.md): dependable
Stop and exact-source ownership must precede listening to another application.
It does not establish source isolation, release latency or useful meeting cues.

## Ownership and cleanup

`Selection` retains one native application object and display on the constructing
thread. Its opaque identity differs for every selection, including another
selection of the same application. Its native name and application-wide scope
are available to the existing review gate. The eventual host must disclose scope
and obtain permission before enumeration; this module does not enumerate.

After exact review approval, `NativeOwner::begin` compares the approved identity
to that retained selection before constructing a filter. It uses positive
one-application inclusion with no window exceptions, never an all-app exclusion
filter. It registers only audio output, requests 16 kHz mono and excludes this
process's audio. This configuration is not proof that delivered buffers have the
requested format or that native filtering meets the intended scope.

The constructor installs its own source-bound audio output on a dedicated serial
queue. It accepts an explicit `ClockBinding` and returns a session-bound reader
alongside the owner. The host must establish the correspondence between native
source time and session time; neither callback arrival nor the first sample is
used to guess it. The constructor remains unsafe because native buffer validity
and CoreMedia copying behavior require live-context validation. No caller exists
in the app. Native objects stay on their constructing worker thread; no
`unsafe Send` or `Sync` implementation is added.

The owner polls bounded completion slots outside audio callbacks and UI work:

- Cancel before startup sends no native start request.
- Cancel during startup closes delivery through the existing control immediately,
  but retains the operation until start completes. Late success triggers Stop;
  it never becomes accepted capture. A failed start is conservatively stopped
  too; failure is not taken as proof that all native resources are released.
- Stop completion must succeed before removing the exact audio output. A fence
  on its dedicated serial queue must then execute before resources and the
  operation reservation are released, in that order.
- Failed Stop or output removal retains the reservation. Cleanup retry is explicit;
  an unresolved request cannot be retried. Each Stop retry has its own completion
  slot, so a delayed old completion cannot satisfy a new request.
- Cancellation while start is pending has its own `CancellingStart` stage; it
  cannot be confused with an ordinary, uncancelled startup.
- A missing completion stays pending. There is no deadline that reports Off,
  broadens the source or starts another operation. The eventual host needs a
  visible stalled-cleanup state and an exit/recovery policy.

**Abandonment is not recovery.** Dropping an unreleased owner cancels delivery but
quarantines its native resources and grant until process exit. It deliberately
cannot report release or allow overlap. Native capture may remain active because
Drop is not an asynchronous Stop implementation. The eventual host must retain
and poll the owner through cleanup, including app shutdown; an owner task panic
and process-exit policy remain release blockers. This fallback is why this code
must remain disconnected from normal app controls.

The retained `SCStreamDelegate` closes delivery immediately when macOS reports
`stream:didStopWithError:`. Its callback only sets operation-scoped atomics; it
does not inspect or retain the stream/error, allocate, lock, log or call cleanup.
The owner observes `StreamFailed` on its next poll and follows the same cleanup
sequence. A failure during pending start still waits for that completion; a
failure during Stop cannot replace its completion or create another Stop.
Cleanup failures take precedence in the reported problem so explicit recovery
remains actionable. Late signals cannot cancel a later operation. The delegate
is retained alongside the stream through cleanup; the queue fence covers the
audio output queue, not a claim about macOS delegate dispatch ordering.

A successful start result alone does not prove continuing source health. Native
error delivery and permission revocation still need device evidence. Sample
validation, unexpected output type, unavailable callback state and a closed
consumer share the same operation-scoped fault signal and cleanup path.
No silent restart, alternate source, resampling, microphone mixing, retention,
provider access or inference is introduced.

## Bounded native PCM reading

The same disabled development feature now includes `native::pcm::PcmReader`.
It reads actual CoreMedia metadata and uses
[`CMSampleBufferCopyPCMDataIntoAudioBufferList`](https://developer.apple.com/documentation/coremedia/cmsamplebuffercopypcmdataintoaudiobufferlist%28_%3Aat%3Aframecount%3Ainto%3A%29?language=objc)
to copy into fixed scratch space owned by the development audio output. The
reader itself carries no source/session authority. The output checks cancellation
before touching native data and passes only validated samples through the
existing handoff using the control bound to its approved Start.

The accepted format is deliberately narrow: ready, valid linear PCM, little-endian
packed float32, 16 kHz, one channel, four bytes per frame/packet and one frame per
packet. Mono planar is accepted only with the same contiguous size metadata.
Unknown flags, inconsistent metadata, variable frame sizes, missing data and
non-finite samples fail closed. Buffers must contain 1–2,048 frames (at most
128 ms). Larger buffers are rejected, not truncated or silently split; observed
native buffer sizes must inform any later change to this bound. The reader does
not convert, clamp, pad or insert silence.

The caller supplies an explicit source-clock origin. The reader checks numeric,
unrounded, nonnegative, epoch-zero `CMTime` values and uses wide rational
arithmetic to map timestamps to exact frame offsets. Uniform per-frame timing
and total duration must agree with the format and frame count. Fractional-frame
offsets, clock resets, overlapping/repeated frames and overflow are rejected.
It preserves missing frame positions, including initial gaps, rather than using
arrival time or the amount successfully queued. An inspected/copied interval
consumes its source time even if the subsequent handoff is full. Any read error
permanently retires this reader; the callback also cancels delivery
and returns cleanup control to the native owner. No automatic restart is supplied.

This is a strict development acceptance contract, not proof that every supported
Mac emits this layout or timestamp representation. The host still needs to
establish the source-clock relationship to the engine's session clock. No native
buffer or borrowed byte pointer escapes the read; the output is copied into the
caller's scratch prefix. A temporary retained format description is released
within the call. The Rust layer allocates no payload during the read, but this
is **not** an allocation, locking or latency guarantee for the CoreMedia APIs.
Validate those properties before exercising the connected callback with live audio.

## Callback delivery

The output and its 2,048-sample scratch array, 32-slot handoff and shared fault
signal are allocated before native startup. Each callback checks the operation's
cancellation, accepts only audio, validates/copies the buffer, then pushes the
exact source-frame interval. A full handoff drops that interval without waiting;
the next accepted interval exposes the gap. A cancelled operation delivers no
more work. Malformed input or a closed consumer cancels the operation, so queued
and already-returned blocks fail their source guards. The owner reports
`StreamFailed` and uses its existing Stop/remove/drain cleanup sequence.

A single `Mutex::try_lock` protects the mutable reader, scratch and producer.
It never waits or retries: unexpected concurrent/reentrant delivery or poisoned
state cancels the operation. The configured queue is serial, but this check avoids
relying on that assumption for Rust mutable aliasing. This does not establish
native scheduling latency or an allocation-free CoreMedia implementation. No
borrowed sample or native stream is stored by the handler. The owner retains the
output through successful Stop, output removal and the queue fence.

The session reader refuses delivery until startup is accepted. It retains the
existing source/session guards and explicit origin mapping. The host must stop
the owner when a session ends or its consumer is retired; detecting a closed
consumer on a later callback is only a fallback and cannot stop a silent stream.
No host task, shutdown policy, live permission flow or recognizer is added here.

## Validation

On the development Mac, all **356 Rust tests** pass with this feature enabled.
The ten ownership tests construct no native stream and request no access: nine
scripted lifecycle tests and one test of the actual completion block. They cover cancellation before startup, cancelled
late success, successful start followed by missing/delayed Stop completion,
explicit retry after failed Stop with a stale old completion, failed output
removal, failed start and owner abandonment. The completion block keeps only the first result, without reading or retaining
the error object. The lifecycle tests assert that another review
remains blocked until successful Stop and queue drain, and that resources are
released once. Two added fault tests cover pending startup, running capture,
pending Stop, repeated faults and isolation from a later operation. They invoke
the same atomic signal as the delegate; they do not simulate an Objective-C
message or prove native error delivery. Seven further tests exercise PCM validation: five construct real CoreMedia
objects containing fictional float samples and call the native copy/metadata
APIs, and two test unsupported ASBD fields and rational clock rejection. They
cover mono/planar values, exact gaps across time scales, wrong rate, missing
backing, oversized buffers, NaN, invalidation, inconsistent duration, overlap,
variable frame sizes and internal timing gaps. No stream or capture source is
created. These memory-only checks run on the development Mac; they do not prove
macOS 14 behavior or the live callback contract. The concrete macOS driver is
compiled with those tests. Six callback tests invoke the actual output handler
with fictional CoreMedia objects: startup gating and explicit session mapping,
queue overflow/gaps, invalid-sample retirement of returned work, Stop before
invalid input, reentrant delivery, and abandoned-session/unexpected-output faults.
These construct the Objective-C output object, but do not simulate native message
dispatch or construct a ScreenCaptureKit stream. A compile-fail doctest
also guards against making the native owner transferable across threads.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked --features native-audio-spike
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --features native-audio-spike -- -D warnings
```

These commands run fictional tests; they do not run capture. macOS CI includes
the feature tests/lint, while the desktop bundle retains default features.
Compilation on a current SDK does not establish macOS 14 runtime availability,
filter behavior, dispatch completion ordering or native release.

## Binding and dependency decision

The development candidate is `objc2-screen-capture-kit` **0.3.2**, pinned to its
published release. The [release source metadata](https://docs.rs/crate/objc2-screen-capture-kit/0.3.2/source/.cargo_vcs_info.json)
identifies upstream revision `7b1abfd750a2cacaea71d6a56ecfb83cb7de560b`. Direct bindings avoid the callback-side handler-list
allocation and read lock found in the alternative wrapper's
[pinned sample handler](https://github.com/doom-fish/screencapturekit-rs/blob/c11c9a95f672c6fafe34dc31d07749b0d58d6e1e/src/stream/sc_stream.rs).
This selects a development implementation, not a production binding proven on devices.

Enabled binding features cover streams, retained source metadata, blocks,
dispatch, CoreMedia and CoreGraphics; picker, recording and screenshot features
are not selected. The existing objc2 0.6.5, block2 0.6.2 and dispatch2 0.3.1
versions are reused. PCM reading adds direct optional CoreMedia/CoreAudioTypes
references and a test-only CoreFoundation reference at their already-resolved
0.3.2 versions, with no new package version. The lockfile additionally resolves ScreenCaptureKit,
CoreMedia and CoreVideo 0.3.2, with no unrelated version update or Swift build.
A lockfile dependency is not a measurement of delivered binary size.

The new framework crates and dispatch2 declare `Zlib OR Apache-2.0 OR MIT`;
objc2, block2 and Foundation declare MIT. Preserve their notices and include
applicable dependency licenses in any future distributed bundle. The pinned
[upstream license explanation](https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md)
also records Apple SDK provenance and Xcode licensing considerations. This record
does not replace those terms or complete a distribution-license review.

## Next acceptance and UI/UX checkpoint

The immediate implementation dependency is the owner-task shutdown/recovery
flow and an established native-to-session clock origin. Verify callback
allocation/latency and actual buffer sizes, and prepare explicit consent/selection
before requesting a bounded native run. Do not add
another generic queue or benchmark framework.

The user task remains: choose one clearly named application, understand its
application-wide audio scope, then reliably Cancel or Stop. This change adds no
rendered flow or accessibility evidence. The eventual flow must distinguish
starting, capturing, cleanup pending and failed cleanup without implying Off
prematurely. Native keyboard/focus, denial/revocation, selected-marker inclusion,
unrelated-marker exclusion, zero delivered video and actual source release on
macOS 14/current hardware remain open. Real capture still needs separate explicit
authorization. Granola recovery, signed installation/updates, device budgets and
participation/listening comparisons remain separate product gates.
