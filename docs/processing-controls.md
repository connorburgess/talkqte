# Fictional processing-control acceptance

The proposed cue-processing controls now have a reusable React component and a typed IPC client. They are mounted only by `tests/fixtures/native-processing.tsx`, which replaces the application entry point during browser tests. The normal notebook and desktop app do not expose these controls or start an evaluator. No microphone, model, sign-in, or provider request runs in this fixture.

This checks the permission flow before activating a provider. It does not establish that people understand the flow, that native assistive technology works, or that evaluated cues help a conversation. The existing notebook style and optional Focus controls are preserved.

## Behavior exercised

- Processing starts off. Neither importing a note nor opening a review approves it. New speech after approval is the default; recent speech and each prior note require explicit selection.
- Confirmation names the registered processor/model, processing location, conversation scope, exact selected notes and data policy. Notes retain provider, ID and revision in the proposed command, plus title and date in the display. File and Granola notes with the same ID remain separate.
- Approval submits an opaque review ID. A changed session, permission/scope revision or returned selection closes or rejects the review. Cancel clears the draft and restores keyboard focus. Late preparation replies are discarded and their review IDs cancelled.
- Pause cues and Disable processing leave capture visibly on. Stop remains independently callable while preparation or approval is pending. It shows a stopping state until capture is confirmed off. Failed Stop preserves the capture warning and allows an explicit retry.
- Quiet is distinct from unavailable. Authentication, allowance, rate-limit, worker and oversized-input failures have bounded messages; raw provider errors are not rendered. The UI never retries approval or processing automatically and never switches processors. Recovery uses an explicit new review.
- Snapshot revisions are monotonic across sessions. Old events or an initial snapshot arriving after Stop cannot restore an earlier state. A failed action triggers one status refresh, not another action.

## Headless evidence

`tests/processing.spec.ts` covers these behaviors with fictional IPC. All 30 Chromium checks passed on 10 November 2026, including keyboard cancellation and focus, delayed approval and Pause/Resume after Stop/new session, source revision changes, rejected scope, missing processor, empty and oversized context, failure recovery, and a long source title at a 320 × 560 viewport with reduced motion. Capture checks cover starting/unknown capture with Stop available and capture off while the session finishes. Command checks verify originating session/scope arguments and delayed Disable after source/session replacement. Six additional [scoped Stop checks](scoped-capture-stop.md) cover model-start cancellation, changed sources, replacement capture/session, missing status and startup completion before delivery. The layout has no horizontal overflow and its buttons remain at least 48 pixels high; pending/cancelled startup and unknown capture also passed a rendered narrow/200%-zoom review.

Run the scoped checks with a free local port:

```sh
PLAYWRIGHT_PORT=1440 npm test -- tests/processing.spec.ts --project=chromium
```

A local macOS WebKit run encountered `html` intercepting pointer events and an initial keyboard-focus failure, also seen in earlier browser checks. That run was stopped; it is not a pass. The pull request must pass the complete browser suite in CI, including WebKit, before merging. Native VoiceOver, cross-app focus and comprehension remain separate acceptance checks.

The screenshots use only fictional content. They show the test harness, not an activated app integration; older Stop labels now read “Stop capture,” with “Cancel start” during model preparation:

- [Source selection, desktop](assets/processing-sources-desktop.png)
- [Hosted confirmation, narrow layout](assets/processing-review-narrow.png)
- [Unavailable processor with capture still on](assets/processing-unavailable-narrow.png) (earlier copy)
- [Unknown capture with Stop available](assets/processing-capture-unknown.png)
- [Capture off while the session finishes](assets/processing-session-drain.png)

## Next integration blocker

The read-only `processing_snapshot` command and main-window `processing:changed` event have a [native implementation](native-processing-status.md). Review/approval/cancellation and session/scope-bound Disable/Pause/Resume have [native handlers and fictional acceptance](native-processing-commands.md). Capture Stop now has [operation/generation guards](scoped-capture-stop.md), including pending model startup and independent monitoring. Browser tests still use fictional IPC. Before activating evaluated cues in the app:

1. Integrate the guarded commands and native events without weakening exact source/processor review. Make Cancel start reachable while the notebook's Start command is pending. Preserve explicit cancellation and bounded errors; no frontend cancellation alone revokes a native grant. Verify the complete start/review/pause/disable/Stop/recovery flow headlessly and in the native target environment.
2. Review the complete concrete adapter and app integration, including existing microphone/privacy copy, before any separately authorized trial. A hosted processor must not coexist with a claim that its submitted transcript stays on-device. Confirm adapter availability and policy before showing an approval flow.

Continue the [processing acceptance sequence](processing-plan.md#acceptance-and-dependency-order). The native controller and fake-adapter checks are independently actionable; provider activation and any new inference remain separate decisions.
