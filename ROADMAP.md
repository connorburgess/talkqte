# Roadmap

This is a development plan. Unchecked items are not implemented.

## Foundation

- [x] Create the public repository and choose TalkQTE as the working name.
- [x] Choose Rust + Tauri + React, with macOS as the first target.
- [x] Document privacy requirements, DCO sign-offs, contribution rules, and feature-branch workflow.
- [x] Add automated contribution metadata, frontend, Rust, and desktop build checks.
- [ ] Configure required branch checks and dedicated secret scanning.
- [ ] Enable external automated review when the prototype is ready for it; currently deferred.

## Runnable prototype

- [x] Fictional meeting playback with a notebook and arriving transcript segments.
- [x] Rust-owned question expiry, cooldown, pause, and timing sensitivity.
- [x] Phrase-based owner, deadline, and decision questions, with save and dismiss actions.
- [x] Preserve manual notes and saved questions during replay; keep them in memory until quit.
- [x] Preview Markdown and save exactly the reviewed content to a chosen destination.
- [x] Separate native question window with a restricted command and event surface.
- [x] Browser checks for keyboard navigation, narrow layout, and reduced motion.
- [ ] Verify cross-app focus, Spaces, full-screen meetings, and screen-sharing behavior on macOS.

This prototype plays synthetic text. It does not capture or transcribe audio, persist a notebook, or integrate with other services.

## First technical milestone

Prove that audio capture, local transcription, and the floating prompt can coexist with a real meeting app before expanding the dashboard.

- [ ] Start and stop microphone and system-audio capture with explicit permission.
- [ ] Transcribe a synthetic meeting locally without network access after model setup.
- [ ] Measure transcript delay, memory growth, CPU use, and dropped audio.
- [ ] Show a dismissible prompt without taking keyboard focus from the meeting.
- [ ] Confirm stop/pause and device-change behavior, including headphones.

## First usable version

- [ ] Meeting notebook with live transcript and manual notes.
- [ ] One question at a time, expiry, cooldown, pause, and adjustable sensitivity.
- [ ] Initial cues for missing owners, vague deadlines, and explicit open questions.
- [ ] Save a question for later; mark a question resolved.
- [ ] Selected-meeting context and a simple meeting goal.
- [ ] Local search, Markdown export, and clear retention controls.
- [ ] Accessible keyboard operation and reduced-motion support.
- [ ] Fictional demo mode that never reads the user's meeting store.

## Later candidates

- Read-only calendar integration and pre-meeting context from selected notes.
- Granola import through supported export or API paths.
- A user-scoped, read-only MCP interface for selected meetings.
- Action-item export with a review step before creating an external task.
- Optional local language-model suggestions and source-linked meeting questions.
- Windows support after the platform adapters are proven on macOS.

Whisper transcribes speech; it does not produce reliable summaries or understand meeting intent on its own. Semantic summaries and conversational search need a separate model or an explicitly limited rules-based implementation.
