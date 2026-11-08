# Privacy design

TalkQTE is not implemented yet. This document defines intended behavior and acceptance criteria, not an assurance about a released product.

## Core requirements

- Capture begins only after an explicit action. Show whether the microphone, system audio, or both are active.
- Provide a visible pause/stop control and an accessible shortcut. Stopping capture releases the devices.
- Transcription runs locally with Whisper. No account, cloud transcription, telemetry, or automatic upload is needed for the initial version.
- Keep model files and personal data in application-managed storage outside the checkout. The frontend receives only the data it needs.
- Raw audio is held in a bounded memory buffer and not written to disk by default. Debugging must not silently create recordings or dump transcripts into logs.
- Sharing is explicit: show the destination and the exact content being exported. Integrations are off until enabled and scoped by the user.
- No private meeting data belongs in the public development repository, review services, demos, or CI artifacts.

Local processing does not make data inaccessible to the device owner, an administrator, malware, or backups. Do not describe local storage as encrypted until encryption is implemented and tested. Plan for protected storage and OS keychain-managed keys before recommending TalkQTE for sensitive meetings.

## Proposed retention defaults

These defaults remain open to product feedback:

| Data | Proposed default |
| --- | --- |
| Raw audio | Memory only; discard after transcription |
| Full transcripts | Delete after 30 days; offer session-only, 7 days, 30 days, and keep until deleted |
| Explicitly saved notes, decisions, and questions | Keep until the user deletes them |
| Temporary analysis and search indexes | Follow the retention of their source data |
| External exports | User-controlled copies; local deletion cannot revoke them |

Show a transcript's expiry before a meeting starts. Keeping notes must not silently keep the entire transcript. If a saved note contains a selected quote, make clear that the quote is retained with the note.

Expired data must be unavailable to search, prompts, exports, and integrations, even before physical cleanup runs. Run cleanup at startup and periodically while the app is open. Do not claim that deletion has erased copies in OS backups or existing exports.

A private-session option should discard its transcript and temporary analysis when the session ends, retaining only items the user explicitly saves. Deletion must cover indexes, temporary files, cached snippets, and derived data.

## Screen sharing

Provide a quick hide-overlay action. Investigate capture-exclusion support, but do not promise an invisible overlay on every meeting app or capture method. Test full-screen sharing and window sharing separately.

## Optional integrations

Begin with user-initiated Markdown/text export. Future calendar access should be read-only and calendar-scoped. Any future MCP interface should expose only user-selected meetings and tools. Sending notes to an external model or service changes where those notes are processed and must be disclosed before connection.
