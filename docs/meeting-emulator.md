# Meeting emulator and window-only recording

Status: development tooling, 14 November 2026. Offline checks and one fictional real-app recording have run on the development Mac. That take captured and transcribed QuickTime Player but showed no cues; it was not a model-cue run. A bounded aggregate diagnostic later confirmed selected-QuickTime audio samples. These observations do not establish supported meeting capture or cue usefulness. The [real-app lab runbook](real-app-lab.md) covers the app side: the build, the permissions, the application source and the timing log. The [checklist](real-app-checklist.md) is the one page to follow at the Mac.

The [cue simulation](cue-simulation.md) replays a conversation inside the browser preview with a stand-in for the app. This page is for the other kind of run: the real TalkQTE desktop app hearing a fictional meeting through its application source, and recording what it does.

## The meeting emulator

`scripts/lab-emulator.mjs` plays a fictional conversation as a mock video call: invented portraits in a gallery of tiles, a ring on the current speaker, optional captions, and the lines spoken aloud. **TalkQTE is not in it**: capture, transcription and any separately enabled cue processing belong to the real app. The emulator supplies no cues.

Without `--results` it plays one of the bundled conversations. It plays only conversations the lab may play (the loader is `scripts/lab-playable.mjs`):

- **Bundled conversations**, checked word for word against their fixture.
- **Generated runs** from the dialogue lane (schema `talkqte-cue-dialogue/1`), checked against the brief file saved beside the results:
  - the brief's SHA-256 must match the one the run recorded, and the brief must name every person;
  - every person must carry casting (`voice`: feminine, masculine or neutral; an age range; a portrait description of at most 200 characters);
  - every line must be spoken by someone in the call, in order.

Voices and portraits are cast from those fields, never from a name.

