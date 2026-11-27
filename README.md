# TalkQTE

## Stay grounded. Respond in the moment.

A quiet meeting companion on your Mac. TalkQTE brings one source-backed cue beside a live call so you can follow the conversation and respond while the moment still matters. Afterward, it can turn the transcript into cited meeting notes—or work alongside the note-taker you already use. No bot joins the meeting room.

**[Explore talkqte.com](https://talkqte.com) · [Build from source](#run-the-current-prototype) · [Follow the roadmap](ROADMAP.md)**

[![A dark basalt basin of still water, with ripples around one warm amber point of light. TalkQTE website artwork.](docs/assets/talkqte-signal-surface.jpg)](https://talkqte.com)

**Build-from-source alpha.** macOS is the first target. There is no supported signed macOS release or public installer yet. The implementation includes live transcription and model cues with your own API keys; dependable real-call behavior and useful timing still need validation.

## One cue, with its source

A context reminder, a question you could ask, a key line just said, or a question asked of you: one cue at a time, quoting where it came from. Hold it, dismiss it, or let it pass. **Pause cues** keeps the conversation transcribing without new cues; **Stop live session** ends capture.

This fictional exchange illustrates the intended experience, not a measured result:

| In the conversation        | TalkQTE could surface                        |
| -------------------------- | -------------------------------------------- |
| “Can we commit to Friday?” | “Earlier, legal said review takes two days.” |
| You need to respond        | “Will the draft be ready Wednesday?”         |
| The timing is settled      | Clear the cue and stay quiet.                |

The goal is relevant help while you keep listening. Accuracy, semantic understanding, and participation benefits remain unproven; phrase-based rules still run alongside model cues. See the [design and research notes](docs/research.md).

The live model policy favors useful sourced context over repeated questions, treats brainstorming as exploration, and stays quiet without an evidenced reason to interrupt. A narrow local check also suppresses copied questions without new cited speech. These checks do not establish live model quality; see [cue policy and limits](docs/own-key-cues.md#usefulness-policy-and-limits).

## What the alpha includes

- **A floating companion and live notebook.** Source quotes, Hold, Dismiss, Pause cues, Stop, your own notes, and the transcript. [Controls and limits](docs/glance-mode.md).
- **Live transcription and model cues.** Choose Deepgram or ElevenLabs for transcription, and Anthropic, OpenAI, or Gemini for cue decisions and meeting notes. The app calls your chosen services directly with your keys; each provider bills your account. [Provider setup](docs/provider-keys.md).
- **Interview nudges.** Open This meeting and choose Session type → Interview before starting an own-key session for brief reminders of relevant details already supplied about an example, contribution, reasoning or outcome. The mode adds no context sources and is instructed to use supplied evidence; it can still produce unsupported cues, and usefulness remains unvalidated. [Interview mode](docs/interview-mode.md).
- **Prepare before a call.** Opt-in macOS Calendar prompts offer an editable meeting title before a linked event. **Prepare session** opens the notebook without starting capture; Calendar titles stay out of provider requests. [Calendar prompts](docs/calendar-prompts.md).
- **Names within one meeting.** Rename Deepgram remote speaker labels in live or saved transcripts. These are provider guesses, not verified identities; names stay scoped to that meeting and appear in its transcript export and confirmed meeting-note requests. [Speaker names and limits](docs/meeting-history.md#remote-speaker-names).
- **Prior context you can inspect.** Import selected file notes or notes through the development Granola connection. Saved meetings can supply written or kept meeting notes for later sessions; transcripts are excluded. Prior context explains automatic-selection and archived/unavailable states; provider sharing needs a separate explicit processing review. This is not a supported live Granola integration. [Prior context](docs/run-the-prototype.md).
- **Cited notes after the call.** Confirm what will be sent, request meeting notes once, then edit, keep, or discard them. Review the exact Markdown before exporting. [Meeting notes](docs/meeting-notes.md).
- **Optional meeting organization.** Non-empty sessions save to Meetings by default; choose ask-each-time or off in Settings. Search, filter by date or notes, read, rename, archive, export, delete, or drag meetings into collapsible folders and arrange their order. Folder selectors and Move up/down controls work without dragging. [Kept meetings](docs/meeting-history.md).

The alpha is free for personal use and internal work under the license below; you pay your providers directly. The website's **Pro** offering—pay as you go without managing keys—is planned and unavailable.

## Run the current prototype

The app uses Rust, Tauri 2, React, and TypeScript. On macOS, install **Node.js 22**, the Rust toolchain pinned in [rust-toolchain.toml](rust-toolchain.toml), and **Xcode Command Line Tools**. The bundle requires macOS 14 or later; native behavior on every supported version has not been verified. See [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/connorburgess/talkqte.git
cd talkqte
npm ci
npm run desktop
```

`npm run dev` opens the notebook at `http://127.0.0.1:1420` as a browser-only preview. It has no native capture or live provider session. `npm run build` checks and builds the frontend; `npm test` runs browser behavior tests.

For platform prerequisites, unsigned Windows/Ubuntu test artifacts, and their limits, see the [platform guide](docs/platforms.md). Local ad-hoc rebuilds can repeat macOS access prompts because their code identity changes; [prompt and key-store limits](docs/provider-keys.md#repeated-macos-access-prompts) explain the distinction. Signed installation, updates, and recovery remain [release-readiness work](docs/release-path.md); mobile companions are a [future direction](docs/mobile.md).

## Live session

The Notebook puts **Start live session** first when your providers are available. Working notes remain editable before a call; **Export Markdown…** stays hidden while nothing exists to export and appears once notes exist or after a session ends (and in saved-meeting details). **This meeting** and **Prior context** stay folded until you need them; **Transcript** and **Ask** cross-link directly; persistent preferences live in grouped **Settings**; and the sidebar footer shows native build provenance on desktop (or `Browser preview` outside Tauri). The footer distinguishes the working copy from locally kept meetings. See [Notebook states and limits](docs/notebook-ready-polish.md).

1. In **Settings → Your API keys**, choose your transcription and cue providers and add their keys. macOS stores them in the Keychain. Without the required keys, the app explains what to add.
2. Read the disclosure beside **Start live session**. In ordinary own-key builds, starting immediately enables capture, cloud transcription, and cue processing for new speech. On macOS 14.2+, the session can also capture system audio from all other apps, excluding TalkQTE; where unavailable it uses the microphone alone. Use headphones, and make sure everyone whose speech is captured knows and agrees.
3. Hold or dismiss a cue as needed. **Pause cues** continues transcription; **Turn off processing** or **Stop live session** stops the session's sending. Stop can drain already-captured audio and wait briefly for final results. Review the saved meeting, request cited notes, or export afterward.

Imported or saved prior notes are not automatically sent to the cue provider. Turn processing off and explicitly select the notes in **Cue processing → Review processing** before including them. On macOS, call-start offers are on by default and can be turned off; automatic start is off unless you explicitly enable it in Settings. [Call-start controls](docs/call-prompt.md).

## Ask about recent discussion

During or after the current session, open **Ask** in the notebook, or use the companion’s **Transcript and Ask** button. **Send** explicitly shares your question and the disclosed latest transcript excerpt with your selected provider and own key. This is separate from cue approval; opening the panel sends nothing. Answers link to transcript timestamps and can be wrong. Older discussion outside the bounded excerpt is excluded. Q&A stays in memory and is not saved or exported. See [scope, controls and limits](docs/live-questions.md).

## Where your meeting goes

- **Cloud processing:** audio goes to the selected transcription provider; approved transcript context goes to the selected cue provider. Meeting-note requests send the transcript only after their separate confirmation. There is no on-device transcription or silent fallback to another service.
- **On your Mac:** TalkQTE does not save audio. Saved meetings contain transcripts, notes, and shown conversation cues in unencrypted local files, until you delete them. Change the default auto-save behavior in Settings; exports and backups have their own lifecycle.
- **Still to validate:** real-call capture, native Stop/recovery and focus, latency, accessibility, and whether cues help without distracting. Automated fictional checks do not establish those outcomes. Start with synthetic material rather than sensitive meetings.

Read [Privacy](PRIVACY.md), [native validation](docs/native-validation.md), and the [product readiness plan](docs/product-readiness.md) for the full boundaries and open acceptance checks. [Troubleshooting](docs/troubleshooting.md) covers setup and recovery.

## Contribute and license

TalkQTE is built in public. Read [CONTRIBUTING.md](CONTRIBUTING.md) for focused pull requests, human sign-offs, the contributor agreement, and fictional test-data requirements. See [SECURITY.md](SECURITY.md) for reporting a vulnerability.

**Source-available under the [Sustainable Use License 1.0](LICENSE)**, not an OSI-approved open-source license. Personal use and ordinary internal workplace use—including your own consulting work—are free. Selling, white-labeling, incorporating it into a commercial product, or offering a paid hosted service requires a separate agreement. The license governs; see the [licensing guide](LICENSING.md) and [name and logo guide](TRADEMARKS.md).

[Website artwork provenance and license](docs/assets/README.md).
