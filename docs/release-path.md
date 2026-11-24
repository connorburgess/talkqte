# macOS release path

Status: 24 November 2026. **No signed, notarized or installable release exists.** Nothing here has been run with a Developer ID certificate, sent to Apple's notary service, or installed on a clean Mac. Everything that needs no credentials is scripted: once the owner's Apple credentials are in the environment, [`npm run release`](#24-sign-notarize-staple-package-verify-npm-run-release) builds, signs, notarizes, staples, packages and verifies the download in one command, and CI does the same from repository secrets. This page records what the repository already settles, what a script can check today, and the exact steps left for the owner. It supports the open roadmap item "Prove a signed, notarized installation and a recoverable upgrade on a clean supported Mac"; that item stays open until every step below marked **Owner** has recorded evidence.

Each step has one of three states:

- **In place:** configured in the repository and checked by the pre-flight or by CI.
- **Scriptable now:** a command exists and needs no credentials, but its release-level result needs an artifact only the owner can produce.
- **Owner:** needs the Apple Developer account, the signing certificate, a clean Mac, or a decision.

## Current state

Read from `main` at `83e5223`, from one release build made with `npm run release -- --adhoc`, and (for the bundle contents) from an earlier debug build.

| Subject               | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle identifier     | `com.talkqte.desktop` in `src-tauri/tauri.conf.json`. It names the data folder and the microphone permission record, so it must not change between releases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Version               | `0.1.0`, stated separately in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`. The bundle takes its version from `tauri.conf.json`. Nothing kept them equal before the pre-flight.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Entitlements          | `src-tauri/Entitlements.plist` requests only `com.apple.security.device.audio-input`, which the hardened runtime requires for the microphone. Nothing else is needed outside the App Sandbox, which TalkQTE does not use: ScreenCaptureKit application audio needs no entitlement (macOS asks for Screen & System Audio Recording instead, and has no usage-description key for it); the provider keys are generic passwords in the login keychain, which need no keychain entitlement; network access is restricted only inside the sandbox. A menu bar item and a login item registered with `SMAppService.mainApp` need none either. Embedded by `npm run release`; checked on an ad-hoc copy. |
| Hardened runtime      | `npm run release` signs with `--options runtime` itself; Tauri's own signing is switched off for the build. Observed on the ad-hoc copy (`flags=0x10002(adhoc,runtime)`), which started and ran with it. Not yet observed under a Developer ID signature.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Permission text       | `src-tauri/Info.plist` supplies `NSMicrophoneUsageDescription`: the microphone is used only after you start it, to show whether there is input and, during a live session you start, to transcribe speech; TalkQTE does not save audio; it sends audio to Deepgram, with your own key, only after you approve that for the session. That matches the app on `main`. Screen & System Audio Recording has no usage text; the notebook explains it before macOS asks. Neither prompt has been seen on a clean Mac.                                                                                                                                                                                   |
| Minimum macOS         | `14.0` in the configuration, matching the [agreed first supported setup](budgets.md#proposed-first-supported-setup). The builds inspected on this page were made while it was `13.0`; no bundle built with `14.0` has been inspected here, and no macOS 14 system has run the app.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Bundle targets        | `app` only in `tauri.conf.json`. `npm run release` makes the disk image and the zip itself, from the signed and stapled app, with `SHA256SUMS` and a manifest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Live transcription    | With the person's own Deepgram and Anthropic keys, a release transcribes through Deepgram and asks the Anthropic API for cues once the session review is approved ([cloud transcription](cloud-transcription.md), [cue decisions](own-key-cues.md)). Without them it refuses a live start and names the missing key. The development `cloud-transcription` feature, which only points a launch at a token file, is refused by the pre-flight. On-device transcription (`local-whisper`) was removed on 16 November 2026.                                                                                                                                                                          |
| Updater               | None installed. The feed format, the reader and the rule that no update is offered during a call are in `src-tauri/src/updates.rs`, off in every build; see [updates](#updates). No updater plugin, endpoint or update-signing key exists. An update is a manual replacement of the app.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Third-party notices   | `src-tauri/THIRD-PARTY-NOTICES.txt`, generated by `npm run notices` and placed in the bundle at `Contents/Resources/`; see [third-party notices](#third-party-notices).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Data on disk          | None written by the app's own code apart from an export you save. Notes, transcripts, settings and the Granola connection live in memory only ([privacy](../PRIVACY.md)). A speech model downloaded by an earlier development build stays at `~/Library/Application Support/com.talkqte.desktop/models/ggml-tiny.en.bin`; the app no longer reads or deletes it, and the person can delete the `models` folder ([model delivery](model-delivery.md)).                                                                                                                                                                                                                                             |
| Keychain              | Provider keys the person adds are generic passwords under the service `app.talkqte.provider-key` (accounts `deepgram`, `anthropic`) in the login keychain. They outlive the app; see [uninstall](#10-uninstall).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| CI                    | `.github/workflows/release.yml` builds the download on a tag, on manual dispatch and on pull requests that touch the release path, and uploads it as a workflow artifact; signing and notarization run only when their [secrets](#ci) exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Other per-app folders | The system web view and macOS create `~/Library/WebKit/com.talkqte.desktop`, `~/Library/Caches/com.talkqte.desktop` and `~/Library/Preferences/com.talkqte.desktop.plist`. Their presence was seen on the development Mac; the app's own code writes nothing there.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Earlier measurements  | A release bundle with the former `local-whisper` feature (removed 16 November 2026), ad-hoc signed, arm64: 15.3 MiB, 4.7 MB zipped ([operating estimates](operating-estimates.md#measured)). Disk image, universal and notarized builds were not measured. [Platforms](platforms.md) records Windows and Ubuntu builds only; it has no macOS installation evidence.                                                                                                                                                                                                                                                                                                                               |

### What the debug bundle contains

`npm run tauri -- build --debug --bundles app` on an Apple M5 Pro (macOS 26.4, arm64), without the former `local-whisper` feature:

| Item                | Observation                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files               | `Contents/Info.plist` (1,208 bytes), `Contents/MacOS/talkqte` (48,221,528 bytes), `Contents/Resources/icon.icns` (48,211 bytes). Nothing else.                                                       |
| Size                | 48,270,947 bytes (46.0 MiB). This is a debug build; it is not a download size.                                                                                                                       |
| `Info.plist`        | Identifier, version `0.1.0`, minimum macOS (`13.0` at that commit) and the microphone text all matched the configuration.                                                                            |
| Executable          | arm64 only; `LC_BUILD_VERSION` minimum macOS 13.0 at that commit.                                                                                                                                    |
| Signature           | Ad-hoc and applied by the linker to the executable only: no sealed resources, no bound `Info.plist`, no team, no hardened runtime, no entitlements. `codesign --verify --deep --strict` fails on it. |
| Build-machine paths | The executable contains paths under the building user's home folder (from compiler panic locations and debug information). See step 1.                                                               |
| Frontend            | Embedded in the executable; no loose web files, source maps or model weights are in the bundle.                                                                                                      |

A second debug build after the notices were added also carries `Contents/Resources/THIRD-PARTY-NOTICES.txt` (515,708 bytes), identical to the repository's copy.

A copy signed ad-hoc with `--options runtime` and the entitlements file carried exactly the one requested entitlement. That confirms the entitlements file is well formed. It is not Developer ID signing.

## Pre-flight script

`scripts/release-preflight.mjs` signs nothing, uploads nothing and never launches the app. The configuration, bundle and `--expect signed` checks work offline. `--expect notarized` runs `xcrun stapler validate`, which asks Apple's ticket service about the artifact, and `spctl`, which may also go online.

```sh
npm run check:release                                             # configuration only
node scripts/release-preflight.mjs path/to/TalkQTE.app            # plus a built bundle
node scripts/release-preflight.mjs --expect signed path/to/TalkQTE.app
node scripts/release-preflight.mjs --expect notarized path/to/TalkQTE.app
```

It exits 0 when every check passes, 1 when any fails (each failure names the check and the reason), and 2 for a usage error.

| Check                      | Fails when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version                    | The five version files (six places, counting both entries in `package-lock.json`) disagree, or the version is not `MAJOR.MINOR.PATCH`; with a bundle, when its `Info.plist` differs.                                                                                                                                                                                                                                                                                                                                                    |
| Bundle identifier          | It is not a reverse-domain name or ends in `.app`; with a bundle, when its `Info.plist` differs.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Signing configuration      | A signing identity is committed in `tauri.conf.json`, the hardened runtime is turned off, or a `tauri.macos.conf.json` appears (Tauri would merge it and this check does not read it).                                                                                                                                                                                                                                                                                                                                                  |
| Development features       | The crate's default features or `build.features` in `tauri.conf.json` switch on a development feature (`native-audio-spike`, `timing-log`, `claude-cli`, `lab-evaluator` or `cloud-transcription`), directly or through another feature; with a bundle, when its executable carries the development-feature marker. ScreenCaptureKit is no longer a marker: every macOS build links it for the application the person chooses. A release build with `native-audio-spike` does not compile (`compile_error!` in `src-tauri/src/lib.rs`). |
| Entitlements               | The file requests anything beyond the reviewed list (today only audio input), or an entitlement lacks its usage description.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Usage descriptions         | The bundle's permission texts are missing, empty, extra, or differ from `src-tauri/Info.plist`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Updater                    | One is configured without an https endpoint and a public key. With none configured it prints a note.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Third-party notices        | The notices file is missing, was generated from other lockfiles, or is not placed in the bundle; with a bundle, when its copy is missing or differs from the repository's.                                                                                                                                                                                                                                                                                                                                                              |
| Development-only files     | The bundle holds source maps, source files, environment files, keys, certificates or profiles, logs, debug symbols, databases, speech model weights (a guard kept from the removed on-device transcription), or a link that is absolute or leads outside the bundle.                                                                                                                                                                                                                                                                    |
| Size                       | The bundle is over a tripwire: 80 MiB by default, 40 MiB for `--expect signed` or `notarized`. These catch a debug build or a bundled model; they are not budgets.                                                                                                                                                                                                                                                                                                                                                                      |
| Architectures              | The executable needs a newer macOS than the bundle declares.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Signature (`signed`)       | It is not Developer ID Application, its certificate chain does not meet Apple's Developer ID requirement, it has no team, hardened runtime or secure timestamp, it fails `codesign --verify --deep --strict`, or its embedded entitlements differ from the file.                                                                                                                                                                                                                                                                        |
| Notarization (`notarized`) | `xcrun stapler validate` fails, or `spctl` does not answer `Notarized Developer ID`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

A plain bundle check notes how many home folders of the build machine appear in the executable (the names are not printed). With `--strict-paths`, and always with `--expect signed` or `notarized`, any such path is a failure.

Limits: the signature and notarization checks read the output of `codesign`, `stapler` and `spctl` on the Mac that runs them. Their tests use fictional tool output, and the signature fields and the Developer ID requirement were compared once against an installed third-party application. No TalkQTE artifact has ever passed `--expect signed` or `--expect notarized`. A Mac with developer tools is not a clean Mac, so a pass here does not replace step 5. In a restricted sandbox `codesign` reports the signing authority as unavailable and `--expect signed` fails; run it in an ordinary terminal.

CI runs the script's tests in the frontend job and the default (`--expect bundle`) check on the debug bundle, which has no Developer ID signature, in the macOS job. CI holds no signing secret and makes no release.

## Steps

| #   | Step                          | State                      | What exists, and what is left                                                                                                                                                                                                |
| --- | ----------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Build a release candidate     | In place                   | `npm run release` builds it through `npm run build:release`. One release build made on 24 November 2026 (above).                                                                                                             |
| 2   | Sign with Developer ID        | Scriptable now, then Owner | `npm run release` signs with the hardened runtime, timestamp and entitlements and checks the team; exercised ad-hoc. Needs Apple Developer Program membership and a Developer ID Application certificate.                    |
| 3   | Notarize                      | Scriptable now, then Owner | Scripted with `notarytool submit --wait`, Apple's log saved on rejection; tested with fictional notarytool output. Needs notary credentials for the same team. No submission has been made.                                  |
| 4   | Staple, package and verify    | Scriptable now, then Owner | Stapling, the disk image, the zip, checks of both downloads, Gatekeeper and checksums are scripted; all but stapling and Gatekeeper were run ad-hoc.                                                                         |
| 5   | Install on a clean Mac        | Owner                      | Needs a Mac that has never held developer tools or TalkQTE. [Checklist](#clean-mac-checklist).                                                                                                                               |
| 6   | First launch and permissions  | Owner                      | The microphone text is in the bundle (checked). The prompts, refusal and recovery on a clean Mac have not been observed.                                                                                                     |
| 7   | Upgrade with data migration   | Owner                      | Needs two signed candidates. The [data snapshot](#data-snapshot) script gives the before-and-after comparison; the settings file being added needs its migration test first ([recoverable upgrades](#recoverable-upgrades)). |
| 8   | Update deferral during a call | Designed and tested, off   | The rule and its tests are in `src-tauri/src/updates.rs`; no updater uses it yet. See [updates](#updates).                                                                                                                   |
| 9   | Rollback                      | Owner                      | Reinstalling the previous candidate is the route; not tried.                                                                                                                                                                 |
| 10  | Uninstall                     | Owner                      | What is left behind and how to remove it is listed in the [checklist](#10-uninstall); not tried.                                                                                                                             |

### 1. Build

```sh
npm ci
npm run notices && git diff --exit-code src-tauri/THIRD-PARTY-NOTICES.txt   # regenerate; commit any change first
npm run check:release
npm run release            # or: npm run build:release -- --bundles app, for the bundle alone
```

A release uses no optional Cargo features, so the third-party notices cover the default build. Such a build has live transcription only with the person's own keys. Never build a candidate with a development feature: `native-audio-spike`, `timing-log`, `claude-cli`, `lab-evaluator` or `cloud-transcription`. The build script and the pre-flight configuration check refuse all five. Two need extra explanation: `native-audio-spike` adds application-audio capture code which is not part of the reviewed release, and `timing-log` can write recognized transcript text to a file for [lab runs](real-app-lab.md#timing-log). `npm run build:release` refuses before building (exit 2) when anything asks for any of them: a `--features`/`-f` list, cargo arguments after `--` (including `--all-features`), an inline or file `--config`, `TAURI_CONFIG`, `RUSTFLAGS`, or the crate's default features and `tauri.conf.json`. The pre-flight fails a configuration that switches any of them on. The pre-flight also fails a bundle whose executable carries the development-feature marker that `native-audio-spike` compiles in, which covers a debug bundle built by hand with that feature; a release build with it fails to compile. Until 24 November 2026 it also treated ScreenCaptureKit as a marker; every macOS build now links it for the application the person chooses, so it no longer means anything. A bundle built by hand with `timing-log` carries no marker; only the build script and configuration checks catch that feature. An executable the check cannot read as Mach-O is noted for a plain bundle check and fails `--expect signed` or `notarized`.

The result is arm64 only when built on Apple silicon, which matches the [proposed supported setup](budgets.md#proposed-first-supported-setup); a universal build is a separate, unmeasured choice.

`npm run build:release` (`scripts/release-build.mjs`) passes its arguments to `tauri build` and adds three things. It stops if the third-party notices are out of date. It tells the Rust and C compilers to record neutral paths (`/build/home`, `/build/cargo`, `/build/talkqte`, `/build/target`) in place of the home folder, Cargo's folder, the checkout and the build folder, because a plain build embeds the dependency sources' full paths, which on a personal Mac publishes the account's home-folder name. It then runs the pre-flight on the finished bundle with build paths treated as a failure. It asks cargo for the build folder, refuses a bundle that this build did not write, and stops before building if the home, Cargo, checkout or build folder has a space in its path. It supplies no signing identity or credential.

Checked on 13 November 2026 with `npm run build:release -- --bundles app` (release profile, arm64, without the former `local-whisper` feature): the 15.6 MiB bundle's executable contained no path under a home folder, the checkout or the build folder, and 523 remapped `/build/cargo/` dependency paths; the earlier plain debug build contained 719 home-folder paths. Not checked: a checkout that itself lives under the home folder, which the same remap rules are expected to cover.

The script's own safeguards were then run end to end on 13 November 2026 with a debug build in a separate build folder (`npm run build:release -- --debug --bundles app`, arm64), which was deleted afterwards:

| Run                                               | Result                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First build                                       | Built and bundled, then stopped at the pre-flight with exit 1: the executable still held 12 home-folder paths, all to the Rust toolchain's standard-library archives, and 753 references to the build folder. These are the linker's debugging records of object files, which path remapping does not change. The dependency sources were remapped (1,213 `/build/cargo/` and 259 `/build/talkqte/` paths, none under the checkout). |
| Same command again, nothing changed               | `tauri build` rebuilt the frontend and recompiled the app crate anyway. Both `Contents/Info.plist` and the executable in the bundle were new files written during the run, so the freshness check passed. The same pre-flight failure followed.                                                                                                                                                                                      |
| `--debug --no-bundle`, leaving the earlier bundle | Exit 1 before any pre-flight: the bundle "was not written by this build". Its `Info.plist` and executable still carried the previous run's times.                                                                                                                                                                                                                                                                                    |
| Build folder with a space in its path             | Exit 2 before compiling, naming the target folder; the folder was not created.                                                                                                                                                                                                                                                                                                                                                       |

So a debug build cannot pass the build-paths check, and the script says so when it fails one; release builds strip those records, as the release build above showed. Because both files are rewritten on every run, the script now requires each of them to be newer than the build's start, where it previously accepted either.

### 2–4. Sign, notarize, staple, package, verify: `npm run release`

`npm run release` (`scripts/release.mjs`) runs every step from the checkout to the two files a person downloads, in this order, and stops at the first failure with the step's name:

1. Builds the bundle with `npm run build:release -- --bundles app --no-sign`, with every variable that would make Tauri sign or notarize by itself removed from the build's environment, so the script alone decides what is signed.
2. Copies the bundle to a work folder and signs the copy: `codesign --force --options runtime --entitlements src-tauri/Entitlements.plist --timestamp --sign "$APPLE_SIGNING_IDENTITY"`. The hardened runtime and the secure timestamp are always set; there are no nested executables or frameworks to sign first.
3. Verifies it with `codesign --verify --deep --strict`, the pre-flight's `--expect signed`, and checks that the signature's team is `APPLE_TEAM_ID`, so a certificate belonging to another team on the same Mac is refused even if named by mistake.
4. Zips the app, submits it with `xcrun notarytool submit --wait`, reads the verdict from notarytool's JSON, and on any verdict but `Accepted` saves Apple's log to `notary-log-app.json` and stops. Then `xcrun stapler staple` and `stapler validate` on the app, so the copy a person drags out opens without a network.
5. Packages the stapled app twice: `TalkQTE_<version>_<arch>.zip` (`ditto -c -k --sequesterRsrc --keepParent`) and `TalkQTE_<version>_<arch>.dmg` (`hdiutil create -format UDZO` with the app and a link to Applications). The disk image is signed, notarized and stapled in its own right.
6. Verifies what a person receives: the app as unpacked from the zip and as found in the mounted disk image, each with `codesign --verify` and the pre-flight's `--expect notarized` (which runs `stapler validate` and `spctl`), then `spctl --assess --type open` on the disk image.
7. Writes `SHA256SUMS` and `TalkQTE_<version>_<arch>.manifest.json` (version, identifier, architecture, mode, commit, team, and each file's size and SHA-256).

The files go to `src-tauri/target/release-artifacts/` (or `--out DIR`). It refuses before building (exit 2) when the credentials for the chosen mode are missing or partial, when `APPLE_SIGNING_IDENTITY` is not a Developer ID Application identity of `APPLE_TEAM_ID` or is not in the keychain, and when the checkout has uncommitted changes.

| Command                            | Result                                                                                                                                    | Needs                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `npm run release -- --dry-run`     | Prints every command it would run, with credentials shown as placeholders; builds, signs and sends nothing. Exit 2 lists what is missing. | Nothing                                    |
| `npm run release`                  | The release: Developer ID, notarized, stapled.                                                                                            | Signing identity, team, notary credentials |
| `npm run release -- --no-notarize` | Developer ID signature only. Files are named `…_not-notarized`; Gatekeeper refuses them on another Mac.                                   | Signing identity, team                     |
| `npm run release -- --adhoc`       | Ad-hoc signature with the hardened runtime and entitlements. Exercises the steps; files are named `…_adhoc-not-for-release`.              | Nothing                                    |
| `npm run release -- --unsigned`    | The linker-signed bundle as built, packaged. What CI uploads without secrets; files are named `…_unsigned-not-for-release`.               | Nothing                                    |

`--app PATH` packages an existing bundle instead of building; `--universal` builds `universal-apple-darwin` (needs `rustup target add x86_64-apple-darwin`, and the [third-party notices](#third-party-notices) cover arm64 only, so a universal release needs them extended first).

Only an `npm run release` without a mode flag is a release. Neither an ad-hoc signature nor the local self-signed "TalkQTE Development" certificate is a signed release: macOS refuses both on any other Mac.

#### Credentials, and where each is entered

Nothing is committed. The script reads them from the environment of the shell that runs it; CI reads them from repository secrets (see [CI](#ci)).

| Variable                                                  | What it is                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_SIGNING_IDENTITY`                                  | The Developer ID Application certificate's name, `Developer ID Application: <Name> (<TEAMID>)`, or its SHA-1 from `security find-identity -v -p codesigning`. The certificate and its private key must be in the login keychain (or `APPLE_KEYCHAIN`). Created in the Apple Developer account under Certificates, by the Account Holder. |
| `APPLE_TEAM_ID`                                           | The ten-character team ID (Apple Developer account, Membership details). The signature must carry it.                                                                                                                                                                                                                                    |
| `APPLE_NOTARY_PROFILE`                                    | For a person's Mac: the name of a profile made once with `xcrun notarytool store-credentials talkqte-notary --apple-id <Apple ID> --team-id <TEAMID>`, which asks for an app-specific password (made at account.apple.com, Sign-In and Security) and stores it in the keychain.                                                          |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` | For CI, or instead of the profile: an App Store Connect API key with the Developer role (App Store Connect, Users and Access, Integrations): its key ID, the issuer ID, and the path of the downloaded `AuthKey_<id>.p8`.                                                                                                                |
| `APPLE_KEYCHAIN`                                          | Optional: a keychain other than the default search list that holds the identity (CI sets it).                                                                                                                                                                                                                                            |

`APPLE_ID` with `APPLE_PASSWORD` is refused, because notarytool would receive the password on its command line, where other processes can read it; store it in a profile instead.

#### Checked without credentials, 24 November 2026

`npm run release -- --adhoc` on an Apple M5 Pro (macOS 26.4) at `83e5223` with this change applied: one release build (`--bundles app --no-sign`), then every step except notarization, stapling and Gatekeeper, exit 0.

| Item                  | Observation                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle                | 19.2 MiB, arm64 only, minimum macOS 14.0; build-path, development-feature and notices checks passed.                                                                                              |
| Signature on the copy | `flags=0x10002(adhoc,runtime)`: the hardened runtime is set; sealed resources; `Info.plist` bound; no team. `codesign --verify --deep --strict` passed.                                           |
| Entitlements embedded | Exactly `com.apple.security.device.audio-input`.                                                                                                                                                  |
| Downloads             | Disk image 7,617,024 bytes, zip 5,933,116 bytes; both checked after unpacking and mounting; `SHA256SUMS` and the manifest written.                                                                |
| Gatekeeper            | `spctl --assess --type execute` answers `rejected`, as it must for an ad-hoc signature.                                                                                                           |
| Launch                | The app unpacked from the zip, with the hardened runtime, started and kept running for 10 seconds with nothing on its output, then was stopped. The window and the microphone were not exercised. |

A real Developer ID signature, notarization, stapling and Gatekeeper's acceptance have not been run: they need the owner's credentials.

### CI

`.github/workflows/release.yml` runs `npm run release` on a `v*` tag, on manual dispatch, and on pull requests that change the release scripts, the workflow, the entitlements, `Info.plist` or `tauri.conf.json`. It uploads the disk image, zip, manifest and `SHA256SUMS` as a workflow artifact kept for 14 days. It never creates a tag or a GitHub Release and publishes nothing. A tag must equal the version in `tauri.conf.json`.

Its mode follows the secrets it can see. Pull requests never see secrets, so they always build `--unsigned`.

| Secret                       | Contents                                                                                                                                           | Used for     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `APPLE_CERTIFICATE`          | The Developer ID Application certificate and private key exported from Keychain Access as `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`). | Signing      |
| `APPLE_CERTIFICATE_PASSWORD` | The password chosen for that `.p12` export.                                                                                                        | Signing      |
| `APPLE_SIGNING_IDENTITY`     | As above.                                                                                                                                          | Signing      |
| `APPLE_TEAM_ID`              | As above.                                                                                                                                          | Signing      |
| `APPLE_API_KEY`              | App Store Connect API key ID.                                                                                                                      | Notarization |
| `APPLE_API_ISSUER`           | App Store Connect issuer ID.                                                                                                                       | Notarization |
| `APPLE_API_KEY_P8`           | The text of `AuthKey_<id>.p8`.                                                                                                                     | Notarization |

