# Selected-application audio ownership

Development checkpoint, 11 November 2026. `src-tauri/src/application_audio.rs`
implements an offline review/start/cancel boundary, synthetic audio handoff,
session timing and chunk preparation for the source-only experiment in the
[system-audio plan](system-audio-plan.md). It has no native adapter, OS enumeration,
permission request, native audio delivery, Tauri command or app control.
The app remains microphone-only. This is not a capture capability or release.

The goal is to receive relevant conversation context without accidentally
listening to a different application or leaving a cancelled start active. Native
filtering and actual release must still be measured independently.

## Implemented boundary

- A review identifies one concrete application selection with bounded identity
  and display metadata. Its disclosure says that audio from all windows of that
  application may be included. There is no all-app or tab-only scope option.
- Replacing a pending selection invalidates the earlier review. Approval consumes
  that exact review once; foreign reviews and reused approval cannot start work.
- The adapter closure is supplied only to the approved start. Cancelling before
  worker entry skips it. If Stop arrives while it is running, its cancellation
  token changes immediately; a late returned stream is destroyed instead of
  becoming current capture. No gate lock spans adapter work or destruction.
- During startup, capture and cleanup, another selection cannot start. Stop stays
  visible until the start owner and returned stream have been released. An old
  Stop cannot cancel a subsequent explicit attempt.
- Permission denial, a missing source or a startup error finishes the attempt.
  There is no fallback, automatic retry or reconnect. A new attempt requires a
  new review and approval. Dropping an unused review/start cancels it.

The boundary follows the reservation/retirement pattern used by microphone and
live startup, without changing those paths. The stream owner lives outside the
gate so cleanup cannot hold its metadata lock. The public Rust module is for
development composition; importing it does not register or activate a provider.

## Synthetic acceptance

Nine Rust tests use fictional application identities, counted resources and
channel-controlled startup/cleanup. They verify:

1. Exact selected-source delivery, application-wide disclosure, one-use approval
   and explicit Stop followed by resource release.
2. Changed or foreign reviews cannot authorize the current selection; old control
   handles do not affect a replacement.
3. Empty, oversized or control-character metadata is refused.
4. Cancel before worker entry makes zero adapter calls and blocks overlap until
   the pending owner is released.
5. Cancel during startup rejects the late stream and keeps retry blocked through
   its delayed destructor.
6. Slow active-stream cleanup leaves status and repeated Stop responsive while
   another start remains blocked.
7. Denial, source loss at startup and startup failure call the adapter once,
   preserve no grant, and permit only a newly reviewed explicit retry.
8. A denial arriving after cancellation does not replace stopped state with a
   stale error.
9. Abandoned reviews/starts and an unwinding fictional adapter release their own
   reservation; another gate's control cannot cancel the current selection.

