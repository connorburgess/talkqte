# Owned-player first recording integration

This internal integration uses approved fictional media: the saved 102.48-second
meeting or a per-run scenario pinned by a reviewed manifest. It
adds no generation, synthesis, adaptive append or forced cue. Runtime remains a
separately coordinated action with concrete signed receipts and a reviewed plan.
The source policy dependency is the native fixed-player implementation; the JS
join requires the same exact v1 source session as authenticated hello/calibration
for a later model-enabled run.

## Shared identity and preparation

Allocate one unique run ID before constructing the player. Prepare the approved
player and exact media before constructing the native launcher. Preparation is
idempotent only for this same file/hash; it is not playback. Pass this same run ID
to the capture-only or prepared model driver. There is no second run/cap created
when the player becomes ready. Production clock support is pinned to macOS,
Node 22.23.2 and libuv 1.51.0; other runtime versions fail before player launch.

The trusted player adapter brands its prepared identity only after validating the
approved bundle receipt and matching owned child protocol. `checkLabPlayerSource`
repeats the signature/hash checks and refuses stopped/failed/exited ownership.
The native launcher consumes only that identity and freezes the exact player PID,
positive canonical start seconds, microseconds, canonical executable and distinct
application name. Native independently checks its own process and SCK association;
the JS receipt is not a substitute for those checks.

The launcher and recorder expose their frozen prepared player-source capability.
The driver requires this same identity object as the player it actually starts,
both at construction and immediately before native launch. Matching only a run
ID cannot join different player processes. Historical Listening must name the
fixed player application as well as the expected session.

The v1 source observer accepts only explicitly configured QuickTime or TalkQTE Lab
Player application identity. The recorder binds the player PID/window ID and the
same owned native process. `createLabOwnedWindowSelector` invokes the dedicated
helper's strict listing mode with exactly those two PIDs before any titles are
emitted. It accepts only the already-known player window and one exact visible
`TalkQTE companion` window on the controlled native PID. Missing, hidden,
duplicate, changed or foreign windows fail without fuzzy selection or retry.
The helper preserves its existing permissive listing/capture modes when strict
mode is absent.

## Capture-only first validation

`createLabCaptureTake` constructs no provider or broker. Its native owner and
launcher use explicit `mode: 'capture-only'`, reject model metadata, and omit model
connection, call cap, backend, provider and descriptor settings entirely. This is
absence, not an unsupported connection-off value. A deterministic phrase cue, if
present, is not model evidence; its origin must be retained in measurements.

Prepare player -> native armed -> exact source/session observation -> strict
recorder frame accepted -> one Start -> measured actual render acknowledgement ->
full natural completion -> independent cleanup. Recorder readiness has a maximum
three-second budget. At Start request the driver checks the remaining source
110-second guard from a conservative time before native spawn, including all
elapsed readiness, a bounded start budget, full media and completion reserve. The player
start deadline must fit that configured budget (one second for the first-take
plan); a longer player deadline is rejected before take construction.
It checks viability again against the actual render anchor and uncertainty.
A late start is stopped; it is never relabeled successful or restarted.
Readonly `take.guard`, optional `onGuard` and the final result expose frozen numeric
request/actual-anchor receipts: conservative native start, source deadline, Start
request, start budget, full media duration, completion reserve, remaining time and
actual anchor uncertainty. The callback contains no text and must remain bounded;
its failure stops the take. These values belong in the private run manifest.

Capture-only has no evaluator calibration and admits zero CLI dispatches. The
measured player mapping still must satisfy its own clock bound. Native transcript
arrival, phrase decisions, recorded frames/audio and cleanup are the acceptance
subjects. SIGINT/SIGTERM and external/root/source/player/recorder failure request
ordinary Stop through the same once-only ownership path.

## Model-enabled follow-up

The existing prepared driver can take the same preallocated authoritative run ID.
Use an explicitly selected provider/model/effort and agreed shared attempt cap in a
fresh run, never a fallback/reset/resume. It installs expected source session
before play, keeps terminal observation after readiness and joins lazy native
hello/calibration before model admission. Playing speech is not paused to force
freshness. Model output counts, correct quiet and human usefulness are separate
measurements, with no forced Show outcome.

## Stop and evidence limits

Both paths Stop audio/video while retaining the exact player process/window.
Native source release, provider cleanup where present, recorder completed-file
finalization and player engine Stop are independent requirements. Only confirmed
native release plus recorder finalization permit final player retirement. Missing
release retains the player process and reports failed cleanup; it does not kill
it and call that native release. An actual unresolved run requires owner
intervention. Constructor failure before ownership transfer leaves prepared
resources with the caller for explicit cleanup.

Stand-ins test zero-model settings, exact IDs, guard expiry before/at actual Start,
source/recorder/retirement failures, process Stop and once-only cleanup. Swift
strict-listing compilation is not device validation. Remaining setup includes
approved native/player/helper receipts, exact companion visibility/permission
observation, a thin reviewed execution plan (see the
[prepared take runbook](lab-take-runbook.md)) and bounded private causal evidence
writer. No app, player, audio, model or capture run is established by these tests.

A failed listing parent close does not end process-group ownership: the bounded
TERM/KILL path remains armed until the exact group is absent. A synchronous Stop
exception also cannot skip independent native/player/recorder cleanup or listener
removal. Either case retains failed-cleanup outcome rather than promoting parent
exit to success.
