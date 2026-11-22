# Real-app lab run

14 November 2026. How to run the real TalkQTE desktop app against a fictional
meeting played on the same Mac. Only the meeting is simulated: a mock-call
video plays in QuickTime Player. Everything else is the real app:
application-audio capture of QuickTime Player, transcription by Deepgram
through [cloud transcription](cloud-transcription.md) once the session's cue
processing is approved, the engine's cues and the real companion window.
On-device transcription was removed on 16 November 2026; this page was
updated for that, and nothing here has been run with cloud transcription.

**None of this has been run yet.** Every step below is written from the code
and has to be confirmed on the owner's Mac. Steps marked _to confirm_ are the
ones most likely to differ. Use fictional conversations only: never a real
meeting, a real person's voice, or any audio you would not publish.

## Disk

Do not build below the project's disk floor. Measured on 14 November 2026,
with the former `local-whisper` feature (removed 16 November 2026), building
into a folder that already held the project's debug test builds:

- 0.98 GiB for the first build with `local-whisper` and `native-audio-spike`,
  including whisper.cpp built from source (about 0.09 GiB of that) and the
  56.5 MiB app bundle;
- 0.34 GiB more to add `timing-log`, which recompiles only TalkQTE's own code.

The current build, with `lab-evaluator` in place of `local-whisper`, has not
been measured. A build into an empty folder compiles every dependency and
needs more; allow several GiB above the floor.

## Build

From the repository root, with Xcode's command-line tools installed:

```sh
npm ci
TALKQTE_COMMIT="$(git rev-parse HEAD)" \
  npm run tauri -- build --debug --bundles app \
  --features lab-evaluator,native-audio-spike,timing-log
```

- `lab-evaluator` switches on `cloud-transcription`, the only live
  transcription the app has, and adds the
  [lab evaluator client](development-lab-evaluator.md). `native-audio-spike`
  adds application-audio capture. `timing-log` adds the timing log below.
  None of these is in a default build, the release scripts refuse all of
  them, and this build must never be distributed.
- `TALKQTE_COMMIT` puts the commit into the timing log's session events. If
  you leave it out they say `unknown`.
- `tauri build` builds the interface first and loads it from the app bundle.
  It starts no development server. Do not use `tauri dev` for a lab run.
- The bundle is written to `src-tauri/target/debug/bundle/macos/TalkQTE.app`,
  or under `$CARGO_TARGET_DIR` if that is set.

A debug build is only ad-hoc signed, with a code-signing identifier such as
`talkqte-55cecaafd599c0f5`, not the bundle identifier. macOS ties Screen &
System Audio Recording to that signature. **Every rebuild is a new app to
macOS and needs the permission granted again.** On 14 November 2026 a fresh
build with no grant was refused at once, with no prompt, and the setting
below reported `permission_denied`. System Settings can then list several
TalkQTE entries. Turn on only the one for the build you are running.

### A stable development signature

A self-signed code-signing certificate, `TalkQTE Development`, makes every
development build the same app to macOS, so one grant survives rebuilds. It
lives only in the developer's login keychain, never in the repository, and
signs nothing for distribution. **Sign TalkQTE with this identity only**,
never with another code-signing identity the keychain may hold, such as an
employer's Developer ID.

1. Once: Keychain Access → Certificate Assistant → Create a Certificate. Name
   it `TalkQTE Development`, identity type Self Signed Root, certificate type
   Code Signing. macOS reports it as not trusted, but `codesign` accepts it.
2. After each build, sign the bundle with it under the app's identifier:

   ```sh
   codesign --force --deep -s "TalkQTE Development" -i com.talkqte.desktop \
     src-tauri/target/debug/bundle/macos/TalkQTE.app
   codesign -dr - src-tauri/target/debug/bundle/macos/TalkQTE.app
   ```

   The second line should print `identifier "com.talkqte.desktop" and
certificate leaf = H"…"`. Whether `APPLE_SIGNING_IDENTITY` does this
   during the build has not been tried.

3. Grant Screen & System Audio Recording once. Remove any older TalkQTE
   entries first: an entry for another signature makes macOS deny the new
   build without asking.

On 14 November 2026 a rebuild signed this way kept the grant.

## Transcription

The session's audio is transcribed by Deepgram. Select it for the launch with
`TALKQTE_DEV_STT_BACKEND=deepgram`, `TALKQTE_DEV_STT_TOKEN_FILE` (the
absolute path of an owner-only file holding a short-lived Deepgram token) and
`TALKQTE_DEV_STT_MINUTE_CAP` (1 to 60). The rules for the token file, what is
sent and what stops it are in [cloud transcription](cloud-transcription.md).
Keep the token file outside the repository, and never put the token itself
on a command line.

Nothing is sent until the session's cue processing review is approved. Until
then the captured audio is thrown away and nothing is transcribed.

