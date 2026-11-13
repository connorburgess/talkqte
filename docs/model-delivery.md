# Speech model delivery plan

Status: plan, 9 November 2026; download implemented in Settings for `local-whisper` builds. See [What is implemented](#what-is-implemented) for what is built and what is not.

## Decisions

| Question              | Decision                                                                                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How the model arrives | An optional step during setup offers the local speech model, with its size and what it is for shown first. Choosing it is not required. The fictional demo, settings, and everything except transcription work without it. The same download stays available later in Settings. | People can try TalkQTE without a large download, and nobody receives a model they did not choose. Bundling it in the installer would add the model's size to every download.                                                                                                                        |
| Default model         | `tiny.en` (74 MB). `base.en` (141 MB) becomes a "more accurate" option once accuracy is measured.                                                                                                                                                                               | On the same fictional two-voice meeting, both raised and withdrew the same question at the same moments. `base.en` used about 85% more processor time (4.4 s against 2.4 s for 30 s of audio) and about 50% more memory (about 327 MB against about 214 MB). Text accuracy has not been scored yet. |
| Where it is hosted    | A copy on the project's GitHub Releases, with the upstream [whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp) as a fallback. Both are checked against the same pinned SHA-256.                                                                        | The project controls the primary copy and its availability, and the fallback avoids a single point of failure. Pinning the checksum in the app means the source cannot change what runs.                                                                                                            |
| Your own cloud model  | Later, an optional cloud transcription backend that uses the user's own API key.                                                                                                                                                                                                | See [Bring your own key](#bring-your-own-key-later).                                                                                                                                                                                                                                                |

Measured on an Apple M5 Pro with macOS 26.4, using a debug build, the network denied, and 5-second chunks. Two runs per model gave the same results. This is one synthetic clip on one machine, not a performance budget.

## Requirements for the download

- **Consent and clarity:** show the model's name, size, the free disk space it needs, and that it is used only on this Mac. The download is the only network step. It sends no account, transcript, or audio, only an ordinary file request.
- **Integrity:** the app ships with the SHA-256 of every model it supports. A file is moved into place only after its checksum matches; otherwise it is deleted and the user is told. An unverified model is never loaded.
- **Interruptions:** download to a temporary file in the app's own storage, resume or restart after a dropped connection, and show progress with Cancel. A partial file never counts as installed.
- **Space:** check free space before starting and leave a margin. A full disk produces a clear message, not a broken install.
- **Storage:** keep models in the app's storage outside any document folder, and never in a synced or shared location chosen without the user's consent. Settings shows installed models, their sizes, and Remove.
- **Offline use:** once installed, transcription works with no network. This is already checked in the developer replay with all network access denied.
- **Failure behavior:** a missing, removed, or corrupt model turns transcription off with an explanation and an offer to download again. Nothing falls back silently to another model or to a cloud service.

## Updates and compatibility

- **What the app accepts:** each app version lists the models and checksums it accepts. A newer app that needs a different model downloads it with the same consent step. The old one is kept until the new one is verified, then removed.
- **Format changes:** if a whisper.cpp update changes the file format, the app keeps the matching model rather than loading an incompatible one. Updates do not happen during a call.
- **Removal and clean-up:** uninstalling or choosing Remove deletes the model files. Temporary partial downloads are cleaned up on the next launch.

## Bring your own key (later)

The transcription worker already accepts any recognizer through its `Transcriber` interface, so a cloud backend fits without changing how cues work. A future option could let a user choose a cloud speech or frontier model and enter their own API key. Rules for that option:

- **Off by default:** it is a separate, explicit choice from the local model.
- **The user's own key:** the key belongs to the user. It is stored in the macOS Keychain, never in logs, files, or the interface, and the user can remove it at any time. TalkQTE never supplies or shares a key.
- **Disclosure:** before enabling it, the app says plainly that meeting audio leaves the Mac and goes to the named provider, and links that provider's data terms.
- **No silent fallback:** if the key fails or the service is unavailable, transcription stops with a message.
- **No paid runs in development:** no paid API is called during development or testing without the owner's explicit approval.

Comparable meeting tools process audio in the cloud. Granola's help center says it sends microphone and system audio to its transcription provider ([Granola transcription docs](https://docs.granola.ai/help-center/taking-notes/transcription)). Neither Granola nor Fireflies publishes its speech-to-text vendor in the sources reviewed. Local transcription by default, with an optional own-key cloud path, is a deliberate difference to validate with users, not an established advantage.

## Licensing

whisper.cpp and the Whisper model weights are MIT-licensed, and `whisper-rs` is released under the Unlicense. Builds that include local transcription ship the whisper.cpp license notice, and the model download screen links the model's license.

## What is implemented

`src-tauri/src/model.rs` and the Settings section **Live transcription**, in builds with the `local-whisper` feature:

- **Consent:** **Download speech model** shows the name, size, free space needed (size plus 512 MB), the host (Hugging Face, which sees the IP address and a file request), and that no account, audio, transcript, or notes are sent. The license is named in text; links in the notebook do not open a browser yet. Nothing downloads until it is chosen.
- **Integrity:** the app pins `tiny.en`'s size and SHA-256. The file is written to a hidden `.part` file and renamed into place only after the checksum matches; a mismatch deletes it and tries the next source. Starting a live session checks the checksum again before loading the model.
- **Source:** the upstream file is pinned to revision `5359861c` rather than a moving branch, and a resumed response must start where the file stopped.
- **Interruptions:** a dropped connection resumes with a range request. Attempts that make progress do not count against the three allowed per source, so a slow connection keeps going. After an attempt that receives nothing, the next waits 2 seconds, then 4, so a busy or rate-limiting server is not hit again at once, and Cancel ends the wait; each step has a time limit, so a silent server cannot hold a download indefinitely: one attempt that receives nothing can take up to about 2 minutes, so with the waits a source is given up within about 7 minutes, or about 13 minutes if it answers with rate limits at the longest honored reset time. Cancel takes effect at the next read, or within about 75 seconds while a request waits for a response. Response statuses are told apart: a 429 or 503 is a rate limit, and the download waits for the server's stated reset time (`Retry-After` in seconds or the `RateLimit` header's `t=` value, at most 5 minutes, and Cancel still works; a date-form `Retry-After` is not parsed, so an 8-second wait is used) before counting the attempt; a 416 discards the partial file and restarts from zero; a 403, 404, or 410 means this source will not serve the file, so it moves to the next source without retrying; other errors are retried as dropped connections. A checksum mismatch is retried once from scratch before the next source. A server that ignores ranges restarts the file cleanly. Progress is shown with Cancel. Cancel, failure, or quitting leaves no partial file; leftovers are removed at launch.
- **Space:** free space is checked before any request.
- **Removal:** **Remove model** deletes the file, refused while a live session or a download is running.
- **Discovery:** when the model is missing, the notebook's session controls show **Set up live session**, which opens Settings, instead of hiding live sessions entirely.
- **Developer override:** `TALKQTE_WHISPER_MODEL` still loads a developer-supplied file without checksum checks, for comparing models.

