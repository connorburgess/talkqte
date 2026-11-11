# Selected-application audio ownership

Development checkpoint, 11 November 2026. `src-tauri/src/application_audio.rs`
implements an offline review/start/cancel boundary for the source-only experiment
in the [system-audio plan](system-audio-plan.md). It has no native adapter, OS
enumeration, permission request, audio delivery, Tauri command or app control.
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
separate adapter design and device acceptance. No audio is routed here, so this
change also does not prove source exclusion, timestamps, zero video delivery or
callback resource budgets.

Independent next implementation: bind synthetic audio to the selected operation,
preserve source identity and time gaps through a bounded handoff, and reject
cancelled or foreign-source buffers. That can be developed without enabling
native capture. The later native experiment still needs separately authorized
synthetic application audio, a reviewed binding, truthful native labels and the
OS/hardware checks in the system-audio plan.
