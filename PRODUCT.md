# TalkQTE product context

## Platform

web

The interface runs in a Tauri desktop shell. macOS is the first target, with Windows planned next. Ubuntu/Linux is an exploratory validation track; broader Linux support is undecided. iPhone and Android are future companion goals: join a meeting on a phone and receive useful prompts during the call. Mobile conversation access and prompt presentation need separate validation. See the [platform plan](docs/platforms.md) and [mobile plan](docs/mobile.md).

## Stack

Rust application core, Tauri 2, React, TypeScript, and CSS. Optional local Whisper transcription is available in a developer build; cue reasoning is a separate, unselected runtime.

## Purpose

Stay grounded. Respond in the moment.

Use AI to help a meeting participant follow what is happening and surface relevant context to respond while the moment still matters. A clarification question is one possible prompt; a concise source-backed reminder or response prompt may also support participation. General semantic reminders and response assistance remain product directions to validate. The prototype can already show selected-note excerpts through title-word matches; that limited rule does not judge relevance. TalkQTE should work on its own or alongside an existing note-taker without requiring a new notes workflow.

The initial audience includes people who want a little help participating and people who already use Granola or Fireflies for their meeting record. The existing note-taker can remain the primary record. The live cue has context disclosure and dismissal, with no Save action or saved-question workflow. Optional notes and export remain prototype utilities; they are not the product promise.

The intended flow is relevant context, an opportunity to respond, then the cue clears when no longer useful. An existing note-taker owns the record of what was actually said or decided; TalkQTE should not ask the user to save the same conversation again. An unused suggestion is not a meeting fact, decision, or action item and should not be automatically written into that record. There is no established need for a saved-prompt archive.

## Goal and first proof

**Help someone stay grounded and respond in the moment through timely, relevant context while continuing to follow the conversation.** A cue that arrives too late, introduces unsupported context, or makes listening harder fails that goal even if its wording is good. Useful participation can include understanding without speaking; response speed or speaking more is not an end in itself.

**Deliver the defined feature set as a dependable product that people can discover, install, use with their existing tools, and keep up to date with minimal friction.** Production reliability, scalability, integration readiness, distribution, and ongoing support are part of the goal from the start. Plan and validate them alongside feature development rather than leaving them until the prototype feels complete.