Not yet built: the project's own GitHub Releases copy (the upstream repository is the only source until a release is prepared), a first-run setup on a clean Mac checked by hand (the notebook's **Before your first meeting** card, 10 November 2026, offers the name, the focus lines, the model download when the build can use one, and prior notes, and steps aside once the required ones are done or when put away for the session; nothing about it persists between launches, so it returns each launch until then), keeping an old model while a new one is verified during an app update, and removal on uninstall (macOS apps removed by dragging to the Trash leave their data folder). Tests use a simulated server for success, resume, a server ignoring ranges, a checksum mismatch with fallback, an unreachable source, Cancel, too little space, a damaged installed file, and leftover partial files. One manual test makes a ranged HTTPS request to the real source to confirm the pinned size.

## Acceptance checks for the implementation

1. A fresh setup without the model runs the fictional demo, and transcription shows as not installed.
2. Choosing the model downloads, verifies, and enables it. Transcription then works with the network turned off.
3. A corrupted file, a checksum mismatch, a dropped connection, Cancel, and a full disk each leave no installed model, show a clear message, and allow a retry.
4. Remove deletes the files and turns transcription off. Uninstall leaves no model behind.
5. An app update that changes the model keeps the old one until the new one is verified.
6. Nothing in logs or temporary files contains audio or transcripts.

## Readiness response ordering — 11 November 2026

Installing or removing the speech model starts a new readiness check. Settings shows **Checking…** and the notebook withholds **Start live session** until that check completes. A response or failure from a retired check cannot replace the current result. This prevents a delayed missing-model response from hiding Start after installation, or a delayed ready response from offering it after removal. Model download, integrity checks and native capture commands are unchanged.

Four scenarios in `tests/model-readiness.spec.ts` mount the actual notebook with fictional native IPC. They cover a stale missing-model result after installation, a stale failure after installation, a stale ready result after removal, and removal while the current check is pending. The keyboard flow checks the notebook controls as well as Settings; no model is downloaded and no microphone is started.

All eight Chromium/WebKit readiness checks pass, including preserved keyboard focus and no horizontal overflow at 600 × 700. Fifty focused Chromium notebook, microphone-control and readiness checks pass, along with the frontend build, formatting and source design scan (no findings). The original Chromium regression failed before the fix. A separate local macOS WebKit pointer-entry timeout also occurred with unchanged `App.tsx` from `df1cec3`; the new regression scenarios use keyboard activation. Existing pointer tests remain unchanged, and their repository checks must still pass before merge. This is not a confirmed native pointer defect or evidence that native pointer access works.

UI/UX checkpoint: preserve a clear setup state so the person can tell when a live session is available. The existing paper/evergreen layout and controls are retained. Compare the [contradictory status before the fix](assets/model-readiness-before.png) at base `df1cec3`, [installed status after the fix](assets/model-readiness-after.png), and [pending check after removal](assets/model-readiness-checking.png). These are rendered fictional fixtures, including a 600 × 700 viewport with reduced motion. They establish neither native accessibility nor clean-install acceptance. The next device check is to install and remove the model in a developer build, verify the notebook readiness state, and separately verify explicit Start/Stop and model integrity.

## Next steps

- Score text accuracy for `tiny.en` and `base.en` against the script of several fictional clips, including faster speech and background noise, before offering `base.en`.
- Check the setup card and the Settings flow on a clean Mac; add the update path. The [release path](release-path.md#7-upgrade) gives the clean-Mac and upgrade procedure, including the model checksum comparison.
- Publish the GitHub Releases copy with its checksum when the first build that uses it is prepared.
