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

Do not build below the project's disk floor. Measured on 14 November 2026,
building into a folder that already held the project's debug test builds:

- 0.98 GiB for the first build with `local-whisper` and `native-audio-spike`,
  including whisper.cpp built from source (about 0.09 GiB of that) and the
  56.5 MiB app bundle;
- 0.34 GiB more to add `timing-log`, which recompiles only TalkQTE's own code;
- 0.08 GiB for the speech model, not yet downloaded, plus the 0.5 GiB the app
  keeps free whenever it downloads one.

That is about 1.3 GiB for the build. A build into an empty folder compiles
every dependency and needs more; allow several GiB above the floor.

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
  It starts no development server. Do not use `tauri dev` for a lab run.
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
the log's path. Use a new file for each run, and never point two running
copies of the app at the same file: one process writes one file.

```sh
mkdir -p ~/talkqte-lab
open -a ./src-tauri/target/debug/bundle/macos/TalkQTE.app \
  --stderr "$HOME/talkqte-lab/run-01.stderr" \
  --env TALKQTE_TIMING_LOG="$HOME/talkqte-lab/run-01.jsonl"
```

**Confirm the log is on** before starting capture. Once the main window has
opened (_to confirm_ how soon), `run-01.stderr` has one line starting
`TalkQTE timing log:`

- `on`: the log file now exists, readable by your account only.
- `off`, with the reason: the path is relative, contains `..`, or is inside
  the repository.
- `could not open`: the folder does not exist or is inside the repository
  once links are resolved, or the path is a link, a folder or a pipe. Nothing
  will be written.

No such line by the time a session starts means the variable did not reach
the app, or the build lacks `timing-log`. The first `session` line is written
when a session starts.

_To confirm:_ that `open --env` and `--stderr` work this way on the owner's
macOS. The alternative is running `TalkQTE.app/Contents/MacOS/talkqte` from
Terminal with the variable set, which prints the line in Terminal. macOS may
then attribute the Screen Recording permission to Terminal rather than
TalkQTE.

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

In the notebook's **Cue processing** panel, under "Application audio ·
development build":

1. Read the notice, then press **List applications**.
2. **The first listing shows the macOS Screen Recording prompt.** On recent
   macOS this is listed as "Screen & System Audio Recording". Grant it to
   TalkQTE in System Settings → Privacy & Security, then quit and reopen the
   app if macOS asks (_to confirm_), and list again. The permission is granted
   once per build.
3. Choose **QuickTime Player** and press **Start session from QuickTime
   Player**. That starts a session for QuickTime Player alone, with no
   microphone.

Wait until the notebook's Cue processing panel says "Application audio from
QuickTime Player is being captured", then press play in QuickTime Player.

A session for one application starts only while the microphone is not
capturing, no other live session or demo is running, and the speech model is
installed. A refusal is shown under the panel's Start in words.

## Start and stop without clicks

For a run nobody is at the Mac for, two development launch settings take the
same steps. Only a `native-audio-spike` build reads them, once, at launch.
Use them for fictional runs only.

```sh
open -a ./src-tauri/target/debug/bundle/macos/TalkQTE.app \
  --stderr "$HOME/talkqte-lab/run-01.stderr" \
  --env TALKQTE_TIMING_LOG="$HOME/talkqte-lab/run-01.jsonl" \
  --env TALKQTE_DEV_APPLICATION_SOURCE="QuickTime Player" \
  --env TALKQTE_DEV_STOP_AFTER_S=600
```

- **`TALKQTE_DEV_APPLICATION_SOURCE`** names the application exactly, as the
  panel lists it. Setting it is your acknowledgement of the scope notice:
  audio from all windows of that application may be included. The app then
  lists applications once, reviews the one with exactly that name, and starts
  a session from it alone. It never starts the microphone. The panel says
  that the setting acknowledged the notice, and the capture line ends
  "Started by the TALKQTE_DEV_APPLICATION_SOURCE launch setting."
