# Granola import recovery check

10 November 2026. The owner confirmed sign-in and note listing work. A compact, content-free account diagnostic now establishes the detail structure: `meetings_data` contains `meeting` entries with metadata attributes and direct `private_notes` and `summary` fields. The parser supports that structure; a successful selected real-note import is still unconfirmed. A build or fictional import is not account-level acceptance.

The chooser now keeps failures inside its dialog, preserves the selection for retry, shows progress, and returns keyboard focus to the control that opened it. Closing, disconnecting, or replacing a pending import invalidates its late result in Rust. Cancellation discards results; an already-sent HTTP request may still finish. No import holds the notebook lock during network work. Granola selection stops at ten notes per request, matching the tool schema; twenty notes can be kept per session.

The design pass keeps the existing paper, evergreen, and terracotta interface. Rows separate titles from dates, show selection, and keep actions visible while the list scrolls. Focus stays in the notebook, is explicitly optional, and does not gate setup completion. Automatically prompting or filling it before a meeting remains a proposal; no model call or meeting detection was added.

These captures contain only fictional garden notes through a test-only native IPC replacement, at a 1320 × 880 browser viewport. They establish appearance, not a working provider connection or native accessibility.

| Before | After |
| --- | --- |
| ![Fictional note chooser before the refinement](assets/granola-chooser-before.png) | ![Fictional note chooser with selected rows and separate dates](assets/granola-chooser-after.png) |

Acceptance evidence: 206 Rust tests passed, including source retention after a failed fetch and invalidation after closing or replacing a chooser. Forty-four headless Chromium/WebKit tests covered the notebook and chooser, including visible failures, selected-note-only mock import, retry without relisting, late-result cancellation, ten-note bulk selection, keyboard operation, and long titles at a 600 × 700 viewport. Build, formatting, and Clippy passed. The Impeccable detector found no mechanical issues; rendered desktop, narrow, and error states were also inspected. Browser tests replace native IPC; they do not verify a real Granola response, native VoiceOver, or capture.

## Tagged detail mapping and headless checks

The detail parser reads only direct private-note and summary fields, labels them separately, decodes XML text references and CDATA, and preserves Markdown as plain text. Empty or unavailable private notes do not hide a summary. Provider notices, attendees, folders, attachments, nested meeting-shaped metadata, and unselected notes are excluded. Requests omit attachment and participant details when the discovered schema supports those arguments. There are no automatic follow-up reads.

Unknown nested content formats, malformed markup, custom entities and duplicate content fields fail explicitly. If any selected ID is absent (for example because of an inaccessible or size-omitted note), no partial selection is imported; the chooser can retry with fewer notes. Known fields with no text are counted as skipped by the store. Excerpts remain capped at 2,000 characters, with private notes before the summary when both exist. Reimporting a Granola note now replaces its copy only when the provider reports a newer `updated_at` timestamp. Repeated or older revisions leave the existing copy intact, including after reconnecting. RFC 3339 timestamps are compared as UTC milliseconds, independent of the meeting date and local clock. Missing, invalid, or pre-epoch timestamps stay unversioned: they can be imported initially but cannot overwrite a known newer copy; remove an unversioned copy first if it needs refreshing.

Acceptance evidence for the mapping: 211 Rust tests passed, including a local fictional MCP server returning the observed tagged structure through the actual import attempt and context store. The selected note arrives with the expected ID, title, date, provider and summary; unselected notes and metadata do not. Additional cases cover private notes plus summaries, unavailable/empty notes, Unicode/XML references, malformed and unknown formats, missing selections, and excerpt limits. Eight headless Chromium/WebKit chooser tests passed for retry, cancellation, keyboard/narrow layout and the selection limit. Browser tests replace native IPC; the Rust check exercises the parser and store but not the native webview command transport.

Repeat the checks without an account or a GUI:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib granola::tests
PLAYWRIGHT_PORT=1432 npm test -- tests/granola.spec.ts
```

The Rust tests use only a loopback fictional server and fictional credentials. The browser tests use a dedicated local port and test-only IPC replacement. Neither reads the running app's sign-in, a real account, microphone, or model. This makes parser regressions reproducible headlessly. A final account check still needs the signed-in native app.

Next acceptance check: after restarting the updated app, verify one selected real note appears with its source/date and no unselected notes. If it fails, the optional developer trace emits only a compact content-free outline. Do not copy real note text or screenshots into the repository. Imported context usefulness remains unvalidated; no TalkQTE user-outcome study has been completed.


## Refreshing an imported note

The adapter previously assigned revision `1` to every Granola note, so reimporting could never refresh it. The observed `updated_at` metadata now supplies the revision for tagged details and JSON detail responses (`updatedAt` is also accepted for JSON). Chrono parses the timestamp with timezone offsets; it was already in the dependency lockfile and is now a direct dependency with only its standard-library feature requested.

Headless acceptance uses a fictional MCP server and the actual connection/store path: a newer note replaces its existing copy, repeating it adds no duplicate, an older reply cannot roll it back, and the same instant with a different timezone offset is unchanged. Invalid or missing update times do not invent a version from the meeting date or request order. No extra provider requests, polling, retention, or account access are added. This source-contract check is independent of the outstanding first real-note import confirmation.