All four signing secrets give `--no-notarize`; those and the three notary secrets give a full release. The certificate goes into a temporary keychain that is deleted at the end of the job, with the API key file. They are entered in the repository's Settings, Secrets and variables, Actions; a protected `release` environment that only the owner can approve would be stricter, and is an owner decision.

## Updates

Status: designed, with the deferral rule and the feed reader implemented and tested; **off in every build**. There is no feed, no update-signing key and no installer, so nothing checks, downloads or replaces anything. Until then an update is the person downloading the new disk image and replacing the app.

### Choice: the Tauri updater, reading a static feed

The planned updater is [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/), which already fits the bundle:

- **Feed:** one static JSON file, `latest.json`: `version`, `notes`, `pub_date`, and per platform (`darwin-aarch64`, `darwin-x86_64`) a `url` and a `signature`. [`scripts/fixtures/update-feed.json`](../scripts/fixtures/update-feed.json) is a fictional example, and `src-tauri/src/updates.rs` reads exactly that format.
- **Artifact:** `TalkQTE.app.tar.gz`, which `tauri build` writes beside the bundle when `bundle.createUpdaterArtifacts` is on and `TAURI_SIGNING_PRIVATE_KEY` is set, with a `.sig` file holding its minisign signature. The updater refuses an archive whose signature does not match the public key compiled into the app. That is in addition to, not instead of, Developer ID and notarization: the archive is made from the notarized, stapled app.
- **Keys:** `npx tauri signer generate` makes the key pair. The public key goes in `tauri.conf.json` (`plugins.updater.pubkey`); the private key and its password are CI secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) and an offline backup. A lost private key means existing copies can never update automatically again; a leaked one lets someone else's archive pass this check (though not Gatekeeper). Its custody is an owner decision.
- **Hosting:** either the assets of a GitHub Release (the feed URL `https://github.com/connorburgess/talkqte/releases/latest/download/latest.json` then always names the newest release), or the website (`https://talkqte.com/updates/latest.json`, which can hold a release back after it is published). Both are https; the pre-flight already fails an updater configured without an https endpoint and a public key.

