# Focus save recovery

Development acceptance, 11 November 2026. The optional Focus lines influence the existing phrase-based cues. This change keeps later submissions from being lost while an earlier save is pending. Focus remains in memory until quit; the cue rules, native commands, capture and connection permissions are unchanged.

## Behavior

Leaving the field submits its trimmed, nonblank lines through the existing command queue. A different submission joins the queue while an earlier one is pending. Repeated blurs of the same pending value do not duplicate it. Removing all lines or returning to the previously applied Focus still takes effect after an older pending save.

Clear and accepted Granola suggestions share this save path. Clear discards the current draft without submitting it again. An accepted suggestion cannot overwrite text edited while its save was pending or take keyboard focus back from another control. Suggestions still require explicit selection and acceptance; they do not silently become notes.

Delayed replies preserve newer drafts. A rejected latest submission stays editable and shows an inline message associated with the field, with instructions to edit and leave the field again or Clear. A successful retry clears it. Superseded failures cannot leave a stale error after a newer save succeeds. No reply starts capture.

## Acceptance and UI/UX checkpoint

The original regression was reproduced at `3a5dee6`: submit fictional “Garden access,” hold its response, submit “Newsletter launch,” then release the first save. The field showed Newsletter launch, but the backing fixture still held Garden access. After this fix, both show Newsletter launch. The screenshots look the same because the original failure was a hidden mismatch; the assertion against the fixture's applied state establishes the difference.

`tests/focus-save.spec.ts` mounts the actual React notebook with fictional native replies. Eleven scenarios pass in Chromium and WebKit (22 checks):

- Later submissions survive an earlier pending save; equivalent pending values are deduplicated.
- Delayed success and rejection preserve a newer unsubmitted draft and its keyboard focus.
- A later valid save supersedes an older rejection without leaving an error.
- Emptying the field and returning to an earlier value survive pending saves.
- Clear follows a pending rejection without resubmitting the discarded draft.
- A rejected latest submission remains editable, preserves focus elsewhere, and recovers on retry.
- An accepted suggestion cannot replace a newer typed submission or steal focus from another control. Resubmitting the unchanged draft while acceptance is pending also wins over the delayed suggestion.

The surrounding Focus, name, notebook, Granola listing and suggestion checks pass in Chromium (50 checks). The frontend build, formatting and source design scan pass. These tests use no real account or inference.

| Fictional state                                                                 | Evidence                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------- |
| Before: visible Newsletter launch while the fixture still applies Garden access | [Before](assets/focus-save-before.png)             |
| After: visible and applied Newsletter launch agree                              | [After](assets/focus-save-after.png)               |
| Rejected latest submission at 600 × 700 with reduced motion                     | [Inline recovery](assets/focus-save-error-600.png) |

The rendered desktop and narrow states were inspected. Existing typography and spacing are retained, the error wraps without horizontal overflow, and keyboard focus stays where the user moved it. This is a browser UI/UX checkpoint, not native VoiceOver or cross-app acceptance.

## Remaining dependency

Confirm native/live phrase-rule behavior and compare useful participation and listening comprehension before claiming benefit. Successful selected-note Granola import, native permission and device release, distribution and resource budgets retain separate gates. No native build, account access, recording, model download or inference was used in these local checks.
