# Scoped capture Stop

The main-window `stop_capture` command can cancel one live startup, stop its capture and finish its queued transcription, or stop independent microphone monitoring. It is bound to the operation the user saw. An unrelated note change does not prevent Stop, and an old request cannot cancel a replacement live start or release a newer microphone generation.

The notebook now uses this contract for [reachable Cancel start and independent Stop](notebook-capture-controls.md). Evaluator permission controls remain mounted only in the fictional browser fixture; neither this native boundary nor the capture integration activates a processor.

## Ownership and truthful status

`processing_snapshot` and main-window `processing:changed` now include `startup` and `stopTarget`. The target contains an opaque live-operation ID (or null before a live start) and an exact microphone-generation string. The operation survives the transition from model loading to a live session; a later explicit start replaces it. Capture authority is separate from the processing permission's session/scope revision.

Rust validates the target under the Runtime lock before cancelling a loader or taking a live session. Taking that session revokes processing before transcript drain. If the same startup has since reserved its microphone, Stop uses that session's owned generation. Independent monitoring uses the observed generation. The adapter checks the generation again after the asynchronous boundary, so delayed device work cannot release replacement capture. A stale request is rejected or becomes a harmless adapter no-op; the client refreshes status without retrying the mutation.

A nonblocking capture read retains its observed generation even when the device mutex is busy. Status remains unknown until it can be read. Stop requests and device cleanup run outside Runtime. Command acknowledgment never means that the microphone is off: status confirms release only after cleanup. A poisoned controller returns a bounded failure and remains unknown. Finishing transcription can continue after capture is off.

Model preparation is reported separately from microphone startup. A cancelled loader may finish its blocking work, but cannot install an engine or request capture. Its reservation prevents overlapping starts until it exits. The test-mounted UI offers **Cancel start**, then **Cancelling…**, while the microphone is off; **Stop capture** remains available for starting, running or unknown capture. Failure keeps current capture status visible and permits an explicit retry. No unscoped Stop fallback or implicit new processing approval is used.

## Acceptance and UI/UX checkpoint — 10 November 2026

The user task is to stop the operation currently shown, even while preparation is pending. The experience risk is confusing cue pause with microphone release, or allowing a delayed action to affect a new session.

Eight new fictional Rust tests exercise production ownership methods: a gated loader and explicit retry; installation/reservation and note changes; malformed and foreign targets; standalone monitoring; status revisions without permission changes; unknown status with generation ownership; deferred stream cleanup and late permission completion; and failed controller state. The existing review-drain test now exercises scoped Stop. The full Rust suite passes **297 tests**. Default and `local-whisper` Clippy checks pass. No model, device or provider was opened.

All **30 Chromium processing checks** pass with fictional IPC. Six added cases cover keyboard cancellation/focus recovery during loading, delayed Stop after source changes, replacement sessions and microphones, missing initial status, and startup finishing before Cancel is delivered. Earlier checks retain explicit error recovery, permission review and capture/drain distinctions.

Rendered synthetic states were inspected at 320 × 560, 1024 × 720 and 200% zoom: pending/cancelled startup and unknown capture remain readable without horizontal overflow; the existing focus ring and 48-pixel controls remain visible. A source design scan found no primary findings. **Checkpoint: pass for the native ownership boundary and fictional UI flow.** This is not a native accessibility or comprehension result; browser fixtures do not prove device release. CI must also pass the complete browser and platform jobs on the reviewed commit before merge.

Fictional visual evidence: [earlier Stop label](assets/processing-capture-unknown.png), [current Stop capture](assets/processing-stop-capture.png), and [Cancel start during preparation](assets/processing-cancel-start.png). These are browser fixtures, not desktop captures.

## Next acceptance boundary

The [notebook capture slice](notebook-capture-controls.md) now makes Cancel start reachable and keeps Stop independent of other busy actions. Next integrate evaluator permission review, pause and disable without duplicated capture controls, retaining optional Focus/setup and unavailable processing when no adapter is registered. Extend the full start/cancel/review/pause/disable/Stop/recovery flow headlessly before separately verifying native permission, focus, cross-window behavior and actual microphone release.

Provider activation, Granola account import, signed installation, resource measurement and participation/listening outcomes remain separate gates. The [processing acceptance sequence](processing-plan.md#acceptance-and-dependency-order) still applies.
