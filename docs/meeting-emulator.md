# Meeting emulator and window-only recording

Status: development tooling, 14 November 2026. Built and checked offline. **No real-app run has been made**: that needs the owner at the Mac, a build of TalkQTE with local transcription, and the recording permission described below. The [real-app lab runbook](real-app-lab.md) covers the app side: the build, the permissions, the application source and the timing log. The [checklist](real-app-checklist.md) is the one page to follow at the Mac.

The [cue simulation](cue-simulation.md) replays a conversation inside the browser preview with a stand-in for the app. This page is for the other kind of run: the real TalkQTE desktop app hearing a fictional meeting through its application source, and recording what it does.

## The meeting emulator

`scripts/lab-emulator.mjs` plays a fictional conversation as a mock video call: invented portraits in a gallery of tiles, a ring on the current speaker, optional captions, and the lines spoken aloud. **TalkQTE is not in it**: the real app makes its own cues from what it hears.

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
  --out <directory outside the repository> [--port 1445] [--open]
```

This serves the meeting from this Mac only (127.0.0.1) and prints the command that opens it as one plain Chrome for Testing window (`--open` runs it).

- **Sound:** the window plays each line's own clip as it starts.
- **Added lines:** while it plays, lines can be added with `POST /append` (`{ "lines": [{ "speaker", "text", "startMs"? }] }`). This is how a conversation can react to the real app's cue mid-meeting.
  - An added line must be spoken by someone in the call.
  - It is spoken if the voice cache holds a clip of those words in that speaker's voice; otherwise it is shown silently and logged as silent.
  - Lines added before the meeting starts are refused.
- **Played log:** every start, line spoken, line ended and line added is written to a `.played.jsonl` log with the wall-clock time, to line up with the app's timing log.

Select **Google Chrome for Testing** as the application source. Whether the app's capture hears a browser at all is not yet known, because a browser plays sound from a helper process. The first device run settles it; until then, use the pre-rendered meeting.

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

Checked offline on 14 November 2026, on the macOS host:

- A meeting video rendered from a recorded run with cached voices and portraits; its sound passed the clip check.
- A live meeting served, opened, given an added line while playing, with its log written and a refusal for a speaker not in the call.
- The capture program compiles and reports that the permission is not granted to this session.
- The label bar placed above a test video with its sound kept.

The offline tests are `scripts/lab-meeting.test.mjs` (in `npm run test:cue-lab`) and the opt-in browser tests in `tests/lab-recording.spec.ts` (`npm run test:lab-record`).

Not checked, because each needs the owner and a real-app run:

- whether the window filter finds the companion by its title;
- whether the capture hears QuickTime Player, and whether it hears Chrome for Testing;
- the recording itself;
- lining the recording up with the app's timing log.