- **`TALKQTE_DEV_STOP_AFTER_S`**, a whole number of seconds from 1, asks the
  ordinary Stop that long after capture is confirmed. Release then follows
  as in [Stop cleanly](#stop-cleanly). Any other value starts nothing.
- **One attempt, no retry.** Nothing is started, and the reason is shown under
  the panel's Start, when:
  - no running application, or more than one, has that exact name;
  - macOS refuses or never answers within 2 minutes;
  - the microphone or another session is running;
  - the speech model is missing.

  macOS is asked at most once per launch. The **one-time Screen Recording
  grant still needs a person**: grant it once, as in
  [Start capture](#start-capture), and relaunch.

- Each step is one stderr line starting `TalkQTE development source:`, and a
  `dev_source` line in the timing log.

Press play in QuickTime Player only once `dev_source` reads `started`. For an
unattended run, start the video with the lab's own tooling.

### Model connection without clicks

Only a **debug** build with **both** `claude-cli` and `native-audio-spike`
reads `TALKQTE_DEV_MODEL_CONNECTION` and `TALKQTE_DEV_MODEL_CALLS`, once at
launch before auto-start. Release compilation excludes this setting code;
the release scripts also refuse these development features.

Setting `TALKQTE_DEV_MODEL_CONNECTION=on` is your explicit consent to send
recent and new conversation lines to Anthropic through your signed-in Claude
subscription for each live session started in that launch. Use fictional
content only. It approves no prior notes and starts no audio source itself.
Read [the full data policy](cue-model.md#what-leaves-the-device-and-when) before
using it: over a session nearly every transcript line is sent, a few at a time,
plus the session name if set and current/earlier cues. Nothing is sent until
eligible transcript input arrives. The existing CLI version, sign-in and
credential checks still run; no fallback or retry is added.

Add these arguments to the launch command above when that build is used:

```sh
--env TALKQTE_DEV_MODEL_CONNECTION=on \
--env TALKQTE_DEV_MODEL_CALLS=100 \
--env TALKQTE_CUE_MODEL=opus-5.5 \
--env TALKQTE_CUE_EFFORT=low
```

- Missing connection setting leaves consent off; use the ordinary review.
  Any value other than exactly `on` (including empty), or an invalid call cap,
  leaves cues off with a launch-settings reason. Correct it and relaunch.
- The call cap defaults to **100**, even when approval comes from review.
  An explicit cap must be a whole number **1–100**. Before any request beyond
  that count, cues stop with a plain reason. There is no retry. Off/On and
  Pause/Resume cannot reset the count; Stop and a new session begin a new run.
- The panel says approval came from the launch setting. The companion retains
  the cloud and sending indicator; while paused it shows only the paused state.
  Off and Stop revoke permission, Pause cancels pending work, and none of these
  controls reapply launch consent within the session.
- The timing log's `evaluator` event records `approval: "launchSetting"`
  (or `"review"` for clicks), alongside model and effort. A cap stop records
  `evaluation_stopped` with `failure: "call_limit"` and no prompt or reply.

Offline tests cover parsing, permission scope/controls and cap exhaustion.
No real model call or native run was performed for this setting. Native panel
visibility, process environment delivery and a bounded fictional end-to-end
run remain acceptance checks before relying on unattended runs.

## During the run

- The notebook and the companion credit "Audio from QuickTime Player" and say
  the microphone is not used. With the model connection off, the companion shows "App audio · Local". With it on, its status says that lines go to Claude.
- A build with `claude-cli` can use model cues after explicit review or the
  launch consent above; without that feature the existing phrase rules remain.
  This development connection is not a selected production provider.
- Leave the run alone until the conversation ends. Pausing QuickTime Player
  pauses the audio, not the session clock.

## Stop cleanly

1. Press **Stop application audio** in the Cue processing panel, or **Stop live
   session**. Either one stops the source and ends the session.
2. Wait until the panel no longer reads stopping, cleanup failed or abandoned.
   Only then is capture confirmed off.
3. **Cleanup failed:** the panel has no retry. Retry once from the main
   window's Web Inspector, opened with right-click → Inspect Element (_to
   confirm_ that debug builds allow it):

   ```js
   const audio = (action) =>
     window.__TAURI_INTERNALS__.invoke('application_audio', { action });
   const { operation } = await audio({ kind: 'snapshot' });
   await audio({ kind: 'retryCleanup', operation });
   ```

4. **Abandoned:** nothing in TalkQTE can stop that capture. Quit TalkQTE and
   check that the menu bar's recording indicator has gone. Whether quitting
   ends the capture has not been checked.
5. Quit TalkQTE before reusing QuickTime Player for anything else.

## Timing log

Only a build with the `timing-log` feature contains the code that writes it,
and it writes only while `TALKQTE_TIMING_LOG` names an absolute path outside
the repository, in a folder that already exists. The app appends one JSON
object per line to that file, created readable by your account only, and
sends nothing anywhere. One app process writes one file; appends from two
processes to the same file are not supported.

The log records **every session the app runs until it quits**, microphone
sessions included, with each recognized line's full text. Run only fictional
conversations in a build launched with the log on, keep the file with the
lab's other fictional material, and delete it when it is no longer needed. A
cue's question is written only for a phrase cue raised by a transcript line:
a cue that quotes an imported or Granola note, lists the focus lines or
concerns them is logged without its question, note or focus text.

Every line has `event`, `wall_ms` (milliseconds since the Unix epoch, for
lining up with the lab's clock) and `mono_ms` (milliseconds since the log
opened). Times named `*_ms` without `wall` or `mono` are on the engine's
session clock.

| `event`          | Other fields                                                                           | Written when                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`        | `session`, `live`, `state` (`started`/`ended`), `elapsed_ms`, `commit`, `features`     | A session starts or stops running, as seen in the snapshot sent to the companion.                                                                       |
| `audio_received` | `source` (`microphone`/`application`), `session`, `start_ms`, `duration_ms`, `audible` | A chunk is handed to transcription. `start_ms` is its first sample on the session clock. `audible` means some sample reaches about −60 dBFS.            |
| `segment`        | `session`, `id`, `at_ms`, `speaker`, `text`, `accepted`                                | A recognized line reaches the engine.                                                                                                                   |
| `cue_decision`   | `session`, `cue`, `kind`, `source`, `question`, `source_id`, `elapsed_ms`              | The engine first holds a cue. `source` is `line`, `note`, `focus` or `evaluated`. Only `line` has `question` and `source_id`, the segment it came from. |
| `cue_published`  | `session`, `cue`, `elapsed_ms`                                                         | The cue is in the snapshot sent to the companion window.                                                                                                |
| `cue_cleared`    | `session`, `cue`, `elapsed_ms`                                                         | That cue has left the snapshot sent to the companion window.                                                                                            |
| `dev_source`     | `step`, `application`, `reason`                                                        | The launch setting acted: `acknowledged`, `started`, `refused` with a `reason`, or `stopping` when the stop setting asked the ordinary Stop.            |
| `dropped`        | `count`                                                                                | Lines were lost since the last line written, because the queue was full or a write failed. Written before the next line.                                |

What it can and cannot tell you:

- **Line said → transcribed → cue on screen.** Use the lab's own time for
  when a line was said, `segment` for when it reached the engine,
  `cue_decision` for the cue, and `cue_published` for when the companion was
  sent it. The log cannot see when the window paints the cue; the lab's screen
  recording shows that.
- `cue_published` is written whether or not the companion window is visible.
  Keep the companion shown during a run.
- **Alignment without transcription.** Audio is handed over in chunks of
  about 3 seconds, so an `audio_received` line is written up to 3 seconds
  after the sound in it. Do not use that line's `wall_ms`. Instead, take the
  `session` `started` event's `wall_ms − elapsed_ms`, the wall time of
  session time zero, and add the `start_ms` of the first `application` chunk
  with `audible: true`. That is the wall time at which that chunk began; the
  first sound reached TalkQTE within its `duration_ms` after that. The same
  offset converts any `*_ms` session time to wall time.
- The microphone's last chunks, which Stop hands over after reading ends, are
  not logged. A lab run uses the application source, where every chunk is.
- Lines lost after the last line written are not reported until another
  line is written, so a loss at the very end of a run can go unreported.

## What stays open

Everything here waits for the owner's first run, with these questions first:

- Whether `open --env` passes the log's path, and which app the Screen
  Recording permission is attributed to.
- Whether the Web Inspector opens in this build, for a cleanup retry.
- That QuickTime Player's audio is captured and nothing else is.
- How long Stop takes to reach confirmed release.
- Whether the companion's window title is visible to the lab's recorder.

The device gates in [the system-audio plan](system-audio-plan.md) and
[the application-audio host](native-application-audio-host.md) apply in full.
