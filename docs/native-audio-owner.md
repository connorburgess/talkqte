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
queue. It accepts an explicit host-clock/session `ClockBinding` and returns a
`NativeReader` alongside the owner. The host must establish that measured
correspondence, including fractional session time; the reader converts through
the actual stream clock on the same worker. Neither callback arrival nor the
first sample is used to guess session time. The constructor remains unsafe because native buffer validity
and CoreMedia copying behavior require live-context validation. No caller exists
in the app. Native objects stay on their constructing worker thread; no
`unsafe Send` or `Sync` implementation is added.

The owner polls bounded completion slots outside audio callbacks and UI work:

- Cancel before startup sends no native start request.
- Cancel during startup closes delivery through the existing control immediately,
  but retains the operation until start completes. Late success triggers Stop;
  it never becomes accepted capture. A failed start is conservatively stopped
  too; failure is not taken as proof that all native resources are released.
- Stop completion must succeed or report the framework's specific already-stopped
  error before removing the exact audio output. A fence
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
Drop is not an asynchronous Stop implementation. The worker loop below can retain
and poll the owner independently of its host handle. App shutdown integration
and a process-exit policy remain release blockers; reporting an abandoned task
does not recover it. This fallback is why this code
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
validation, unexpected output type and unavailable callback state share the
operation-scoped fault signal. Consumer retirement requests ordinary cancellation;
both follow the same cleanup path.
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

The native output uses the first validated sample as its source-frame origin.
The PCM reader checks numeric,
unrounded, nonnegative, epoch-zero `CMTime` values and uses wide rational
arithmetic to map timestamps to exact frame offsets. Uniform per-frame timing
and total duration must agree with the format and frame count. Fractional-frame
offsets, clock resets, overlapping/repeated frames and overflow are rejected.
It preserves missing frame positions, including initial gaps, rather than using
arrival time or the amount successfully queued. An inspected/copied interval
consumes its source time even if the subsequent handoff is full. Any read error
permanently retires this reader; the callback also cancels delivery
and returns cleanup control to the native owner. No automatic restart is supplied.

The output uses `PcmReader::from_first_sample` to retain the first
fully validated source timestamp as frame zero. This avoids assuming that an
arbitrary session-start reading lies on the source's 16 kHz frame grid. Its
`source_origin` is absent until metadata, PCM copying and finite-value checks all
succeed; it then stays unchanged across later blocks, gaps and errors. Invalid
first input permanently retires the reader without publishing an anchor. Later
fractional-frame offsets and overlap are still rejected. This mode does not infer
session time. The callback publishes only copied first-PTS metadata through a
fixed atomic slot before the ring packet; it never queries a native clock or
waits for the worker. The serial sample guard provides the single writer; a
release/acquire ready flag protects the immutable fields. The worker never takes
the callback's sample mutex.

### Native clock mapping — 12 November 2026