Run without capture or inference:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked application_audio
```

## UI/UX checkpoint and next dependencies

This change tests control policy, not a rendered or native user flow. The intended
flow is scope disclosure, selection, review of the named application, explicit
start, visible starting/capturing/stopping state, and Cancel/Stop. The important
experience risk is mistaking a window or browser tab for the whole application,
or mistaking a Stop acknowledgement for completed release. No usability,
VoiceOver, focus, permission-dialog or release-time result is claimed.

Before native integration, a trusted adapter must bind the selection ID to the
actual native filter and revalidate it; a string or matching display name is not
proof of identity or filtering. Scope disclosure must precede any native
enumeration or picker action that can itself request access. Future IPC must map
an opaque review ID to the Rust review; the frontend must not choose the source
at approval time. Authentication and permissions are not supplied by this module.

The adapter must observe cancellation, clean up before returning an error and
release its resource in a non-panicking destructor. This boundary cannot undo an
OS request already sent, force a blocked adapter to return, stop an adapter that
ignores cancellation, or prove that destructor completion released OS capture.
Native startup deadlines, real source release and asynchronous cleanup need a
separate adapter design and device acceptance. No native audio is routed here,
so these checks do not prove source exclusion, native timestamps, zero video delivery or
callback resource budgets.

The synthetic handoff below implements the next independent ownership/timing
step. The later native experiment still needs separately authorized synthetic
application audio, a reviewed binding, truthful native labels and the OS/hardware
checks in the system-audio plan.

## Source-bound synthetic audio handoff — 12 November 2026

`application_audio::handoff` adds an offline callback-to-worker boundary. A
consumed approval can create exactly one queue on its startup worker. Audio can
queue during startup, but the reader refuses delivery until that exact start
accepts its resource. Failed, abandoned or cancelled starts cannot deliver their
queued audio. Nothing instantiates this path in the app.

The queue holds 1–32 preallocated blocks, each with at most 2,048 interleaved
`f32` samples. The maximum sample payload is 256 KiB, plus fixed metadata and
ring overhead; this is a structural limit, not a measured whole-app budget.
Each queue has one immutable format (8–192 kHz, 1–8 channels). These bounds are
validation limits, not promises of native format support. An adapter must split
larger callbacks at complete frame boundaries before submission. Push scans and
copies at most 2,048 samples, with no allocation, mutex, waiting, logging, I/O or
inference. Finite values are clipped to [-1, 1]; empty, partial-frame, oversized,
non-finite and overflowing-time buffers are rejected as whole buffers.

Every submission must carry the exact approved operation token. Matching
application names or selection IDs do not authorize a different operation.
Returned blocks retain the application identity, operation, format and original
frame position. They do not identify a speaker or prove native filtering. A
trusted adapter must derive the token from the actual selected native stream,
not attach it to arbitrary audio.

Frame positions are absolute on a fixed-rate, zero-origin operation clock. They
must include missing frames. Backwards or overlapping buffers are rejected. A
full queue drops the entire incoming buffer, counts its frames, and advances the
producer's position; it never overwrites queued speech or silently retries it.
The next accepted block reports the missing frame range before it, including
source-clock gaps and queue drops. Real zero-valued samples stay distinguishable
from missing audio. If no later block arrives, the drop total still reports
capacity loss; no final gap block or invented silence is emitted. Native time to
session-clock mapping, drift, clock resets, channel conversion and resampling
remain separate adapter work; a format or clock reset requires a fresh operation.

Stop rejects future submissions and reader delivery. Queued audio is discarded
on cancelled reads, and both endpoints must be dropped by the owning worker to
release the ring. Cancellation may race the final producer write, but repeated
reads still reject it. Already returned audio cannot be retracted: downstream
work must recheck the block's operation with `belongs_to` before committing a
result, then use the existing session-result guards. Memory release is not a
secure-erasure guarantee; there is no file, log, network or webview payload.

Eight additional synthetic tests cover the single queue/format/capacity limits,
startup delivery gate, exact source and stereo samples, repeated full queues,
source-clock gaps, malformed/overlapping input, Stop and same-ID restart,
abandoned/failed startup, endpoint closure, and 100 coordinated slow-consumer
cycles on another thread. These are offline behavioral checks. Callback timing,
allocations in a native adapter, actual hardware drops, release latency and
sustained device resources remain unmeasured.

The user task remains explicitly starting one named application and trusting
Stop. This milestone addresses the risk of misattributing or joining separated
speech; it adds no rendered user flow or usability evidence. The session timing below supplies checked frame-to-session mapping with
synthetic discontinuities. The native adapter contract must still establish truthful
source selection, native clock mapping, startup deadlines and asynchronous cleanup. The separately
permissioned capture experiment must still prove filtering, no delivered video,
actual release and device budgets before any app integration. Integration,
delivery/signing, native accessibility and participation/listening acceptance
remain independent release gates; this handoff does not close them.

## Session timing — 12 November 2026

`application_audio::timing` consumes one handoff reader and binds it once to an
explicit engine session ID and the session-relative millisecond time of frame
zero. Delayed reads keep their capture position; neither wall time nor queue
arrival time supplies the origin. The adapter remains responsible for deriving
that origin from the native clock before use.

Start and exclusive end are each calculated from absolute frame positions:
`origin_ms + floor(frame * 1000 / sample_rate)`. Checked wide integer arithmetic
avoids intermediate overflow and accumulated per-block rounding drift. A result
outside `u64` milliseconds retires the reader without returning a partially
mapped block. Millisecond rounding can make a short block or gap have equal
endpoints; original samples, frame positions and a nonzero gap frame count retain
that distinction. Missing audio is never filled with silence or concatenated.

The wrapper retains exact operation/source identity and unconverted interleaved
samples. A changed session, cancellation or closed handoff permanently retires
its reader; pending startup remains retryable. Retirement closes the queue
consumer, but the capture owner must still stop and release the actual source.
Already returned work must pass `belongs_to(current_session, current_source)`
and the engine's existing session-result guard at commit. Session IDs must not
be reused. Queue-capacity losses remain readable, including trailing drops; after
retirement the count is the last observation, not a native loss measurement.

Eight offline tests verify delayed stereo delivery, explicit origins, irregular
blocks at 8/44.1/192 kHz over a year-long frame offset, initial and capacity gaps,
sub-millisecond gaps, trailing loss counts, session replacement, cancellation,
same-application restarts, startup and closure, and near-`u64` boundary arithmetic.
These synthetic inputs establish timestamp and ownership behavior only. No
native clock precision, capture latency, resampling quality or useful-conversation
outcome has been measured.

The experience goal is context placed at the right point in the conversation,
without treating missed audio as continuous speech. This milestone accepts the
offline timing contract; it has no rendered UI change. The chunk preparation below accepts the existing 16 kHz mono transcription
contract and rejects unsupported formats until conversion is explicit. Native clock origin,
drift and resets, filtering, asynchronous cleanup, permission disclosure and
actual device resource budgets remain separate adapter acceptance. Granola
source/date and recovery checks, native accessibility, signed delivery/updates,
support and participation/listening evidence remain release blockers.


## Gap-aware transcription chunks — 12 November 2026

`SessionReader::into_chunks` consumes the mapped reader and accepts only an
explicit 16 kHz mono format. Other rates and channel layouts are refused; no
samples are resampled, downmixed or relabelled. This is worker-side preparation
for `transcription::AudioChunk`, not a recognizer connection or native capability.

Each poll consumes at most one handoff block and returns at most one chunk.
Continuous audio is split into three-second chunks (48,000 samples). The
assembler holds at most that many pending samples; each returned chunk contains
at most 192,000 sample bytes. The original bounded handoff remains upstream.
Allocations and sample copies occur on the worker. These structural limits are
not measurements of whole-app memory, allocator overhead or device latency;
callers still need a bounded downstream queue and must release rejected chunks.

Every nonzero frame gap ends any partial chunk before the later samples begin,
even when both sides round to the same millisecond. No missing samples are
replaced with silence. Splits use the original absolute frame-to-session mapping,
not repeated addition of rounded block durations. A clean producer EOF returns
the last partial chunk once, then reports Closed; empty input emits no chunk.
Cancellation, session replacement or timing failure discards pending audio and
permanently retires the reader. Retirement closes the queue consumer; the source
owner must still stop and release native resources. Queue-loss counts survive
retirement, including loss after the last delivered block.

Returned chunks retain exact operation and session identity. Before committing
recognized text, a consumer must recheck `belongs_to` and the engine session;
Stop cannot retract samples already returned. Borrowing the `AudioChunk` alone
does not preserve that authorization. No production worker is connected in this
change, and the microphone pipeline is unchanged.

Nine synthetic tests verify sample-by-sample continuity across one minute of
irregular blocks, exact split times after a long frame offset, initial and
sub-millisecond gaps, capacity and trailing loss, final partial/empty EOF, startup,
unsupported formats, cancelled or replaced sessions, returned-work guards and
overflow. They establish offline assembly behavior only, with no model run,
native audio, user-flow observation or transcription-quality result.

The user goal remains timely context while following the conversation. This
slice addresses the risk of turning separated speech into continuous input; it
adds no rendered UI or listening-benefit evidence. The bounded synthetic
measurement below now covers this combined handoff/timing/chunk path; it does not
complete native integration or the whole-app resource budgets.
Native format conversion, clock accuracy, source filtering, startup/cleanup and
hardware budgets remain open. The broader integration, accessibility, delivery,
support and participation/listening gates above remain open too.

## Bounded component measurement — 12 November 2026

A one-off synthetic probe checked the combined path at
[`98c1aa6`](https://github.com/connorburgess/talkqte/tree/98c1aa6fed720e60299a0e8ad844e71847d9ff1f).
It found no loss in five minutes of normal pacing, preserved the exact gap under
intentional overload, and rejected work after cancellation. This is an isolated
component measurement, not a live-call benchmark or native capture result. No
application behavior or permanent benchmark framework was added.

### Method and acceptance

- Apple M5 Pro, 48 GiB RAM, macOS 26.4 (25E246), native ARM64, Rust 1.97.1.
  This was a shared development machine, not a controlled idle-host experiment.
- The standalone driver compiled unchanged ownership, handoff, timing and chunk
  modules from the recorded commit, with the existing `AudioChunk` definition
  and sample-rate constant. It used `rustc -C opt-level=2 -C debug-assertions=yes`
  and cached development-profile `rtrb` 0.4.1. It did not load Tauri, a recognizer,
  a model or a device. Synthetic startup returned a unit resource.
- One producer generated 320 mono frames at 16 kHz every 20 ms against absolute
  monotonic deadlines. The ring held eight blocks (160 ms at that input size);
  output chunks held at most 48,000 frames (three seconds). The consumer polled
  about every millisecond and released each output after checking it.
- Every frame's value was its absolute frame number divided by 2^23, exactly
  representable and below 1 for these runs. Checking each output value against
  its timestamp detected reordered samples or speech joined across a missing
  interval. No output audio was accumulated. This probe used millisecond-aligned
  frames; existing unit tests cover irregular blocks and sub-millisecond gaps.
- Acceptance was declared before execution: zero normal loss; generated frames
  equal delivered plus counted loss at clean EOF; input/output loss counters and
  missing positions agree; chunks stay bounded; cancellation invalidates returned
  work and discards pending audio. Resource figures establish a descriptive
  baseline, without a component CPU/RSS pass threshold.
- The overload run stalled the consumer for 800 ms after its first full chunk.
  The cancellation run reused one gate for 1,000 freshly approved operations,
  each with one full output chunk and 320 additional frames pending before Stop.
  It checked the returned chunk's source/session guard, rejected further pushes
  and repeated polls, dropped the resource/endpoints and observed the idle gate.

### Observed results

| Case | Driver wall time | Result | Process CPU time, user + system | Maximum RSS |
| --- | --- | --- | --- | --- |
| Normally paced input | 300.003 s | 4,800,000 generated and delivered frames; 100 chunks; zero dropped frames or gaps | 0.55 + 1.54 s | 3.02 MiB |
| Intentional consumer stall | 10.003 s | 160,000 generated; 149,760 delivered in five chunks; 10,240 dropped frames exactly matched the preserved gap | 0.02 + 0.05 s | 2.30 MiB |
| Repeated cancellation | 0.167 s, accelerated | 1,000 cycles; no accepted output after Stop; gate returned idle after each resource release | 0.16 + 0.00 s | 2.42 MiB |

All output chunks were at most 48,000 frames. Normal process CPU time was 2.09 s
across approximately 300 s, about 0.70% of one core. That includes generation,
per-sample assertions, allocation and polling, not just the component. The
cancellation driver's elapsed time excludes process startup; the external timed
process took 0.67 s. It is not a long-duration memory test or a native Stop timer.

An external `ps` sampler collected 298 RSS observations at approximately one-second
intervals during the normal run. After the first 30 seconds, RSS ranged from
2,240 to 3,088 KiB. Median RSS was 2,496 KiB during seconds 30–60 and 2,304 KiB
during seconds 270–300, a 7.7% decrease rather than growth in this interval.
`/usr/bin/time -lp` supplied process CPU time and maximum RSS; the external sampler
is excluded. Raw process observations and the disposable driver remain outside
the repository. The 34 existing boundary tests also passed in the standalone
source harness; no test was added merely to repeat these implementations.

### Decision and remaining dependency

This closes the bounded synthetic component check, with no defect requiring a
code change. It does not meet the [60-minute whole-app and minimum-device
budgets](budgets.md): there was no native capture, format conversion, transcription,
meeting app, companion, M1/8 GiB device or battery measurement. There is no new
privacy, performance, accessibility or participation guarantee.

The next meaningful audio evidence is the existing [source-only native
experiment](system-audio-plan.md): truthful application selection, selected-source
inclusion and unrelated-source exclusion, zero delivered video, and observed
startup/Stop/resource release on the target OS. Binding and lifecycle preparation
can proceed independently; running other-app capture still needs its explicit
scope authorization and hardware. Add further offline work only for a named
experiment prerequisite or reproduced failure. Granola account recovery, native
accessibility, signed installation/upgrades, support and the separate
participation/listening comparison remain open; another helper or successful
build cannot substitute for them.