Adding the plugin is a separate change: it adds an HTTP client and archive crates to the release (third-party notices, size), a Tauri permission, and the key. It is not in this change.

### Never during a call

The rule, in `src-tauri/src/updates.rs`, is that an update is neither offered nor applied while anything is listening. The app knows from the same state Stop changes (`Runtime::update_hold`):

- a live session is starting, running, paused or still finishing (`live_session_open`, which the transcription-language setting already uses);
- the microphone is starting, on (including the microphone check without a session) or stopping, or its state cannot be read without waiting;
- an application's audio is being captured (`live_source`, `source_session`).

An offer found then is held (`Deferral`), replaced only by a newer one, and shown once nothing holds it: after Stop, the next check gives it back. Nothing installs on its own; installation and the restart wait for the person's choice, and a restart is offered only when nothing holds. Checks happen at launch and when the person asks, never on a timer during a session. Tests cover each hold, the release after Stop, and a newer offer replacing a held one, against the fictional feed.

### Recoverable upgrades

- **Failed update:** the Tauri updater on macOS unpacks the new bundle to a temporary location and swaps it for the old one only after the archive's signature checks out; a failed download, a bad signature or an interrupted unpack leaves the old app in place and working. To be observed on the first two signed candidates (step 7), along with whether the swap needs the person's password when the app is in `/Applications` and they are not an administrator.
- **Settings file:** another change adds a settings file under `~/Library/Application Support/com.talkqte.desktop/`. Before it ships it needs a format version, a migration test from the previous release's file, and a refusal (not a silent reset) of a file from a newer version, so a rollback keeps the newer file intact. The data snapshot comparison in step 7 covers that folder.
- **Keychain items:** provider keys are generic passwords under the service `app.talkqte.provider-key` (accounts `deepgram` and `anthropic`) in the login keychain. Access is granted to the app's designated requirement, which for a Developer ID signature is the bundle identifier and team, so it survives an update signed by the same team without a prompt. Changing the team, the bundle identifier, or moving between ad-hoc and Developer ID builds makes macOS ask the person to allow access again (the item itself is kept). To be observed in step 7.
- **Notes in memory:** notes, transcripts and imported context live in memory only and are lost when the app quits, which an update requires. That is why the update waits for Stop and never restarts the app itself; once anything listening has stopped, the offer says that quitting discards unsaved notes, as quitting does today.
- **Permissions:** the microphone and Screen & System Audio Recording grants are tied to the bundle identifier and signature; expected to survive a same-team update, to be observed.

