![TalkQTE — a quiet meeting companion](docs/assets/talkqte-banner.png)

# TalkQTE

**AI cues that help you stay grounded and respond in the moment.**

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
| Prior notes imported from a file you choose, with a once-per-note reminder when the conversation touches a note's title    | A connected note-taker, and evidence that reminders help rather than interrupt     |
| In-memory demo notes and reviewed Markdown export                                                                          | Reliable meeting use, processing choices, and install/update support               |

The microphone indicator measures signal activity only. It does not transcribe, record, or feed the demo. A live session is separate: see [Live session](#live-session-developer-build). No note-taker is connected; prior notes come only from a file you choose, and the reminder they can raise is a title-word match, not a judgment of relevance. See [current privacy behavior](PRIVACY.md) and the [native validation record](docs/native-validation.md) for the limits of existing checks.

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

The stack is Rust, Tauri 2, React, and TypeScript. Local Whisper transcription is available only in a developer build with a manually installed model. The AI cue runtime is still being evaluated, and a lab model is not automatically the production choice.

On macOS, install Node.js 22, Rust 1.97.1, and Xcode Command Line Tools. See [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run desktop
```

Choose **Try demo** for the fictional community-garden conversation. It requires no capture permission, model download, or API credentials. Open **Why?** to inspect a question's source and keep it available while reading; **Dismiss** clears it. Untouched questions pass quietly. New questions expand briefly, with a reduced-motion alternative. Settings provides text size, timing, companion placement, a session-only name used to notice questions asked of you in a live session, and a one-line meeting goal: when a line uses the goal's words, a question about it comes through even during the pause after another question, with either timing setting, and stays 45 seconds, the length of a question asked of you by name; a topic change still withdraws it. Both are word matches, kept only until you quit.

The companion is configured not to take keyboard focus; use the notebook for keyboard controls. Drag it by its top bar to put it anywhere on the display; choosing a position in Settings moves it back. Dismissal there returns focus to notes or the selected Transcript tab unless you have already moved elsewhere. Cross-app focus and native placement still have [pending checks](docs/native-validation.md). See [Glance view](docs/glance-mode.md) for the current hold and expiry behavior.

**Prior context from a file:** the notebook's **Add notes from a file** reads a small JSON notes file you choose (a `notes` list with an `id`, `date`, and `text` for each note; up to 1 MB and 200 notes are read, and up to 20 can be kept), lets you tick the notes to keep, and shows them beside your notebook labeled as not from this conversation. They stay in memory for the session, can be removed one by one or all at once, and are never exported. When a line of the conversation uses two or more distinctive words from a note's title, the companion shows that note once as a reminder, labeled with its date and "not from this conversation"; this is a phrase match on the title, not a judgment of relevance, and whether such reminders help is an untested hypothesis. No note-taker is connected; this is the file half of the [integration plan](docs/product-readiness.md#integration-readiness).

**Demo notes are kept in memory until you quit.** Review and export anything you want to retain. Optional notes and export support prototype exploration; saving generated cues is not part of the live flow.

<details>
<summary>Microphone activity and development commands</summary>

Choose **Start microphone** explicitly and grant macOS permission if prompted. **Stop microphone** releases the input device; the stopping state remains until release completes. Pausing or ending the fictional demo does not stop monitoring. Hiding the companion only hides its window. The monitor does not retain samples, upload audio, hear the other side of a call through system audio, or generate cues. The browser preview cannot monitor a microphone. On one Mac, the permission prompt, signal activity, and Stop releasing the microphone have been checked ([record](docs/native-validation.md#microphone-activity-check)); permission denial, device disconnect, and other setups remain unchecked.

`npm run dev` serves a separate browser simulation at `http://127.0.0.1:1420`. `npm test` runs browser behavior checks; `npm run build` builds the frontend. Browser checks do not verify Rust IPC or native windows.

`APPLE_SIGNING_IDENTITY=- npm run tauri -- build --debug --bundles app` builds an ad-hoc-signed local development app. It is not a Developer ID-signed or notarized release.

</details>

## Live session (developer build)

A live session transcribes your microphone on this Mac and runs the phrase-based questions on what it hears. It is off in ordinary builds. To try it, build with the `local-whisper` feature (needs CMake):

```sh
npm run tauri -- dev --features local-whisper
```

Then choose **Download speech model** in Settings; **Set up live session** in the notebook opens it. It fetches the 78 MB `tiny.en` model over HTTPS from the whisper.cpp repository on Hugging Face, at a pinned revision, checks it against a pinned SHA-256, and keeps it in the app's data folder; **Remove model** deletes it. Hugging Face and its download network see your IP address and a file request from TalkQTE; no account, audio, transcript, or notes are sent. A dropped connection resumes with further requests. A developer can instead point `TALKQTE_WHISPER_MODEL` at their own model file, which is not checksum-checked.

Choose **Start live session** in the notebook and grant microphone permission if asked. **Stop live session**, in the notebook or companion, releases the microphone, finishes transcribing the last few seconds, and ends the session; **Stop microphone** does the same. If microphone access is refused or the device fails, the session ends. Speech is transcribed in chunks of up to 3 seconds, ending early at a pause, so lines appear about 3 seconds after they are spoken in a synthetic replay; the delay on real hardware has not been measured. Audio is not recorded. The transcript stays in memory until you start another session or quit, and a live session cannot be exported. Other apps' audio, including the other side of a call, is not captured. Settings shows whether this build and model support a live session.

This has been checked with synthetic audio and a scripted recognizer in tests. The download is tested against a simulated server, plus one ranged request to the real source. A live session on real hardware, real-meeting accuracy, and the first-run setup step in the [model delivery plan](docs/model-delivery.md) are still unchecked or unbuilt.

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
