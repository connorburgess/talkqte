# Development selected-source observation

An armed development QuickTime or [identity-pinned owned player](development-owned-player-source.md) source run can emit versioned, content-free
identity observations on its existing private timing channel. This is a narrow
addition to the [owned-process Stop handshake](development-lab-evaluator.md#stop-for-an-owned-development-process),
not a new Start/control interface. It requires the same macOS debug,
`native-audio-spike`, `lab-evaluator`, timing channel, exact source and finite
ordinary Stop guard. No additional environment setting enables it.

This implementation has deterministic tests for offline execution. Native/device
validation remains pending. Ordinary builds and non-opted-in source launches
retain the legacy behavior. The versioned client and its source/session-to-broker
join are separate integration dependencies; an older subscriber must not infer
identity from the legacy `dev_source.started` event.

## Version 1

```json
{
  "event": "dev_source_observation",
  "version": 1,
  "run_id": "fictional-run",
  "step": "listening",
  "application": "QuickTime Player",
  "host_operation": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "live_operation": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "session": "1"
}
```

`step` is `listening` or `retired`. Run identity is the validated frozen armed run;
no environment reread occurs. Host operation is the 32-character lowercase opaque
review/capture operation. Live operation is the different 64-character lowercase
live-start operation. Session is a canonical positive decimal u64 string, including
values beyond JavaScript's safe-integer range. No PID, native selection identifier,
path, nonce, provider input, audio, transcript or cue text is included.

The setting-launched host captures one candidate from the exact active operation,
Control and cached Listening view under its own lock. It releases that lock before
Runtime. There is one nonblocking Runtime acquisition and one nonblocking StartGate
identity/phase read. A busy or poisoned lock refuses the observation. The dedicated
guard does not call the existing blocking startup/source helpers or advance time.

The guard joins the running Live, Attached source and SourceSession to the same
engine session, live-start operation and candidate Control. It requires settled
startup, no stopping/cancellation, no microphone or runner, and no existing
binding. The exact tuple is recorded on that attachment and queued under Runtime.
A failed association requests ordinary selected-source Stop; the independent
finite timed-Stop path remains in place. Nothing retries or broadens the source.

Dropping the exact bound attachment queues `retired` with that same tuple before
canceling its Control. Explicit retirement, sync/reconciliation, replacement and
Runtime destruction use the same drop path. A retirement that wins before the
guard prevents a later binding; the attachment cannot publish a second Listening
observation. Retirement means processing eligibility ended, not that native device
or transcription cleanup was released. `dev_stop.released` retains its separate
completion requirements.

## Historical evidence and consumer obligations

The observation describes the successful guard, not atomic current readiness at
delivery. A host cancellation or raw signal can win immediately afterward; the
file can be delayed, lose events or fail. A consumer's root Stop/end/replacement
always dominates later observations. Missing, dropped, malformed, wrong-version,
wrong-run/application, different-tuple, repeated or out-of-order evidence must
fail readiness. A retired tuple cannot be repaired, rebound or used as release.

The orchestrator must retain its terminal subscription through the entire take,
check matching build/session metadata, set the expected source session before
playback/lazy authentication, and require the authenticated broker/calibration to
name that same session. Actual player-start acknowledgement is independent.
Listening comes before playback; speech can then trigger the lazy hello and
bounded clock calibration. Waiting for that hello before speech would deadlock
startup. The JavaScript expected-session/join adapter is separate work; this
native event does not supply it automatically.

The next acceptance check is combined-feature compilation/tests and review of
this exact implementation, followed by the separately reviewed consumer join.
Actual selected-source audio, permission behavior, physical clock alignment,
provider cleanup, native release and companion paint still require the approved
fictional integrated run. No app/model/capture run is established here.
