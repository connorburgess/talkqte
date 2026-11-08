# Troubleshooting

What the current prototype shows when something goes wrong, what it means, and what to do. Every quoted message is one the app actually displays; the last table lists the rarer ones. This page covers the macOS developer build; there is no released version, and nothing here is a support commitment.

If a problem is not listed, the [feedback route](#reporting-a-problem) at the end says what to include.

## Microphone

| You see                                                                                                                 | What it means                                                                        | What to do                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| "Microphone access is unavailable. Check TalkQTE in System Settings → Privacy & Security → Microphone, then try again." | macOS refused microphone access for TalkQTE, or you dismissed the permission prompt. | Open System Settings → Privacy & Security → Microphone and turn TalkQTE on, then choose Start microphone or Start live session again. |
| "No microphone is available. Connect an input device, then try again."                                                  | macOS reports no default input device.                                               | Connect or select a microphone in System Settings → Sound → Input, then try again.                                                    |
| "Microphone monitoring stopped. Check your input device and permission, then try again."                                | The input stream reported an error, for example the device was unplugged.            | Reconnect or choose another input, then start again. The app does not restart capture on its own.                                     |
| "The microphone stopped delivering audio. Check your input device, then try again."                                     | No audio arrived for three seconds, so the app released the microphone.              | Check that the device is awake and selected as input, then start again.                                                               |
| "This microphone or platform is not supported by the activity monitor yet."                                             | The input's format is one the monitor does not handle.                               | Choose a different input device. Record the device model when reporting it.                                                           |
| "Could not stop the microphone check. Try Stop microphone again."                                                       | The stop request did not reach the controller.                                       | Choose Stop microphone again. If it still fails, quit TalkQTE; quitting releases the microphone.                                      |
| The companion shows "Stopping…" for a long time                                                                         | The device is slow to release.                                                       | Wait a few seconds. If it does not clear, quit and relaunch TalkQTE.                                                                  |

## Live session

| You see                                                               | What it means                                                                                                | What to do                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| "This build does not include local transcription."                    | The app was built without the `local-whisper` feature, so there is no live session.                          | Build with `npm run tauri -- dev --features local-whisper` (needs CMake), as the [README](../README.md#live-session-developer-build) describes. |
| "The local speech model is not installed."                            | No speech model file is in the app's data folder and `TALKQTE_WHISPER_MODEL` is not set.                     | Choose Settings → Download speech model, or follow Set up live session in the notebook.                                                         |
| "The local speech model is damaged. Remove it and download it again." | The installed model file does not match its pinned checksum.                                                 | Choose Remove model in Settings, then Download speech model again.                                                                              |
| "Could not load the local speech model."                              | The file exists but whisper.cpp could not open it, or `TALKQTE_WHISPER_MODEL` points to an unsupported file. | For a downloaded model, remove and download it again. For a developer file, check the path and that it is a `ggml` model.                       |
| "End the demo before starting a live session."                        | The fictional demo is running or paused.                                                                     | Choose End demo, then Start live session.                                                                                                       |
| "A live session is already running."                                  | Start was chosen twice.                                                                                      | Nothing to do; the first session continues.                                                                                                     |
| The session ends by itself soon after starting                        | Microphone access was refused or the device failed; a live session never runs with nothing listening.        | See the microphone message shown beside it, fix that, then start again.                                                                         |
| Lines appear several seconds late                                     | Speech is transcribed in chunks of up to 3 seconds, ending early at a pause, and then recognized.            | Expected in this version; the measured delay on one Mac is in [local transcription](local-transcription.md#pause-based-chunks).                 |
| Lines are wrong or missing                                            | The `tiny.en` model is small and English-only, and recognition in real rooms has not been checked.           | Expected limitation. Record what was said and what appeared, with the setup, when reporting it.                                                 |

## Speech model download

| You see                                                                                               | What it means                                                                                                      | What to do                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Not enough free space. The model needs about 615 MB free."                                           | The free space check failed before any request; the model is 78 MB plus a 537 MB (512 MiB) margin.                 | Free some space, then try again.                                                                                                                    |
| "The model could not be downloaded. Check your connection and try again. Nothing was installed."      | Every attempt received nothing, or the server could not be reached.                                                | Check the connection, then choose Download speech model again. A failed download leaves no partial file, so the next one starts from the beginning. |
| "The model could not be downloaded. The download server asked us to wait. Nothing was installed."     | Hugging Face rate-limited the request, or answered that it was unavailable (503), more times than the app retries. | Wait a few minutes, then try again. On a shared office network, the limit is shared by everyone behind the same address.                            |
| "The model could not be downloaded. The downloaded file did not match the expected checksum. …"       | The file received is not the pinned model.                                                                         | Try again once. If it repeats, the source has changed; report it. The app installs nothing that fails the check.                                    |
| "The model could not be downloaded. The model file is not available from this source. …"              | The source answered that the file is missing or forbidden.                                                         | Report it; another source would need a new app version.                                                                                             |
| "The model could not be saved. Nothing was installed."                                                | Writing to the app's data folder failed.                                                                           | Check that the app's data folder is writable and the disk is not full, then try again.                                                              |
| "Download cancelled. Nothing was installed."                                                          | You chose Cancel.                                                                                                  | Nothing to do; choose Download speech model when ready.                                                                                             |
| "Cancel the download before removing the model." / "Stop the live session before removing the model." | Remove was chosen while a download or a live session was running.                                                  | Cancel or stop first, then Remove model.                                                                                                            |

## Prior notes from a file

| You see                                                                                               | What it means                                      | What to do                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| "That is not a TalkQTE notes file. It needs a "notes" list with an id, date, and text for each note." | The chosen file is not JSON in the expected shape. | Check the file: a `notes` list, each note with `id`, `date` (YYYY-MM-DD), and `text`; `title` and `revision` are optional. |
| "That file is larger than 1 MB. Choose a smaller notes file."                                         | The file exceeds the size the app will read.       | Split or trim the file.                                                                                                    |
| "The file has no notes."                                                                              | The `notes` list is empty.                         | Add notes to the file.                                                                                                     |
| Some notes are "not listed"                                                                           | The file has repeated ids or more than 200 notes.  | Give each note a unique id; keep files under 200 notes.                                                                    |
| A note is "skipped (no date or text)" after Import                                                    | The note lacks a real date or any text.            | Fix the note's `date` or `text` and import again.                                                                          |
| "Choose a notes file first."                                                                          | Import was requested with no file read.            | Choose Add notes from a file.                                                                                              |

## Companion window

| Problem                                          | What to do                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| The companion is not visible                     | Hide only hides the window; it does not stop anything. Turn it back on with Settings → Floating question window.       |
| The companion is on the wrong display            | It follows the notebook's display. Move the notebook to the display you want.                                          |
| The companion sits over something important      | Settings → Companion position offers three corners and top center. Near-camera placement is optional, never automatic. |
| A question stays after the conversation moved on | Choose Dismiss. Untouched questions expire on their own; one you opened with Why? stays until dismissed.               |

## Export

| You see                                                   | What to do                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| "Review the export before choosing a destination."        | Choose Export, read the preview, then choose Choose destination. |
| "Could not save the file. Choose a writable destination." | Pick a folder you can write to.                                  |
| "Live sessions are not saved or exported."                | Expected: a live transcript stays in memory only.                |

## Other messages

| You see                                                                                                    | What it means and what to do                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| "A live session cannot be paused. Stop it instead." / "A live session cannot be resumed. Start a new one." | Pause and Resume are demo controls. Use Stop live session.                                                                                       |
| "Could not finish the live session."                                                                       | The final transcription step did not complete. The app has already ended the session; if the indicator still shows activity, quit and relaunch.  |
| "Could not start the microphone check."                                                                    | The start request did not reach the microphone controller. Try again; if it repeats, quit and relaunch.                                          |
| "Stop the microphone check first."                                                                         | Shown as a hint on the disabled Start live session button: a live session cannot start while the microphone check is on. Choose Stop microphone. |
| "The model is already downloading."                                                                        | Download was chosen twice. Wait for the first download.                                                                                          |
| "Could not start the download."                                                                            | The download thread could not be started. Try again; if it repeats, quit and relaunch.                                                           |
| "The download stopped unexpectedly. Nothing was installed."                                                | The download thread ended with an error. Try again.                                                                                              |
| "The model could not be removed."                                                                          | The file could not be deleted. Check the app's data folder is writable, then try Remove model again.                                             |
| "The local speech model could not be read."                                                                | The installed file could not be opened for its checksum. Remove it and download it again.                                                        |
| "The file could not be read."                                                                              | The chosen notes file could not be opened, or is not UTF-8 text. Check the file and choose it again.                                             |
| "That question has already passed."                                                                        | The question expired or was dismissed before the action reached it. Nothing to do.                                                               |

## Reporting a problem

There is no support service for this prototype. Open an issue on the [GitHub repository](https://github.com/connorburgess/talkqte) with:

- the build commit or version, macOS version, and Mac model;
- the exact message shown;
- the steps that led to it, using fictional content only;
- for microphone and live-session problems, the input device and whether headphones were in use.

Do not include meeting content, transcripts, or recordings. The app writes no diagnostic file; describe what you saw.
