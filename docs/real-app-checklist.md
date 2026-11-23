# Real-app lab run: checklist

One page to follow at the Mac for a recorded run of the real TalkQTE app hearing a fictional meeting. The [runbook](real-app-lab.md) has the detail behind each app step; the [meeting emulator page](meeting-emulator.md) has the detail behind the meeting and the recording. Fictional conversations only. Record on the Mac itself, never in a virtual machine. Before each run, write its question, why existing evidence is insufficient, and its duration/call bounds. Stop at the first unexpected failure; a new macOS permission prompt requires the owner. Coordinate app launches and capture with other active runs. This is the manual QuickTime route; a model-enabled prepared take with the owned lab player follows the [prepared take runbook](lab-take-runbook.md).

## Once

1. **Disk.** `df -k /` must stay above the project's floor with several GiB to spare.
2. **Build** a lab copy of TalkQTE (development only, never distributed), from the repository root:

   ```sh
   npm ci
   TALKQTE_COMMIT="$(git rev-parse HEAD)" \
     npm run tauri -- build --debug --bundles app \
     --features lab-evaluator,native-audio-spike,timing-log
   ```

   `lab-evaluator` switches on `cloud-transcription`, the only live transcription the app has.

3. **Transcription.** Prepare an owner-only short-lived Deepgram token file outside the repository, and choose a minute cap from 1 to 60, as [cloud transcription](cloud-transcription.md#selecting-it) describes. On-device transcription and its speech model were removed on 16 November 2026.
4. **Two permissions**, both "Screen & System Audio Recording" in System Settings → Privacy & Security:
   - **TalkQTE**, for its own capture of QuickTime Player. It is asked for at the first "List applications" (step 9). Quit and reopen TalkQTE if macOS asks.
   - **The app you run the recorder from**, such as Terminal, for recording the two windows. Restart that app after allowing it.

## Each run

5. **The meeting video.** Render one (or use one already made):

   ```sh
   npm run lab:emulator -- render --conversation standup-flaky-test \
     --out <meeting folder> --voices-cache <voices cache> --portraits-cache <portraits cache>
   ```

6. **Launch TalkQTE with a new timing log** (a new file each run, outside the repository):

   ```sh
   mkdir -p ~/talkqte-lab-runs
   open -a <bundle>/TalkQTE.app --stderr "$HOME/talkqte-lab-runs/run-01.stderr" \
     --env TALKQTE_TIMING_LOG="$HOME/talkqte-lab-runs/run-01.jsonl" \
     --env TALKQTE_DEV_STT_BACKEND=deepgram \
     --env TALKQTE_DEV_STT_TOKEN_FILE=<token file> \
     --env TALKQTE_DEV_STT_MINUTE_CAP=<1 to 60>
   ```

   Only one copy of TalkQTE may be running: a preview build has the same name, and the recorder refuses when two copies have windows on screen.

7. **Check the log is on** once the session starts (step 9): `run-01.stderr` then has a line `TalkQTE timing log: on`. The file is opened at the first session, so the line is not there before.
8. **Open the meeting video in QuickTime Player**, paused at the start. Nothing else plays in QuickTime Player. Keep its window and the TalkQTE companion both visible.
9. **Start the session.** In the notebook's Cue processing panel, under **Development build** → "Application audio" at the end of the panel:
   - press **List applications**;
   - choose **QuickTime Player**; only regular applications with a bundle identifier and a normal-level window are offered, with meeting/player apps first;
   - press **Start session from QuickTime Player**;
   - wait for "Application audio from QuickTime Player is being captured". Do not press play yet;
   - approve the session's cue processing review (**Enable for this session**). Until then nothing is sent to Deepgram and the captured audio is thrown away.
10. **Dry-run the recorder.** Every line should read `ready`:

    ```sh
    npm run lab:window-record -- --meeting <meeting record .json> \
      --out <recordings folder> --timing-log ~/talkqte-lab-runs/run-01.jsonl --dry-run
    ```

11. **Record.** Run the same command without `--dry-run`, then **press play in QuickTime Player within a few seconds**. It records only the two windows, with QuickTime Player's sound, and stops by itself after the meeting's length plus 15 seconds.
12. **Stop.** Press **Stop application audio** in TalkQTE and wait until the panel no longer reads stopping, cleanup failed or abandoned. Quit TalkQTE before using QuickTime Player for anything else.

## What comes out

- **Recording:** the video, with a label bar above it ("Simulated meeting", "Fictional", the synthetic voices and portraits, "Pre-rendered meeting", "Real TalkQTE app" with its commit, and where the cues came from, read from the log), and its record beside it.
- **Timing log:** `run-01.jsonl` holds when each chunk of sound was heard, each line recognised (with the cloud stream's `stt_state` and `stt_final` rows), and each cue decided and shown. It contains the meeting's fictional lines and nothing else.

## Known on 14 November 2026

- `open --env` and `--stderr` work: the log recorded the build's commit and features.
- The earlier QuickTime startup failures were fixed in [#291](https://github.com/connorburgess/talkqte/pull/291), merged on 14 November 2026: resampled buffer timestamps and the observed planar buffer layout are accepted. A development build containing those fixes captured and transcribed the fictional meeting, using the former on-device transcription (removed 16 November 2026); this does not validate cloud transcription, and does not validate other output devices or sample rates.
- The first recorded take matched the companion by title and had sound. It showed zero cues and made zero model calls. The recipe above is a capture/transcription run; model cues require a separately enabled development connection and its explicit processing approval. Do not label a take as model-driven unless the timing log establishes that.
- A later selected-QuickTime aggregate diagnostic received nonzero audio samples, then stopped without saving audio/video. It was a separate probe, not another TalkQTE cue run. Chrome's selected-source comparison remained silent; see the [emulator evidence](meeting-emulator.md#what-has-and-has-not-been-checked).

## Record for each run

- whether TalkQTE needed reopening after the permission;
- whether the recorder found the companion by its title;
- whether the take has sound.

The companion-title match and recorded sound were observed once on the development Mac. Permission prompts, recovery and other hardware configurations still need their own evidence; the earlier take and aggregate probe do not establish model-cue delivery or usefulness.