After the existing accepted-start guard yields a packet, `NativeReader` obtains
the stream's nullable
[`synchronizationClock`](https://developer.apple.com/documentation/screencapturekit/scstream/synchronizationclock)
and uses [`CMSyncConvertTime`](https://developer.apple.com/documentation/coremedia/cmsyncconverttime%28_%3Afrom%3Ato%3A%29)
to convert new source boundaries for that packet to the host clock. It obtains
the clock once for that packet and performs conversion again for later packets,
rather than assuming one fixed offset and identical source/host rates. A shared
source boundary keeps its already-published rational session time: the previous
block's end is the next contiguous block's start, or the start of its missing-frame
gap. Re-estimating that same boundary must not create an overlap or an unmarked
hole. New endpoints still use the current clock relationship; if a new endpoint
falls behind the retained boundary, delivery fails. This continuity policy does
not resample audio or establish a bound on clock estimation error.
CoreMedia may quantize converted host timestamps;
the binding preserves their rational values and the session fraction until the
final floor to milliseconds. Source sample-grid addition must be exactly
representable or delivery fails.

Missing clocks, invalid conversion, unsupported epochs, negative session time,
overflow, backwards delivery or a changed session permanently retire the reader
and cancel the operation. Stop during conversion also refuses the packet;
already returned work must still pass its source/session check. Owner polling
continues through native cleanup, including for a silent source. No start/Stop
completion or release policy changes. The reader stays on its constructing
worker; call it alongside `NativeOwner::poll`. `NativeTask::run` remains a
blocking cleanup loop and does not consume audio.

`NativeReader::dropped_frames()` reports queue-capacity loss even without a later
packet. Retirement preserves the last observed counter, including trailing loss
before Stop, clock failure or EOF. It is not a count of all native capture loss or
proof that a callback racing retirement has completed.

Eight clock tests use the same delivery path with memory-only CoreMedia timebases
at relative rates 0.5, 1 and 2, explicit offsets, a source timestamp off the
session-origin sample grid, fractional session time and a missing initial frame
range. They also cover start/empty guards, Stop during conversion, session
replacement, missing clocks, invalid/backwards time and overflow. A callback
regression checks publication before delivery and no anchor from invalid input.
Two regressions change a real memory timebase's anchor between packets, checking
both directions of re-estimation and continuity through a real frame gap. Both
fail against the earlier per-packet shared-boundary conversion. A third checks
trailing queue-loss visibility before and after Stop, clock failure and EOF.
These tests create no SCStream, device or permission request and do not measure
independent hardware-clock drift.

`ClockBinding::new` validates numbers; it does **not** measure correspondence
between the runtime's Rust `Instant` and the native host clock or establish an
uncertainty bound. That host measurement remains required before app activation.
The native reader deliberately does not enter the synthetic nominal-rate
chunker. It now returns a `NativeBlock` retaining rational start/end session
positions alongside the original source-owned `TimedBlock` envelope. Its
`frame_ms` lookup projects an absolute frame boundary inside that block,
including the exclusive end, and floors only the final answer. A split must
retain this original mapping rather than start again from a rounded timestamp.
Positions outside the block, including missing frames, are rejected. The
`timing().belongs_to` guard still has to pass before samples or delayed results
are used; a numeric lookup is not source/session authorization.

Interior positions use a fixed linear interpolation between that block's two
converted boundaries. This is a bounded mapping policy for at most 2,048 native
mono samples (128 ms at 16 kHz), not measured intra-block clock accuracy. Keeping
the original mapping also prevents a later clock re-estimate from retiming
already returned work. Comparison happens before rounding: a backwards or flat
time span for a nonempty block, or a backwards gap even within one millisecond,
retires delivery and invalidates earlier work. Exact arithmetic that cannot be
represented fails instead of clamping or falling back to nominal sample time.

Five additional memory-only tests cover every possible split boundary of a
2,048-sample block at relative rates 0.5, 1 and 2; fractional source phase;
immutable shared boundaries after a timebase change; sub-millisecond backwards
blocks and gaps; invalid ranges and arithmetic overflow. These establish the
mapping policy, not native drift, recognition quality or latency. Chunk assembly
must next carry these mappings through splits and gaps, and the transcription
worker must apply them to recognized offsets with source/session checks at
result delivery. No resampling, recognizer connection, app command, capture
permission or default-build behavior changes here.

### Native transcription chunks — 12 November 2026

`NativeChunker` assembles native blocks into bounded mono chunks of at most
three seconds on the worker that owns the `NativeReader`. It does not own the
reader: the worker passes each block from `try_next`. `finish` can release the
last partial chunk after a clean close, but the source worker added later
discards that audio by decision and never calls it. Each chunk keeps one timing segment per
block it holds, with that block's rational start and end. A block split by a full
chunk computes its split boundary once and uses it on both sides.
`NativeChunk::session_ms` maps a recognizer offset, measured in the chunk's
nominal 16 kHz samples, to session time through the segment that holds it.
Offsets beyond the chunk's audio, including its gap side, are refused rather
than clamped.

A gap ends the current chunk; audio is never joined across one. A chunk holds at
most 256 segments, so a stream of unusually small blocks ends chunks early
instead of growing the map. Stop, cancellation, a changed session or a block
from another source retires the chunker and discards pending audio without a
final flush. `belongs_to` still has to pass before a chunk's results are used.

Six memory-only tests run real `NativeBlock`s through the clock delivery path at
relative rates 0.5, 1 and 2. They check every recognizer millisecond of a full
chunk and the remainder after a split, a gap, the segment limit, Stop, session
replacement and a foreign block. A mutation check confirmed the tests fail if
offsets are added to the floored chunk start, or if the split boundary is wrong.
The transcription worker still accepts only `AudioChunk`; it is not connected to
these chunks, and nothing here starts capture or recognition. Applying
`session_ms` at result delivery, with the source/session check, is the next
dependency. Actual drift and recognition quality remain native gates.

Two memory-only regressions cover a source phase rejected by an arbitrary fixed
origin, exact cross-timescale offsets and gaps, immutable anchoring, later phase
rejection and failure before anchoring (invalid time, missing backing or NaN).
They construct CoreMedia buffers containing fictional samples, with no stream,
device or permission request. They prove source-frame arithmetic only.

This is a strict development acceptance contract, not proof that every supported
Mac emits this layout or timestamp representation. The host still needs to
measure the host-clock relationship to the engine's session clock. No native
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
more work. Malformed input cancels the operation, so queued and already-returned
blocks fail their source guards. The owner reports `StreamFailed` and uses its
existing Stop/remove/drain cleanup sequence. A closed consumer is ordinary
cancellation rather than a native-stream failure.

A single `Mutex::try_lock` protects the mutable reader, scratch and producer.
It never waits or retries: unexpected concurrent/reentrant delivery or poisoned
state cancels the operation. The configured queue is serial, but this check avoids
relying on that assumption for Rust mutable aliasing. This does not establish
native scheduling latency or an allocation-free CoreMedia implementation. No
borrowed sample or native stream is stored by the handler. The owner retains the
output through successful Stop, output removal and the queue fence.

The session reader refuses delivery until startup is accepted. It retains the
existing source/session guards and explicit origin mapping. Retiring or dropping
the reader publishes an operation-scoped atomic closure signal. The native owner
checks it on every poll, cancels delivery and initiates Stop even if the selected
application is silent. During pending startup it waits for completion before
Stop, preserving the reservation; repeated polls cannot duplicate that request.
No callback-state lock or native object crosses this closure signal. A live
session's Stop or replacement now cancels its attached source
([below](#live-session-ownership-of-the-source--13-november-2026)); the host
must still retire the reader. The worker below keeps polling,
but app shutdown policy, live permission flow and recognition remain separate.

## Owner worker and host control

`NativeOwner::into_task` produces a `NativeTask` and a sendable `TaskControl`.
Construct and run the task on the same dedicated worker thread; only the control
and session reader cross to the host. The task is not Send and is not an abortable
async future. It does not spawn a worker or enable capture by itself. The host
must run it until `Released`, rather than discard it when a window, session or
async caller ends. It must not occupy the UI thread or a shared worker pool whose
shutdown depends on a bounded join.

`TaskControl::stop` closes delivery atomically and wakes the worker without a
status lock or join. Dropping the control does the same; if shared through an
`Arc`, the last control owner requests Stop. The task retains native resources
and the reservation independently, including while startup is pending. It polls
completion slots at 20 ms intervals and wakes early for Stop/retry; this interval
is not a native latency guarantee. A quiet source cannot prevent cleanup polling.

Snapshots distinguish the last observed native stage, cancellation requested,
and task abandonment. A native call in progress cannot hold the host's status or
command mutex. The snapshot may still show an earlier stage while that call
runs; `stop_requested` is not proof of native release. Only `Released` follows
confirmed Stop, output removal, callback drain and resource release.

One explicit cleanup retry can be pending at a time. A request made before a
completed Stop/removal failure is rejected rather than retained for a future
failure. Native retry calls run outside the shared mutex. No failure, timeout,
lost host handle or repeated status read triggers an automatic retry or restart.
Dropping an unrun task or unwinding its worker closes delivery, marks its snapshot
abandoned and uses the existing resource quarantine. This can leave native capture
active; it does not confirm Off, free the reservation, or recover the stream.
If the control is gone and cleanup fails, the task continues holding that operation.
The app still needs a visible stalled/failed state and an explicit exit/recovery
policy before this development path can be enabled.

## Validation

On the development Mac, all **362 Rust tests** pass with this feature enabled.
The eleven original ownership tests construct no native stream and request no access: ten
scripted lifecycle tests and one test of the actual completion block. They cover cancellation before startup, cancelled
late success, successful start followed by missing/delayed Stop completion,
explicit retry after failed Stop with a stale old completion, failed output
removal, failed start and owner abandonment. A real session-reader retirement
also exercises pending/running owner cleanup without any sample callback; it
keeps new reviews blocked through confirmed Stop and drain. The start completion
block keeps only the first result without reading the error object. The Stop
completion reads only its borrowed error's domain/code and retains no error or
diagnostic text. The lifecycle tests assert that another review
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
dispatch or construct a ScreenCaptureKit stream. Five worker-control regressions
add pending/running controller drop through real worker-thread cleanup, explicit
Stop/removal retry and stale-control isolation, a deliberately blocked native Stop
that leaves host controls responsive, unrun-task abandonment, and worker unwind.
These use scripted native calls, not real capture. Two compile-fail doctests guard
against moving the native owner or task across threads.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked --features native-audio-spike
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --features native-audio-spike -- -D warnings
```

These commands run fictional tests; they do not run capture. macOS CI includes
both default-feature and native-feature tests/lint; the desktop bundle retains
default features.
Compilation on a current SDK does not establish macOS 14 runtime availability,
filter behavior, dispatch completion ordering or native release.

### Already-stopped cleanup — 12 November 2026

The external review identified a recovery dead end: after failed startup or an
OS stop, another Stop request can report that the stream is already stopped.
Treating that result as an ordinary failure would retain the source indefinitely.
Apple documents [`attemptToStopStreamState`](https://developer.apple.com/documentation/screencapturekit/scstreamerror/attempttostopstreamstate)
as a stopped or nonexistent stream. Only this code in `SCStreamErrorDomain`,
returned by the outstanding Stop completion, now allows output removal and the
queue fence. Other domains, other failures and a pending completion still retain
the reservation. A failed start or callback fault alone never proves release.

Memory-only error fixtures exercise the actual completion block, including
foreign-domain collisions, audio-stop failure, first-result handling and rejection
of the same error by start completion. Scripted owner checks cover failed start
and stream fault, including output-removal failure/retry and reservation retention
until the queue drains. No device experiment establishes which error a particular
macOS version returns or how quickly resources are released.

Both new regressions fail with the previous Stop classification/cleanup behavior
and pass with the fix. The full local checks pass with 364 feature tests, 333
default-feature tests, both compile-fail doctests and warnings-denied Clippy in
both configurations. These are offline checks, not native release measurements.

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

### Native timing at result delivery — 13 November 2026

The transcription worker's queue now accepts any chunk that supplies its own
timing (`transcription::Timed`), and a `NativeChunk` is one. The chunk travels
through the queue with its mapping, so a line recognized seconds later is still
timed by `NativeChunk::session_ms`, not by a floored start plus a nominal
offset. An offset the chunk cannot map, which in practice means one outside its
audio, is skipped and counted, never clamped. Microphone chunks keep their existing nominal timing and behavior.

The worker asks the chunk whether its source is still current before
recognition and again before each delivered line. A chunk whose source was
stopped or replaced, or that was made for a session other than the worker's, is
not recognized; if Stop arrives while the recognizer is busy or between two
lines, the undelivered lines are discarded. Each such chunk is counted once in
`Stats::stale`, including one that produced no lines. The worker itself keeps
running, so this does not depend on the caller also cancelling it. Whether the
worker's session is still the engine's remains the engine's check at delivery.

The check reads the chunk's own cancellation flag, which every stop and
replacement path in the gate sets. Releasing the capture sets it as well. The
source worker added later cancels on any end of input, so queued audio is
withheld by decision and nothing is transcribed after a clean end.

Three memory-only tests queue real native chunks at relative rates 0.5, 1 and
2 with a scripted recognizer: delivered times across a split block, an
out-of-range offset, Stop during recognition with a second chunk waiting, and a
chunk from another session. Five default-build tests cover the same contract
with a synthetic clock, plus a stop between two lines of one chunk and a
stopped chunk with no recognized lines. A mutation check confirmed the native tests fail with
nominal timing or without the source check.

Nothing creates a native chunk in the app: no capture path, recognizer
connection, command or permission request is added. Actual drift, recognizer
offset accuracy on real audio, and Stop latency on a device remain untested.

## Next acceptance and UI/UX checkpoint

The source worker and sink below connect selection, the owner and the
transcript in code that nothing calls. The next dependency is the host around
them: a disclosed selection flow, a visible stopping state and app shutdown.
The worker mechanism is tested; the app exit/recovery policy is not implemented. Verify callback
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

## Measured runtime correspondence preparation — 12 November 2026

The private, macOS `native-audio-spike` module `native_session_clock` prepares a
host-clock binding in three stages. No app command calls it yet:

1. Under the runtime lock, synchronize and copy the live session identity,
   startup operation, Rust instant and elapsed time including its fractional
   millisecond. Demo, ended, stopping, mismatched and cancelled states refuse a
   snapshot. Pausing live cues leaves this clock running.
2. On the owning worker, outside the runtime lock and audio callback, bracket
   one CoreMedia host-clock read with Rust instant reads. Project the snapshot
   through the worker's scheduling delay and use the bracket midpoint as an
   estimate. Preserve the full bracket width in nanosecond-capable `Duration`;
   reject reversed clocks, invalid host times, arithmetic overflow or a width
   beyond the caller's explicit tolerance. A separate caller-supplied maximum
   age runs from the original snapshot through runtime acceptance. An expired
   snapshot is rejected before the host-clock call, and the age is checked again
   after that call. A narrow read does not reset this budget. There is no implicit
   retry or default tolerance presented as a proven budget.
3. Reacquire the runtime lock and consume the measurement only if its exact live
   session, operation and source control remain current. Stop or replacement
   during the read or before acceptance rejects it. The same age limit includes
   time waiting to reacquire the runtime lock; reversed acceptance time is also
   rejected. Age exactly at the limit is accepted, without millisecond rounding.
   Acceptance attaches the source to that live session (see the next
   section). The native owner's and delivered blocks' ongoing cancellation
   checks remain necessary after this acceptance; a clock measurement is not
   source permission.

Eight deterministic tests use injected instants and fictional host times. They
cover fractional timing, delayed workers, exact tolerance boundaries, reversed
and over-wide brackets, invalid timestamps, overflow, Stop/replacement races,
source cancellation before the SDK read, invalid runtime states and live cue
pause. Three age regressions additionally cover expiry before the SDK read,
a narrow read crossing the age limit, delayed acceptance and reversed time.
These checks do not exercise a hardware clock or activate capture.

The bracket describes read uncertainty only. It does not bound drift between
Rust and CoreMedia clocks, account for suspension, or establish a safe numerical
age budget. The age check ends at acceptance: it is not a lifetime guarantee for
the returned binding. Before connecting the experiment, define and verify
invalidation and remeasurement on suspension/clock changes, retain the uncertainty evidence,
and integrate source selection, consent and shutdown/recovery. Drift-aware
transcription offsets and separately authorized native filtering/release checks
remain dependencies. Normal microphone, UI, retention and provider behavior is
unchanged; the broader capture roadmap acceptance remains open.

## Live session ownership of the source — 13 November 2026

Before this change a live session's Stop did not reach an application-audio
source. Stop keeps the engine's session number until cleanup finishes, so the
reader's session check kept passing and the source's own control was never
cancelled: blocks, chunks and recognized lines would have stayed acceptable
until something else stopped the source.

The runtime now holds one attached source at a time for the live session
(`live_source.rs`, compiled in every build). Accepting a clock measurement
attaches the source as its last step, so a rejected or expired measurement
attaches nothing. One binding is accepted per source operation. A second
acceptance, for the same source or another one, is refused with a distinct
`Occupied` error and leaves the attached source running; it never replaces it.
Once that source has stopped, a newly reviewed one can be attached.

Retirement is one atomic store on the source's control, made under the runtime
lock. It makes no native call and does not wait for a worker, an audio callback
or the review gate; the surrounding runtime step briefly takes the existing
startup-gate mutex, as it did before.

- `stop_live_session`, scoped `stop_capture`, End during a live session,
  microphone loss and a failed live start all pass through the same runtime
  step, which now cancels the attached source.
- Each runtime sync also retires a source whose session ended, was replaced, is
  stopping or no longer matches its startup operation, in case a path changes
  the session without that step. Syncs run on commands and on the 200 ms
  background tick, so this fallback normally acts within about one tick; it is
  not immediate and stops if that thread does.
- A source that stops by itself is detached on the next sync or attach.
- Dropping the attachment, including with the runtime, cancels the source. The
  running app never drops its runtime, so this is not an app-exit policy.

From that store on, the callback-side `push` refuses new audio, the reader
discards what is queued, a partly assembled chunk is not flushed, and returned
blocks and chunks fail `belongs_to`. A transcription worker holding native
chunks skips queued ones and discards the undelivered lines of one in progress,
counting each as stale. Lines delivered before Stop stay delivered. This differs
from the microphone path, where Stop transcribes queued audio: for application
audio, Stop discards undelivered audio. The reason is recorded
[below](#stop-discards-undelivered-application-audio).

A worker can pass its own source check just before Stop takes the runtime lock,
and the engine still accepts lines while it drains the microphone. A transcript
sink for application audio must therefore call `live_source_accepts` with the
runtime lock held, immediately before committing each line; it refuses after
Stop and refuses a source that was never attached. The sink in the next section
does this.

Limits of this step:

- When this step merged, attachment was not enforced by the audio types. The
  next section narrows that: the binding and native chunker constructors are
  now crate-private and the sink refuses an unattached source. The synthetic
  `Reader::bind_session` path is still public and has no sink.
- Attaching requires an uncancelled control, not an approved one. A review that
  is never approved can occupy the session until it is dropped or replaced; it
  delivers nothing and Stop cancels it.
- The review gate is not locked, so its snapshot keeps the earlier phase
  (`Reviewing`, `Starting` or `Capturing`) until the source's owner observes
  the cancellation on its next poll and begins Stop. The gate stays reserved
  through that cleanup, so another review cannot overlap. A future UI must not
  present that phase as continued listening after a live Stop.
- Because one binding is accepted per operation, a later re-measurement, for
  example after sleep, is refused. No policy for that exists yet.

Six tests in the default build use a synthetic 16 kHz source with no device:
three runtime-level Stop paths (the shared Stop step, scoped capture Stop and
dropping the runtime) with one block returned, one queued and a later callback;
a partly assembled chunk followed by a gap; a session that ends, is replaced or
starts stopping without the Stop step; a sink thread that passed its own check
and then waits behind Stop for the runtime lock; a refused second source; and
refusal outside a running live session, with live cue pause keeping the source.
Two native-feature tests run an accepted binding through the memory-only clock
delivery path, `NativeChunker` and a transcription worker with a scripted
recognizer: Stop arrives while the recognizer holds a chunk, and a rejected
measurement or second acceptance attaches nothing. With the Stop step and the
sync check disabled, five of these eight tests fail. The sink check, the
refusals and the attach-once test pass either way, because they do not depend
on cancellation.

Not covered: a ScreenCaptureKit stream, real callbacks, Stop racing a callback
on another thread beyond the handoff's own tests, native Stop latency or
release, system sleep and wake, a lifetime bound on an accepted binding, app
exit, and any UI. No command attaches a source, so app behavior is unchanged.

## Source worker and transcript sink — 13 November 2026

`native_source.rs` (macOS, `native-audio-spike` only) is the host loop for one
selected application. Nothing calls it: there is no command, picker,
enumeration or permission request, and it has not been run against a device.

`run` takes the approved `Start`, the `Selection` built on the calling worker
thread and explicit clock limits. In order, it:

1. snapshots the session under the runtime lock, reads the host clock without
   it, and accepts the measurement under the lock again. Acceptance attaches
   the source. Any refusal ends here, before a native request is sent;
2. starts the transcription worker, so a thread that cannot start fails
   before anything is asked of the OS, then begins the native owner for exactly that selection with the accepted
   binding. The owner still refuses a selection that differs from the review;
3. loops on that worker until the owner reports `Released`: poll native
   completions first on every pass, then move available blocks into
   `NativeChunker` and submit full chunks to a transcription worker.

The host passes in a sendable `Monitor`. The loop records the owner's stage in
it on every pass, so a failed Stop or output removal is visible while the loop
is still running. `Monitor::retry_cleanup` accepts one explicit retry of such
an observed failure. It is refused before a failure, while a retry is waiting
or being performed, and after the retry until a new failure is observed: the
loop polls again after performing a retry and records that stage, as the owner
task does. Nothing retries by itself. The monitor holds no native object and
its lock is never held across a native call or together with the runtime lock.

If the loop ends any other way than through `Released`, for example by a panic
on its thread, the monitor reports `abandoned` and delivery is closed. This is
not a Stop: the owner quarantines its native resources, capture may still be
running, and no retry is accepted. The host must show that state, not Off.

The worker stops listening, by cancelling the source and continuing native
cleanup, whenever capturing would serve nothing:

- the sink finds the source is not attached. The line is refused with a typed
  not-attached answer, distinct from an engine refusal such as an out-of-order
  line, which leaves the source running;
- the runtime is unavailable (its lock is poisoned) when a line arrives;
- every 50 passes the loop asks the runtime whether the source is still
  attached, and stops on "no" or no answer. A silent source is therefore
  covered too. On a responsive machine 50 idle passes take about a second, but
  the interval is counted in passes, not time: a starved or throttled thread
  makes fewer passes. At macOS background priority, where timers are
  coalesced, it took more than five seconds locally. This check is a backstop;
  Stop, session replacement and the sink cancel the source directly;
- the transcription worker thread has ended, for example after a recognizer
  panic.

Recognized lines enter the engine through `Runtime::ingest_source_line` and
nowhere else. Like attaching, it is compiled only with the feature or in tests;
the default app build contains neither. With the runtime lock held it syncs, checks that this exact
source is attached to this running session, and only then calls the engine. A
line from a source that is not attached is refused even when its session number
is right and its audio was recognized. The sink check sits behind the worker's
own source check, so it also closes the window where Stop arrives between that
check and the commit.

Attachment is now the only supported way for native audio to reach a session.
Three things hold that, with the caveat after them:

- `ClockBinding::new` is crate-private. Outside tests only the clock
  measurement calls it, and the binding leaves the runtime only through
  acceptance, which attaches a source. `NativeOwner::begin` needs a binding.
- `NativeChunker::new` is crate-private; outside tests only the source worker
  calls it.
- The sink refuses everything else. This is the enforcement that does not
  depend on how the audio was produced.

This holds inside the crate by convention plus the sink, not by the type
system. A binding names a session, not a source, so crate code could accept
the clock for one operation and begin another; `run` uses one operation for
both, and the sink compares the operation itself, so the other one's lines are
refused. Crate code could also hand native chunks to a worker with a different
sink. The synthetic `Reader::bind_session` path remains public for tests and
has no route to the engine.

### Stop discards undelivered application audio

Decision: when the live session stops, is replaced, or the source ends for any
reason, audio from the selected application that has not yet produced a
delivered line is discarded. This covers audio in the callback queue, a partly
assembled chunk, chunks waiting for the recognizer and the chunk being
recognized. Lines already in the transcript stay. A clean end of input is
treated the same way; the worker cancels the operation when reading ends.

Reasons:

- Stop is the person's instruction to stop listening to another application.
  A flush would keep recognizing that application's audio after Stop and add
  lines the person did not expect. With the current limits that is up to about
  22 seconds of audio when the recognizer is behind: a 32-block callback queue
  (about 4 s), a partial chunk (under 3 s), four queued three-second chunks
  and the one in progress.
- One cancellation is the only authority that closes the callback, the queue,
  returned work and the sink together. A flush needs a second state in which
  the source is stopped but still allowed to deliver, which reopens the gap the
  attachment closed.
- The cost is bounded by the same limits: at most about 22 seconds of speech
  are missing from the end of the transcript, and normally a few seconds when
  the recognizer keeps up. Cues are meant to be timely, not a complete record.

The microphone path keeps its existing behavior and transcribes its queued
audio on Stop. The two differ on purpose; this has not been tried with people.

### Tests

Ten native-feature tests use the memory-only clock feed, a scripted owner
(running until cancelled, then two polls of stopping, then released) and a
scripted recognizer. Nine run the worker and loop joined as `run` joins them;
one covers preparation alone.

- An attached source puts its first line in the engine at the clock's time.
  While the recognizer holds the second chunk the session is stopped, or in a
  second case ended without the Stop step. No second line arrives, the loop
  ends at `Released` and the review gate returns to idle. In the second case
  the engine itself refuses the late line; what the case adds is that the
  sink's sync retires the still-running source, which is what ends the loop.
  The queued audio contains two real gaps, which end chunks instead of joining
  audio.
- A source whose binding was built directly, with the same numbers an accepted
  one would hold, is read, chunked and recognized once. Its line is refused at
  the sink, the transcript stays empty, and that refusal stops the source with
  no further recognition. The live session is undisturbed.
- The same unattached source with no audio at all is stopped by the periodic
  attachment check.
- A scripted Stop failure stays visible in the monitor across further polls
  with no automatic retry and the gate still reserved. A retry requested before
  the failure is refused; one explicit retry is performed once and releases;
  further requests during and after it are refused.
- A loop that panics leaves the monitor abandoned, with delivery closed, a
  last stage other than released, and retry refused.
- A recognizer that panics ends the transcription worker, and the loop stops
  the source.
- A valid block from a different operation is refused by the chunker, and the
  worker cancels its own source without recognizing its queued audio.
- A clean end of input ends the loop with the source cancelled and the
  trailing audio unrecognized. Here the reader's own retirement cancels it, and
  the test does not require that any line was recognized first.
- An unavailable runtime cancels the source.
- Preparation with a real host-clock read attaches one source, refuses a second
  as `Occupied` without stopping the first, and refuses after Stop without
  reading the clock.

One test compiled in every build's test run drives the sink directly: an
attached source's line is accepted, a repeated line gets an engine refusal, a
line from an unattached source of the same application gets the not-attached
answer, and after Stop the source's line is refused while a microphone line for
the same session is still accepted.

Mutation checks, each restored afterwards. Without the sink's attachment check
the sink test and the unattached-source test fail. Each of these also makes
its own test fail: no cancel at the end of reading, no cancel for an
unavailable runtime, the retry not performed, the status not refreshed after a
retry, a dead worker ignored, no periodic attachment check, no cancel on a
not-attached refusal, and no abandoned mark. The threaded tests are bounded by
a five-second watchdog so a regression fails instead of hanging.

The silent unattached source test counts passes instead of waiting: it runs
the loop without parking and asserts that the first poll to see the
cancellation is the one right after the 50th pass. An earlier version waited
up to five seconds of wall time for it, and failed on a loaded CI runner
without any change to the loop; the same version fails every time when run at
macOS background priority.

Not covered:

- `run` itself, because beginning the owner constructs a real stream. The
  scripted owner starts already running and stands in for native completion
  order, which has its own tests above; the starting stage and a start failure
  are not exercised through this loop.
- Real callbacks, Stop latency, and a native completion that never arrives.
  The loop then keeps the worker and gate reserved by design, with no UI.
- A transcription thread that cannot be started. `run` starts it before the
  native request, but that ordering is not exercised by a test.
- A full transcription queue. The loop reads as fast as audio arrives, so a
  slow recognizer drops the newest chunks; they are counted, not retried.
- A transcription worker that does not stop within its two-second wait after
  release; its counts are then incomplete.
- Publishing state after a line. The test access is a plain shared runtime; the
  app's access must publish under the lock as the microphone sink does.
- App exit, sleep and wake.
- A microphone and an application feeding one session at once. The engine
  refuses a line timed before the last accepted one, so two sources would lose
  lines until ordering is designed.
