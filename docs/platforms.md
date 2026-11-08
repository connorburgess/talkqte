# Platform plan

Planning baseline, 8 November 2026. These are delivery priorities and validation tasks, not current support claims. The prototype currently runs from source on macOS.

| Platform           | Direction                                                 | Next evidence                                                                                                                |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| macOS              | First live companion and release target                   | Both sides of a synthetic call, useful cues, native companion behavior, and a clean signed installation                      |
| Windows            | Next planned desktop platform                             | Build and launch in Parallels, then validate capture, focus, and distribution on the claimed configurations                  |
| Ubuntu/Linux       | Exploratory; general support undecided                    | Build and run an Ubuntu ARM64 guest, record audio/window limitations, and assess maintenance effort                          |
| iPhone and Android | Future companion goal, including Google Meet on the phone | Establish a supported live-context source and usable cue surface independently; prove same-phone capture before promising it |

## Windows validation

Use Parallels for an initial development and smoke-test environment. On Apple silicon, the ordinary guest path is Windows on Arm. Record whether TalkQTE itself runs natively or under emulation. A successful Arm guest run does not prove x64 or physical-PC compatibility. Check the installed Parallels version against its [supported guest systems](https://kb.parallels.com/en/124223).

1. Record guest OS, architecture, VM resources, WebView2, and build prerequisites. Build the frontend and native app, run Rust tests, and launch the fictional demo.
2. Check companion placement, keyboard focus, display scaling, accessibility, full-screen meeting windows, and screen sharing. Preserve the user's control of the meeting app.
3. Implement and validate the Windows capture adapter using synthetic calls. Check both speakers, headphones, microphone/output changes, denial, and Stop/recovery. Virtual audio results apply only to that setup.
4. Add Windows build and Rust checks once the target builds reproducibly. Browser tests on Linux runners do not establish native Windows behavior.
5. Before advertising support, test installation, signing, updates, uninstall, sustained performance, and audio behavior on the hardware and architectures the release names. Track physical-device evidence separately from VM evidence.

The first acceptance gate is a reproducible Windows build and fictional demo in the VM, with the remaining native gaps recorded. This work can proceed alongside macOS reliability work without delaying its first live milestone.

### First VM result, 8 November 2026

Configuration: Windows 11 Arm (build 26300), Parallels 27.1.0 host with 27.0.3 guest tools, WebView2 157.0.4341.42. Built from app commit `b05b4dc` with Visual Studio 2022 Build Tools (MSVC 14.44, ARM64 C++ tools, Windows 11 SDK 26100), Rust 1.97.1 (`aarch64-pc-windows-msvc`), and Node.js 22.23.4. Commands: `npm ci`, `npm run build`, `cargo test --locked`, and `npm run tauri -- build --debug --no-bundle`.

| Check                         | Result                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Frontend build and Rust tests | Passed; 30 Rust tests, the same count as macOS.                                                                                   |
| Native build                  | A native ARM64 executable (PE machine `0xAA64`), not emulated.                                                                    |
| Launch                        | The main window opened and stayed responsive with a WebView2 child process; it closed cleanly.                                    |
| Fictional demo                | Through Windows UI Automation, **Try demo** started playback, “Who will take the first draft?” appeared, and **End demo** worked. |
| Missing Windows icon          | The build stopped until `src-tauri/icons/icon.ico` existed. Added from the existing PNG.                                          |
| Compiler warnings             | macOS-only microphone code produced dead-code warnings, which fail the CI lint. Now allowed off macOS only.                       |

Not checked or not available: microphone monitoring (reports unsupported off macOS), companion placement, focus, display scaling, accessibility, full-screen meetings, and screen sharing. Also not covered: installer, signing, release builds (the debug build opens a console window), x64, and physical PCs. This result covers one Arm VM configuration only.

## Ubuntu exploration

Parallels supports Ubuntu guests and documents installation from an ARM image on Apple silicon. Start with a supported Ubuntu LTS guest; record its exact version, architecture, desktop environment, display session, and audio configuration. [Ubuntu installation guide](https://kb.parallels.com/en/128445)

Build and launch the desktop prototype, then investigate cue focus/placement, accessibility, screen sharing, and both-side synthetic audio. Test the selected Wayland or X11 session explicitly. Record unsupported behavior and the cost of maintaining the native dependencies and packages. VM success is evidence for that configuration only.

The output is a feasibility record and a decision about a bounded Linux support target. It is not a commitment to every distribution, desktop environment, or CPU architecture.

### First VM result, 8 November 2026

Configuration: Ubuntu 26.04 LTS ARM64 (kernel 7.0) in Parallels 27.1.0 with matching guest tools, 2 virtual CPUs and 4 GiB memory. GNOME Shell 50 provides only a Wayland session. Built from app commit `b05b4dc` as an ordinary user with Rust 1.97.1 and Node.js 22.23.4, after installing `build-essential`, `pkg-config`, `libwebkit2gtk-4.1-dev` (WebKitGTK 2.52.6), `libayatana-appindicator3-dev`, `librsvg2-dev`, `libasound2-dev`, `libssl-dev`, and `libxdo-dev`.

| Check                         | Result                                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| Frontend build and Rust tests | Passed; 30 Rust tests.                                                   |
| Native build                  | A native aarch64 ELF executable.                                         |
| Compiler warnings             | The same macOS-only dead-code warnings as Windows; the same fix applies. |
| Launch and fictional demo     | Not run: no desktop session was logged in on the VM.                     |

Next: log in to a desktop session, then launch the demo. Record how the companion behaves on Wayland, which limits how apps place their own windows and keep them on top. Note whether X11 is unavailable on this release, and check accessibility and both-side audio. General Linux support remains undecided.

## Mobile validation

Follow the [mobile plan](mobile.md). Start with a readable touch interface and a foreground companion connected to an explicitly selected, authorized live session. A paired desktop must actually receive the meeting; pairing cannot obtain audio from a separate call on the phone by itself.

The longer-term goal remains joining Google Meet on the phone and receiving cues during that call. Same-phone audio access, simultaneous microphone use, background execution, and cue presentation each require platform-specific evidence. Keep the first paired experience and the phone-only goal distinct in releases.

## Evidence and release claims

Use fictional conversations and synthetic signals. Record app commit, OS, architecture, meeting app, audio route, and whether the result came from a VM or physical device. Keep private machine details and raw diagnostics outside the public repository.

A build is the first gate. Capture, listening/participation value, focus, accessibility, resource use, privacy, installation, and updates remain separate checks. Publish only the capabilities verified for the named release configuration.
