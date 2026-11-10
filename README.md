![TalkQTE — a quiet meeting companion](docs/assets/talkqte-banner.png)

# TalkQTE

**AI cues that help you stay grounded and respond in the moment.**

⭐ **Star the repo to follow development.** It is early, built in public, and not yet something to install for real meetings.

TalkQTE is a small meeting companion being built to follow the conversation and surface useful context while it still matters. That might be a reminder of an earlier constraint, a point worth clarifying, or a prompt to help you respond. The aim is to help you keep up without pulling you away from listening.

One cue appears in a quiet floating window. You can inspect its context, dismiss it, or let it pass. There is no Save step or queue of questions to manage. Your existing note-taker can remain the record of what was actually said.

## The experience we are working toward

This fictional example illustrates the intended experience, not functionality the current prototype provides:

| In the conversation         | TalkQTE could surface                        |
| --------------------------- | -------------------------------------------- |
| “Can we commit to Friday?”  | “Earlier, legal said review takes two days.” |
| You need to respond         | “Will the draft be ready Wednesday?”         |
| Someone resolves the timing | Clear the cue and stay quiet.                |

AI is intended to select relevant context, decide whether a cue would help, and recognize when it is no longer useful. Clarification questions are one cue type. Generating more prompts or getting someone to speak more is not the goal.

## Where it stands today

**Early development.** The app runs from source on macOS, but it does not yet understand a live meeting or generate AI cues. A developer build can transcribe your own microphone on the device and apply the same phrase-based questions; it does not hear the other side of a call. There is no supported public release.

| Working prototype                                                                                                          | Still to build and validate                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Fictional conversation replay with fixed, phrase-based questions                                                           | AI-selected context and prompts grounded in the conversation                       |
| Floating companion, source disclosure, pause, and dismissal                                                                | Useful timing, and semantic suppression of answered questions and stale cues       |
| Phrase-based withdrawal for answers, corrections, and topic openings; the same question is not repeated within two minutes | Recognizing paraphrased answers, duplicates, and topic changes said in other words |
| Opt-in microphone activity check; local live session (dev build)                                                           | Both sides of meeting audio, model setup, and real-meeting accuracy                |
| Selected file-note imports, title-match reminders, and a development Granola connection                                    | Confirmed real-note import, and evidence that reminders help rather than interrupt |
| In-memory demo notes and reviewed Markdown export                                                                          | Reliable meeting use, processing choices, and install/update support               |

