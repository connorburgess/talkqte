# Mobile companion plan

Status: future work. Official documentation reviewed on 2026-11-08. No mobile capture, companion connection, or mobile overlay is implemented or verified on a device.

## User goal

Join Google Meet from a phone and receive timely context and prompts that help the user stay grounded and respond during the call, including help keeping track of a question addressed directly to them. Saving and note-taking are secondary ideas requiring a separate use case; the existing note-taker can own the meeting record.

This requires both a supported source of conversation context and a usable prompt surface. Displaying a prompt does not establish access to the meeting's audio. A phone-only experience must not be promised on the strength of desktop capture or browser UI tests.

## What the first mobile experience could be

The desired end state is to open TalkQTE, join Google Meet on the same phone, and receive useful cues during that call. The first feasible slice may instead be a foreground phone companion receiving cues from a paired desktop that already has authorized access to the meeting. That is useful evidence for presentation and pairing, but it does not complete the phone-only goal.

Investigate a supported live transcript or meeting integration alongside native capture. A prior-note import cannot substitute for the current conversation. For every candidate, prove both where the live context comes from and how the cue remains usable while Meet is active. Keep macOS and Windows delivery moving while these mobile questions are unresolved.

## Keep the stack, separate the platform adapters

Tauri supports native mobile plugins in Swift for iOS and Kotlin or Java for Android. Retain the Rust-owned question lifecycle and narrow UI commands described in the [architecture](architecture.md), while implementing capture, presentation, permissions, and lifecycle handling through separate platform adapters. Desktop window behavior must not be assumed to work across mobile apps. [Tauri mobile plugin documentation](https://v2.tauri.app/develop/plugins/develop-mobile/)

## Current feasibility limits

| Capability                 | Documented constraint                                                                                                                                                                                                                                                                                                                                                                                         | Planning consequence                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android playback capture   | AudioPlaybackCapture permits media, game, and unknown usage; communication audio is outside that set. The source app's capture policy also applies. [Playback capture](https://developer.android.com/media/platform/av-capture)                                                                                                                                                                               | Do not promise Google Meet call capture through ordinary screen/audio recording. Meet's actual device behavior still needs testing.                                          |
| Android microphone sharing | Two ordinary apps cannot capture input simultaneously. Active calls have priority, with limited privileged exceptions. [Audio input sharing](https://developer.android.com/media/platform/sharing-audio-input)                                                                                                                                                                                                | Detect unavailable or silenced input. Do not attempt to take over Meet's microphone or use privileged/accessibility exceptions as a capture workaround.                      |
| iOS screen capture         | Apple's current ScreenCaptureKit sample explicitly requires **iOS 27 or later and Xcode 27 or later**. It supports a system picker for full-display capture and declares a `screen-capture` background mode. [iOS capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios)                                                                                 | This is a version-specific research path, not evidence of Google Meet audio access. The sample does not cover older iOS versions or prove capture of both call participants. |
| iOS call microphone        | Activating a recording or play-and-record audio session fails when another app is hosting a call; an app is not permitted to capture that call's microphone. [Audio-session activation](<https://developer.apple.com/documentation/avfaudio/avaudiosession/setactive(_:options:)>)                                                                                                                            | The new screen-capture API does not remove the need to prove an eligible source for both sides of the conversation.                                                          |
| Android prompt overlay     | `SYSTEM_ALERT_WINDOW` permits drawing over other apps only after explicit special permission; Android recommends this for very few apps. [Overlay permission](https://developer.android.com/reference/android/Manifest.permission#SYSTEM_ALERT_WINDOW)                                                                                                                                                        | Investigate a native, dismissible surface separately. Provide an in-app fallback when permission is denied.                                                                  |
| iOS picture-in-picture     | The documented video-call PiP view does not receive touch events for custom buttons. [Video-call PiP](https://developer.apple.com/documentation/avkit/adopting-picture-in-picture-for-video-calls)                                                                                                                                                                                                            | Do not treat PiP as an interactive version of the desktop prompt window. Test keeping TalkQTE foreground while Meet uses its own supported PiP.                              |
| Background execution       | Android microphone foreground services have start and permission restrictions. Ordinary iOS background execution is time-limited unless a supported mode applies. [Android services](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone), [iOS background execution](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time) | Do not assume a background webview, socket, or timer will run continuously. Account for suspension and expired prompts when resuming.                                        |

Google's Meet Media API preview is discontinued, accepts no new signups, and is scheduled to shut down on **2027-01-15**. It is not a dependency for this plan. The Meet REST API's meeting artifacts are a potential source for later imports, not a replacement for live call audio. [Meet discontinuation notice](https://developers.google.com/workspace/meet), [meeting artifacts](https://developers.google.com/workspace/meet/api/guides/artifacts)

## Phased implementation

### 1. Cue presentation and selected context

Validate a readable cue, source context, and user controls on a small touch screen using fictional input. Selected file imports may supply prior context; keep their source and date visible. Add provider-specific access only through supported exports or documented APIs after checking permissions and availability. Do not imply that imported notes are a live transcript. Preserve existing notebook capabilities where available, but do not make mobile notes, saving, or exports the purpose of this phase without a demonstrated participation use case.

### 2. A paired live companion

Prove a phone receiving prompts from an explicitly selected live session on a paired desktop or another documented, authorized context source. A desktop source must itself participate in or receive the meeting through a supported capture path; pairing alone does not grant access to a call on the phone.

Start with TalkQTE in the foreground. Test Meet's own PiP where supported by the device and app, or use the phone as a second screen. An integration with Granola or another note-taker must separately establish whether live context is available; an import integration is not evidence of that capability.

Pairing must be explicit, authenticated, encrypted in transit, limited to one selected session, and revocable. Show the source and connection state. Send only the context required for the chosen feature; do not transmit audio or entire notebooks by default. Sensitive notification previews should be off by default. Retention and deletion rules must cover any received copies.

### 3. Same-phone capture and prompt surfaces

Run separate native experiments for eligible audio sources on Android and iOS, including the documented iOS 27 ScreenCaptureKit path. Record results by OS, device, meeting app, and audio route. Treat an unavailable speaker stream, silent input caused by policy, or interference with the meeting as a failed capture path. Do not silently fall back to recording the speaker through the microphone.

Evaluate Android overlays and other supported platform surfaces independently from audio capture. Retain the foreground companion when the operating system cannot support the desired presentation. Do not publish phone-only support until the entire path works on the stated device matrix.

## Next experiment

**Phone cue presentation beside Meet, with no pairing or capture.** This is the smallest test of phase 1. It checks whether one cue can stay readable and controllable on a phone while Google Meet is active, before any pairing or audio work.

- **Setup:** two test accounts join a fictional call; one joins on the phone under test. On the same phone, open a page from a development server on a trusted local network that shows the companion with one fictional cue, and switch Meet to its supported picture-in-picture mode, or use split screen where Android offers it. That page has no access to the call, the desktop session, or any audio. Stop the server afterwards. **Blocked since 14 November 2026:** this step used the browser preview's **Try demo**, which was removed with the in-app demo, and the preview by itself now shows no cue. The lab's recording stage already feeds the real companion a simulated, fictional session on a desktop browser; serving that companion frame to a phone is the missing piece ([readiness blocker](product-readiness.md#native-companion-checks-need-a-cue-source--14-november-2026)).
- **Record for each phone, OS version, browser, and Meet mode:**
  - whether the question is readable at standard and large text;
  - whether **Hold** and **Dismiss** remain usable touch targets;
  - whether Meet's essential controls stay visible;
  - whether Meet audio continues uninterrupted;
  - what happens to the cue when the phone switches back to full-screen Meet, locks, or backgrounds the browser.
- **Pass:**
  - the cue is readable and dismissible beside Meet without covering its controls or interrupting its audio;
  - after the browser is suspended and resumed, an expired question does not come back as a new prompt.
- **Fail:** record what was hidden, blocked, or interrupted. A failure argues for a native surface or a second screen, not for capture work.

This does not test the live conversation, pairing, a native app, or a screen reader beyond a basic check. Results apply only to the devices and modes recorded.

**Gates that stay unresolved after it:**

- **Pairing:** how the phone discovers and authenticates one selected desktop session. This covers local network permission prompts, encryption in transit, revocation, and reconnecting after suspension without replaying stale cues.
- **Live source:** whether the paired desktop actually receives the meeting through a supported path while the user joins Meet on the phone, without echo or a second participant appearing in the call.
- **Same-phone capture:** whether any eligible audio source exists for both sides of a Meet call on iOS or Android (see the limits above).
- **Native surfaces:** Android overlays and other platform surfaces, tested separately from capture.

## Acceptance gates

- Use only fictional meetings and synthetic data. Keep raw test recordings, device logs, and runtime data outside the repository.
- Test real supported iPhone and Android devices, including older-OS fallback behavior, headphones, Bluetooth, speaker output, mute, permission denial, app startup order, backgrounding, and screen lock.
- Demonstrate both speakers' context without disrupting Meet's audio. Report unsupported capture and connection loss clearly; an active stream receiving policy-induced silence is not success.
- Verify pairing consent, session scoping, revoked access, deletion, and denial paths. Inspect network traffic and logs for unintended meeting data.
- Show one readable prompt without covering essential meeting controls. Verify touch targets, screen-reader behavior, text scaling, and dismissal.
- Test direct-address priority with fictional names: a question clearly addressed to the user takes precedence; another or uncertain addressee stays quiet. Keep the question available while answering without a competing cue, fabricated answer, response score, or countdown pressure. Dismiss remains available; saving cues is not part of the live flow.
- Preserve Rust-owned timing decisions across suspension and reconnect. Reject expired, duplicate, or out-of-order updates; a stale question must not reappear as a new prompt.
- Measure end-to-end prompt latency, battery use, thermal behavior, and resource growth during sustained synthetic calls. Publish measured limits for tested configurations, not platform-wide guarantees.
- Verify screen-sharing exposure separately. Do not claim the prompt is invisible to other participants without testing the relevant sharing mode.

Native device evidence is required before marking a capability complete. Browser previews and responsive layouts validate presentation only.
