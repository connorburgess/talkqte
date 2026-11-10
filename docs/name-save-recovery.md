# Session name save recovery

Development acceptance, 11 November 2026. The optional name in Settings controls the existing phrase-based **Asked you** cues. This change keeps edits and the applied name consistent when a save is delayed. It does not change cue rules, capture, persistence or processing permissions.

## Behavior

Pressing Enter or leaving the field submits the trimmed name. A different submission joins the existing command queue even when an earlier save is pending; Enter followed by blur does not send the same pending name twice. Clearing the field removes the name, including while another save is pending.

A delayed response cannot overwrite a newer draft. If the latest submitted name is rejected and its draft has not changed, the field returns to the last successfully saved name. A newer draft remains editable. Rejections appear beside the field with a recovery instruction; a successful retry clears the error. A rejection from a superseded submission cannot leave an error after the newer submission succeeds. Replies do not move keyboard focus or start capture. The name still lives only in memory until quit.

## Acceptance and UI/UX checkpoint

The original regression was reproduced at `7d3dc4b`: submit fictional Robin, type Alex while the save is held, then release it. The field reverted to Robin. The same test preserves Alex after this fix.

`tests/name-save.spec.ts` mounts the actual React notebook with fictional native replies. Seven scenarios pass in Chromium and WebKit (14 checks):

- Delayed success and failure preserve a newer unsubmitted draft and its focus.
- New submissions follow either a successful or rejected older save, without a duplicate Enter/blur command or stale error.
- A rejected latest submission returns to the last successful queued name; a subsequent valid edit clears the error.
- Clearing the name and returning to the previously saved name both survive an older pending save.

The surrounding name, microphone, notebook capture and notebook checks also pass in Chromium (53 checks). The frontend build, formatting and source design scan pass.

The 600 × 700 reduced-motion case checks no horizontal overflow and preserves focus outside the field on rejection. The rendered error is associated with the field and marked as an alert. The existing type, spacing and colors are retained, with the error constrained to the field's width.

| Fictional state                              | Evidence                                                         |
| -------------------------------------------- | ---------------------------------------------------------------- |
| Before: old reply replaces Alex with Robin   | [Name field before](assets/name-save-before.png)                 |
| After: Alex stays editable after Robin saves | [Name field after](assets/name-save-after.png)                   |
| Rejected latest submission, 600px viewport   | [Inline error and retained name](assets/name-save-error-600.png) |

These are cropped browser screenshots with synthetic names. The UI/UX checkpoint covers the rendered field, keyboard continuity and error recovery; it is not native VoiceOver, cross-app focus, a real-device check or evidence of improved participation.

## Remaining dependency

The direct-address roadmap items remain open. Verify how the session name and phrase rules behave with actual transcription, and compare useful participation and listening comprehension before claiming benefit. Native permission/device release, selected-note Granola import, signed distribution and resource budgets retain their separate acceptance gates. No account, capture or inference run was used for these checks.
