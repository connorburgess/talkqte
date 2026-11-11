# Granola import recovery check

## Owner-observed native import and removal — 11 November 2026

The owner reports that adding a Granola note and removing it both succeeded in the native app. The development checkout was updated to `d269764` before the check. This establishes a successful basic account import/removal on one Mac, beyond the fictional parser and browser tests. It is an owner observation, not an instrumented account or privacy audit; no private note content, identifiers or screenshot is included here.

Sign-in, listing and requested Focus suggestions had already been observed. This new report does not independently verify displayed source/date accuracy, rejection of unselected provider content, newer/older reimport ordering, disconnect during a real request, or provider/OS retention. Those checks remain explicit integration acceptance work. It also supplies no live transcript input, writeback, meeting-usefulness or user-outcome evidence.

Next account check: deliberately reimport a known updated note, confirm its source/date and absence of duplicates, then verify disconnect/reconnect and failure recovery without retaining private content. Keep existing notebook operation available throughout. Native accessibility and participation/listening validation remain separate.

The dated development checkpoints below retain their original evidence scope. Their references to an unconfirmed first account import describe the state before this owner report.


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

## Privacy boundary checks

10 November 2026. An offline review found three gaps: delayed results could survive disconnect/reconnect, developer diagnostics printed raw tool schemas and arbitrary JSON keys, and removing a note did not clear an excerpt already displayed in a reminder. These are corrected independently of the pending real-account import check.

- **Disconnect and reconnect:** fictional MCP responses are held while the old connection is retired and a replacement opens. Listing, suggested focus, and selected-note fetches discard the old response; queued/retained connection copies send no later requests. Idle credentials are dropped immediately, and an in-flight call drops its credentials on completion. Disconnect never waits for that call and does not remove imported copies or revoke provider-side consent.
- **Diagnostics:** tests supply fictional private keys, identifiers, numeric values, tool descriptions, schema defaults, and deeply nested/wide replies. The projection retains only fixed structural names, type/length markers, and collection sizes within depth/node limits. The existing XML outline masks text and attributes. No provider response is logged verbatim.
- **Removal and export:** the engine regression removes the note quoted by an ordinary or held reminder while another imported note remains. Both cue snapshots clear, stale disclosure is rejected, unrelated questions/manual notes remain, and generated Markdown contains no imported excerpt or source ID. The native command publishes the changed cue state to both windows. The browser preview mirrors removal; Chromium/WebKit regressions remove one or all notes while a reminder is held and the demo is paused, then verify the excerpt disappears and stays out of export.
- **Existing boundaries reviewed:** tokens remain behind native commands; OAuth and provider errors use fixed messages; import/list/suggestion commands are available only to the notebook capability, not the companion; the generated export does not traverse the context store. No provider writeback or transcript-read call was added.

Acceptance: eight Chromium/WebKit import/removal checks, frontend build/formatting, and 217 Rust tests passed, including these regressions and the existing import-selection, retry, callback-state and context-store tests. All inputs and credentials were fictional. This is source review and headless regression evidence, not traffic inspection of a real account or native VoiceOver/cross-app validation. A request already sent may still finish; logical deletion does not promise memory zeroization or control over terminal, operating-system, browser or provider retention.

Remaining release checks: confirm one real selected-note import and removal in the native app, inspect an explicitly authorized account session's data flow without retaining content, and verify provider-side disconnect/retention expectations separately. Imported-context usefulness remains a separate human validation task.


## Disconnect while notes are loading

11 November 2026. The notebook previously disabled **Disconnect Granola** while a note listing was pending, even though the native connection already supported retirement without waiting for that request. A headless regression reproduced the disabled control before the fix.

Disconnect now stays available during listing. A short loading status names that option. After a successful disconnect, keyboard focus returns to **Connect Granola**, imported copies remain, and file import is available again. The old listing cannot reopen the chooser, report an obsolete error, or clear a replacement connection's loading state. A failed disconnect leaves the connection visible and offers an explicit retry. The native retirement and HTTP behavior are unchanged: a request already sent may finish, but its retired result is discarded.

UI/UX checkpoint: the task is to leave an optional provider wait and return to the conversation without losing selected prior context. The existing notebook appearance is preserved. Fictional native-IPC replacements cover a delayed success, delayed failure across reconnect, failed-disconnect retry, retained imports and keyboard focus. All 54 Granola/notebook checks passed in Chromium and WebKit; the narrower loading flow was checked at 600 × 700 with reduced motion, without horizontal overflow. The frontend build, formatting and mechanical design scan passed. The scan reported no findings; rendered states were also inspected.

These cropped browser captures use fictional garden notes at a 1320 × 880 viewport:

| Before: Disconnect disabled during listing | After: Disconnect available during listing |
| --- | --- |
| ![Fictional prior-context panel with every action disabled during listing](assets/granola-loading-before.png) | ![Fictional prior-context panel with Disconnect available and a loading explanation](assets/granola-loading-after.png) |