Without these settings, a session for the application is refused with "Live
transcription needs cloud transcription selected for this development
launch."; with settings the app refuses, "The cloud transcription settings
are not usable." Nothing is cleared either way. The
[lab-owned launcher](lab-owned-launcher.md) passes these three settings when
its plan asks for transcription.

## Launch with the timing log

Make a folder for lab output outside the repository and any other git checkout,
then launch the app with
the log's path. Use a new file for each run, and never point two running
copies of the app at the same file: one process writes one file.

```sh
mkdir -p ~/talkqte-lab-runs
open -a ./src-tauri/target/debug/bundle/macos/TalkQTE.app \
  --stderr "$HOME/talkqte-lab-runs/run-01.stderr" \
  --env TALKQTE_TIMING_LOG="$HOME/talkqte-lab-runs/run-01.jsonl" \
  --env TALKQTE_DEV_STT_BACKEND=deepgram \
  --env TALKQTE_DEV_STT_TOKEN_FILE="$HOME/talkqte-lab-runs/private/deepgram-token" \
  --env TALKQTE_DEV_STT_MINUTE_CAP=15
```

The token path and the cap of 15 minutes are examples; the token file and its
folder must meet the rules in
[cloud transcription](cloud-transcription.md#selecting-it).

**Confirm the log is on** before starting capture. Once the main window has
opened (_to confirm_ how soon), `run-01.stderr` has one line starting
`TalkQTE timing log:`

- `on`: the log file now exists, readable by your account only.
- `off`, with the reason: the path is relative, contains `..`, or is inside
  the repository.
- `could not open`: the folder does not exist or is inside the repository or
  another git checkout once links are resolved, or the path is a link, a folder or a pipe. Nothing
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
3. Choose **QuickTime Player**, which is listed near the top, and press **Start session from QuickTime
   Player**. That starts a session for QuickTime Player alone, with no
   microphone.

Wait until the notebook's Cue processing panel says "Application audio from
QuickTime Player is being captured", then press play in QuickTime Player.

A session for one application starts only while the microphone is not
capturing, no other live session or demo is running, and cloud transcription
is selected for the launch with usable settings. A refusal is shown under the panel's Start in words. Only open
applications with a window are listed, on any desktop. If QuickTime Player is
missing, open the MP4, then press **List again**.

If the start fails, the panel names the reason where macOS or TalkQTE gave
one:

- macOS refused capture to this copy of TalkQTE. Right after the Screen
  Recording grant, that should mean TalkQTE must be quit and reopened (_to
  confirm_);
- the application quit;
- macOS could not capture its audio;
- capture was stopped from macOS;
- the audio arrived in a form TalkQTE cannot read.

The timing log's `source_problem` line has the reason and ScreenCaptureKit's
error code, and its `source_ended` line says how many final results the
cloud stream returned.

Capturing is not yet transcribing. Approve the session's cue processing
review (**Enable for this session**) before pressing play, or the start of the
conversation is thrown away untranscribed.

## Start and stop without clicks

For a run nobody is at the Mac for, two development launch settings take the
same steps. Only a `native-audio-spike` build reads them, once, at launch.
Use them for fictional runs only.

```sh
open -a ./src-tauri/target/debug/bundle/macos/TalkQTE.app \
  --stderr "$HOME/talkqte-lab-runs/run-01.stderr" \
  --env TALKQTE_TIMING_LOG="$HOME/talkqte-lab-runs/run-01.jsonl" \
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
- **`TALKQTE_DEV_APPLICATION_WITH_MICROPHONE=1`** makes the application join
  a microphone session instead of starting one alone, for a call with both
  sides. After finding the application, the app waits up to 5 minutes for
  you to start a live session from the microphone in the notebook, then
  attaches the application to it. You still start the microphone and approve
  processing yourself; one approval then sends both the microphone's and the
  application's audio, although its text names one source. The timed Stop
  below stops the application only. Any other value starts nothing. _To
  confirm_: this has not been run on a device, and microphone pickup of the
  application's sound can add duplicate lines unless you use headphones.
- **`TALKQTE_DEV_STOP_AFTER_S`**, a whole number of seconds from 1, asks the
  ordinary Stop that long after capture is confirmed. Release then follows
  as in [Stop cleanly](#stop-cleanly). Any other value starts nothing.
- **One attempt, no retry.** Nothing is started, and the reason is shown under
  the panel's Start, when:
  - no running application, or more than one, has that exact name;
  - macOS refuses or never answers within 2 minutes;
  - the microphone or another session is running;
  - cloud transcription is not selected for the launch, or its settings are
    not usable.

  macOS is asked at most once per launch. The **one-time Screen Recording
  grant still needs a person**: grant it once, as in
  [Start capture](#start-capture), and relaunch.

- Each step is one stderr line starting `TalkQTE development source:`, and a
  `dev_source` line in the timing log.

Press play in QuickTime Player only once `dev_source` reads `started`. For an
unattended run, start the video with the lab's own tooling.

### The user's name without typing

A **debug** build reads `TALKQTE_DEV_USER_NAME` once at launch and sets it as
the user's name before the first session, as if it had been typed in
Settings, so a run can check questions asked of the listener by name. Use the
fictional listener's first name. The name accepts what Settings accepts:
letters, combining accents, spaces, apostrophes and hyphens, up to 40
characters, with at least one letter. It stays in memory only, appears in
Settings, and can still be changed or cleared there. Like a typed name, it is
sent with model requests when a model is connected
([data policy](cue-model.md#what-leaves-the-device-and-when)).

- Unset, there is no name, as before.
- Set but empty, or not a usable name, every live session refuses to start
  with "The developer name setting is not usable." Correct it and relaunch.
- The timing log never records the name. Its `user_name_set` row says, at the
  start of each session and whenever it changes, whether a name is set.
- Release compilation excludes this setting.

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
  the microphone is not used. Before cue processing is approved the companion
  shows "App audio · not transcribing yet"; once audio is sent its status
  names Deepgram, and Claude too when the model connection is on.
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
| `audio_received` | `source` (`microphone`/`application`), `session`, `start_ms`, `duration_ms`, `audible` | Captured audio is handed on for transcription, about a second at a time for an application; it is sent only once the review is approved. `start_ms` is its first sample on the session clock. `audible` means some sample reaches about −60 dBFS. |
| `segment`        | `session`, `id`, `at_ms`, `speaker`, `text`, `accepted`                                | A recognized line reaches the engine.                                                                                                                   |
| `cue_decision`   | `session`, `cue`, `kind`, `source`, `question`, `source_id`, `elapsed_ms`              | The engine first holds a cue. `source` is `line`, `note`, `focus` or `evaluated`. Only `line` has `question` and `source_id`, the segment it came from. |
| `user_name_set`  | `session`, `set`                                                                       | A session starts, and whenever the name changes during it: whether Settings holds a name for **Asked you** cues. The name itself is never written.      |
| `cue_published`  | `session`, `cue`, `elapsed_ms`                                                         | The cue is in the snapshot sent to the companion window.                                                                                                |
| `cue_cleared`    | `session`, `cue`, `elapsed_ms`                                                         | That cue has left the snapshot sent to the companion window.                                                                                            |
| `source_problem` | `problem`, `os_code`                                                                   | An application source failed to start or stopped on its own. `os_code` is ScreenCaptureKit's error code, when it gave one.                              |
| `source_ended`   | `application`, `problem`, `transcribed_finals`                                         | An application source's run ended, with its reason if it failed and how many final results its cloud stream returned.                                   |
| `stt_state`      | `session`, `state`, `code`, `audio_ms`                                                 | Cloud transcription started, finished, ended or stopped, with a fixed `code` when it failed and the audio sent so far ([cloud transcription](cloud-transcription.md#what-is-kept)). |
| `stt_final`      | `session`, `seq`, `start_ms`, `end_ms`, `untrusted_speaker`                            | A final result arrived. Its text is in the `segment` row. The speaker label is the provider's guess; it is never shown or sent to a cue model.           |
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
- **Alignment without transcription.** An application's audio is logged
  about a second at a time, so an `audio_received` line is written up to
  about a second after the sound in it. Do not use that line's `wall_ms`. Instead, take the
  `session` `started` event's `wall_ms − elapsed_ms`, the wall time of
  session time zero, and add the `start_ms` of the first `application` chunk
  with `audible: true`. That is the wall time at which that chunk began; the
  first sound reached TalkQTE within its `duration_ms` after that. The same
  offset converts any `*_ms` session time to wall time.
- The microphone's last chunks, which Stop hands over after reading ends, are
  not logged. A lab run uses the application source, where every chunk is.
- Lines lost after the last line written are not reported until another
  line is written, so a loss at the very end of a run can go unreported.

## Subscription broker preparation

The [development lab evaluator client](development-lab-evaluator.md) adds the
bounded Rust transport, separate coalescing policy and provider disclosure for a
fictional subscription-broker experiment. Development-only native selection,
consent, publication, clock and Stop hooks are implemented and tested offline; the
coordinated streamed run remains pending. The build/launch commands above do not
select that backend. Preserve explicit processing consent, session call cap,
Stop/revoke and release guards; offline tests do not establish clock accuracy,
companion paint, provider readiness or runtime cleanup.

## What stays open

Everything here waits for the owner's first run, with these questions first:

- Whether `open --env` passes the log's path, and which app the Screen
  Recording permission is attributed to.
- Whether the Web Inspector opens in this build, for a cleanup retry.
- That QuickTime Player's audio is captured and nothing else is.
- That cloud transcription works against the real service: no session has
  been run with this code, and its delay on real hardware is unmeasured.
- How long Stop takes to reach confirmed release.
- Whether the companion's window title is visible to the lab's recorder.

The device gates in [the system-audio plan](system-audio-plan.md) and
[the application-audio host](native-application-audio-host.md) apply in full.
