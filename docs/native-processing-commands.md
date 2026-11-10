# Native processing command authority

> Follow-up: [Notebook capture controls](notebook-capture-controls.md) now expose Cancel start and guarded Stop in the app. References below to the missing Cancel UI describe this earlier acceptance boundary. Evaluator permission integration and native device checks remain open.

The main window can now prepare, approve and cancel an exact processing review, disable processing, and pause/resume approved cues through native commands. The normal app still registers no evaluator and does not mount the processing controls. This is a prerequisite for dependable user control, not activated inference or evidence of useful meeting assistance.

## Command boundary

`review_processing_scope`, `revoke_processing` and `set_processing_paused` require the originating snapshot's `session` and `scopeRevision`. Rust checks both against current engine identity, permission generation, complete available-note fingerprint and session/pause/Stop state under the Runtime lock. A source change is rejected even before its event reaches the webview. Engine replacement cannot reuse authority even if its numeric session happens to match. Capture status and ordinary clock updates do not invalidate an otherwise current scope.

Review input contains only conversation scope and selected provider/ID/revision values. Unknown fields, provider values and conversation options are rejected; the engine validates every selection, duplicate and source bound. The review response supplies trusted processor and selected-note metadata from that same native state, with no excerpts or credentials. The webview cannot supply a processor, destination or policy. `approve_processing_scope` takes only the opaque, single-use review ID; `cancel_processing_review` clears only its matching review. Invalid or replayed IDs cannot clear a newer review or grant.

Pause/Resume requires a current approval and leaves capture/transcription running. Disable clears the review and grant without stopping capture. Their native handlers are separate from the existing phrase-rule controls. Rejected changes publish current state for recovery; the UI refreshes failed control actions once without retrying mutations or silently approving a replacement scope. Errors use bounded codes, never raw provider messages.

Command permissions and runtime window checks restrict these operations to the main window. The companion receives neither processing metadata nor mutation permissions. No command constructs a worker, chooses a provider or opens a device.

## Acceptance and UI/UX checkpoint

Seven new fictional Rust checks cover exact metadata-only disclosure and explicit approval, all available-note changes before/after publication, newer grants and replacement engines, scoped Pause/Resume/Disable, Stop drain, malformed/replayed/cancelled inputs, and disclosure injection. The full Rust suite passes 289 tests. Fixtures use production Runtime methods with fake workers; they do not exercise a real webview or device.

The user task is to approve only the sources reviewed and keep control when the underlying session changes. The experience risk is a delayed action silently affecting a newer session or grant. All 24 headless Chromium checks in `tests/processing.spec.ts` pass, including three new checks for narrow command arguments and delayed Disable after source/session replacement. Existing checks retain keyboard focus/cancellation, narrow layouts, truthful capture warnings and failure recovery. **Checkpoint: pass for this native authority and fictional UI scope.** No layout or normal-app flow changed, so the existing [fictional screenshots](processing-controls.md#headless-evidence) remain representative.

These checks establish reproducible command behavior, not native accessibility, account/provider operation or user comprehension. No new capture, inference, retention or network behavior was exercised.

## Next dependency

The processing surface's Stop action now uses [operation/generation-bound capture Stop](scoped-capture-stop.md), including independent microphone monitoring and cancellable model startup. Its fictional acceptance is separate from the command counts above. The next step is integrating the UI with reachable Cancel start, then separately checking native focus, permission clarity and actual device release. Processing scope revision is deliberately not the authority for capture Stop.

Provider selection/activation, Granola selected-note account acceptance, signed installation and a comparison of participation plus listening remain independent release gates.
