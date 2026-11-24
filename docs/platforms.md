# Platform plan

Planning baseline, 8 November 2026. These are delivery priorities and validation tasks, not current support claims. The prototype currently runs from source on macOS. Unsigned Windows and Ubuntu test builds are made in CI ([below](#unsigned-ci-builds-for-windows-and-ubuntu)); they are not releases.

| Platform           | Direction                                                 | Next evidence                                                                                                                |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| macOS              | First live companion and release target                   | Both sides of a synthetic call, useful cues, native companion behavior, and a clean signed installation                      |
| Windows            | Next planned desktop platform                             | Build and launch in Parallels, then validate capture, focus, and distribution on the claimed configurations                  |
| Ubuntu/Linux       | Exploratory; general support undecided                    | Build and run an Ubuntu ARM64 guest, record audio/window limitations, and assess maintenance effort                          |
| iPhone and Android | Future companion goal, including Google Meet on the phone | Establish a supported live-context source and usable cue surface independently; prove same-phone capture before promising it |

## Unsigned CI builds for Windows and Ubuntu

The [Windows and Ubuntu builds workflow](../.github/workflows/platform-builds.yml) runs on every pull request and on manual dispatch. It builds the release app (no development features) and uploads, per platform, the installers, `SHA256SUMS.txt`, the third-party notices for that build's Rust target and a `README-UNSIGNED.txt` naming the commit and run. Nothing is signed or notarised, nothing is published as a release, and no update feed exists. Artifacts are kept for 14 days. To download one, open the workflow run from the pull request's checks (or **Actions → Windows and Ubuntu builds (unsigned)**), then the **Artifacts** list at the bottom of the run summary, or use `gh run download <run-id> -n <artifact-name>`.

| Artifact | Contents | Built on | What CI checks |
| --- | --- | --- | --- |
| `talkqte-windows-x64-unsigned-<sha>` | NSIS `*-setup.exe` and MSI | `windows-2025` | Rust tests and Clippy; silent per-user NSIS install, the app's `TalkQTE` window appears with a WebView2 child process, silent uninstall removes it |
| `talkqte-windows-arm64-unsigned-<sha>` | NSIS `*-setup.exe` (WiX, which Tauri uses for MSI, has no Arm64 target) | `windows-11-arm` | The same install, launch and uninstall; tests and Clippy run in the [checks workflow](../.github/workflows/checks.yml) |
| `talkqte-ubuntu-x64-unsigned-<sha>` | `.deb` and `.AppImage` | `ubuntu-24.04` | Rust tests and Clippy; the built app opens its `TalkQTE` window under Xvfb; the `.deb` installs with its dependencies in an `ubuntu:26.04` container and the installed app opens its window there |
| `talkqte-ubuntu-arm64-unsigned-<sha>` | `.deb` and `.AppImage` | `ubuntu-24.04-arm` | The same as x64 |

The Ubuntu packages are built on 24.04 so their library requirements are met on 24.04 and on the current LTS, 26.04, where the installed package is launched. The AppImage is built but not launched in CI.

A launch check proves that the app starts and creates its window on that runner. It does not show that anything in the window works, and it involves no microphone, display a person sees, meeting app, keyring prompt or network provider. Windows SmartScreen and an unsigned-publisher warning will appear on a real machine; Ubuntu installs the `.deb` without any signature check. The installed apps do not yet carry their own copy of the third-party notices; it is beside the installer in the artifact.

### What each build does, by capability

As of this branch. "CI" is the hosted-runner evidence above; "VM" is the owner's Parallels records below; anything else is unverified.

| Capability | Windows (x64, Arm64) | Ubuntu (x64, Arm64) | Where macOS-only code lives |
| --- | --- | --- | --- |
| Install, launch, window | CI: installs, launches, uninstalls | CI: launches under Xvfb on 24.04 and, installed, on 26.04 | — |
| Notebook, onboarding, settings, export | Built; Arm64 VM ran the fictional demo on an older commit. Onboarding and the session start name Windows and say what this build does not do (browser tests against a Windows stand-in) | The same for Linux; Arm64 VM ran the demo under Wayland on an older commit | `src-tauri/src/platform.rs` reports the platform; `src/lib/platform.ts` words it |
| Provider keys | Credential Manager; CI round-trips a fictional key in the runner's real store | Desktop keyring through the Secret Service; CI round-trips a fictional key in a throwaway GNOME Keyring; with no keyring service, keys cannot be saved and Settings says so | `src-tauri/src/provider_keys.rs` (Keychain); `provider_keys/windows.rs`, `provider_keys/secret_service.rs` |
| Microphone check and microphone-only live session | Built on cpal's WASAPI host (shared mode, default input). No access prompt; if Windows' microphone privacy switch for desktop apps is off, the start reports a device error naming it. **Not run on a device**: hosted runners have no microphone | Built on cpal's ALSA host (default input, which desktop Ubuntu routes to PipeWire or PulseAudio). **Not run on a device** | `src-tauri/src/microphone/native.rs` (AVFoundation permission is macOS only) |
| Another application's audio | Not built; the notebook says it is not available on Windows yet | Not built; the notebook says so | `src-tauri/src/application_audio*`, `native_source.rs` (ScreenCaptureKit) |
| Companion window | Always on top and not focusable through Tauri; placement in steps; focus over full-screen apps unverified | The same; GNOME Wayland neither lets an app keep a window on top nor report its position | `src-tauri/src/companion_macos.rs` |
| Call-starting offer | Not built; Settings says it is not available on Windows yet | The same for Linux | `src-tauri/src/call_prompt.rs` (Core Audio, NSWorkspace) |

### Designs for what is not built yet

These are designs, not code. Each needs its own adapter module beside the macOS one, fakes for its tests, and a real-machine check before the notebook offers it.

- **Another application's audio.** Windows 10 version 2004 (build 19041) and later can capture one process tree's output with WASAPI process loopback: `ActivateAudioInterfaceAsync` on `VAD\Process_Loopback` with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` and `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`, listing candidate applications from processes with an audio session. It needs no permission prompt, so the notebook's notice and per-session review are the only consent step, as on macOS. On Linux, PipeWire exposes each application's output as a node (`media.class = Stream/Output/Audio`); a capture stream linked to that node hears it alone. Inside a sandbox (Flatpak, Snap) this goes through the screencast or camera portals instead. PulseAudio-only systems would need a monitor of a per-application null sink, which moves the person's audio and is not proposed. Both would feed the existing application-audio contract (`application_audio.rs`), keeping its review, attachment and Stop rules.
- **Call-starting offer.** Windows records each app currently using the microphone under `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone` (`LastUsedTimeStop` of 0 while in use), readable without a permission, and `GetForegroundWindow` names the frontmost app. Linux can see capture streams in the PipeWire graph, but Wayland gives no portable way to learn the frontmost application, so only the microphone signal would be available there.
- **Companion window.** Windows: keep Tauri's always-on-top, non-activating window and check it over full-screen and screen-shared meetings (D2); reduced motion from `SPI_GETCLIENTAREAANIMATION`. Linux on X11 honours always-on-top (`_NET_WM_STATE_ABOVE`); GNOME on Wayland lets no ordinary window stay on top or choose its position, so a Linux companion there may only be a normal window or need a GNOME extension.
- **Menu bar item and login item** (arriving on macOS from another change). Windows: a notification-area icon (Tauri's tray, `Shell_NotifyIcon`) and `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Linux: an AppIndicator/StatusNotifierItem tray icon (needs `libayatana-appindicator3`; GNOME shows it only with the AppIndicator extension) and an XDG autostart entry in `~/.config/autostart/`. A settings file under Tauri's app configuration directory is already cross-platform (`%APPDATA%\com.talkqte.desktop`, `~/.config/com.talkqte.desktop`).

### What a person must check on a real machine

CI cannot show any of these. On a real Windows 11 PC (x64 first, then Arm64) and a real Ubuntu 26.04 LTS desktop (GNOME, Wayland and X11 sessions), using fictional conversations only:

1. Install the artifact; record the SmartScreen or package warning, the install location, and that the Start menu or applications entry opens TalkQTE.
2. Go through onboarding: the platform name, the "test build" card and step 3's cards read as on this page.
3. Save, test, replace and remove a fictional-shaped key; find it in Credential Manager or Passwords and Keys; quit and reopen and see it still set. On Ubuntu, lock the keyring first and note the unlock prompt; in a session without GNOME Keyring, see "Keys cannot be saved on this system yet".
4. Start the microphone check: the input name, activity while speaking, Stop releasing the device (the Windows microphone indicator or PipeWire's stream list clears). Turn off Windows' "Let desktop apps access your microphone" and see the device error naming it.
5. With real keys and a fictional recording played into the microphone: a live session's review, transcript lines, a cue, Stop.
6. Companion: placement, staying on top of another app, not taking focus, over a full-screen browser call, during screen sharing, at 150% scaling.
7. Export a notes file with the save dialog; uninstall and confirm what remains (keys stay in the store until removed).

## Windows validation

Use Parallels for an initial development and smoke-test environment. On Apple silicon, the ordinary guest path is Windows on Arm. Record whether TalkQTE itself runs natively or under emulation. A successful Arm guest run does not prove x64 or physical-PC compatibility. Check the installed Parallels version against its [supported guest systems](https://kb.parallels.com/en/124223).

1. Record guest OS, architecture, VM resources, WebView2, and build prerequisites. Build the frontend and native app, run Rust tests, and launch the fictional demo.
2. Check companion placement, keyboard focus, display scaling, accessibility, full-screen meeting windows, and screen sharing. Preserve the user's control of the meeting app.
3. Implement and validate the Windows capture adapter using synthetic calls. Check both speakers, headphones, microphone/output changes, denial, and Stop/recovery. Virtual audio results apply only to that setup.
4. Add Windows build and Rust checks once the target builds reproducibly. Browser tests on Linux runners do not establish native Windows behavior.
5. Before advertising support, test installation, signing, updates, uninstall, sustained performance, and audio behavior on the hardware and architectures the release names. Track physical-device evidence separately from VM evidence.

The first acceptance gate is a reproducible Windows build and fictional demo in the VM, with the remaining native gaps recorded. This work can proceed alongside macOS reliability work without delaying its first live milestone.

### First VM result, 8 November 2026

Configuration: Windows 11 Arm (build 26300) with 4 virtual CPUs and 12 GiB memory, Parallels 27.1.0 host with 27.0.3 guest tools, WebView2 157.0.4341.42. Built from app commit `b05b4dc` with Visual Studio 2022 Build Tools (MSVC 14.44, ARM64 C++ tools, Windows 11 SDK 26100), Rust 1.97.1 (`aarch64-pc-windows-msvc`), and Node.js 22.23.4. Commands: `npm ci`, `npm run build`, `cargo test --locked`, and `npm run tauri -- build --debug --no-bundle`.

| Check                         | Result                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend build and Rust tests | Passed; 30 Rust tests, the same count as macOS.                                                                                                                |
| Native build                  | A native ARM64 executable (PE machine `0xAA64`), not emulated.                                                                                                 |
| Launch                        | The main window opened and stayed responsive with a WebView2 child process; it closed cleanly.                                                                 |
| Fictional demo                | Through Windows UI Automation, **Try demo** started playback, “Who will take the first draft?” appeared, and **End demo** worked.                              |
| Missing Windows icon          | The build stopped until `src-tauri/icons/icon.ico` existed. Added from the existing PNG.                                                                       |
| Compiler warnings             | macOS-only microphone code produced dead-code warnings, which would fail `clippy -D warnings` there (CI lints Rust only on macOS). Now allowed off macOS only. |

Not checked or not available: microphone monitoring (reports unsupported off macOS), companion placement, focus, display scaling, accessibility, full-screen meetings, and screen sharing. Also not covered: installer, signing, release builds (the debug build opens a console window), x64, and physical PCs. This result covers one Arm VM configuration only.

### Companion check, 9 November 2026

In the same Windows 11 Arm VM, commit `81aa840` built successfully with `npm ci`, the frontend build, 93 Rust tests, and a Tauri debug build. In the logged-in desktop session, UI Automation started the fictional demo and found its question. The notebook's **Why?** button accepted keyboard focus, and Enter opened its context. The app and companion windows reported 192 DPI through `GetDpiForWindow`; a separate 150% scaling check was not performed.

The Notepad foreground comparison was inconclusive: the automation did not establish that its test Notepad was foreground before the question arrived. The initial automation cleanup forced the app process to exit. A separate idle-app check closed the notebook through its UI Automation window control and observed the app process exit within five seconds; exit after a running demo remains unverified. These results do not establish cross-app focus behavior, general keyboard accessibility, or support on other Windows configurations.

### Current build and installer packaging, 11 November 2026

App commit `17e100d`, with the Windows configuration added in this change, produced an unsigned debug NSIS installer in the Windows 11 Pro ARM64 VM (10.0.26300.9711, four virtual CPUs, 12 GiB memory). Parallels remains 27.1.0 with 27.0.3 guest tools; WebView2 is now 157.0.4341.46. The check reused Node.js 22.23.4, npm 10.9.9, Rust 1.97.1 (`aarch64-pc-windows-msvc`), Visual Studio 2022 Build Tools with MSVC 14.44.35207 / SDK 10.0.26100.0, and Clang 22.1.8. No VM configuration, guest-tool or system toolchain change was needed.

Run from an ARM64 MSVC developer command prompt with Node, Rust and Clang on its process `PATH`. The first attempt failed while building `ring` because Clang was missing from that process's `PATH`; adding the already-installed compiler fixed it. After locked dependency preparation, the frontend build, **297 Rust tests** and Clippy with warnings denied passed on `17e100d`:

```bat
npm ci --no-audit --no-fund
cargo fetch --manifest-path src-tauri/Cargo.toml --locked
set CARGO_BUILD_JOBS=1
set CARGO_PROFILE_DEV_DEBUG=0
set CARGO_PROFILE_TEST_DEBUG=0
set CARGO_NET_OFFLINE=true
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
npm run tauri -- build --debug --ci
```

Initial packaging failed with NSIS child-process error `0x2` from the system account's tool cache. The Windows-only [configuration](../src-tauri/tauri.windows.conf.json) selects NSIS and caches bundler tools under the project's target directory. With that override, the final command above rebuilt the app and successfully packaged it without a command-line bundle override. Tauri documents [platform-specific configuration and local tool caching](https://v2.tauri.app/reference/config/#uselocaltoolsdir). The Windows CI job now exercises this default packaging command.

| Output | Observed result |
| --- | --- |
| Application | 17,204,736 bytes; native ARM64 PE (`0xAA64`); Authenticode `NotSigned`. |
| NSIS installer | 3,402,263 bytes (3.24 MiB); x86 PE wrapper (`0x014C`) containing the ARM64 app; Authenticode `NotSigned`. |
| Development footprint | About 3.29 GiB for the isolated checkout, dependency caches and build output. |

These are one debug build's measurements, not release delivery or runtime resource budgets. The NSIS wrapper architecture matches Tauri's [Windows Arm packaging design](https://v2.tauri.app/distribute/windows-installer/). The default WebView2 download-bootstrapper behavior remains; this is not a self-contained offline installer. Cargo's offline setting does not stop the bundler fetching its tools. No model feature, account access or meeting capture was exercised.

**UI/UX checkpoint:** packaging completed, but the installer and app were not opened because native UI access was unavailable. Earlier demo observations do not validate this executable. Next acceptance is installation in an available ordinary-user desktop, launch, start/end of the fictional demo, keyboard disclosure/dismissal, companion focus and placement, then clean exit and uninstall. Signing, upgrades, missing-WebView2 recovery, capture, screen sharing, x64 and physical-PC checks remain separate. The build/install/launch roadmap item stays open.

## Ubuntu exploration

Parallels supports Ubuntu guests and documents installation from an ARM image on Apple silicon. Start with a supported Ubuntu LTS guest; record its exact version, architecture, desktop environment, display session, and audio configuration. [Ubuntu installation guide](https://kb.parallels.com/en/128445)

Build and launch the desktop prototype, then investigate cue focus/placement, accessibility, screen sharing, and both-side synthetic audio. Test the selected Wayland or X11 session explicitly. Record unsupported behavior and the cost of maintaining the native dependencies and packages. VM success is evidence for that configuration only.

The output is a feasibility record and a decision about a bounded Linux support target. It is not a commitment to every distribution, desktop environment, or CPU architecture.

### First VM result, 8 November 2026

Configuration: Ubuntu 26.04 LTS ARM64 (kernel 7.0) in Parallels 27.1.0 with matching guest tools, 2 virtual CPUs and 4 GiB memory. GNOME Shell 50 provides only a Wayland session. Built from app commit `b05b4dc` as an ordinary user with Rust 1.97.1 and Node.js 22.23.4, after installing `build-essential`, `pkg-config`, `libwebkit2gtk-4.1-dev` (WebKitGTK 2.52.6), `libayatana-appindicator3-dev`, `librsvg2-dev`, `libasound2-dev`, `libssl-dev`, and `libxdo-dev`.

| Check                         | Result                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend build and Rust tests | Passed; 30 Rust tests.                                                                                                                                                                                                                                                    |
| Native build                  | A native aarch64 ELF executable.                                                                                                                                                                                                                                          |
| Compiler warnings             | The same macOS-only dead-code warnings as Windows; the same fix is expected to apply but was not re-run here.                                                                                                                                                             |
| Launch and fictional demo     | In the logged-in GNOME Wayland session, the app stayed running and exposed its `TalkQTE` window to the accessibility interface (AT-SPI). Through AT-SPI, **Try demo** showed “Who will take the first draft?” and **End demo** worked; the app exited cleanly on SIGTERM. |

Wayland reports window positions as 0,0 to the accessibility interface, so this check could not confirm where the companion appears or whether it stays on top. Next: check companion placement, focus and stacking under Wayland, keyboard access and the screen reader, and both-side synthetic audio. General Linux support remains undecided.

### Companion accessibility check, 9 November 2026

In the same Ubuntu ARM64 GNOME Wayland VM, the fictional demo on commit `b05b4dc` exposed both the notebook and companion as AT-SPI frames (1024 × 736 and 320 × 76). Both reported position `(0, 0)`, so these coordinates do not establish actual placement or stacking. The fictional question appeared; the **Why?** and **Dismiss** buttons reported focusable and accepted AT-SPI focus. A synthesized Return key did not open context, so keyboard activation remains unverified; this check cannot distinguish an application issue from Wayland input synthesis restrictions. The demo ended and the test process exited on SIGTERM. No screen-reader, physical keyboard, cross-app focus, or stacking result is claimed.

### Current headless build, 11 November 2026

App commit `ab8d369` builds in an isolated checkout in the Ubuntu 26.04 LTS ARM64 guest. The current configuration is Linux 7.0.0-42, GNOME Shell 50.1, two virtual CPUs and 4 GiB assigned memory, with Parallels 27.1.0 and matching guest tools. WebKitGTK is 2.52.6 and GTK is 3.24.52. The check reused the existing Node.js 22.23.4, npm 10.9.9 and Rust 1.97.1 binaries; no system package, guest-tool or VM configuration change was needed.

The dependency preparation and validation commands passed:

```sh
npm ci --no-audit --no-fund
cargo fetch --manifest-path src-tauri/Cargo.toml --locked
npm run build
CARGO_NET_OFFLINE=true cargo test --manifest-path src-tauri/Cargo.toml --locked
CARGO_NET_OFFLINE=true npm run tauri -- build --debug --no-bundle --ci
```

The native test run passed all **297 tests**, with no failures or ignored tests. The desktop build produced an aarch64 ELF executable. Both used the default features, one Cargo build job, and `CARGO_PROFILE_DEV_DEBUG=0` / `CARGO_PROFILE_TEST_DEBUG=0` to reduce debug-information memory and disk use. Cargo's offline setting applies after dependency retrieval; it is not a claim that dependency setup or every test has no network access. The tests use fictional inputs and local test servers, with no real account, meeting capture or model trial. The isolated source, dependency caches and build output occupied about 2.9 GiB after completion; this is one development setup's footprint, not an application delivery budget.

**UI/UX checkpoint:** no application window was opened. The guest had only a Wayland login-screen session, so the earlier demo and companion observations above do not validate this current executable. Launch, keyboard activation, focus, placement/stacking and screen-reader checks still need a signed-in desktop. Audio, screen sharing, packaging, updates and physical-device support are not established by this build. The Ubuntu roadmap item stays open and general Linux support remains undecided.

Next acceptance: launch this build in an available signed-in session, start and end the fictional demo, verify notebook disclosure/dismissal by keyboard and observe companion placement and cross-app focus. Preserve existing applications and stop before any capture or meeting access that has not been explicitly authorized.

## Mobile validation

Follow the [mobile plan](mobile.md). Start with a readable touch interface and a foreground companion connected to an explicitly selected, authorized live session. A paired desktop must actually receive the meeting; pairing cannot obtain audio from a separate call on the phone by itself.

The longer-term goal remains joining Google Meet on the phone and receiving cues during that call. Same-phone audio access, simultaneous microphone use, background execution, and cue presentation each require platform-specific evidence. Keep the first paired experience and the phone-only goal distinct in releases.

## Evidence and release claims

Use fictional conversations and synthetic signals. Record app commit, OS, architecture, meeting app, audio route, and whether the result came from a VM or physical device. Keep private machine details and raw diagnostics outside the public repository.

A build is the first gate. Capture, listening/participation value, focus, accessibility, resource use, privacy, installation, and updates remain separate checks. Publish only the capabilities verified for the named release configuration.