### Turning it on

1. Owner: decide hosting and key custody; generate the key pair.
2. Add `tauri-plugin-updater`, `plugins.updater` (`pubkey`, `endpoints`) and `bundle.createUpdaterArtifacts`; regenerate the notices.
3. Wire `updates::Deferral` and `Runtime::update_hold` to the plugin's check and install, behind the setting (off by default) in the settings file.
4. Extend `npm run release` to make the updater archive from the stapled app and write `latest.json`; publish both with the disk image.
5. Run step 7 with the updater, including a deliberately corrupted archive.

## Clean-Mac checklist

For the owner, with candidate A (and later B) built by `npm run release`. A clean Mac is a supported Apple silicon Mac on macOS 14 or later, or a fresh macOS virtual machine on one, that has never had Xcode, the Command Line Tools, Rust, Node.js or TalkQTE. A virtual machine shows Gatekeeper and installation behavior; its microphone and audio capture are not evidence for real hardware. Record the Mac model, macOS version, the candidate's SHA-256 from `SHA256SUMS`, and each result.

### 5. Install

1. Download the disk image with a browser so macOS marks it as downloaded; confirm with `xattr -p com.apple.quarantine <dmg>`. Compare `shasum -a 256 <dmg>` with `SHA256SUMS`.
2. Turn networking off. Open the image. Pass: it mounts with no warning. Drag TalkQTE to Applications and eject the image.
3. Open TalkQTE from Applications. Pass: only the ordinary "downloaded from the Internet" confirmation; no "unidentified developer", "damaged" or "cannot be checked for malicious software" warning. This launch, offline, shows the stapled ticket working.
4. Turn networking on, quit and open again. Pass: no further confirmation.
5. Repeat 1–3 with the zip on a second account or after an uninstall (step 10). Pass: the same.