The microphone indicator measures signal activity only. It does not transcribe, record, or feed the demo. A live session is separate: see [Live session](#live-session-developer-build). Granola sign-in, listing, and requested focus suggestions have worked in account checks; selected-note import still needs real-account confirmation. Imported-note reminders use title-word matches, not a judgment of relevance. See [current privacy behavior](PRIVACY.md) and the [native validation record](docs/native-validation.md) for the limits of existing checks.

## Where we are heading

The direction is to grow from a proof of concept into a dependable AI companion that works with existing meeting tools and becomes available across desktop and mobile platforms.

| Stage                             | What it delivers                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Proof of concept — current** | A fictional conversation demo to explore cue presentation, timing, and controls.                                                                    |
| **2. Live AI companion**          | Meeting audio, transcription, and relevant AI cues working together reliably on macOS.                                                              |
| **3. Connected workflows**        | Supported connections to meeting and note-taking tools, with selected context and clear permissions.                                                |
| **4. Broader availability**       | Easy installation and updates, Windows as the next desktop target, and a mobile companion as its live-context and presentation paths are validated. |

These are development milestones, not announced release dates or current capabilities. Integrations, reliability, and platform feasibility are planned alongside the core experience; each supported release must work end to end. See the [development milestones](docs/initial-rollout.md) and [detailed roadmap](ROADMAP.md).

**Platform direction:** macOS first, Windows next. Ubuntu/Linux is an exploratory track. iPhone and Android are future companion goals, including receiving cues while using Google Meet on a phone; same-phone call access still needs to be proven. See the [platform plan](docs/platforms.md) and [mobile feasibility plan](docs/mobile.md).

[Follow development on GitHub](https://github.com/connorburgess/talkqte).

## Run the current prototype

The stack is Rust, Tauri 2, React, and TypeScript. Local Whisper transcription is available only in a `local-whisper` developer build, with model setup in Settings or a developer-supplied model path. The AI cue runtime is still being evaluated, and a lab model is not automatically the production choice.

On macOS, install Node.js 22, Rust 1.97.1, and Xcode Command Line Tools. See [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run desktop
```

`npm run dev` serves the same notebook as a browser simulation at `http://127.0.0.1:1420`, with the fictional demo and no microphone. What the notebook, companion, focus list, prior notes, and export do today, with their limits, is in [Run the prototype](docs/run-the-prototype.md).

Granola sign-in, listing, and focus suggestions have worked in account checks. Selected-note import now reads the observed private-note and summary fields; fictional headless checks pass, while a successful real-note import still needs confirmation. Reimporting refreshes a kept note when Granola supplies a newer update timestamp. Import failures now stay visible in the chooser and preserve your selection for retry; Cancel discards pending import results. Disconnect remains available while the note list loads and returns focus to Connect Granola; a late response cannot reopen the chooser or overwrite a new connection's loading state. Disconnect also invalidates delayed listing and suggestion responses, including after reconnecting; notes already imported stay until removed. Refreshing or removing a note clears a reminder quoting the old revision, even while held open; an unchanged reimport leaves it in place. Granola selection is limited to 10 notes per import (20 kept per session). Focus is optional and stays in the notebook; suggestions run only when requested.

## Live session (developer build)

A live session transcribes your microphone on this Mac and runs the phrase-based questions on what it hears. It is off in ordinary builds. To try it, build with the `local-whisper` feature (needs CMake):

```sh
npm run tauri -- dev --features local-whisper
```

Then choose **Download speech model** in Settings; **Set up live session** in the notebook opens it. It fetches the 78 MB `tiny.en` model over HTTPS from the whisper.cpp repository on Hugging Face, at a pinned revision, checks it against a pinned SHA-256, and keeps it in the app's data folder; **Remove model** deletes it. Hugging Face and its download network see your IP address and a file request from TalkQTE; no account, audio, transcript, or notes are sent. A dropped connection resumes with further requests. A developer can instead point `TALKQTE_WHISPER_MODEL` at their own model file, which is not checksum-checked.

Choose **Start live session** in the notebook and grant microphone permission if asked. **Stop live session**, in the notebook or companion, releases the microphone, finishes transcribing the last few seconds, and ends the session; **Stop microphone** does the same. If microphone access is refused or the device fails, the session ends. Speech is transcribed in chunks of up to 3 seconds, ending early at a pause, so lines appear about 3 seconds after they are spoken in a synthetic replay; the delay on real hardware has not been measured. Audio is not recorded. The transcript stays in memory until you start another session or quit, and a live session cannot be exported. Other apps' audio, including the other side of a call, is not captured. Settings shows whether this build and model support a live session.

**Pause cues**, in the notebook or companion, clears the current suggestion and keeps cues quiet while the microphone, transcript, and session clock continue. **Resume cues** waits for newly spoken lines; delayed speech from the pause does not become a new cue. The companion shows **Cues off / Mic still on** while paused. Use **Stop live session** to stop listening. These controls are [checked headlessly](docs/live-cue-pause.md); native microphone and cross-app acceptance remain separate.

This has been checked with synthetic audio and a scripted recognizer in tests. The download is tested against a simulated server, plus one ranged request to the real source. A first microphone session is recorded in the [native validation notes](docs/native-validation.md#live-session-check); measured latency, Stop/device edge cases, real-meeting accuracy and clean-install first-use acceptance remain open in the [model delivery plan](docs/model-delivery.md).

**Cancel start** appears beside microphone status while the local speech model prepares. Cancellation prevents capture even if preparation finishes later; wait for it to finish before starting again. **Stop live session** stays beside microphone status in both Notebook and Settings, independently of pending notebook actions. Microphone status confirms release; the session can keep finishing queued transcription afterward. This [notebook flow is checked headlessly](docs/notebook-capture-controls.md) on fictional IPC, over the [native cancellation race tests](docs/live-start-cancellation.md). Real-device Stop and permission checks remain pending.

**Cue processing** is available as a status and permission surface in the live notebook and Settings. The normal app has no evaluator configured: it reports **Processing unavailable** and continues to describe its local phrase rules. Fictional headless checks cover source review, approval, Pause/Disable, failures and independent Stop through the real notebook; this does not enable a model or establish native/device acceptance. See the [permission flow and UI/UX checkpoint](docs/notebook-processing-controls.md).

## Fictional cue lab

An optional developer lab evaluates one bundled fictional scenario through Claude Code with Opus 5.5 using an existing subscription. It explores when to stay quiet or resolve a cue; it is separate from the phrase-based app and does not process real calls. `npm run lab:claude` lists cases without inference. Read the [lab setup and billing checks](docs/claude-cue-lab.md) before explicitly running a case; separately billed inference APIs are not supported.

## Project context

- [Product goal](PRODUCT.md) and [development milestones](docs/initial-rollout.md)
- [Cue intelligence and evaluation](docs/cue-intelligence.md)
- [Architecture](docs/architecture.md), [product readiness](docs/product-readiness.md), and [roadmap](ROADMAP.md)
- [Troubleshooting](docs/troubleshooting.md): what each message in the prototype means and what to do
- [Research and evidence limits](docs/research.md)
- [Privacy](PRIVACY.md) and [licensing](LICENSING.md)

## Contributing

Small fixes and documentation improvements are welcome. Discuss larger changes in an issue first. After the initial repository bootstrap, changes go through pull requests. Read the [contribution guide](CONTRIBUTING.md) for commit sign-offs and the short [contributor agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md).

## License

TalkQTE is **source-available** under the [Sustainable Use License 1.0](LICENSE).

- Personal use and ordinary internal workplace use are free, including using TalkQTE in your own consulting work.
- You can inspect and modify the source, and share copies free of charge for noncommercial purposes while preserving the required notices.
- Selling TalkQTE, white-labeling it for customers, incorporating its implementation into a commercial product, or offering it as a paid hosted service requires a separate commercial agreement.

Using your notes in paid work or connecting a permitted TalkQTE installation to another note-taker does not by itself require a commercial agreement. This is not an OSI-approved open-source license. Previously published Apache-2.0 material keeps its existing permissions.

See the [licensing guide](LICENSING.md) for examples, prior-version rights, and commercial inquiries. The license text governs.
