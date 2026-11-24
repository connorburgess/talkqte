# Troubleshooting

What the current prototype shows when something goes wrong, what it means, and what to do. Every quoted message is one the app actually displays; the last table lists the rarer ones. This page covers the macOS developer build, whose bundle requires macOS 14.0 or later; there is no released version, and nothing here is a support commitment.

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
| "Add your Anthropic API key in Settings to start a live session."     | No Anthropic key is stored, so there is no cue connection and no review could approve sending audio. | Add it under **Settings → Your API keys** ([provider keys](provider-keys.md)).            |
| "Your Anthropic key could not be read from the Keychain. Check it in Settings." or the same for Deepgram | macOS refused or could not open the Keychain item. | Unlock the login Keychain or allow TalkQTE's access when macOS asks, then check the key in Settings; replace it if needed. |
| "Anthropic rejected your API key. Replace it in Settings to start a live session." | Anthropic refused the stored key, at a check or during a session. | Create a new key in your Anthropic Console account and replace the stored one. |
| "Add your Deepgram API key in Settings to start a live session." | No Deepgram key is stored, and no development launch selects a token file.              | Add it under **Settings → Your API keys** ([provider keys](provider-keys.md)), or relaunch with the developer settings in [cloud transcription](cloud-transcription.md#selecting-it).                                  |
| "Deepgram rejected your API key. Replace it in Settings to start a live session." | Deepgram refused the stored key, at a check or during a session.              | Create a new key in your Deepgram account and replace the stored one.                                  |
| "The cloud transcription settings are not usable."                    | Cloud transcription is selected for this launch, but its settings were refused.                              | Check the token file and minute cap against [cloud transcription](cloud-transcription.md#selecting-it), then relaunch.                          |
| "End the current session before starting a live session."             | Another session is still running.                                                                            | Stop it, then choose Start live session.                                                                                                        |
| "A live session is already running."                                  | Start was chosen twice.                                                                                      | Nothing to do; the first session continues.                                                                                                     |
| The session ends by itself soon after starting                        | Microphone access was refused or the device failed; a live session never runs with nothing listening.        | See the microphone message shown beside it, fix that, then start again.                                                                         |
| No lines appear after Start                                           | Audio is sent to Deepgram only after **Enable for this session** in the cue processing review. Until then nothing is transcribed. | Approve cue processing for the session if you want it transcribed. See [when audio is sent](cloud-transcription.md#when-audio-is-sent).          |
| Lines appear several seconds late                                     | Only final results become lines. A long utterance with no pause gets its final about 6 seconds after it starts, plus the round trip. | Expected in this version; see [latency and the cue window](cloud-transcription.md#latency-and-the-cue-window). It has not been measured on real hardware with this code. |
| Lines are wrong or missing                                            | Recognition with this code has not been checked against the real service or in real rooms.                   | Record what was said and what appeared, with the setup, when reporting it.                                                                      |
| "Transcription by Deepgram stopped: …"                                | Cloud transcription ended for the reason given, and the live session ended with it. Nothing fell back to another transcription service. | See [what stops it](cloud-transcription.md#what-stops-it), deal with the cause, then start a new session.                                       |

## Speech model left from an earlier version

Earlier development builds could download a speech model for on-device transcription. That was removed on 16 November 2026. A model downloaded before then stays at `<app data folder>/models/ggml-tiny.en.bin` (on macOS, `~/Library/Application Support/com.talkqte.desktop/models/`). TalkQTE no longer reads or deletes it; delete that `models` folder yourself if you want the space back.

## Prior notes from a file

**Add notes from a file** is inside the notebook's **Prior context** section, which starts closed; open it first.

| You see                                                                                                | What it means                                                                     | What to do                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| "That is not a TalkQTE notes file. It needs a "notes" list with an id, date, and text for each note."  | The chosen file is not JSON in the expected shape.                                | Check the file: a `notes` list, each note with `id`, `date` (YYYY-MM-DD), and `text`; `title` and `revision` are optional. |
| "That file is larger than 1 MB. Choose a smaller notes file."                                          | The file exceeds the size the app will read.                                      | Split or trim the file.                                                                                                    |
| "The file has no notes."                                                                               | The `notes` list is empty.                                                        | Add notes to the file.                                                                                                     |
| Some notes are "not listed"                                                                            | The file has repeated ids or more than 200 notes.                                 | Give each note a unique id; keep files under 200 notes.                                                                    |
| A note is "skipped (no date or text)" after Import                                                     | The note lacks a real date or any text.                                           | Fix the note's `date` or `text` and import again.                                                                          |
| "TalkQTE reads notes from a Markdown (.md) or plain-text (.txt) file, or a TalkQTE JSON notes file. …" | The file is another format, such as DOCX or PDF.                                  | Export or save the notes as Markdown or plain text ([how files are read](note-file-formats.md)).                           |
| "That is a transcript or captions file. …"                                                             | An `.srt` or `.vtt` file is a transcript, not notes.                              | Export the meeting's summary or notes as Markdown or plain text instead.                                                   |
| "The file has no note text."                                                                           | The file is empty or holds only a title or front matter.                          | Add the notes to the file, or choose another one.                                                                          |
| "That file is not plain text. …"                                                                       | The file holds binary data, such as a renamed PDF.                                | Export the notes as Markdown or plain text.                                                                                |
| "No date in the file" and Import stays unavailable                                                     | The note states no `YYYY-MM-DD` date TalkQTE can read.                            | Enter the date in the note's Date field, or add a `Date: YYYY-MM-DD` line near the top of the file.                        |
| A note shows a date that is not the meeting's                                                          | The file's front matter `date:` or a `Date:` line near the top gives that date.   | Correct or remove that line, remove the note, and choose the file again.                                                   |
| An edited file is "already imported"                                                                   | Its modification time is not newer than the imported copy's.                      | Remove the note and choose the file again.                                                                                 |
| A note is titled by its file name                                                                      | A Markdown file has no `# ` heading on its first line, or the file is plain text. | Add a `# Title` first line, or rename the file.                                                                            |
| "Choose notes first."                                                                                  | Import was requested with nothing chosen to read.                                 | Open **Prior context**, then choose Add notes from a file or Choose Granola notes.                                         |

## Companion window

| Problem                                          | What to do                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| The companion is not visible                     | Hide only hides the window; it does not stop anything. Turn it back on with Settings → Floating question window.       |
| The companion is on the wrong display            | It follows the notebook's display. Move the notebook to the display you want.                                          |
| The companion sits over something important      | Settings → Companion position offers three corners and top center. Near-camera placement is optional, never automatic. |
| A question stays after the conversation moved on | Choose Dismiss. Untouched questions expire on their own; one you held stays until dismissed.                           |

## Export

| You see                                                   | What to do                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Review the export before choosing a destination."        | Choose Export, read the preview, then choose Choose destination.                                                                                 |
| "Could not save the file. Choose a writable destination." | Pick a folder you can write to.                                                                                                                  |
| "Live sessions are not saved or exported."                | Expected while a live session runs: the transcript stays in memory only. After Stop live session, Export saves your notes, never the transcript. |

## Other messages

| You see                                                     | What it means and what to do                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Could not finish the live session."                        | The final transcription step did not complete. The app has already ended the session; if the indicator still shows activity, quit and relaunch.  |
| "Could not start the microphone check."                     | The start request did not reach the microphone controller. Try again; if it repeats, quit and relaunch.                                          |
| "Stop the microphone check first."                          | Shown as a hint on the disabled Start live session button: a live session cannot start while the microphone check is on. Choose Stop microphone. |
| "The file could not be read."                               | The chosen notes file could not be opened, or is not UTF-8 text. Check the file and choose it again.                                             |
| "That question has already passed."                         | The question expired or was dismissed before the action reached it. Nothing to do.                                                               |

## Reporting a problem

There is no support service for this prototype. Open an issue on the [GitHub repository](https://github.com/connorburgess/talkqte) with:

- the build commit or version, macOS version, and Mac model;
- the exact message shown;
- the steps that led to it, using fictional content only;
- for microphone and live-session problems, the input device and whether headphones were in use.

Do not include meeting content, transcripts, or recordings. The app writes no diagnostic file. **Settings → Diagnostics → Show diagnostics** shows the app version, your settings, whether each key is set and the fixed codes of what last went wrong, with nothing from a meeting; read it, choose **Copy diagnostics** and paste it into the issue.
