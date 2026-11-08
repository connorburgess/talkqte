# TalkQTE product context

## Platform

web

The interface runs in a Tauri desktop shell. macOS is the first target. Mobile is a future product goal: join a meeting on a phone and receive useful prompts during the call. Mobile capture and prompt presentation need separate platform validation; see the [mobile plan](docs/mobile.md).

## Stack

Rust application core, Tauri 2, React, TypeScript, and CSS. Local Whisper is the planned transcription engine.

## Purpose

Stay grounded. Respond in the moment.

Help a meeting participant follow what is happening and use relevant context to respond while the moment still matters. A clarification question is one possible prompt; a concise source-backed reminder or response prompt may also support participation. These broader cue types are product directions to validate, not implemented capabilities. TalkQTE should work on its own or alongside an existing note-taker without requiring a new notes workflow.

The initial audience includes people who want a little help participating and people who already use Granola or Fireflies for their meeting record. The existing note-taker can remain the primary record. Saving prompts and note-taking are secondary capabilities whose value needs a demonstrated use case; they are not the core product promise or required end of the experience. This direction does not remove existing Save, notes, or export functionality.

The intended flow is relevant context, an opportunity to respond, then the cue clears when no longer useful. An existing note-taker owns the record of what was actually said or decided; TalkQTE should not ask the user to save the same conversation again. An unused suggestion is not a meeting fact, decision, or action item and should not be automatically written into that record. There is no established need for a saved-prompt archive.

## Goal and first proof

**Help someone stay grounded and respond in the moment through timely, relevant context while continuing to follow the conversation.** A cue that arrives too late, introduces unsupported context, or makes listening harder fails that goal even if its wording is good. Useful participation can include understanding without speaking; response speed or speaking more is not an end in itself.

**Deliver the defined feature set as a dependable product that people can discover, install, use with their existing tools, and keep up to date with minimal friction.** Production reliability, scalability, integration readiness, distribution, and ongoing support are part of the goal from the start. Plan and validate them alongside feature development rather than leaving them until the prototype feels complete.

