# Privacy design

TalkQTE is an early desktop prototype with an optional microphone activity check and, in developer builds, an optional local live session. It is not a released meeting recorder. Current behavior and future requirements are separated below.

## Current prototype

- The demo plays bundled fictional dialogue and generates questions only from that text. It does not use microphone audio. There is no system-audio capture, bundled Whisper model, cloud model connection, account system, or telemetry integration. A speech model is downloaded only on request, as described below.
- The macOS app can separately monitor activity from the default microphone after an explicit start action and operating-system permission. It processes samples only to produce a coarse quiet/active indicator. Samples are not retained, recorded, logged, uploaded, or sent to the interface. It detects signal level, not speech, meeting participation, or the other side of a call.
- Monitoring starts off. Stop releases the input device on a worker, with a stopping state until release finishes; restarting is blocked during cleanup. A pending permission result cannot restart a cancelled session. Monitoring does not automatically restart or switch devices after an error. Pausing or ending the demo and hiding the companion do not stop microphone monitoring; only a live session's own microphone use ends with the session. Use Stop microphone or quit the app.
- In builds with the `local-whisper` feature, Settings offers an optional speech model download. It starts only when you choose it, after showing the model's size and source. It makes HTTPS file requests to the whisper.cpp repository on Hugging Face, which may redirect to its download network, and resumes with further requests if a connection drops. Those hosts see your IP address and a `TalkQTE` user agent; no account, audio, transcript, or notes are sent. The file is kept in the app's data folder, installed only after its SHA-256 matches the value pinned in the app, and deleted by Remove model. Partial downloads are deleted on Cancel, on failure, and at the next launch.
- A live session exists only in builds with the `local-whisper` feature and an installed speech model. It starts only when you choose **Start live session** and the operating system grants microphone access. Microphone samples pass through a bounded in-memory buffer to a speech model running in the app process on this device; they are not written to disk, logged, or sent anywhere, and are discarded once transcribed. The recognized text feeds the same phrase-based questions as the demo. It stays in memory until you start another session or quit, and export is refused for a live session. Stop, in either window, releases the microphone, transcribes the last queued seconds, and ends the session; the session also ends if microphone access is refused or the device fails. Quitting discards queued audio. Both windows see the live cue and its source line; the companion can stop the session but not start it. Other apps' audio is not captured.
- The optional name in Settings is kept in process memory for the session, is not sent to the companion window, and is cleared when the app quits.
- Prior notes you import from a file you choose are read once into memory while you choose, and released when you import, cancel, or close the chooser; only the notes you tick are kept, for this session, beside the notebook and labeled as not from the conversation. Remove deletes a note at once. They are never exported, written anywhere, or sent, and nothing reads a file you did not pick.
- The transcript and your notes live in process memory. Dismissed or expired questions are let go; nothing keeps them as notes or action items. Ending or replaying the demo, and switching between the demo and a live session, keep notes. Quitting the app clears everything. There is no database, recovery, retention scheduler, or encrypted notebook.
- A Markdown export is the only implemented persistence. You review the generated text, then choose the file destination in a native save dialog. The saved file contains exactly that preview, even if the demo advances while the dialog is open. The destination may be a folder synchronized by other software; exported files are outside TalkQTE's control.
- The floating window receives only the current question, its source excerpt, and the state needed to display it. It cannot invoke note editing or export commands.
- Both windows receive microphone status and coarse activity, without samples, device names, or precise levels. Only the main window can start monitoring; the companion can stop it. The browser preview never requests microphone permission.
- The app has no automatic upload feature. The development server uses loopback connections, and installing dependencies requires network access. The browser preview downloads exports through the browser and is not a separate production service.

Do not use this prototype for real or sensitive meeting data. Closing the app loses unsaved notes, and there is no implemented storage protection beyond the operating system's process boundaries. Real-device microphone operation, permission prompts, and disconnect behavior still need explicit native testing; synthetic tests do not prove those platform behaviors.

## Optional fictional development lab

The [Claude cue lab](docs/claude-cue-lab.md) is a separate, explicitly invoked development script. A selected bundled fictional scenario is sent to Claude through the user's subscription; this is hosted processing. It has no microphone, live transcript, arbitrary-file input, or connection to the desktop engine. Listing cases and offline tests do not invoke a model.

The runner disables tools, customizations, MCP connections, and session persistence, uses a temporary working directory, and prints a filtered report to stdout. It does not store a meeting archive or extract credentials. These controls do not establish zero provider retention or prevent all CLI diagnostic/account state. Review the CLI and provider settings independently before any future work with real content. No such input path is implemented here.

## Requirements for meeting capture

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

| Data                                             | Proposed default                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Raw audio                                        | Memory only; discard after transcription                                          |
| Full transcripts                                 | Delete after 30 days; offer session-only, 7 days, 30 days, and keep until deleted |
| Explicitly saved notes, decisions, and questions | Keep until the user deletes them                                                  |
| Temporary analysis and search indexes            | Follow the retention of their source data                                         |
| External exports                                 | User-controlled copies; local deletion cannot revoke them                         |

Show a transcript's expiry before a meeting starts. Keeping notes must not silently keep the entire transcript. If a saved note contains a selected quote, make clear that the quote is retained with the note.

Expired data must be unavailable to search, prompts, exports, and integrations, even before physical cleanup runs. Run cleanup at startup and periodically while the app is open. Do not claim that deletion has erased copies in OS backups or existing exports.

A private-session option should discard its transcript and temporary analysis when the session ends, retaining only items the user explicitly saves. Deletion must cover indexes, temporary files, cached snippets, and derived data.

## Screen sharing

The desktop settings include a floating-window toggle. Pausing the demo collapses the question into a compact paused companion; ending the demo or choosing Hide removes the companion. Capture exclusion is not implemented. Do not assume the overlay is invisible to screen sharing. Cross-app focus, Spaces, full-screen meetings, and different sharing methods still require native testing.

## Optional integrations

The prototype supports user-initiated Markdown export to a chosen file; it has no provider connection or import feature. Future calendar access should be read-only and calendar-scoped. Any future MCP interface should expose only user-selected meetings and tools. Sending notes to an external model or service changes where those notes are processed and must be disclosed before connection.

Future connections to Granola and other note-takers must let users select the content and direction of transfer. Show retention choices for imported copies; deleting a TalkQTE copy must not silently delete its original in another app. Disconnecting must stop future access and offer a separate choice to remove imported data. Exported copies remain subject to the destination's access and retention rules.
