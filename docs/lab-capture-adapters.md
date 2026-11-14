# Prepared-take capture observation adapters

This offline follow-up supplies `createLabListening` and `createLabRecorder` for
the [prepared driver](lab-prepared-take.md). It adds no runtime command, model
call, permission change, helper build or UI fallback. Real use still requires
reviewed builds, exact fictional media/window approvals and a bounded run plan.

## Historical Listening evidence

Create `createLabListening({launcher,commit,features})` before launching, using the
same owned launcher and reviewed receipt metadata. Its `waitListening({runId,signal})`
waits for a matching armed run, one checked live-session start, the exact frozen
QuickTime acknowledgement and `dev_source.started` on that child's private file.
It returns `{runId,listening:true,historical:true,session}`. Missing/replaced/end/
Stop/failure/closed evidence refuses readiness; timeout and abort settle the wait.
The prepared driver closes the observer during shared cleanup.

The launcher's bounded subscription forwards only validated source/session
metadata, never transcript/cue text. Session metadata retains the native session
number and checked commit/features. The launcher's `identity` binds its exact
owned child PID, executable and launch run id; this provenance is not a newly
invented native event field. Up to eight subscribers are allowed. Close is
terminal and prevents a later launch; observed source stopping/ending also
notifies the native owner to abort the shared run.

**This is historical evidence, not atomic current-operation readiness.** Native
reads Listening under the host lock and emits `dev_source.started` afterward;
concurrent Stop/replacement can retire that operation before emission. The event
contains only application/step, not operation or session identity. Separate lossy
metadata events cannot repair that missing identity or prove physical audio.
Observed retirement is rejected, and the lifecycle still requires authenticated
native clock calibration plus actual player-start evidence before dispatch.
An identity-bound native contract remains a separate investigation; this adapter
must not be promoted into a current-operation guarantee. Runtime remains held.

## Strict window recorder

`createLabRecorder({binary,sha256,directory,native,selectWindows,seconds})` requires
an explicitly supplied canonical helper executable and reviewed digest. It does
not call `ensureHelper`, compile Swift or guess a binary. It checks the executable
digest again before direct spawn, with no shell or ambient provider/runtime keys.
`directory` must be an external owned `0700` directory; each take creates a new
private subdirectory and fixed movie destination. The returned `output` remains
private evidence, including incomplete artifacts on failure; cleanup/export is
an explicit run-plan responsibility.

`native` is the same owned launcher. `selectWindows({runId,signal})` is a trusted
approved-window discovery adapter returning emulator/companion `{app,pid,windowId}`.
The companion PID must equal that run's owned native child; emulator application
is exactly QuickTime Player. Both PID/window pairs must be positive and distinct.
The helper verifies those exact on-screen identities **before creating streams**.
Selection is never inferred from a substring title, smallest window or spawn.
The exact fictional document/other QuickTime audio and companion visibility/model
readiness still require independent checks; exact windows do not prove cue paint.

The Swift helper's new `--strict-windows` mode requires `--emulator-pid`,
`--emulator-window-id`, `--companion-pid` and `--companion-window-id`. Its existing
permissive CLI path is preserved. Strict `matched` echoes exact apps/PIDs/window
IDs and `rule:"exact pid/window"`; the adapter compares them to approved selection.
Strict readiness is `frame_accepted`, emitted only after at least one successful
video append **and both capture streams have started and ordinary Stop handlers
are installed**. This is a frame accepted
by the writer, not necessarily a durable persisted movie before finalization.
Legacy `started` is not accepted as strict readiness.

The adapter implements the driver's subscribe/start/stop contract. It parses the
owned helper's stdout incrementally with fatal UTF-8 and duplicate-key rejection,
16 KiB frame and 256 KiB combined stdout/stderr bounds. Unexpected/malformed/
wrong-identity messages fail closed; raw helper error text is never forwarded.
Startup defaults to five seconds. The fixed helper duration is at most 180 seconds.
Stop sends ordinary SIGTERM once to that exact owned child and awaits stream
closure plus `stopped` with positive frame/audio counts, completed writer status,
empty problem, a nonempty regular output file and exit zero. Output is then `0600`.
No sound, failed writer, partial message, process exit or signal receipt alone
counts as a successful recording.

Finalization defaults to six seconds. On expiry only the owned helper process
group is killed, then ownership remains until close; forced termination is always
failed/unconfirmed recording cleanup. This is not the native app's SIGUSR2 seam
and cannot establish native source release. Early setup cancellation before the
helper installs ordinary Stop handlers is also failed/unconfirmed. Stop before
any helper spawn is a proven never-started recorder; a pending selector cannot
launch later after that Stop. A noncooperative selector must settle on abort for
the enclosing driver to settle. Filesystem bytes are not writer-quota capped.

## Offline evidence and remaining work

```sh
node --test scripts/cue-lab-listening.test.mjs scripts/cue-lab-recorder.test.mjs
```

Listening checks include a real harmless Node child writing synthetic private
timing frames through the launcher/parser. Recorder checks spawn only the fixed
harmless fixture, which writes protocol messages and a text artifact, not video.
They cover partial/malformed/duplicate/oversized streams, wrong identities,
spawn-without-frame, missing/failed finalization, owned timeout termination and
Stop during window discovery. Source checks cover the Swift strict-mode ordering;
they do not compile Swift or establish ScreenCaptureKit/device behavior.

The actual helper still needs reviewed compilation/receipt and opt-in native
validation. Approved build/disk availability, exact-window discovery, identity-bound
current source readiness, exact-file QuickTime/audio-clock controls and visible
companion/model/permission observation remain runtime gaps. No app, audio,
recording, model or actual code-signature operation was run by these checks.
