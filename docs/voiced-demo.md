# Voiced practice demo

**Retired on 14 November 2026.** The demo described here was removed from the app at the owner's decision, together with **Try demo**, its controls and the bundled speech. Fictional demonstrations now come from the lab's simulations and recordings ([batches and simulations](cue-simulation.md)). This page is kept as a record of what was built, how the audio was produced and which checks ran; its present-tense descriptions are of the app before that date. The app no longer contains it: the fictional script survives only as a fixture for the engine's own tests.

The fictional community-garden demo ("A better welcome") now plays with two synthetic voices, Robin and Alex. This record covers what the voiced demo does, how its audio was produced, and which acceptance checks from [product readiness](product-readiness.md#voiced-practice-demo) have run.

## What it does

- **Try demo** starts the scripted conversation and its voices together from the same click. The session clock stays the authority: speech pauses, resumes, ends and replays with the demo, and moves back into place if it drifts more than 0.75 seconds from the clock.
- Each transcript line appears when its speaker finishes the line, and cues follow those lines as in the text-only demo.
- **Mute voices** switches to text-only playback without stopping the demo; **Enable voices** resumes speech at the current point.
- **Pause** stops speech and the clock together, so you can try a response aloud. The demo does not listen to the response, record it, or change its script. The notebook says so beside the session controls.
- If the audio file cannot load or play, a status line says **Voices could not play**, and the transcript, cues and Pause continue.
- The companion window never loads a second copy of the audio.
- The status line describes the session as **Fictional conversation · synthetic voices**.

The script is 63 seconds long (the text-only version was 1 minute 44 seconds). Its lines are timed to the recorded speech, and the gaps between turns come from the recording, not from padding.

## Cues in the voiced script

A full run in the browser preview shows three cues:

| Time | Cue                                     | Trigger                                                                        |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------ |
| 0:09 | Owner: "Who will take the first draft?" | "Someone can take the first draft of the welcome guide."                       |
| 0:37 | Timing: "What date should we aim for?"  | "We should have it ready soon …"                                               |
| 0:51 | Said: the quoted "ready by Friday" line | It answers the timing question, so the question is replaced by the exact words |

With a prior note titled "Garden welcome guide" imported, the opening line shows that note as a reminder first.

The text-only script also reached a Decision cue ("How will we choose between those options?") at 1:12. In the shorter script, "We could either print the guide …" comes at 0:56, while the Friday quote is still showing and the 10-second pause after an answered question is still running, so the engine correctly holds it back. Restoring the Decision cue would need about 13 more seconds of conversation between those two lines. Decision cues remain covered by the engine's own scenario tests.

## Playback in the desktop app

The first version played the file through an HTML audio element. In the desktop app the owner heard it as very choppy. The likely cause is that the packaged app serves bundled files through Tauri's own protocol, which handles media seeking poorly, while the player kept seeking to follow the clock. The browser preview did not show this, because Vite's development server handles seeking normally.

Speech now ships inside a script chunk that only the notebook loads. It is decoded once into memory and played through the Web Audio API, so following the clock never goes back to the file protocol. Browser tests check that speech starts once and keeps playing while it keeps pace with the clock. Whether it now sounds smooth in the desktop app still needs a listener.

## Audio production and provenance

- Seven clips, one per line, generated during development with OpenAI's `gpt-4o-mini-tts` speech model using its built-in `marin` (Robin) and `cedar` (Alex) voices. These are the provider's preset voices; nothing was cloned, and the script is fictional.
- Two lines were regenerated once: the third line was lengthened to replace a long silence, and the opening was reworded so it mentions the welcome guide again, which the imported-note reminder depends on. Generation used existing development credit within a bounded budget; there is no generation at runtime, no automatic regeneration, and no API fallback.
- The clips are mixed into one 24 kHz mono MP3 (`src/demo/welcome.mp3`, about 740 KB) with each line placed so that it ends at its transcript time. `src/demo-voices.json` recorded each line's speaker, voice, start and end. Both files were deleted with the demo.
- The app plays this bundled file. Running the demo needs no account, model download, or provider request.
- OpenAI's speech guide requires telling listeners that the voice is AI-generated. The notebook's status line does that.

## Acceptance checks

| Check                                                              | Result                                                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoken lines match the script                                      | Passed. A local, offline `whisper.cpp` transcription (tiny.en model) of the final MP3 recovered all seven lines, with only punctuation differences, at the scripted times. |
| No overlapping or clipped turns                                    | Passed at production time. The mixing step checked that every line starts after the previous one ends and that the last line ends two seconds before the file does.        |
| Text and cue alignment                                             | Passed in browser tests. Lines and cues appear at the scripted end-of-line times, and the cue sequence above was observed in a full run.                                   |
| Pause, Resume, Mute, End and Replay                                | Passed in Chromium and WebKit browser tests, including a play request that resolves after Pause.                                                                           |
| Audio failure recovery                                             | Passed in browser tests. A blocked audio file shows the status line, and the transcript and Pause continue.                                                                |
| No network request during the demo                                 | Passed in the browser preview test.                                                                                                                                        |
| Native desktop playback                                            | **Open.** The first version was audibly choppy in the owner's desktop check; playback was rebuilt on Web Audio (see above) and needs another listen.                       |
| Audible quality and speaker distinction                            | **Open.** Needs a person to listen.                                                                                                                                        |
| VoiceOver and keyboard route in the native app                     | **Open.**                                                                                                                                                                  |
| Comprehension and useful participation compared with no assistance | **Open.** This demo establishes no user outcome.                                                                                                                           |
