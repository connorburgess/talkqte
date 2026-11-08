# TalkQTE product context

## Platform

web

The interface runs in a Tauri desktop shell. macOS is the first target; other desktop platforms are future work.

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

## Brand commitments

TalkQTE is the product name; talkqte is the repository name. Quick-time events inspire the timing of prompts. The interface need not imitate an arcade game. Marketing describes a privacy-focused meeting companion.

## First implementation

A runnable desktop prototype proves the dashboard, Rust-owned prompt lifecycle, and floating prompt window using a fictional demo. Audio capture and Whisper inference are subsequent technical milestones and must be clearly labeled as unavailable in this prototype.

## Open decisions

The final visual identity, target audience beyond meeting participants, and exact transcript retention defaults remain open. Proposed defaults live in PRIVACY.md. No real customer evidence or product performance benchmarks are available.