### 6. First launch, onboarding and permissions

1. Pass: onboarding appears, and the fictional demo runs without a permission prompt or a network request.
2. Add a Deepgram and an Anthropic key in Settings. Pass: no Keychain prompt on adding or on next use.
3. **Start microphone**. Pass: the prompt shows the text from `src-tauri/Info.plist`. Refuse once and confirm the app explains how to allow it; allow it in System Settings, Privacy and Security, Microphone, and confirm it works after reopening.
4. Choose an application to listen to. Pass: the Screen & System Audio Recording prompt appears only then; after allowing it in System Settings and reopening as the app asks, the application can be chosen.

### Session and quit

1. Start a live session with a real call or a played recording, let a cue appear, and Stop. Pass: transcript and cues appear; Stop ends the microphone and capture (the menu bar recording indicator goes away).
2. Quit with ⌘Q. Pass: the app ends without a crash report; reopening shows no notes from the earlier run (they were in memory only).

### 7. Upgrade

Needs candidate B with a higher version (all five version files changed together; the pre-flight enforces this).

1. With A installed and quit, record what it keeps: `node release-data-snapshot.mjs record --identifier com.talkqte.desktop --out before.json` (see [data snapshot](#data-snapshot)).
2. Replace the app in Applications with B from its disk image (and, once updates exist, through the updater instead; also start a session first and confirm no update is offered until Stop).
3. Open it. Pass: no new Gatekeeper warning; no new microphone or Screen & System Audio Recording prompt; the stored keys are read without a Keychain prompt; settings are as A left them.
4. Quit, record `--out after-upgrade.json`, and `node release-data-snapshot.mjs compare before.json after-upgrade.json`. Pass: exit 0 and "Kept: nothing in the data folder was removed or changed" (or, for a release that migrates the settings file, `--allow-changes` and the migration's expected change).

### 9. Rollback

1. Quit and replace B with A.
2. Pass: it opens, **Start microphone** works, and a settings file written by B is either read or refused with a message, never silently reset.
3. Record `--out after-rollback.json` and compare with `before.json`, as in step 7.

### 10. Uninstall

Moving TalkQTE to the Trash removes the app only. What is left, and how to remove it:

| Left behind                                           | Remove with                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider keys in the login keychain                   | `security delete-generic-password -s app.talkqte.provider-key -a deepgram` and the same with `-a anthropic`, or remove them in the app's Settings before uninstalling.                                                                           |
| Settings file and data folder                         | `rm -rf ~/Library/Application\ Support/com.talkqte.desktop` (also holds a speech model left by an early development build).                                                                                                                      |
| Web view storage, caches, preferences, window state   | `rm -rf ~/Library/WebKit/com.talkqte.desktop ~/Library/Caches/com.talkqte.desktop ~/Library/HTTPStorages/com.talkqte.desktop ~/Library/Saved\ Application\ State/com.talkqte.desktop.savedState ~/Library/Preferences/com.talkqte.desktop.plist` |
| Microphone and Screen & System Audio Recording grants | `tccutil reset Microphone com.talkqte.desktop` and `tccutil reset ScreenCapture com.talkqte.desktop`.                                                                                                                                            |
| A login item, once that exists                        | Check System Settings, General, Login Items after deleting the app, and remove TalkQTE there if it is still listed.                                                                                                                              |

Pass: a data snapshot recorded after these commands lists nothing for TalkQTE, and reinstalling starts at onboarding with no keys.

### Data snapshot

`scripts/release-data-snapshot.mjs` records the names, sizes and SHA-256 digests of the files TalkQTE and macOS keep for it, and compares two records. It reads only, sends nothing, and stores paths relative to the home folder so a record does not name the account. A record does list the data folder's file names, so keep it outside the checkout.

- **Locations:** `~/Library/Application Support/com.talkqte.desktop` must be kept; any file there that is removed, changed or unreadable makes `compare` exit 1. The preferences file, caches, web-view storage, HTTP storage and saved window state are reported but may change at any launch. Added files are reported, not failed.
- **Migrations:** when a release is meant to change stored data, `compare --allow-changes` reports the differences without failing; what changed still has to be checked against that release's migration test.
- **On the clean Mac:** the script is one file with no dependencies beyond Node.js, and `--identifier` lets it run without a checkout. A clean Mac has no Node.js, so either install Node.js there only after steps 5–6 are recorded, or run the script from another Mac against the test Mac's home folder with `--home` (for example a virtual machine's shared folder). It notes the installed app's version from `/Applications/TalkQTE.app`, or from `--app`.
- **Uninstall (step 10):** record before moving the app to the Trash and again afterwards; the comparison lists exactly what remains.

Checked with fictional home folders in its tests, and once read-only on the development Mac, where it found the speech model then in use in the data folder and files in three of the other five locations and two consecutive records compared as kept. It has not been used across a real upgrade, because no two signed candidates exist.

## Third-party notices

`npm run notices` (`scripts/third-party-notices.mjs`) writes `src-tauri/THIRD-PARTY-NOTICES.txt` from the dependencies a macOS release contains, and the bundle carries it at `Contents/Resources/THIRD-PARTY-NOTICES.txt`. It is regenerated for every release and whenever a lockfile changes. The app does not read or display it, and nothing is fetched at run time.

- **Rust:** the crates linked into the executable for `aarch64-apple-darwin` with the default features, since a release has no optional features: the set `cargo tree --edges normal,no-proc-macro` reports with the locked versions, with licence fields and package locations from `cargo metadata`. Build scripts, test-only crates, procedural macros and other platforms' crates are left out because they are not linked. Development builds link more and are not covered. An Intel or universal build is not covered.
- **JavaScript:** the packages whose modules Vite puts in the frontend bundle, found by a non-writing build.
- **Texts:** each package's own licence and notice files, copied from the package and stored once when identical.
- **Freshness:** the file records the SHA-256 of `src-tauri/Cargo.lock` and `package-lock.json`. The pre-flight fails when either has changed since, and when a bundle's copy differs from the repository's. CI regenerates the file in the macOS job (`npm run check:notices`) and fails on any difference.

Generated on 13 November 2026 with the former `local-whisper` feature, it listed 170 Rust crates; regenerated on 16 November 2026 for the default build, it lists 168. The figures below are from the 13 November file, less the two `whisper-rs` crates. It also lists the Rust standard library and 5 JavaScript packages (`@tauri-apps/api`, `lucide-react`, `react`, `react-dom`, `scheduler`). Declared licences:

- MIT, Apache-2.0, or a choice between them (some also offering Zlib or the Unlicense): 139 crates, the standard library and four JavaScript packages.
- Unicode-3.0: the 15 ICU4X crates.
- MPL-2.0: `option-ext`.
- BSD-3-Clause, alone or with MIT: `alloc-no-stdlib`, `alloc-stdlib`, `subtle`, `brotli`, `brotli-decompressor`. BSD-2-Clause OR MIT OR Apache-2.0: `mach2`.
- ISC: `rustls-webpki`, `untrusted`, `lucide-react`. Apache-2.0 AND ISC: `ring`. Apache-2.0 OR ISC OR MIT: `rustls`.
- 0BSD OR MIT OR Apache-2.0: `adler2`. CC0-1.0 OR MIT-0 OR Apache-2.0: `dunce`.
- CDLA-Permissive-2.0: `webpki-roots` (certificate data).

No package declares a GPL, LGPL or AGPL licence. This is a list of what the packages declare, not a legal review; whether the MPL-2.0 and other terms are met by shipping this file is for the owner to confirm.

Gaps: 16 crates (`objc2` and its framework crates, `block2`, `dispatch2`, `dasp_sample`, `alloc-stdlib`) ship no licence file in their package, and the standard library's notices are not copied; for these the file gives the declared licence and the source repository only. Notices kept below a package's top level are included only where listed in the script (`ring`, `regex-syntax`); generation fails when a linked crate carries one that is neither listed nor deliberately ignored, but a notice under a file name the script does not recognise, or inside a source file, would be missed. Windows and Linux bundles do not carry a notices file. The system web view and macOS frameworks are not listed.

## Open decisions for the owner

1. **Apple Developer Program membership and team.** Every **Owner** step waits on it. The account (individual or organisation) decides the name Gatekeeper shows, "Developer ID Application: <Name> (<TEAMID>)", and the team every later release must keep, because the Keychain items, permission grants and updates are tied to it. Then: where the Developer ID certificate's private key and the notary credentials are kept, and who may use them.
2. **Bundle identifier.** `com.talkqte.desktop` today. It names the data folder, the Keychain access and the permission records, so it should be settled before the first signed build and never changed after it. Keep it unless the owner prefers one under a domain the owner controls (the Keychain service already uses `app.talkqte`).
3. **arm64 only or universal.** arm64 only today, matching the [proposed supported setup](budgets.md#proposed-first-supported-setup). `--universal` builds both, but needs the third-party notices extended to the Intel build and roughly doubles the executable; no Intel Mac has run the app.
4. **Download hosting.** GitHub Releases on this repository, or the website. Either serves the disk image, the zip and `SHA256SUMS`; the update feed lives in the same place.
5. **Update channel and keys.** Whether to turn on the updater at all for the alpha, one stable channel or a separate beta feed, and custody of the update-signing key ([updates](#updates)).
6. **Disk image or zip** as the advertised download. Both are made; the disk image is the usual Mac download, the zip is what an updater archive and some browsers handle best.
7. **Minimum macOS:** settled as 14.0. Remaining: run the clean-Mac checklist on a macOS 14 system as well as a current one.
8. **Where the candidate is built:** `npm run build:release` remaps build paths; the 24 November build from a checkout under the home folder carried no home-folder path. CI builds on GitHub's runners.

## Remaining steps, in order

1. Make decisions 1–6. Join the Apple Developer Program, create the Developer ID Application certificate, and make notary credentials (a `notarytool` profile on the Mac, an App Store Connect API key for CI). Enter them as described in [credentials](#credentials-and-where-each-is-entered) and [CI](#ci).
2. For candidate A: regenerate the third-party notices (`npm run notices`) and commit any change, then `npm run release -- --dry-run` (exit 0 means every credential is in place) and `npm run release`. Keep its output, `SHA256SUMS` and the manifest. Or push a `v0.1.0` tag and take the workflow artifact.
3. Run the [clean-Mac checklist](#clean-mac-checklist) steps 5–6 and the session.
4. Raise the version, make candidate B the same way, and run steps 7, 9 and 10 on the same Mac, keeping the data snapshot comparisons.
5. Record the evidence here, measure the signed bundle and disk image for the [operating estimates](operating-estimates.md#follow-up), and only then review the roadmap item. Automatic updates and their deferral stay open until the updater is turned on ([turning it on](#turning-it-on)).
