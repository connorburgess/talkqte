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

## Ubuntu exploration

Parallels supports Ubuntu guests and documents installation from an ARM image on Apple silicon. Start with a supported Ubuntu LTS guest; record its exact version, architecture, desktop environment, display session, and audio configuration. [Ubuntu installation guide](https://kb.parallels.com/en/128445)

Build and launch the desktop prototype, then investigate cue focus/placement, accessibility, screen sharing, and both-side synthetic audio. Test the selected Wayland or X11 session explicitly. Record unsupported behavior and the cost of maintaining the native dependencies and packages. VM success is evidence for that configuration only.

The output is a feasibility record and a decision about a bounded Linux support target. It is not a commitment to every distribution, desktop environment, or CPU architecture.

## Mobile validation

Follow the [mobile plan](mobile.md). Start with a readable touch interface and a foreground companion connected to an explicitly selected, authorized live session. A paired desktop must actually receive the meeting; pairing cannot obtain audio from a separate call on the phone by itself.

The longer-term goal remains joining Google Meet on the phone and receiving cues during that call. Same-phone audio access, simultaneous microphone use, background execution, and cue presentation each require platform-specific evidence. Keep the first paired experience and the phone-only goal distinct in releases.

## Evidence and release claims

Use fictional conversations and synthetic signals. Record app commit, OS, architecture, meeting app, audio route, and whether the result came from a VM or physical device. Keep private machine details and raw diagnostics outside the public repository.

A build is the first gate. Capture, listening/participation value, focus, accessibility, resource use, privacy, installation, and updates remain separate checks. Publish only the capabilities verified for the named release configuration.
