# Granola import recovery check

10 November 2026. The owner confirmed the note listing now works. Importing a selected real note remains blocked by an unmapped tagged detail response; the supplied diagnostic ended in the first meeting’s attributes before the note fields. A build or mocked import is not evidence that the account import works.

The chooser now keeps failures inside its dialog, preserves the selection for retry, shows progress, and returns keyboard focus to the control that opened it. Closing, disconnecting, or replacing a pending import invalidates its late result in Rust. Cancellation discards results; an already-sent HTTP request may still finish. No import holds the notebook lock during network work. Granola selection stops at ten notes per request, matching the tool schema; twenty notes can be kept per session.

The design pass keeps the existing paper, evergreen, and terracotta interface. Rows separate titles from dates, show selection, and keep actions visible while the list scrolls. Focus stays in the notebook, is explicitly optional, and does not gate setup completion. Automatically prompting or filling it before a meeting remains a proposal; no model call or meeting detection was added.

These captures contain only fictional garden notes through a test-only native IPC replacement, at a 1320 × 880 browser viewport. They establish appearance, not a working provider connection or native accessibility.

| Before | After |
| --- | --- |
| ![Fictional note chooser before the refinement](assets/granola-chooser-before.png) | ![Fictional note chooser with selected rows and separate dates](assets/granola-chooser-after.png) |

Acceptance evidence: 206 Rust tests passed, including source retention after a failed fetch and invalidation after closing or replacing a chooser. Forty-four headless Chromium/WebKit tests covered the notebook and chooser, including visible failures, selected-note-only mock import, retry without relisting, late-result cancellation, ten-note bulk selection, keyboard operation, and long titles at a 600 × 700 viewport. Build, formatting, and Clippy passed. The Impeccable detector found no mechanical issues; rendered desktop, narrow, and error states were also inspected. Browser tests replace native IPC; they do not verify a real Granola response, native VoiceOver, or capture.

Next dependency: use the updated content-free tag outline to establish the detail fields, add fictional parser fixtures matching those fields, then verify one selected real note imports with its source/date and no unselected notes. The outline omits prose and all attribute values, so provider notices cannot crowd out the field names. Do not copy real note text or screenshots into the repository. Imported context usefulness remains unvalidated; no TalkQTE user-outcome study has been completed.
