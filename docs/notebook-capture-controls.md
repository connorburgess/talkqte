# Notebook capture controls

The notebook offers **Cancel start** beside microphone status while a local speech model is preparing. It calls the native operation/generation-bound `stop_capture` command directly, outside the ordered notebook command queue. The existing queue still orders Start and note/demo edits. Once the native session is installed, **Stop live session** remains available during microphone permission and other pending notebook actions, including from Settings.

Cancellation prevents late preparation from opening capture. A blocking model load can still finish; the interface says to wait before trying again. The native startup state determines when cancellation is available. A Stop acknowledgement does not set microphone status to Off. The microphone observer confirms release, and the native processing phase separately reports remaining transcript drain. Independent microphone monitoring keeps its existing controls and label. Cue pause continues to leave the microphone and transcript running.

The status listener subscribes before fetching its first snapshot and ignores older revisions. Stop uses the target already displayed; rejection refreshes status but never automatically stops a replacement operation. Missing status offers **Refresh capture status**, without an unscoped Stop fallback. No adapter is registered or processing permission granted by this UI.

## Acceptance and UI/UX checkpoint — 10 November 2026

The task is to cancel preparation or stop the current capture without waiting for unrelated notebook work. The main interaction risk is confusing cue pause, model cancellation, microphone release and transcript drain.

Nine actual-app scenarios in `tests/notebook-capture.spec.ts` run through the existing native IPC fixture, with no microphone, model, provider or account access:

- Held Start remains cancellable; late completion cannot start capture; explicit retry works and keyboard focus returns to Start.
- Stop stays available in Settings during a pending name update; acknowledgement alone does not report Off.
- A late initial status cannot replace a newer startup or its Stop target.
- A stale Stop cannot stop a replacement operation; retry needs another click.
- Failed cancellation is retryable and a genuine model failure is still reported.
- Controls fit 390px and 1320px layouts; completion does not take keyboard focus back from Settings.
- Stop bypasses Start while microphone permission is pending and does not return to a misleading preparation state.
- Missing status recovers explicitly without legacy unscoped commands.
- Independent microphone cleanup is not relabelled as a live session.

Both Chromium and WebKit pass these scenarios. The full local browser run passed 204 checks; two existing WebKit keyboard-focus checks in the separate processing fixture failed, and both failures reproduced on unchanged base `43f6338`. All 17 existing Chromium microphone/companion checks pass. Exact-head repository checks remain required before merge. The fictional native ownership tests described in [scoped Stop](scoped-capture-stop.md) verify the Rust boundary; browser mocks alone cannot prove device release.

Compared the [previous notebook](assets/notebook-start-before.png) at base `43f6338`, with a synthetic held Start in its IPC fixture, against rendered [preparation](assets/notebook-cancel-start.png), [narrow cancellation](assets/notebook-cancelling-narrow.png) and [Stop in Settings](assets/notebook-stop-settings.png) were inspected. Controls use the existing 48px targets and focus ring. The narrow setup heading no longer floats into its checklist, and a preparing live session no longer shows the demo duration. Focus stays optional. The source design scan reports no findings. **UI/UX checkpoint: pass for this fictional capture-control flow**, not a native accessibility, comprehension, browser-zoom or meeting-use result. Native zoom and full accessibility acceptance remain unverified.

## Remaining acceptance

Integrate evaluator permission review, pause and disable into the notebook with unavailable processing when no adapter is registered. Keep this capture path independent, and test the complete flow before selecting or activating any concrete evaluator.

Separately check real macOS model preparation, permission cancellation, microphone release, queued transcript drain, device failure, app shutdown and cross-window focus. Keep Granola selected-note account import, signed installation/upgrades, device resource budgets and useful participation with preserved listening as independent release gates. This developer change is not a released or production-verified capability.
