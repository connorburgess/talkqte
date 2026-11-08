![TalkQTE — a quiet meeting companion](docs/assets/talkqte-banner.png)

# TalkQTE

A privacy-focused meeting companion for timely context and participation.

Built in public with Rust, Tauri, and React. **Early development:** a runnable desktop prototype is available from source. It plays a fictional meeting and includes an opt-in macOS microphone activity monitor. Live meeting transcription, system-audio capture, and persistent storage are not implemented yet. There is no signed release.

## The idea

Stay grounded. Respond in the moment. The aim is to supply relevant context and prompts while the conversation is still on that topic. A clarification question is one possible cue. The intended flow is context, an opportunity to respond, then the cue clears. Your existing note-taker can remain the record of what was said or decided; saving a prompt is not part of the core experience.

The current prototype uses fictional dialogue and phrase rules; broader context assistance is the intended direction. Follow development on GitHub.

Prompts should help you participate without stealing focus or demanding a response. TalkQTE is intended to work independently or alongside tools such as Granola and Fireflies; provider integrations are future work. The visual style is still being explored.

## Try the prototype

On macOS, install Node.js 22, Rust 1.97.1, and Xcode Command Line Tools. See [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/) for native build requirements.

```sh
npm ci
npm run desktop
```

Choose **Try demo** to play a fictional community-garden conversation. The notebook lets you:

- See transcript segments arrive and receive one timed question at a time.
- Read a compact question by default. Open **Why?** for its source and keep it available while you read, then save or dismiss it.
- New questions expand briefly once, and opening **Why?** reveals the source. Reduced-motion preferences show both immediately.
- Pause/resume the demo, keep using question controls while paused, and adjust the gap between questions.
- Write notes and replay the demo while keeping saved questions and notes in memory.
- Review the exact Markdown export before choosing a file destination.
- Use a desktop companion that stays compact between questions. In Settings, choose larger question text or optional near-camera placement; the default remains bottom-right on the notebook's display.

An opened question stays available after its original expiry and when demo playback finishes, with an earlier-question label when appropriate. Hiding its context keeps the hold; Save, Dismiss, explicitly ending the demo, or replaying clears it. Untouched questions still pass quietly. Appearance settings last until you quit. The companion is configured not to take keyboard focus; use the notebook for keyboard question controls. Save or Dismiss in the notebook returns focus to notes, or the selected Transcript tab, unless you have already moved to another control or application. Cross-app focus and native placement still need verification; see the [native validation record](docs/native-validation.md). Glance view does not access the camera or alter video. See the [design choices, supporting studies, and evidence limits](docs/glance-mode.md).

**The prototype does not save your notebook when you quit.** Export anything you want to keep. The demo captures no audio, downloads no models, and requires no API credentials. Suggestions use a few phrase rules, not a language model.

### Check microphone activity

The native macOS app has separate microphone controls. Start monitoring explicitly, then grant the operating system's microphone permission if prompted. The indicator reports coarse signal activity from the current default microphone. Noise can trigger it; it does not detect speech, identify a meeting, or generate questions from audio.

Choose **Stop microphone** to release the input device. The app shows a stopping state until release completes. Pausing or ending the fictional demo does not stop microphone monitoring; hiding the companion only hides its window. Monitoring does not start automatically and does not retain samples, create recordings, or upload audio. It does not hear the other side of a call through system audio. The browser preview cannot monitor a microphone.

Synthetic lifecycle tests and a macOS build cover the adapter, but real microphone permission, device-disconnect, and audio-operation checks still need explicit native testing. See [PRIVACY.md](PRIVACY.md) for current behavior and limitations.

For UI development, `npm run dev` starts a browser preview at `http://127.0.0.1:1420`. It uses a separate simulated adapter and cannot verify native window behavior. For packaged macOS testing, `APPLE_SIGNING_IDENTITY=- npm run tauri -- build --debug --bundles app` builds an ad-hoc-signed development app with the microphone entitlement. This is not a Developer ID-signed or notarized release.

## Intended first usable version

- macOS desktop app with a small floating cue window and clear context and response controls.
- Local Whisper transcription, with no transcription API key required.
- Microphone and system-audio capture, started explicitly by the user.
- Clarification prompts for missing owners, vague deadlines, and unanswered questions as the first bounded slice; source-backed context reminders need separate validation.
- A clear pause control, adjustable prompt frequency, and keyboard access.
- Clear privacy and retention choices for any saved content. Saving, note-taking, and export are secondary use cases to validate; public demos use fictional data.

These are development targets. The activity monitor does not yet transcribe meetings or supply live prompts, and the prototype has no retention controls. See [ROADMAP.md](ROADMAP.md) and the [current privacy behavior](PRIVACY.md).

## Project decisions

- [Product goal and first proof](PRODUCT.md#goal-and-first-proof)
- [Cue intelligence, feedback, and runtime candidates](docs/cue-intelligence.md)
- [Research summary and product decisions](docs/research.md)
- [Architecture and stack](docs/architecture.md)
- [Glance view design and research](docs/glance-mode.md)
- [Privacy design](PRIVACY.md)
- [Contribution guide](CONTRIBUTING.md)
- [Practices drawn from existing projects](docs/contribution-baseline.md)
- [Review and repository setup](docs/repository-setup.md)

## Contributing

Small fixes and documentation improvements are welcome. Discuss larger changes in an issue first. After the initial repository bootstrap, changes go through pull requests. Read the [contribution guide](CONTRIBUTING.md) for commit sign-offs and the short [contributor agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md).

## License

TalkQTE is **source-available** under the [Sustainable Use License 1.0](LICENSE).

- Personal use and ordinary internal workplace use are free, including using TalkQTE in your own consulting work.
- You can inspect and modify the source, and share copies free of charge for noncommercial purposes while preserving the required notices.
- Selling TalkQTE, white-labeling it for customers, incorporating its implementation into a commercial product, or offering it as a paid hosted service requires a separate commercial agreement.

Using your notes in paid work or connecting a permitted TalkQTE installation to another note-taker does not by itself require a commercial agreement. This is not an OSI-approved open-source license. Previously published Apache-2.0 material keeps its existing permissions.

See the [licensing guide](LICENSING.md) for examples, prior-version rights, and commercial inquiries. The license text governs.