The first technical goal is a macOS companion that can receive both sides of a synthetic call, transcribe locally, and show one controllable cue without taking focus from the meeting. Clarification questions remain the bounded first implementation slice. The current fictional demo and separate microphone activity monitor do not meet that goal yet. See the [technical milestone](ROADMAP.md#first-technical-milestone).

The first product proof is a comparison of short fictional conversations with and without cues. Check whether the cue supplies accurate relevant context, helps the participant stay oriented or make an appropriate response in time, and preserves comprehension of surrounding speech. Compare clarification questions and context reminders separately with human-selected content before automating them. Keep useful clarification as a specific outcome of the question condition. Include already-answered, late, unsupported, and distracting cues, and cases where staying quiet is correct. Check ignore, hold, and dismiss controls. Agree on acceptance criteria before evaluation; more prompts, faster speech, or more saves alone is not success.

This keeps the next work focused on live input, relevance, timing, and user control. Broader meeting management, summaries, and integrations follow only when they support that experience. Camera-facing gaze is an optional presentation preference, not the product goal or a measure of successful participation.

See [research and product decisions](docs/research.md) for the short evidence summary, what we use, and wording suitable for the website.

## Whole-product readiness

The [product readiness plan](docs/product-readiness.md) connects the feature roadmap to production engineering, Granola and other integrations, onboarding, privacy and security, distribution, support, and sustainable operating costs. A working demo establishes only part of readiness.

For each meaningful feature or milestone, identify its user outcome, production failure cases, performance or capacity limits, integration implications, and path into a supported release. Record an acceptance check and the next unresolved dependency. Choose bounded work across these areas according to the next release blocker; do not let either feature work or speculative infrastructure consume the whole roadmap.

For the local-first core, scaling includes resource use on supported devices, reliable model and application delivery, compatible upgrades, and support effort as adoption grows. Add services or a more complex architecture only when a measured need and operating plan justify them. Frictionless use preserves explicit capture and sharing choices, clear permissions, and an easy way to stop or disconnect.

## Operating context

The app accompanies a meeting in another application. Its small prompt window must not take keyboard focus. Keep the resting companion quiet and minimal; use rounded surfaces, readable type, and clearly named controls when a cue appears. The current notebook supports saved questions and optional notes; it is an existing prototype capability, not a required step in the intended experience.

The current notebook is a prototype surface, not a requirement to build a meeting-management product. Additional saving, archives, summaries, and CRM work need a specific use case that supports participation. Integration readiness continues alongside the core work, with selected prior context as the first Granola candidate.

## Product principles

- One timely cue at a time; dismissal is always easy and has no penalty.
- Ground context and response prompts in inspectable sources. Do not invent facts, commitments, or an answer on the user's behalf.
- Let the conversation answer first. Cancel a candidate that is resolved before display, and remove a displayed question when it becomes stale or redundant. These checks are not implemented in the current phrase-based demo.
- Timing should preserve relevance without countdown pressure, scores, or a demand to respond.
- Keep the rules-first approach until observed misses or false prompts justify a more complex method.
- Plan production operation, integration, installation, updates, and support alongside the feature they enable; distinguish planned readiness from verified capability.
- Capture and sharing require explicit actions and visible state.
- Meeting content is private; public demos and tests use fictional data.
- Describe implemented behavior accurately. A demo must never imply that audio is being captured.
- Build in public under the Sustainable Use License, with free personal/internal-business use and separate commercial licensing. Follow the contributor agreement, human sign-off, and pull-request policies; preserve prior Apache-2.0 grants.

## Future direct-address behavior

When the conversation clearly asks the user a question, prioritize that question over a general clarifying suggestion. Use explicit addressee evidence and the user's selected identity; a question addressed to someone else or an ambiguous addressee should stay quiet.

Keep the question visible while the user is answering, without a competing suggestion or an expiring countdown pressuring them to respond. Let the user dismiss or save it at any time. Do not fabricate an answer, assign a response score, or penalize silence. Direct-address detection and answer-aware timing are future work, not behavior provided by the current phrase-based demo.

## Brand commitments

TalkQTE is the product name; talkqte is the repository name. Describe a privacy-focused meeting companion for timely context and participation. Suggested headline: **Stay grounded. Respond in the moment.** AI assistance is the intended direction, not a claim that the phrase-based prototype already generates language-model responses. Note-taking or agentic note-taking should not define the product without a separate use case.

Focus, low distraction, and compatibility are product hypotheses to test. Related products exist; do not claim TalkQTE is first, unique, or proven to improve meetings.

## Current public presentation

Explain the idea and give interested people a reason to follow development. Use a short fictional **Concept preview**, with **Follow development on GitHub** as the primary link. Keep links and topics few and relevant. Downloads, tester recruitment, and a broad launch are later stages; production and integration planning still continue now.

Proposed sequence:

- Conversation: “Can we commit to Friday?”
- Context cue: “Earlier, legal said review takes two days.”
- Response prompt: “Will the draft be ready Wednesday?”

The intended benefit occurs during the conversation; no save or export step is required. Label this as an intended experience, distinct from the current fictional dialogue and phrase-rule prototype. It is not evidence of live transcription or language-model-generated context.

## Integration priorities

Plan and validate integration boundaries now, alongside the core experience. Evaluate Granola first, Fireflies second, and others when actual demand justifies them. Treat reading previous notes, receiving a live transcript, and writing results back as separate capabilities. Verify supported interfaces, account access, authentication, data handling, and failure recovery before promising a connection. Keep the core useful when a provider is unavailable. See the [readiness plan](docs/product-readiness.md#integration-readiness) and dated capability notes in [ROADMAP.md](ROADMAP.md#future-goal-work-with-other-note-taking-apps).

## Smallest useful comparison

Try a short fictional meeting workflow with and without TalkQTE, keeping any existing note-taking workflow unchanged. Start with human-selected cues to isolate the interaction from detection errors. Use comparable scenarios and alternate order to reduce familiarity effects. Evaluate timely, context-grounded participation and listening comprehension together; measure useful clarification within the question condition. Compare context reminders as a separate condition, including whether people remain oriented without needing to speak. Record stale or unsupported cues and distraction. Include a case where the right behavior is to stay quiet. Saving is not a required outcome.

Use the observations to choose the next small change. A demo or a few comparisons do not establish effectiveness; no broad research program or automatic collection of real meeting data is required.

## First implementation

A runnable desktop prototype provides the dashboard, Rust-owned prompt lifecycle, and floating prompt window using a fictional demo. An optional macOS microphone activity monitor reports signal activity after explicit opt-in. It does not generate questions from audio or transcribe speech. System-audio capture, Whisper inference, and a live clarification pipeline remain subsequent technical milestones. Real microphone operation and native cross-app companion behavior still need platform verification.

## Open decisions

The final visual identity and exact retention defaults remain open. Proposed defaults live in PRIVACY.md. No real customer evidence or product performance benchmarks are available.
