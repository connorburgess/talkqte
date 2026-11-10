# Notebook processing permissions

Development acceptance, 11 November 2026. The main notebook and Settings now share native processing status with the existing capture controls. **No evaluator is registered in the normal app.** It shows **Processing unavailable**, explains that live cues still use local phrase rules, and offers no approval action. This change does not select a provider or enable inference.

## User task and boundaries

The task is to understand what would process the conversation, choose its sources, and retain independent control of capture. Focus, name and imported notes remain optional. The browser demo has no new processing controls. The companion receives no processor or prior-note metadata through this integration.

With a registered evaluator, the existing permission surface can review new speech alone or explicitly selected recent speech and prior notes. Confirmation names the processor/model, location, policy, and each selected note's source and date. Approval sends only the opaque native review ID; Pause/Resume and Disable use the originating session and scope revision. A changed source or session invalidates the review. A failed approval returns to source review because native IDs are single-use; retrying does not reuse a possibly consumed ID.

The notebook keeps one capture panel and one native status subscription. **Stop live session** remains callable while review, approval or Pause is pending, including in Settings. Pause and Disable leave capture on; Stop ends capture and revokes processing through its separate native authority. An acknowledgement alone never means the microphone is off. Source changes do not move keyboard focus out of another Settings field. Status failure blocks permission changes and provides one shared refresh control; mutations are never retried automatically.

A configured evaluator uses its native-supplied processing disclosure rather than the phrase-only transcript privacy copy. A concrete hosted adapter still requires review of its complete data path and retention policy before activation. No adapter, network/model request or account access was used for this acceptance.

## Headless acceptance and UI/UX checkpoint

`tests/notebook-processing.spec.ts` mounts the real App through `native-microphone.ts`, with fictional native permission replies. Nine scenarios pass Chromium and WebKit (18 checks):

- No evaluator: truthful availability, ordinary phrase cues, optional setup, Settings access and one Stop control.
- Hosted fictional confirmation: exact provider/ID/revision selection, dates, no implicit approval and review continuity across Settings.
- Pause/Resume and Disable leave capture on; Stop bypasses a held permission command.
- Cancel a pending review, restore keyboard focus and discard its late reply.
- Changed notes close the review without stealing focus from Settings.
- Failed approval hides private errors and requires a new review ID.
- Stop during approval prevents late activation after capture ends.
- Long note titles wrap at 390px; approval/cancel actions remain at least 48px high.
- Failed status refresh blocks permission changes until explicit recovery, while Stop remains available.

The nine existing notebook capture scenarios also pass both browsers. The full local suite before the final status-recovery case passed 220 checks with the same two pre-existing macOS WebKit focus failures in `processing.spec.ts` documented in [capture acceptance](notebook-capture-controls.md). The final focused capture/permission run passes 36 checks. Required repository CI must pass on the exact PR head before merge. Browser mocks prove wiring and visible behavior; [native review tests](native-processing-commands.md) separately cover authority.

Rendered comparison uses only fictional content, with reduced motion:

| Surface | Before at `a5c3aa6` | Current |
| --- | --- | --- |
| Desktop, 1320 × 880 | [Live notebook](assets/notebook-processing-before-1320.png) | [Unavailable processing](assets/notebook-processing-after-1320.png) |
| Narrow, 390 × 844 | [Live notebook](assets/notebook-processing-before-390.png) | [Unavailable processing](assets/notebook-processing-after-390.png) |

[Desktop review](assets/notebook-processing-review-1320.png) and [narrow review](assets/notebook-processing-review-390.png) show a **fictional** hosted evaluator in the actual notebook. It is not available in the app. Body text is 16px, review actions are 48px, source and policy text wrap without horizontal overflow, and the source design scan reports no findings. Capture and permission panels use separate spacing and one capture action. The live breadcrumb now identifies the live session rather than the demo.

**UI/UX checkpoint: passed for the fictional headless workflow.** This is not a finding about comprehension, listening, native VoiceOver, actual browser zoom, cross-app focus or device release. Native keyboard/permission/device checks remain open, as does whether permission details can be made simpler after a real processing path is chosen.

## Next readiness blocker

Choose and review a concrete processing path before any activation: quality and still-useful latency, privacy/retention, subscription limits, distribution terms and onboarding remain unresolved. The permission UI can express a decision; it cannot make that product decision.

Independently verify real macOS permission denial/cancellation, Stop and device release, transcript drain, companion focus and VoiceOver. Selected-note Granola account acceptance, supported-device budgets, signed installation/upgrades and the participation/listening comparison retain separate gates. A successful mock or developer build is not a supported release.