Sound and pictures come from the caches the separate [voice and portrait steps](cue-simulation.md#recording-a-simulation) fill (`npm run lab:voices -- --results <file>` and `npm run lab:portraits -- --results <file>` now take a generated run). Without a cache it uses the Mac's own voices, plain test tones, or nothing, and initials instead of portraits. The emulator itself sends nothing anywhere.

Every emulated meeting is labelled on screen and in its record: "Simulated meeting", "Fictional", and "Synthetic voices" and "Synthetic portraits" where they apply.

### Pre-rendered: one meeting video for QuickTime Player

```sh
npm run lab:emulator -- render [--results <results .json>] --conversation <id> \
  --out <directory outside the repository> [--voices-cache <dir>] [--portraits-cache <dir>] [--no-captions]
```

This makes one MP4 (1280 × 800, with the sound as one 48 kHz track built from the clips and measured against them) and a record beside it.

- **Why one file:** picture and sound are in one file played by one single-process app, so they cannot drift apart, and the app's capture has one obvious source.
- **Timing record:** the record says where every line starts and ends in the video, to line up with the app's timing log.
- **What it suits:** conversations written in full beforehand.

Open it in QuickTime Player, select **QuickTime Player** as the application source in TalkQTE, and press play. Nothing else should play in QuickTime Player meanwhile, because capture takes the whole app's sound.

### Live: a meeting window that can change while it plays

```sh
npm run lab:emulator -- live [--results <results .json>] --conversation <id> \
  --out <directory outside the repository> [--port 1445] [--start-delay <seconds>] [--open]
```

The first line starts `--start-delay` seconds after the window opens (3 by default, up to 600), so the app's capture can start first. This serves the meeting from this Mac only (127.0.0.1) and prints the command that opens it as one plain Chrome for Testing window (`--open` runs it).

- **Sound:** the window plays each line's own clip as it starts.
- **Added lines:** while it plays, lines can be added with `POST /append` (`{ "lines": [{ "speaker", "text", "startMs"? }] }`). This is how a conversation can react to the real app's cue mid-meeting.
  - An added line must be spoken by someone in the call.
  - It is spoken if the voice cache holds a clip of those words in that speaker's voice; otherwise it is shown silently and logged as silent.
  - Lines added before the meeting starts are refused.
- **Played log:** every start, line spoken, line ended and line added is written to a `.played.jsonl` log with the wall-clock time, to line up with the app's timing log.

Chrome for Testing capture is currently blocked on the tested Mac. On 14 November 2026, an app run received only silent chunks. A later dedicated-instance diagnostic found an audio-active helper in the verified browser process tree that ScreenCaptureKit did not list. Both 12-second meters were silent: the main-only and helper-inclusive modes both had only the main process available to their filters. Page playback events overlapped voiced intervals, but no helper audio samples were captured, so physical audibility remains unverified. Use the pre-rendered QuickTime meeting for the checked capture path; this is not evidence about other browsers or configurations.

## Recording the real app, window by window

```sh
npm run lab:window-record -- --meeting <emulator record .json> \
  --out <directory outside the repository> (--timing-log <file> | --app-commit <sha>) \
  [--seconds <n>] [--emulator-app "QuickTime Player"] [--keep-silent] [--dry-run]
```

Without `--seconds` it records a pre-rendered meeting's length plus 15 seconds. **`--dry-run` goes through every step except recording**, and prints each as ready or to do:

- the meeting record and its video;
- the output folder and the recording length;
- the app's commit from the timing log;
- the cues label so far;
- the capture program and the permission;
- with the permission, whether QuickTime Player and the TalkQTE companion each have a window on screen.

It lists the windows of those two apps only, and captures nothing.

### What it records

Exactly two windows, the emulator's and the real TalkQTE companion's ("TalkQTE companion", owned by TalkQTE), with the emulator app's sound. It never records the whole screen, so no notification or other window of the owner's can appear.

- **The capture program:** `scripts/lab-window-capture.swift`, a small ScreenCaptureKit program, built on first use into a temporary folder. It needs the Xcode command line tools and macOS 14 or later.
- **The picture:** a display filtered to those two windows only, cropped to them.
- **The sound:** a second stream that takes only the emulator app's sound.
- **If a window is missing:** if either window cannot be found, nothing is recorded.
- **If two copies of TalkQTE are running:** a preview build has the same app name, so if windows of more than one TalkQTE process are on screen, nothing is recorded, and the dry run says so.
- **If the companion's title is hidden:** if its panel does not expose its title, the companion is the TalkQTE app's smallest on-screen window. The record says which rule matched.

### Permission

It needs **Screen & System Audio Recording** for the app that starts it (Terminal, for example), in System Settings, Privacy & Security. The program checks that first without asking (`--check`) and records nothing if it is not allowed.

### What is saved

- **The video:** a label bar is added above the picture, never over it. It reads "Simulated meeting", "Fictional", "Synthetic voices", "Synthetic portraits", "Pre-rendered meeting" or "Live meeting", "Real TalkQTE app" with its commit, and where the cues came from.
- **The commit:** it comes from `--app-commit`, or from the app's timing log when that records it.
- **Where the cues came from** is read from the app's timing log after the run, never given by hand. Each `cue_decision` names its `decider` (`phrase_rule` or `model`); a log from before that field existed says `source`, where `evaluated` means a model. The model and effort come from the latest `evaluator` event. The label reads, for example, "cues: model, claude-opus-5-5, low effort", "cues: phrase rules", or "cues: none shown". Without a timing log it reads "cues: unknown". The record keeps the counts of each kind of decision.
- **A take with no sound** is discarded unless `--keep-silent` is given.
- **The record** names the two windows matched, the picture size, when recording started and stopped (wall-clock milliseconds), how many frames and sound buffers were written, and the emulator record it played.

Recordings are private working files: the output directory must be outside the checkout, and they never go in the repository, the README, the website or anything promotional. Record on the Mac itself, never in a virtual machine.

## What has and has not been checked

Tooling checks on 14 November 2026, on the macOS host:

- A meeting video rendered from a recorded run with cached voices and portraits; its sound passed the clip check.
- A live meeting served, opened, given an added line while playing, with its log written and a refusal for a speaker not in the call.
- The capture program compiled, and its permission preflight reported both unavailable and allowed states across the earlier sessions; it captures nothing when permission is unavailable.
- The label bar placed above a test video with its sound kept.

The offline tests are `scripts/lab-meeting.test.mjs` (in `npm run test:cue-lab`) and the opt-in browser tests in `tests/lab-recording.spec.ts` (`npm run test:lab-record`).

Observed native evidence on 14 November 2026:

- The first recorded take used a development build containing the QuickTime fixes later merged in [#291](https://github.com/connorburgess/talkqte/pull/291). The recorder matched the companion by title and produced a 92-second take with sound. The app received audible chunks and transcribed the fictional meeting, but showed no cues. Model calls: zero.
- A separate, coordinated 12-second selected-QuickTime aggregate meter received nonzero audio samples while the exact fictional video played, then stopped. That diagnostic retained no audio or video and did not run TalkQTE transcription or cue inference.
- The dedicated Chrome comparison above remains a failure of the tested selected-source path; it is not a successful browser meeting run.

Still unverified: model cues reaching the real companion during captured speech, rendered cue timing against the recording, clean-Mac permission/recovery behavior, dependable source release across device changes, and participation/listening usefulness. Each further run needs a written question and bounds, uses fictional content only, and stops at the first unexpected failure. Existing grants permit coordinated runs without the owner present; a new macOS permission prompt still needs the owner's action.
