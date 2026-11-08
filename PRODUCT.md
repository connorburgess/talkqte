# TalkQTE product context

## Platform

web

The interface runs in a Tauri desktop shell. macOS is the first target. Mobile is a future product goal: join a meeting on a phone and receive useful prompts during the call. Mobile capture and prompt presentation need separate platform validation; see the [mobile plan](docs/mobile.md).

## Stack

Rust application core, Tauri 2, React, TypeScript, and CSS. Local Whisper is the planned transcription engine.

## Purpose

Help a meeting participant notice a useful clarifying question while the conversation is still on that topic. Keep questions, notes, and decisions together in a meeting notebook.

## Operating context

The app accompanies a meeting in another application. Its small prompt window must not take keyboard focus. A dashboard supports reviewing notes and questions before and after meetings. Future integrations should complement Granola and other note-takers through explicitly selected imports and exports.

## Product principles

- One timely question at a time; dismissal is always easy and has no penalty.
- Capture and sharing require explicit actions and visible state.
- Meeting content is private; public demos and tests use fictional data.
- Describe implemented behavior accurately. A demo must never imply that audio is being captured.
- Build in public with Apache-2.0, human DCO sign-offs, and feature pull requests.

## Future direct-address behavior

When the conversation clearly asks the user a question, prioritize that question over a general clarifying suggestion. Use explicit addressee evidence and the user's selected identity; a question addressed to someone else or an ambiguous addressee should stay quiet.

Keep the question visible while the user is answering, without a competing suggestion or an expiring countdown pressuring them to respond. Let the user dismiss or save it at any time. Do not fabricate an answer, assign a response score, or penalize silence. Direct-address detection and answer-aware timing are future work, not behavior provided by the current phrase-based demo.

## Brand commitments

TalkQTE is the product name; talkqte is the repository name. Marketing describes a privacy-focused meeting companion for timely questions and clearer notes.

## First implementation

A runnable desktop prototype proves the dashboard, Rust-owned prompt lifecycle, and floating prompt window using a fictional demo. Audio capture and Whisper inference are subsequent technical milestones and must be clearly labeled as unavailable in this prototype.

## Open decisions

The final visual identity, target audience beyond meeting participants, and exact transcript retention defaults remain open. Proposed defaults live in PRIVACY.md. No real customer evidence or product performance benchmarks are available.
