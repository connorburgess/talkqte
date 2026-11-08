# TalkQTE product context

## Platform

web

The interface runs in a Tauri desktop shell. macOS is the first target. Mobile is a future product goal: join a meeting on a phone and receive useful prompts during the call. Mobile capture and prompt presentation need separate platform validation; see the [mobile plan](docs/mobile.md).

## Stack

Rust application core, Tauri 2, React, TypeScript, and CSS. Local Whisper is the planned transcription engine.

## Purpose

One useful question, at the right moment.

Help a meeting participant notice a useful clarification while the conversation is still on that topic. TalkQTE should work on its own or alongside an existing note-taker without requiring a new notes workflow.

The initial audience includes people who want a little help participating and people who already use Granola or Fireflies for their meeting record. Keep saved questions and minimal prompt history; the existing note-taker can remain the primary record.

## Operating context

The app accompanies a meeting in another application. Its small prompt window must not take keyboard focus. Keep the resting companion quiet and minimal; use rounded surfaces, readable type, and clearly named controls when a question appears. A dashboard supports reviewing saved questions and optional notes before and after meetings.

The current notebook is a prototype surface, not a requirement to build a meeting-management product. Archives, summaries, CRM features, and a broad integration framework can wait until the clarification experience proves useful.

## Product principles

- One timely question at a time; dismissal is always easy and has no penalty.
- Let the conversation answer first. Cancel a candidate that is resolved before display, and remove a displayed question when it becomes stale or redundant. These checks are not implemented in the current phrase-based demo.
- Timing should preserve relevance without countdown pressure, scores, or a demand to respond.
- Keep the rules-first approach until observed misses or false prompts justify a more complex method.
- Capture and sharing require explicit actions and visible state.
- Meeting content is private; public demos and tests use fictional data.
- Describe implemented behavior accurately. A demo must never imply that audio is being captured.
- Build in public under the Sustainable Use License, with free personal/internal-business use and separate commercial licensing. Follow the contributor agreement, human sign-off, and pull-request policies; preserve prior Apache-2.0 grants.

## Future direct-address behavior

When the conversation clearly asks the user a question, prioritize that question over a general clarifying suggestion. Use explicit addressee evidence and the user's selected identity; a question addressed to someone else or an ambiguous addressee should stay quiet.

Keep the question visible while the user is answering, without a competing suggestion or an expiring countdown pressuring them to respond. Let the user dismiss or save it at any time. Do not fabricate an answer, assign a response score, or penalize silence. Direct-address detection and answer-aware timing are future work, not behavior provided by the current phrase-based demo.

## Brand commitments

TalkQTE is the product name; talkqte is the repository name. Marketing describes a privacy-focused meeting companion for timely questions and clearer notes.

Focus, low distraction, and compatibility are product hypotheses to test. Related products exist; do not claim TalkQTE is first, unique, or proven to improve meetings.

## Integration priorities

Evaluate Granola first, Fireflies second, and others when actual demand justifies them. Treat reading previous notes, receiving a live transcript, and writing results back as separate capabilities. Verify each against supported interfaces and user access before promising it. See the dated capability notes in [ROADMAP.md](ROADMAP.md#future-goal-work-with-other-note-taking-apps).

## Smallest useful comparison

Try a short fictional meeting workflow with and without TalkQTE, keeping the existing note-taking workflow unchanged. Use comparable scenarios and alternate the order to reduce familiarity effects. Record which questions were useful, already answered or stale, and whether a prompt made the conversation harder to follow. Include a case where the right behavior is to stay quiet.

Use the observations to choose the next small change. A demo or a few comparisons do not establish effectiveness; no broad research program or automatic collection of real meeting data is required.

## First implementation

A runnable desktop prototype proves the dashboard, Rust-owned prompt lifecycle, and floating prompt window using a fictional demo. Audio capture and Whisper inference are subsequent technical milestones and must be clearly labeled as unavailable in this prototype.

## Open decisions

The final visual identity and exact retention defaults remain open. Proposed defaults live in PRIVACY.md. No real customer evidence or product performance benchmarks are available.
