# Real-app lab run

14 November 2026. How to run the real TalkQTE desktop app against a fictional
meeting played on the same Mac. Only the meeting is simulated: a mock-call
video plays in QuickTime Player. Everything else is the real app:
application-audio capture of QuickTime Player, on-device transcription with
the local speech model, the engine's phrase-rule cues and the real companion
window.

**None of this has been run yet.** Every step below is written from the code
and has to be confirmed on the owner's Mac. Steps marked _to confirm_ are the
ones most likely to differ. Use fictional conversations only: never a real
meeting, a real person's voice, or any audio you would not publish.

## Disk

Do not build below the project's disk floor. A development build with local
transcription and application audio needs, on top of what a debug build of
the app already uses:

- about 0.3–0.5 GiB for whisper.cpp, built from source by CMake;
- about 1–2 GiB of Rust debug build output for the app binary and the crates
  that the extra features and the app build profile recompile;
- about 0.05 GiB for the debug app bundle;
- 0.08 GiB for the speech model, plus the 0.5 GiB the app keeps free whenever
  it downloads one.

Plan on 4–6 GiB free above the floor before starting, and more if the build
folder starts empty. These are estimates from earlier builds of this project,
not a measurement of this configuration.

## Build

From the repository root, with Xcode's command-line tools and CMake installed:

```sh
npm ci
TALKQTE_COMMIT="$(git rev-parse HEAD)" \
  npm run tauri -- build --debug --bundles app \
  --features local-whisper,native-audio-spike,timing-log
```

- `local-whisper` adds on-device transcription. `native-audio-spike` adds
  application-audio capture. `timing-log` adds the timing log below. None of
  these is in a default build, and this build must never be distributed.
- `TALKQTE_COMMIT` puts the commit into the timing log's session events. If
  you leave it out they say `unknown`.
- `tauri build` builds the interface first and loads it from the app bundle.
  It starts no development server. Do not use `tauri dev` for a lab run: it
  serves the interface on port 1420, which is the owner's own development
  server. If a lab tool needs a local server of its own, the native lane's
  port is 1438.
- The bundle is written to `src-tauri/target/debug/bundle/macos/TalkQTE.app`,
  or under `$CARGO_TARGET_DIR` if that is set.

A debug build is unsigned. macOS ties permissions to the exact binary, so
rebuilding can mean granting Screen Recording again (_to confirm_).

## Speech model

The model never goes inside the repository. Use one of these:

- **In the app:** Settings → speech model → Download. It is saved as
  `~/Library/Application Support/com.talkqte.desktop/models/ggml-tiny.en.bin`
  and checked against its pinned SHA-256 before use.
- **A file you already have:** set `TALKQTE_WHISPER_MODEL` to its absolute
  path when launching. That file is not checksum-checked.

Without a model, a session for the application is refused as unavailable and
nothing is cleared.

## Launch with the timing log

Make a folder for lab output outside the repository, then launch the app with
the log's path:

```sh
mkdir -p ~/talkqte-lab
open -a ./src-tauri/target/debug/bundle/macos/TalkQTE.app \
  --env TALKQTE_TIMING_LOG="$HOME/talkqte-lab/run-01.jsonl"
```

_To confirm:_ that `open --env` passes the variable on the owner's macOS. The
alternative is running the executable inside `TalkQTE.app/Contents/MacOS/`
from Terminal with the variable set. macOS may then attribute the Screen
Recording permission to Terminal rather than TalkQTE.

## The meeting

The lab lane provides the mock call as one MP4 file: the call's picture and
its pre-mixed sound together, with no TalkQTE in it.

1. Open the MP4 in **QuickTime Player** and leave it paused at the start.
2. Make sure nothing else plays in QuickTime Player. Capture covers the whole
   application, all of its windows.
3. Leave the system output at a normal volume. Capture reads QuickTime
   Player's audio directly and excludes TalkQTE's own sound.

**Alternative to check once:** the lab's live Chrome for Testing window, for
conversations generated on the fly. Browsers play sound from a separate
helper process, and whether the application filter includes it is unknown.
If selecting "Google Chrome for Testing" captures nothing, that route is out.

## Start capture

The notebook has no Start for application audio yet. In this development build
the steps go through the app's own command, from the main window's Web
Inspector. Open it with right-click → Inspect Element (_to confirm_ that debug
builds allow it).

```js
const audio = (action) =>
  window.__TAURI_INTERNALS__.invoke('application_audio', { action });

// 1. The notebook would show this notice before listing. Read it, then:
(await audio({ kind: 'snapshot' })).scopeNotice;
await audio({ kind: 'list', acknowledged: true });
```

**The first listing shows the macOS Screen Recording prompt.** On recent
macOS this is listed as "Screen & System Audio Recording". Grant it to TalkQTE
in System Settings → Privacy & Security, then quit and reopen the app if macOS
asks (_to confirm_). The permission is granted once per build.