The first technical goal is a macOS companion that can receive both sides of a synthetic call, transcribe locally, and show one controllable cue without taking focus from the meeting. Clarification questions remain the bounded first implementation slice. The current fictional demo and separate microphone activity monitor do not meet that goal yet. See the [technical milestone](ROADMAP.md#first-technical-milestone).

The first product proof is a comparison of short fictional conversations with and without cues. Check whether the cue supplies accurate relevant context, helps the participant stay oriented or make an appropriate response in time, and preserves comprehension of surrounding speech. Compare clarification questions and context reminders separately with human-selected content before automating them. Keep useful clarification as a specific outcome of the question condition. Include already-answered, late, unsupported, and distracting cues, and cases where staying quiet is correct. Check ignore, hold, and dismiss controls. Agree on acceptance criteria before evaluation; more prompts, faster speech, or more saves alone is not success.

This keeps the next work focused on live input, relevance, timing, and user control. Broader meeting management, summaries, and integrations follow only when they support that experience. Camera-facing gaze is an optional presentation preference, not the product goal or a measure of successful participation.

See [research and product decisions](docs/research.md) for the short evidence summary, what we use, and wording suitable for the website.

## Development direction

Progress from the current proof of concept to a live AI meeting companion, then expand supported integrations and platform availability. macOS is the first delivery target, followed by Windows. Use Parallels for initial Windows and Ubuntu experiments, recording guest architecture and virtual hardware limits. Ubuntu/Linux remains exploratory. Mobile work starts with cue presentation and a supported live-context source; same-phone capture is a separate feasibility gate. Each platform needs its own capture, presentation, accessibility, and distribution validation.

The public roadmap describes delivered capabilities and the evidence needed to support them. Test-participant selection and internal execution arrangements are not the product audience. Automated fictional scenarios establish reproducible behavior; human evaluation establishes whether cues help participation while preserving listening. See the [development milestones](docs/initial-rollout.md) for scope and acceptance criteria.

## Whole-product readiness

The [product readiness plan](docs/product-readiness.md) connects the feature roadmap to production engineering, Granola and other integrations, onboarding, privacy and security, distribution, support, and sustainable operating costs. A working demo establishes only part of readiness.

For each meaningful feature or milestone, identify its user outcome, production failure cases, performance or capacity limits, integration implications, and path into a supported release. Record an acceptance check and the next unresolved dependency. Choose bounded work across these areas according to the next release blocker; do not let either feature work or speculative infrastructure consume the whole roadmap.

For the local-first core, scaling includes resource use on supported devices, reliable model and application delivery, compatible upgrades, and support effort as adoption grows. Add services or a more complex architecture only when a measured need and operating plan justify them. Frictionless use preserves explicit capture and sharing choices, clear permissions, and an easy way to stop or disconnect.

## Operating context

The app accompanies a meeting in another application. Its small prompt window must not take keyboard focus. Keep the resting companion quiet and minimal; use rounded surfaces, readable type, and clearly named controls when a cue appears. The current notebook supports the fictional demo and optional notes; it is not a required step in the intended live experience.

The integration direction is to bring cues into the existing note-taker workflow, with Granola first; an embedded presentation surface still needs supported provider access. The TalkQTE notebook can be an optional alternative workspace, with ongoing selected-note refresh as a separate planned capability. Manual import does not complete either integration.

The current notebook is a prototype surface, not a requirement to build a meeting-management product. Additional saving, archives, summaries, and CRM work need a specific use case that supports participation. Integration readiness continues alongside the core work, with selected prior context as the first Granola candidate.

## Product principles

- One timely cue at a time; dismissal is always easy and has no penalty.
- Ground context and response prompts in inspectable sources. Do not invent facts, commitments, or an answer on the user's behalf.
- Let the conversation answer first. Cancel a candidate that is resolved before display, and remove a displayed question when it becomes stale or redundant. The prototype uses fixed answer, repeat, topic-change and correction patterns to withdraw or suppress some cues; it does not judge their meaning or reliably resolve paraphrases.
- Timing should preserve relevance without countdown pressure, scores, or a demand to respond.
- AI should select useful context and prompts, including when to stay quiet. Compare candidate reasoning against simple baselines and human-labeled fictional cases. The current phrase rules are a demo scaffold, not the intended product intelligence.
- Plan production operation, integration, installation, updates, and support alongside the feature they enable; distinguish planned readiness from verified capability.
- Capture and sharing require explicit actions and visible state.
- Meeting content is private; public demos and tests use fictional data.
- Describe implemented behavior accurately. A demo must never imply that audio is being captured.
- Build in public under the Sustainable Use License, with free personal/internal-business use and separate commercial licensing. Follow the contributor agreement, human sign-off, and pull-request policies; preserve prior Apache-2.0 grants.

## Future direct-address behavior

When the conversation clearly asks the user a question, prioritize that question over a general clarifying suggestion. Use explicit addressee evidence and the user's selected identity; a question addressed to someone else or an ambiguous addressee should stay quiet.

Keep the question visible while the user is answering, without a competing suggestion or an expiring countdown pressuring them to respond. Let the user dismiss it at any time. Do not fabricate an answer, assign a response score, or penalize silence. The current engine has a narrow name-based “Asked you” rule, controlled by the optional session name in Settings. It prioritizes a matched question over an unread suggestion and gives it a fixed 45-second unread lifetime; source disclosure can hold it for reading. It does not detect whether the user is answering. Reliable addressee judgment and answer-aware timing remain future work, with live accuracy and usefulness unverified. See the [rule limits](docs/cue-intelligence.md) and [native acceptance gaps](docs/native-validation.md#live-session-check).

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

## Cue intelligence and feedback

Evaluate context-aware decisions about when to surface, suppress, or resolve a cue. Conversation can supply possible signals that a question was asked, answered naturally, corrected, or overtaken by a topic change. Observed use is not proof of usefulness: a context reminder may help without being spoken, and dismissal is not necessarily rejection.

The current app engine uses fixed phrase rules, with no reasoning model or conversational learning. Compare a semantic evaluator against rules and human-selected cues; keep lifecycle controls in Rust. An optional [fictional lab](docs/claude-cue-lab.md) evaluates one case through Claude Code with Opus 5.5 using an existing subscription. Cursor CLI with Composer remains an alternative proposal. Avoid separately billed inference APIs and stop at subscription limits. This lab is separate from the app, not a selected production dependency or permission to run background inference. See the [cue intelligence and feedback plan](docs/cue-intelligence.md) for documented access, distribution questions, evaluation criteria, and the separation between session context, personal preferences, and model training.

## Smallest useful comparison

Try a short fictional meeting workflow with and without TalkQTE, keeping any existing note-taking workflow unchanged. Start with human-selected cues to isolate the interaction from detection errors. Use comparable scenarios and alternate order to reduce familiarity effects. Evaluate timely, context-grounded participation and listening comprehension together; measure useful clarification within the question condition. Compare context reminders as a separate condition, including whether people remain oriented without needing to speak. Record stale or unsupported cues and distraction. Include a case where the right behavior is to stay quiet. Saving is not a required outcome.

Use the observations to choose the next small change. A demo or a few comparisons do not establish effectiveness; no broad research program or automatic collection of real meeting data is required.

## First implementation

A runnable desktop prototype provides the notebook, Rust-owned prompt lifecycle, and floating prompt window using a fictional demo. An optional macOS microphone activity monitor reports signal activity only. Separately, a `local-whisper` developer build provides model setup and a user-started microphone transcription session using phrase rules. A first hardware session is recorded, while timing, Stop/device edge cases and native cross-app behavior still need verification. System-audio capture and semantic live cues remain subsequent milestones. Development-only evaluator constructors and source/scheduling tests do not enable inference in the app.

## Open decisions

The final visual identity and exact retention defaults remain open. Proposed defaults live in PRIVACY.md. No TalkQTE user-outcome study has been completed. [Synthetic transcription measurements](docs/local-transcription.md#sustained-session) exist on one development Mac; they do not establish whole-app live-call budgets or performance on the lowest supported Mac.
