# TalkQTE

A privacy-focused meeting companion that suggests timely questions, inspired by quick-time events.

Built in public with Rust, Tauri, and React. **Early development:** this repository currently contains the project and contribution foundation. There is no runnable app or release yet.

## The idea

Listen during a meeting, notice a point that needs clarification, and show one useful question while it is still relevant. Save the important bits in a meeting notebook afterward.

Quick-time events inspire the timing and interaction. The visual style is still being explored. Prompts should help you participate without stealing focus or demanding a response.

## Intended first version

- macOS desktop app with a meeting notebook and a small floating prompt window.
- Local Whisper transcription, with no transcription API key required.
- Microphone and system-audio capture, started explicitly by the user.
- Suggestions for missing owners, vague deadlines, and unanswered questions.
- A clear pause control, adjustable prompt frequency, and keyboard access.
- Private local storage and explicit export, using fictional data for every public demo.

These are development targets, not claims about completed features. See [ROADMAP.md](ROADMAP.md).

## Project decisions

- [Architecture and stack](docs/architecture.md)
- [Privacy design](PRIVACY.md)
- [Contribution guide](CONTRIBUTING.md)
- [Practices drawn from existing projects](docs/contribution-baseline.md)
- [Review and repository setup](docs/repository-setup.md)

## Contributing

Small fixes and documentation improvements are welcome. Discuss larger changes in an issue first. After the initial repository bootstrap, changes go through pull requests. Every contribution commit needs a [DCO](DCO) sign-off (`git commit -s`).

Code is licensed under [Apache-2.0](LICENSE). There is no separate contributor license agreement.