```js
// 2. Wait for the list, then review QuickTime Player.
let status = await audio({ kind: 'snapshot' });
status.choices; // repeat until it lists applications
const player = status.choices.find((c) => c.name === 'QuickTime Player');
await audio({ kind: 'review', source: player.id });

// 3. Start a session for QuickTime Player alone, with no microphone.
status = await audio({ kind: 'snapshot' });
await audio({ kind: 'startSession', review: status.operation });
```

Wait until the notebook's Cue processing panel says "Application audio from
QuickTime Player is being captured", then press play in QuickTime Player.

A session for one application starts only while the microphone is not
capturing, no other live session or demo is running, and the speech model is
installed. A refusal is shown in the status as `problem`.

## During the run

- The notebook and the companion credit "Audio from QuickTime Player" and say
  the microphone is not used. The companion shows "App audio · Local".
- Cues come from the engine's phrase rules, which is the product path. No
  model evaluator is connected to this build.
- Leave the run alone until the conversation ends. Pausing QuickTime Player
  pauses the audio, not the session clock.

## Stop cleanly

1. Press **Stop application audio** in the Cue processing panel, or **Stop live
   session**. Either one stops the source and ends the session.
2. Wait until the panel no longer reads stopping, cleanup failed or abandoned.
   Only then is capture confirmed off.
3. **Cleanup failed:** retry once from the Web Inspector:
   `await audio({ kind: 'retryCleanup', operation: (await audio({ kind: 'snapshot' })).operation })`.
4. **Abandoned:** nothing in TalkQTE can stop that capture. Quit TalkQTE and
   check that the menu bar's recording indicator has gone. Whether quitting
   ends the capture has not been checked.
5. Quit TalkQTE before reusing QuickTime Player for anything else.

## Timing log

Only a build with the `timing-log` feature writes it, and only while
`TALKQTE_TIMING_LOG` names an absolute path in a folder that already exists.
The app appends one JSON object per line to that file and sends nothing
anywhere. The log contains fictional transcript text, so keep it with the
lab's other fictional material and delete it when it is no longer needed.

Every line has `event`, `wall_ms` (milliseconds since the Unix epoch, for
lining up with the lab's clock) and `mono_ms` (milliseconds since the log
opened). Times named `*_ms` without `wall` or `mono` are on the engine's
session clock.

| `event`          | Other fields                                                                           | Written when                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`        | `session`, `live`, `state` (`started`/`ended`), `elapsed_ms`, `commit`, `features`     | A session starts or stops running, as seen in the snapshot sent to the companion.                                                            |
| `audio_received` | `source` (`microphone`/`application`), `session`, `start_ms`, `duration_ms`, `audible` | A chunk is handed to transcription. `start_ms` is its first sample on the session clock. `audible` means some sample reaches about −60 dBFS. |
| `segment`        | `session`, `id`, `at_ms`, `speaker`, `text`, `accepted`                                | A recognized line reaches the engine.                                                                                                        |
| `cue_decision`   | `session`, `cue`, `kind`, `question`, `source_id`, `elapsed_ms`                        | The engine first holds a cue. `source_id` is the segment it came from.                                                                       |
| `cue_published`  | `session`, `cue`, `elapsed_ms`                                                         | The cue is in the snapshot sent to the companion window.                                                                                     |
| `cue_cleared`    | `session`, `cue`, `elapsed_ms`                                                         | That cue has left the snapshot sent to the companion window.                                                                                 |
| `dropped`        | `count`                                                                                | Lines were lost because the writer fell behind, before the next line written.                                                                |

What it can and cannot tell you:

- **Line said → transcribed → cue on screen.** Use the lab's own time for
  when a line was said, `segment` for when it reached the engine,
  `cue_decision` for the cue, and `cue_published` for when the companion was
  sent it. The log cannot see when the window paints the cue; the lab's screen
  recording shows that.
- `cue_published` is written whether or not the companion window is visible.
  Keep the companion shown during a run.
- **Alignment without transcription.** The first `audio_received` from
  `application` with `audible: true` marks when sound first reached TalkQTE.
- The microphone's last chunks, which Stop hands over after reading ends, are
  not logged. A lab run uses the application source, where every chunk is.
- Lines lost from a full queue at the very end of a run are not reported.

## What stays open

Everything here waits for the owner's first run, with these questions first:

- Whether `open --env` passes the log's path, and which app the Screen
  Recording permission is attributed to.
- Whether the Web Inspector opens in this build.
- That QuickTime Player's audio is captured and nothing else is.
- How long Stop takes to reach confirmed release.
- Whether the companion's window title is visible to the lab's recorder.

The device gates in [the system-audio plan](system-audio-plan.md) and
[the application-audio host](native-application-audio-host.md) apply in full.
