# Prepared take runbook

How to get from "the owner is at the Mac and approves a run" to "take recorded and report written" for one prepared, model-enabled fictional take: the owned lab player plays approved fictional media, the real TalkQTE app captures it, Deepgram transcribes it and the Anthropic API decides cues, while the two windows are recorded. This is the roadmap's [prepared technical take](../ROADMAP.md#current-focus). Following this page does not check off a roadmap item, and nothing here says a take has been run from the repository.

Each step says what it needs, the command, and what proves it worked. **Verified from code** means the rule is read from the modules and their offline tests. **_To confirm on the Mac_** means the step has not been checked from code alone and has to be confirmed at the first run. Stop at the first unexpected failure or new macOS permission prompt, and keep everything ([after a failure](#after-a-failure)).

Use fictional material only. Every path below is a placeholder: keep receipts, keys, media, plans and evidence in private folders outside the checkout, and never commit them.

## What exists and what does not

- **Modules (verified from code):** the [owned launcher](lab-owned-launcher.md) `prepareLabLauncher`, the [source session join](lab-source-session-join.md) `createLabSourceV1`, the [owned player](lab-owned-player.md) `createLabPlayer`, the strict window selector and recorder ([owned-player take](lab-owned-player-take.md)), the [fixed model take](lab-prepared-take.md#fixed-saved-meeting-model-recording) `createFixedModelTake`, the [evidence writer](lab-evidence-writer.md) and the [evidence report](lab-evidence-report.md).
- **A plan check:** `npm run lab:take -- --plan <plan.json>` checks one plan file with the same option checks those modules apply and prints what a take would launch, send and spend ([step 10](#10-the-plan-and-its-dry-run)). It launches nothing and reads no key file.
- **A runner:** `npm run lab:take -- --plan <plan.json> --execute --confirm <plan sha256>` runs that check again, then one attempt of the plan within the [owner's decisions](#owner-decisions), composing only the modules above in the order of [step 11](#11-run-the-take). It has been tested offline against the existing fixtures only; it has not run a real take.

## 0. Scope and reservation

Needs: the owner at the Mac for the whole take; no other app launch, capture, player or provider run on the Mac; a written question for the take and its bounds (the plan). Each take needs its own plan and approval; approving one plan approves one attempt of that plan, in that sitting, and nothing else ([owner decisions](#owner-decisions)).

Proves it: the owner has written down which variant ([prepared](#11-run-the-take), [provider failure](#provider-failure-take), [turn-off](#turn-off-take)) and why existing evidence is not enough. The takes run in that order, each from its own plan.

## 1. Checkout and offline checks

Needs: Node.js 22, a clean checkout of the commit to be built.

```sh
git status --porcelain   # must print nothing
npm ci
npm run test:cue-lab
node -p "process.version + ' ' + process.versions.uv"
```

Proves it: the tests pass, and the last line prints `v22.23.2 1.51.0`. **Verified from code:** `createLabPlayer` refuses any other Node or libuv version, on macOS only.

## 2. Build the lab app

Needs: Xcode command line tools, the [Rust and Tauri prerequisites](../CONTRIBUTING.md#run-and-check-the-prototype), several GiB of free disk above the project's floor ([disk](real-app-lab.md#disk)).

```sh
TALKQTE_COMMIT="$(git rev-parse HEAD)" \
  npm run tauri -- build --debug --bundles app \
  --features lab-evaluator,native-audio-spike,timing-log
```

Proves it: `src-tauri/target/debug/bundle/macos/TalkQTE.app` exists (or under `$CARGO_TARGET_DIR`). **Verified from code:** the launcher accepts exactly the four features `cloud-transcription`, `lab-evaluator`, `native-audio-spike` and `timing-log` (`lab-evaluator` turns on `cloud-transcription`), a debug build, and nothing else. This build must never be distributed.

Copy the bundle into a private folder so a later rebuild cannot change it under the receipt. The launcher does not require this; it refuses to launch a bundle whose executable changed after its receipt was written.

```sh
PRIVATE="$HOME/talkqte-lab-private"   # placeholder, outside the checkout
mkdir -p "$PRIVATE/build" && chmod 700 "$PRIVATE" "$PRIVATE/build"
ditto src-tauri/target/debug/bundle/macos/TalkQTE.app "$PRIVATE/build/TalkQTE.app"
```

## 3. Sign the app

Needs: the self-signed `TalkQTE Development` code-signing identity in the login keychain ([a stable development signature](real-app-lab.md#a-stable-development-signature)). Sign with that identity only.

```sh
codesign --force --deep -s "TalkQTE Development" -i com.talkqte.desktop \
  "$PRIVATE/build/TalkQTE.app"
codesign --verify --strict --deep "$PRIVATE/build/TalkQTE.app"
codesign --display --verbose=4 --requirements - "$PRIVATE/build/TalkQTE.app" 2>&1 \
  | grep -E '^(Identifier|Authority|Signature|designated)'
```

Proves it: the verify line prints nothing and exits 0; the display shows `Identifier=com.talkqte.desktop`, exactly one `Authority=TalkQTE Development` line, no `Signature=adhoc`, and `designated => identifier "com.talkqte.desktop" and certificate leaf = H"…"`. **Verified from code:** these are the launcher's checks, repeated immediately before launch. **_To confirm on the Mac_:** that `--deep` signing with the self-signed root gives exactly one `Authority=` line.

## 4. The app's build receipt

Needs: the signed bundle. Write `native-manifest.json` in a private folder, mode `0600`, at most 16 KiB:

```json
{
  "schema": "talkqte.lab.build.v1",
  "executable": "/Users/you/talkqte-lab-private/build/TalkQTE.app/Contents/MacOS/talkqte",
  "bundlePath": "/Users/you/talkqte-lab-private/build/TalkQTE.app",
  "sha256": "<shasum -a 256 of the executable>",
  "commit": "<git rev-parse HEAD of the build>",
  "features": [
    "cloud-transcription",
    "lab-evaluator",
    "native-audio-spike",
    "timing-log"
  ],
  "debug": true,
  "signature": {
    "identifier": "com.talkqte.desktop",
    "authority": "TalkQTE Development",
    "designatedRequirement": "<the text after 'designated => '>"
  }
}
```

```sh
shasum -a 256 "$PRIVATE/build/TalkQTE.app/Contents/MacOS/talkqte"
codesign -d -r- "$PRIVATE/build/TalkQTE.app" 2>&1 | sed -n 's/^designated => //p'
chmod 600 "$PRIVATE/build/native-manifest.json"
shasum -a 256 "$PRIVATE/build/native-manifest.json"
```

Proves it: the plan's `native.approved` tuple (`manifestSha256`, `executableSha256`, `commit`) matches these values, and the [dry run](#10-the-plan-and-its-dry-run) passes its "native build receipt" step. **Verified from code:** paths must be absolute and canonical (`realpath`), the manifest outside the checkout and owned by you. The approval tuple comes from the person reviewing the receipt, never from the receipt itself.

## 5. The owned player and its receipt

Needs: the player sources `scripts/lab-owned-player.swift`, `scripts/lab-player-state.c` and its header. **_To confirm on the Mac_:** the repository has no player build script. The commands below are the offline input test's compile (`scripts/cue-lab-player-input.test.mjs`) without its test flag, plus a bundle layout that matches what the player check reads:

```sh
P="$PRIVATE/build/TalkQTE Lab Player.app"
mkdir -p "$P/Contents/MacOS"
/usr/bin/clang -target arm64-apple-macos14.0 -std=c11 -Wall -Wextra -Werror \
  -c scripts/lab-player-state.c -o "$PRIVATE/build/lab-player-state.o"
/usr/bin/swiftc -target arm64-apple-macos14.0 -warnings-as-errors \
  -import-objc-header scripts/lab-player-state.h \
  scripts/lab-owned-player.swift "$PRIVATE/build/lab-player-state.o" \
  -framework AppKit -framework AVFoundation -framework CryptoKit -lproc \
  -o "$P/Contents/MacOS/lab-owned-player"
/usr/libexec/PlistBuddy \
  -c 'Add :CFBundleIdentifier string com.talkqte.lab-player' \
  -c 'Add :CFBundleExecutable string lab-owned-player' \
  -c 'Add :CFBundleName string TalkQTE Lab Player' \
  -c 'Add :CFBundlePackageType string APPL' \
  "$P/Contents/Info.plist"
codesign --force -s "TalkQTE Development" -i com.talkqte.lab-player "$P"
```

Write `player-manifest.json` (mode `0600`) with `schema: "talkqte.lab.player.build.v1"`, `executable` (`…/TalkQTE Lab Player.app/Contents/MacOS/lab-owned-player`), `bundlePath`, `sha256` of the executable, `commit`, and `signature` with `identifier: "com.talkqte.lab-player"`, `authority: "TalkQTE Development"` and the designated requirement, exactly as in step 4 but without `features` and `debug`.

Proves it: the same `codesign` display as step 3 shows `Identifier=com.talkqte.lab-player`; the dry run passes "player build receipt". **Verified from code:** the player bundle must be outside the checkout; `createLabPlayer` repeats the signature, Info.plist and hash checks before it starts the player. **_To confirm on the Mac_:** whether the player needs any other Info.plist key, and that it opens its window and plays (offline tests use a harmless Node stand-in, never the Swift player).

## 6. The recorder helper

Needs: Xcode command line tools. Build `scripts/lab-window-capture.swift` with the same flags `scripts/lab-window-record.mjs` uses, into the private folder:

```sh
swiftc -O -parse-as-library -swift-version 5 \
  -o "$PRIVATE/build/lab-window-capture" scripts/lab-window-capture.swift \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia \
  -framework CoreGraphics -framework CoreImage
shasum -a 256 "$PRIVATE/build/lab-window-capture"
```

A helper built before 24 November 2026 must be rebuilt with the command above, with the new hash put in the plan. **Verified on a development Mac (macOS 26.4):** the helper as built on 17–23 November either recorded nothing or hung before printing anything in about 4 starts in 10. Building the desktop-independent window filter aborted inside macOS (`CGS_REQUIRE_INIT`) until the helper connected to the window server first. The child processes that probed that filter made ScreenCaptureKit itself unreliable: a child's or the parent's window listing never answered or failed, and a stream started right after a child exited was stopped (`-3805`). The helper now connects to the window server first, starts no child, and gives both windows the desktop-independent filter (`filters` reports `independent` for both). It lists the windows once, with a 1.5 s bound (`list-timeout`), and bounds each stream start at 1.5 s (`start-timeout`), so a start never hangs silently. A stream macOS stops prints reason `stream-stopped` with macOS's numeric code. The recorder keeps the reason, the code and the times from spawn to `matched`, `filters` and `frame_accepted` (`failureDetail.timings`), and `take-outcome.json` carries them. Thirty consecutive starts, 0.5 s apart, with two real windows all accepted a frame: `matched` at 72 / 82 / 149 ms and `frame_accepted` at 481 / 611 / 1012 ms (min / median / max), within the recorder's 3000 ms start budget.

Proves it: the plan's `helper.sha256` matches and the dry run passes "recorder helper". **Verified from code:** the recorder and the strict window selector hash the helper again before use; it must be outside the checkout and at most 64 MiB. Recordings go into the evidence folder.

The runner builds one more small helper itself, `scripts/lab-recording-duration.swift`, which measures the finished recording for the evidence writer ([runner settings](#runner-settings)). It needs the same command line tools; nothing to do here. **Verified on a development Mac:** it compiles with the runner's command (about 40 s the first time) and reports an audio file's duration to the microsecond, matching `afinfo`. **_To confirm on the Mac_:** its result on a real recording.

## 7. Media

Needs **the fixed meeting**, the only media the owner approved for an attempt: copy the fixed MP4 into an owner-only (`0700`) folder. `shasum -a 256` must print the `LAB_FIXED_MEDIA_SHA256` value in `scripts/cue-lab-media.mjs`. The plan names it as `"media": { "fixedPath": "<absolute path>" }`.

The dry run also accepts a per-run scenario, a `talkqte.fresh-scenario.media.v1` manifest ([fresh scenarios](lab-fresh-scenarios.md)) named as `"media": { "manifestFile": "<absolute path>", "sha256": "<approved sha256>" }`, but the runner refuses it.

Proves it: the dry run passes "media" and prints the duration and scenario. **Verified from code:** media is at most 104 s; a hand-built descriptor is refused; the player hashes the file again and refuses a measured duration more than 100 ms from the approved one.

## 8. Key files and environment

Needs, for a real take: `~/.config/talkqte-lab/anthropic.env` holding exactly `TALKQTE_LAB_ANTHROPIC_KEY=<Console API key>` and `~/.config/talkqte-lab/deepgram.env` holding exactly `TALKQTE_LAB_DEEPGRAM_KEY=<key>`. The folder is `0700` and each file `0600`, owned by you, outside any repository or temporary folder ([key handling](lab-providers.md#direct-anthropic-api-route), [Deepgram token](lab-owned-launcher.md#cloud-transcription-token)). A [provider-failure take](#provider-failure-take) needs no Deepgram key.

Check the modes without opening the files:

```sh
stat -f '%Sp %Su %N' ~/.config/talkqte-lab ~/.config/talkqte-lab/*.env
env | grep -E '^(ANTHROPIC_|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_OPTIONS|NODE_USE_ENV_PROXY)='
```

Proves it: `drwx------` for the folder and `-rw-------` for each file; the `env` line prints nothing, and the dry run passes "environment". **Verified from code:** none of those settings may be present, even empty. The dry run never reads the key files: the Deepgram key is read before launch to mint a 900 s token (one request to Deepgram), the Anthropic key only after the in-app approval. A bad key file therefore fails the take later, not the dry run.

## 9. Permissions

Needs: Screen & System Audio Recording, in System Settings → Privacy & Security, for:

- **TalkQTE**, signed as in step 3. Remove older TalkQTE entries first; an entry for another signature makes macOS deny the new build without asking ([build](real-app-lab.md#build)).
- **The app the take runs from** (Terminal, for example), for the recorder helper. Restart that app after allowing it.

Proves it: both entries are on before the take. A new prompt during the take means stop; there is no workaround. **_To confirm on the Mac_:** that the player needs no permission (it uses no microphone or network) and that a signed TalkQTE keeps its grant across rebuilds signed the same way.

## 10. The plan and its dry run

Needs: steps 4–8. Write `plan.json` in a private folder (owner-only, at most 16 KiB) and an evidence folder (`0700`). For a normal take:

```json
{
  "schema": "talkqte.lab.take-plan.v1",
  "runId": "fictional-take-01",
  "fictional": true,
  "native": {
    "manifestFile": "/Users/you/talkqte-lab-private/build/native-manifest.json",
    "approved": {
      "manifestSha256": "<64 hex>",
      "executableSha256": "<64 hex>",
      "commit": "<40 hex>"
    }
  },
  "player": {
    "manifestFile": "/Users/you/talkqte-lab-private/build/player-manifest.json",
    "approved": {
      "manifestSha256": "<64 hex>",
      "executableSha256": "<64 hex>",
      "commit": "<40 hex>"
    }
  },
  "helper": {
    "path": "/Users/you/talkqte-lab-private/build/lab-window-capture",
    "sha256": "<64 hex>"
  },
  "media": {
    "fixedPath": "/Users/you/talkqte-lab-private/media/fixed-meeting.mp4"
  },
  "selection": {
    "provider": "anthropic-api",
    "model": "claude-opus-5-5",
    "effort": "low",
    "maxCalls": 40
  },
  "transcription": { "backend": "deepgram", "minuteCap": 5 },
  "evidenceDirectory": "/Users/you/talkqte-lab-private/evidence"
}
```

Optional fields: `tailMs` (0–15000), `turnOffAfterMs` ([turn-off take](#turn-off-take)), `userName` (the app's own name rule), `contextPolicy` (`fresh-only`, `bounded-history` or `selected-prior-v2`, each needing a build that implements it), and `transcription.reconnect: true` or `transcription.failureProbe: "refused-token"`. No other field is accepted, and the plan never holds a grant or key. The runner takes `runId`, `tailMs`, `turnOffAfterMs`, `userName` and `contextPolicy` from the plan and nothing else; an absent field stays absent (no tail, no name, `fresh-only`).

Each take needs a new plan: change at least `runId` (for example `fictional-take-02`), which changes the sha256.

```sh
npm run lab:take -- --plan /Users/you/talkqte-lab-private/plan.json
```

Proves it: the first line reads `Plan valid (dry run). Nothing was launched, no key file was read.`, followed by the plan's sha256, the four executables and the media it would launch, the timing (approval within 180 s of Listening, native Stop at 320 s, the take's 135 s after approval), what goes to Deepgram and to the Anthropic API, the spend bounds, and the execute command with this sha256. A refused plan prints `Plan refused at <step>` and exits 1. The owner reviews that output and records the plan sha256 with the approval.

**Verified from code:** the dry run uses the launcher's own scope check (`assertLabLaunchOptions`, `assertLabTranscriptionRoute`), the receipt checks (`validateLabBuildRecord`, `validateLabPlayerBuildRecord`), the media loaders and `assertFixedModelTakeOptions`. It does not check signatures, hash the app or player executables, read key files or measure disk space; those happen when a take runs. The model and call cap are fixed by the code: the direct API route runs a listed model at effort `low` with exactly 40 calls, and a local estimated-spend guard of $1.00 for Opus or $0.25 for Sonnet and Haiku ([limits](lab-providers.md#direct-anthropic-api-route)). Deepgram cost is not computed by the code; the minute cap (1–60) bounds the stream.

## 11. Run the take

Needs: the reviewed plan sha256, the owner at the Mac with TalkQTE's window area free, and at least 5 GiB free on the evidence folder's volume. The owner starts the runner in a terminal (Terminal, if that is the app with the recorder permission):

```sh
npm run lab:take -- --plan /Users/you/talkqte-lab-private/plan.json \
  --execute --confirm <plan sha256>
```

The runner, in order:

1. Prints the same dry run as step 10 (its first line reads `Plan valid. Checking this attempt before anything is launched.`); a refused plan stops here (exit 1). `--confirm` must equal the plan's sha256 exactly.
2. Refuses a plan outside the [owner decisions](#owner-decisions) (`Plan refused at owner decisions`): only `claude-opus-5-5`, a minute cap of 5 and the fixed meeting.
3. Refuses to start under any Node other than v22.23.2 with libuv 1.51.0 on macOS, which the owned player requires (`Plan refused at runtime`), and below 5 GiB free on the evidence volume (`Plan refused at disk`).
4. Refuses a plan whose attempt was already used (`Plan refused at attempt`). Then it runs the launcher's and the player's own receipt, executable-hash and signature checks (`Plan refused at native build signature` or `player build signature`; both are repeated at launch), prints `Building the recording-duration helper …` and builds the [duration helper](#6-the-recorder-helper) (up to two minutes the first time), and creates the attempt marker `take-attempt-<plan sha256>.json` (owner-only, exclusive) in the evidence folder. Nothing has been launched and no key file has been read up to here, and every check that needs nothing private has run, so none of them can use up the attempt. A failed or interrupted attempt keeps its marker; a new attempt needs a new plan.
5. Sweeps stale tokens: `removeStaleTranscriptionTokens()` (`scripts/cue-lab-launcher.mjs`). It touches only owner-only `tq-owned-*` folders whose run provably ended.
6. Opens the evidence writer: `createLabEvidenceWriter({ parentDirectory: evidenceDirectory, runId, fictional: true, mode: 'prepared', contentMode: 'fictional-content', onFailure })`, with `onFailure` stopping the take, and declares the `node` and `native-logger` clocks. It prints the evidence folder.
7. Prepares the player before anything else: `createLabPlayer({ runId, manifestFile, approved, startMs: 1000 })`, then `player.prepare({ media })` with the media descriptor the dry run loaded.
8. Mints the Deepgram grant, unless this is a provider-failure take: `mintDeepgramGrant()` (reads `deepgram.env`, one request).
9. `prepareLabLauncher({ manifestFile, approved, mode: 'model-enabled', selection, sourceApplication: 'TalkQTE Lab Player', playerSource: player.identity, stopAfterS: 320, transcription: { backend: 'deepgram', minuteCap, grant }, environment })`, adding `userName`, `contextPolicy` or `turnOff: true` when the plan names them, and `ownProcessGroup: true` so TalkQTE runs in its own process group. It verifies the signature and creates the run folder; it launches nothing yet. The grant's TTL (or the probe) is recorded in the manifest.
10. `createLabSourceV1({ launcher, application: 'TalkQTE Lab Player', commit, features })` with the receipt's commit and features.
11. `createLabOwnedWindowSelector({ binary, sha256, playerSource: player.identity, native: launcher, nativeApplication: 'TalkQTE' })` and `createLabRecorder({ binary, sha256, directory: writer.directory, selectWindows, native: launcher, playerSource: player.identity, seconds: 180, startupMs: 3000 })`.
12. `createFixedModelTake({ settings: { ...selection, deadlineMs: 30000, execution: 'api', environment }, runId, launcher, source, player, recorder, media, stopAfterS: 320, approvalBudgetMs: 180000, takeMs: 135000, onApproval, observe, onGuard, signal })`, with `tailMs` and `turnOffAfterMs` from the plan; `observe` stops the take when `writer.emit` returns false, and `onGuard` goes to `writer.recordGuard`. Then it waits for `take.done`.

The take then runs on its own: it launches TalkQTE, waits for the exact player's Listening, waits for the [in-app approval](#12-the-in-app-approval), opens the provider, releases the Deepgram token, starts the recorder, starts playback, and stops and cleans up at the end ([composition and startup order](lab-prepared-take.md#composition-and-startup-order)). **Verified from code** for each interface and against offline compositions (`scripts/cue-lab-prepared-take.test.mjs`, and `scripts/cue-lab-take.test.mjs` for the runner with the existing fixtures); the whole composition has not run a real take.

**Stopping:** Ctrl-C (SIGINT) or SIGTERM in the runner's terminal asks the take's ordinary Stop and cleanup. The terminal sends Ctrl-C to its whole foreground process group; the runner launches TalkQTE in its own process group, so the signal reaches only the runner, which then stops the app with the lab's Stop (SIGUSR2) and waits for its release. (Launched in the runner's group, TalkQTE would get the same SIGINT and exit through its own handler, without the lab's Stop; `scripts/cue-lab-launcher.test.mjs` shows both.) The player and recorder already run in their own groups. The runner prints one `SIGINT: stopping …` line, ignores repeated signals, and still writes the evidence and report.

Before the take exists, a stop takes effect at the next step: nothing is launched, and the prepared player is retired. A Ctrl-C while the Deepgram grant is being minted lets that one request finish; the grant is then discarded unused and nothing reaches the app. After the take settles the runner always retires the player, also when the take could not (release unconfirmed); the outcome records whether native was released.

Do not force-quit the runner: a killed runner skips cleanup, and TalkQTE, in its own group, would keep running.

### Runner settings

What the modules leave open, fixed in `RUNNER_SETTINGS` (`scripts/cue-lab-take.mjs`):

| Setting                              | Value                                                                                        | Why                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recorder `seconds`                   | 180                                                                                          | The recorder's maximum. The helper must outlast the take's 135 s after approval plus native release; the take stops it earlier.                                                      |
| Recorder `startupMs`                 | 3000                                                                                         | The take's own recorder budget (`recorderMs`).                                                                                                                                       |
| Player `startMs`                     | 1000                                                                                         | Must fit the take's 1 s start budget.                                                                                                                                                |
| Provider `deadlineMs`                | 30000                                                                                        | The value the fixed-take tests use.                                                                                                                                                  |
| Run `startupMs` after approval       | 30000                                                                                        | The run's maximum. The app greets the lab broker only with its first cue request, which needs the first transcript line; the 10 s default ended a real take 8 s into playback.       |
| Launcher and provider environment    | `HOME`, `PATH`, `TMPDIR`, `LANG`, `LC_ALL` from the runner's own environment                 | The only names either forwards to its children.                                                                                                                                      |
| Window selector `nativeApplication`  | `TalkQTE`                                                                                    | The bundle's product name (`src-tauri/tauri.conf.json`).                                                                                                                             |
| Evidence writer limits and retention | the writer's defaults: 4 MiB per file, 16 MiB in total, 10 000 events, 7 days                | No reason found to change them; expiry is metadata only.                                                                                                                             |
| Tail, user name, context             | from the plan only; absent means none, none, `fresh-only`                                    | The user name is never taken from the scenario.                                                                                                                                      |
| Report content                       | metadata only (the report's default)                                                         | Re-run the report with `--fictional-content` into a new folder for the transcript and cue text ([step 14](#14-evidence-and-report)).                                                 |
| Recording duration                   | `scripts/lab-recording-duration.swift`: AVFoundation's precise duration of the finished file | Exact to the movie's timescale (1/timescale s, usually well under 1 ms). macOS ships no `ffprobe`; `afinfo` cannot open a QuickTime movie, and `mdls` depends on Spotlight indexing. |

## 12. The in-app approval

Needs: the owner at the Mac. After Listening, TalkQTE shows its cue processing review, and the runner prints one line: `TalkQTE is Listening. Press Review processing, Review selected sources, Enable for this session NOW: 180 s remain.` Within that time press **Review processing**, **Review selected sources**, **Enable for this session**. This in-app approval is the only consent for sending audio and text; the terminal confirmation only started the attempt.

Proves it: the runner prints `In-app approval received after <n> s`; the timing log has an `evaluator` row with `state` `on`, `approval` `review`, `backend` `lab-api` and the launched model. **Verified from code:** before approval no Anthropic key file is read, no provider worker starts and nothing is sent; no approval in time stops the take as `approval-not-given` with nothing played; an approval by launch setting, or naming another backend or model, stops it as `approval-fault`. The attempt was already recorded before launch, so an approval that is not given still uses it. **_To confirm on the Mac_:** the exact wording and position of the three controls in this build.

## 13. The recording

Needs: TalkQTE's companion window and the player window visible, nothing else playing.

Proves it: the recorder accepts its first frame within 3 s of approval; the player reports its actual render start (mapped with measured uncertainty, at most 100 ms with calibration); the timing log shows `stt_state` `connected`, then lines and cue decisions; the media plays to the end, the optional tail runs, and the take stops. **Verified from code:** a late start is stopped, never restarted; cleanup stops the run and player, waits for native release and provider cleanup, then finalizes the recorder before retiring the player. `take.done` resolves with `completed`, `nativeReleased`, `dispatchesUsed`, `clockCalibration` and `guard`. Quiet is a valid result; publication is not paint.

## 14. Evidence and report

The runner does this after the take settles, and only after native release and recorder finalization:

1. Snapshots the timing file with `snapshotLabTiming` ([timing snapshot](lab-timing-snapshot.md)) and attaches it as `native-timing` on the `native-logger` clock (released by Stop, or ended by native itself).
2. Measures the recording (`recorder.output`) with the duration helper and attaches it with that `durationMs`.
3. `writer.close()` writes the manifest.
4. Writes the report into `<evidence>/tq-evidence-XXXX/report` (`writeEvidenceReport`, metadata only).
5. Writes `take-outcome.json` beside the manifest: the take's terminal state, `failure`, `failedStep`, `runStopReason`, `approval`, `turnOff`, `dispatchesUsed`, `providerSpentMicroUsd`, `providerReceipts`, `evaluationSummary`, `startupDiagnostics`, the launcher's content-free transcription facts, `player.diagnostics`, the recorder's `failureDetail` and report, and what was attached. It never holds a token, key or transcript.

It then prints `Take ended: <state> (…)`, the report path and the outcome path, and exits 0 when the report was written (1 otherwise). **The runner claims nothing:** a `completed` state is not an accepted take. The coordinator reviews the evidence afterwards; visible cues still need a person to check recording frames.

To include the fictional transcript and cue text, write a second report into a new folder:

```sh
node scripts/cue-lab-evidence-report.mjs --fictional-content \
  --manifest <evidence>/tq-evidence-XXXX/manifest.json \
  --out <evidence>/tq-evidence-XXXX/report-content
```

Proves it: `report.md` and `report.json` exist (mode `0600`) with the timeline, transcription coverage, cue decisions and the human review table ([evidence report](lab-evidence-report.md)). **Verified from code:** the writer refuses a recording without a duration, and neither the report nor the runner deletes anything.

## 15. Cleanup

Proves it, each separately:

- **Native release:** `take.done` reports `nativeReleased: true` and the timing log has `dev_stop` `released`. Process exit or an elapsed timer is not release.
- **Recorder:** finalized, with the recording in the evidence folder.
- **Player:** retired (exit zero, process group gone) only after native release and recorder finalization.
- **Token:** the Deepgram token file is gone from the run's `tq-owned-*` folder: `ls -la "$TMPDIR"/tq-owned-*`.
- **The app:** the TalkQTE process may keep running after release; there is no lab path that ends it, and the runner never kills it. The runner prints `TalkQTE keeps running after its release: quit it from its menu.` and exits once TalkQTE has quit; after the report is written, Ctrl-C ends only the runner, not TalkQTE. **_To confirm on the Mac_:** that it quits cleanly from its menu after a lab take.
- **Evidence:** expiry is metadata only (seven days by default); deleting private evidence is the owner's manual step.

## After a failure

Keep everything: the attempt marker, the evidence folder (partial recording included, with `take-outcome.json`), and the run's `tq-owned-*` folder until its token is swept. Record the first failure as reported; later failures never replace it.

Do not retry, restart or resume the same take, kill the app and call it release, or work around a permission prompt. If release is unconfirmed, cleanup counts as failed (`failed-cleanup`); the take keeps the player, and the runner retires it once the take has settled. Whether the app released its capture is then the owner's to check. The runner refuses the same plan again; a new take needs a new plan and its review ([owner decisions](#owner-decisions)).

## Variants on main

### Provider-failure take

The second take. Plan: `"transcription": { "backend": "deepgram", "minuteCap": 5, "failureProbe": "refused-token" }` (the dry run accepts any cap from 1 to 60; the runner only 5). No Deepgram key is read and nothing is minted; at approval the launcher writes a fixed text that Deepgram is expected to refuse (401, code `auth`). The app ends the session and the take ends `stopped`; the result is in the evidence report. If the app reports `connected` for it, the run stops. The dry run shows `kind: provider-failure` and "no key file read". **_To confirm on the Mac_:** no probe has been run against Deepgram ([refused-token probe](lab-owned-launcher.md#cloud-transcription-token)).

### Turn-off take

The third take. Plan: `"turnOffAfterMs": <1 to less than the media's duration>`, never with the probe. The runner prepares the launcher with `turnOff: true`. At that time after the render start the take sends one SIGUSR1; native withdraws processing as **Disable processing** does and reports `dev_off` `done`. If the run then ends as `lab-ended` or `session-ended`, the take ends `stopped` with failure `turned-off`. The dry run shows `kind: turn-off` and the time. **_To confirm on the Mac_:** no turn-off has been run in the app ([turning processing off](lab-prepared-take.md#provider-failure-and-turning-processing-off-t5)).

### Both-sided session: not supported by the take path

`TALKQTE_DEV_APPLICATION_WITH_MICROPHONE=1` is a development setting for a manual call with both sides: the app waits up to five minutes for a microphone session the person starts, then attaches the application to it ([start and stop without clicks](real-app-lab.md#start-and-stop-without-clicks)). **The lab take path does not support it.** What is missing, verified from code:

- the launcher keeps only its own frozen settings and cannot pass this one;
- native refuses it in a lab run (`with_microphone_unsupported`), because a lab run binds a session for the application alone;
- the lab Stop handshake admits only source-only sessions and permanently refuses admitted microphone history;
- the source observation, recorder audio and evidence are for one application; nothing records or attributes the microphone side;
- the session review names one capture source, not both.

A both-sided take would need native, launcher, recorder and evidence changes, a fictional second voice at the microphone (and headphones against pickup of the app's sound), and its own review. Several synthetic voices inside the player's audio do not establish both sides of a call.

## Owner decisions

Made by the owner on 23 November 2026 and enforced by the runner:

1. **Approval:** approving a plan covers one attempt per plan sha256, in that sitting only. The in-app approval (Review processing → Review selected sources → Enable for this session, within 180 s) is the only consent step for sending audio and text; the terminal confirmation only starts the attempt. The runner enforces one attempt with the marker; keeping to one sitting is the owner's.
2. **Media:** the existing fixed fictional meeting.
3. **Model and budget:** `claude-opus-5-5`, the code's fixed 40 calls and $1.00 local estimate, and a Deepgram minute cap of 5.
4. **Order of takes:** normal, then [provider failure](#provider-failure-take), then [turn-off](#turn-off-take); each its own plan and its own attempt. The runner does not enforce the order.
5. **Roles:** the owner starts the runner in a terminal, presses the approval controls and watches for permission prompts. The coordinator prepares the plan and reviews the evidence afterwards.

Also settled in code: the [runner settings](#runner-settings), the recording duration tool, a 5 GiB free-space floor on the evidence volume, and that the runner deletes no evidence (expired private evidence stays until the owner deletes it). The take path supports only the owned TalkQTE Lab Player; any other application or a both-sided session needs code changes first.

## To confirm on the Mac

Not checked from code alone; confirm at the first run and stop if any differs:

- `--deep` signing with the self-signed root gives exactly one `Authority=` line ([step 3](#3-sign-the-app)).
- The player build commands, any other Info.plist key the player needs, and that it opens its window and plays ([step 5](#5-the-owned-player-and-its-receipt)).
- The duration helper's result on a real recording ([step 6](#6-the-recorder-helper)).
- That the player needs no permission, and a signed TalkQTE keeps its grant across rebuilds signed the same way ([step 9](#9-permissions)).
- That the companion window's application name is `TalkQTE` for this bundle, as the window selector is told ([runner settings](#runner-settings)).
- The exact wording and position of the three approval controls ([step 12](#12-the-in-app-approval)).
- That TalkQTE quits cleanly from its menu after a lab take ([step 15](#15-cleanup)).
- The refused-token probe against Deepgram and a turn-off in the app, neither run yet ([variants](#variants-on-main)).
