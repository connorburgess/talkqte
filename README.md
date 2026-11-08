# TalkQTE

A privacy-focused meeting companion for timely questions and clearer notes.

Built in public with Rust, Tauri, and React. **Early development:** a runnable desktop prototype is available from source. It plays a fictional meeting; audio capture, Whisper transcription, and persistent storage are not implemented yet. There is no signed release.

## The idea

One useful question, at the right moment. Notice a point that needs clarification during a meeting and show a question while it is still relevant. Save a question for later without replacing an existing notes workflow.

Prompts should help you participate without stealing focus or demanding a response. TalkQTE is intended to work independently or alongside tools such as Granola and Fireflies; provider integrations are future work. The visual style is still being explored.

## Try the prototype

On macOS, install Node.js 22, Rust 1.97.1, and Xcode Command Line Tools. See [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/) for native build requirements.

```sh
npm ci
npm run desktop
```

Choose **Try demo** to play a fictional community-garden conversation. The notebook lets you:

- See transcript segments arrive and receive one timed question at a time.
- Save or dismiss a question, pause/resume the demo, and adjust the gap between questions.
- Write notes and replay the demo while keeping saved questions and notes in memory.
- Review the exact Markdown export before choosing a file destination.
- Use a bottom-right desktop companion that stays compact between questions, expands for a prompt, and offers pause and hide controls.

**The prototype does not save your notebook when you quit.** Export anything you want to keep. The demo captures no audio, downloads no models, and requires no API credentials. Suggestions use a few phrase rules, not a language model.

For UI development, `npm run dev` starts a browser preview at `http://127.0.0.1:1420`. It uses a separate simulated adapter and cannot verify native window behavior. `npm run tauri -- build --debug --bundles app` builds an unsigned macOS development app.

## Intended first usable version

- macOS desktop app with a small floating prompt window and saved questions.
- Local Whisper transcription, with no transcription API key required.
- Microphone and system-audio capture, started explicitly by the user.
- Suggestions for missing owners, vague deadlines, and unanswered questions.
- A clear pause control, adjustable prompt frequency, and keyboard access.
- Private local storage and explicit export, using fictional data for every public demo.

These are development targets. The prototype does not yet listen to meetings or provide retention controls. See [ROADMAP.md](ROADMAP.md) and the [current privacy behavior](PRIVACY.md).

## Project decisions

- [Architecture and stack](docs/architecture.md)
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