The [narrow rendering](assets/granola-loading-narrow.png) keeps the action and retained note readable. Browser checks do not establish native VoiceOver, real-account request behavior or usefulness during a meeting. The next integration acceptance gate remains a successful selected real-note import and removal in the updated native app; no account, capture or model was used for this change.

## Waiting for Focus suggestions

11 November 2026. **Suggest from Granola** previously used the notebook's shared busy state. A held fictional response reproduced that **Disconnect Granola** and **Try demo** were disabled until the assistant answered. The optional request now has its own loading and error state, leaving the notebook and Disconnect available. The request still asks the same fixed question only after an explicit action; no new native command, automatic request or provider access was added.

Disconnect clears unapplied suggestions and invalidates the pending UI result. Accepted or manually typed Focus lines remain. A reply from a retired connection cannot show an old suggestion or error, or clear a replacement request's loading state. The existing native connection retirement is unchanged: an HTTP request already sent may finish. This is not a remote cancellation guarantee.

The waiting button stays in the keyboard route with an unavailable state, and repeated activation sends no additional request. If keyboard focus remains there when an answer arrives, it moves into the suggestion group. A reply leaves another focused control alone. The user still chooses which lines to add; typing during the wait is preserved. Errors offer an explicit retry or manual Focus entry; an empty answer leaves existing Focus intact. Focus remains optional and is not a meeting prerequisite.

UI/UX checkpoint: the task is to request optional preparation without losing the ability to work or leave the connection. The paper/evergreen interface is preserved, with a named waiting state and a short recovery explanation. All 64 Granola, Focus-suggestion and notebook checks passed in Chromium and WebKit, including reconnect races, repeat activation, selected-only addition, empty/error recovery and keyboard focus. The 600 × 700 reduced-motion rendering has no horizontal overflow. Frontend build, formatting and the design scan passed; the scan returned no findings, and rendered states were inspected.

| Before: no pending explanation | After: named wait and recovery route |
| --- | --- |
| ![Fictional Focus panel waiting with a disabled suggestion button](assets/granola-focus-before.png) | ![Fictional Focus panel with an Asking Granola state and disconnect guidance](assets/granola-focus-after.png) |

The corresponding prior-context control is [disabled before](assets/granola-focus-connection-before.png) and [available after](assets/granola-focus-connection-after.png). The [narrow state](assets/granola-focus-narrow.png) and [retry state](assets/granola-focus-error.png) use fictional garden text. The desktop captures use a 1320 × 880 viewport.

Acceptance is limited to the actual React notebook with a fictional native IPC replacement. No account, capture, inference or VM run was used. Native VoiceOver, behavior alongside another application and real-account waits remain unverified. The next integration gate is still one selected real-note import and removal in the updated native app; a successful suggestion flow does not verify that separate capability or demonstrate useful participation.


## Connection status after sign-in or navigation

11 November 2026. A delayed fictional startup status reproduced a connection-control regression: after sign-in succeeded, an older disconnected reply replaced the current state and hid **Choose Granola notes**, **Disconnect Granola** and **Suggest from Granola**. The notebook and prior-context panel previously made separate startup status requests. A response from a prior notebook view could also change suggestion availability after navigating through Settings and disconnecting or reconnecting.

The prior-context panel now owns the status read and reports current connection results to the notebook. A startup success or failure is ignored after a newer connection result or after that panel closes. Returning to the notebook still reads the current connection; an initial read failure leaves explicit sign-in available. The empty-context guidance now tells a connected person to choose notes instead of asking them to connect again. No native authentication, provider request, retained-data or capture behavior changes.

The UI/UX task is to keep connection state, available actions and keyboard focus consistent while optional prior context is prepared. The existing paper/evergreen presentation and explicit connection flow are preserved. Fictional IPC tests cover late disconnected and failed replies, old views returning connected or failed replies after disconnect/reconnect, current status on remount, and recovery from an initial status failure. Keyboard focus remains on the current control, and Disconnect returns it to Connect Granola. The connected panel is also reviewed at 600 × 700 with reduced motion and no horizontal overflow.

| Before: an older reply hid the connected controls | After: current connection and Disconnect remain available |
| --- | --- |
| ![Fictional prior-context panel incorrectly asking to connect again](assets/granola-status-before.png) | ![Fictional prior-context panel retaining note selection and keyboard-focused Disconnect](assets/granola-status-after.png) |

These desktop crops use a 1320 × 880 browser viewport; the [narrow rendering](assets/granola-status-narrow.png) uses the same fictional IPC. All 12 new checks passed in Chromium and WebKit, plus 32 surrounding Granola/notebook checks in Chromium. The frontend build, formatting and source design scan passed; the scan reported no findings and the rendered crops were inspected. Existing local WebKit pointer-entry tests timed out before the test body; the same timeout was reproduced with unchanged app source from `60355d3`, so the surrounding local WebKit suite is not counted as passing. This is a reproduced browser boundary defect, not an observed real-account failure. Real selected-note import, native VoiceOver and cross-app behavior remain separate acceptance gates.
