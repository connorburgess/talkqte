# Selected-application audio ownership

Development checkpoint, 11 November 2026. `src-tauri/src/application_audio.rs`
implements an offline review/start/cancel boundary and synthetic audio handoff
for the source-only experiment in the [system-audio plan](system-audio-plan.md). It has no native adapter, OS
enumeration, permission request, native audio delivery, Tauri command or app
control.
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
speech; it adds no rendered user flow or usability evidence. The next live-input
independent step is checked frame-to-session clock mapping with synthetic
discontinuities. The native adapter contract must still establish truthful
source selection, native clock mapping, startup deadlines and asynchronous cleanup. The separately
permissioned capture experiment must still prove filtering, no delivered video,
actual release and device budgets before any app integration. Integration,
delivery/signing, native accessibility and participation/listening acceptance
remain independent release gates; this handoff does not close them.
