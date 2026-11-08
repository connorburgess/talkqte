# Roadmap

This is a development plan. Unchecked items are not implemented.

## Foundation

- [x] Create the public repository and choose TalkQTE as the working name.
- [x] Choose Rust + Tauri + React, with macOS as the first target.
- [x] Document privacy requirements, contribution sign-offs, licensing and contributor terms, and feature-branch workflow.
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
- [x] Compact complete questions, source disclosure that holds a question for reading, larger text, and optional near-camera placement.
- [x] Browser checks for keyboard navigation, narrow layout, and reduced motion.
- [x] Separate, explicit macOS microphone activity monitoring with a Stop control and no retained audio.
- [ ] Verify real microphone permission, device release, signal activity, and disconnect behavior on macOS.
- [ ] Verify native placement, cross-app focus, Spaces, full-screen meetings, and screen-sharing behavior on macOS.

The [native validation record](docs/native-validation.md) covers a limited macOS notebook keyboard smoke check and lists the remaining companion acceptance checks. It is not a complete accessibility or meeting-app compatibility pass.

The question demo plays synthetic text. Separate microphone monitoring measures signal activity only; it does not supply live prompts or transcribe audio. The prototype does not capture system audio, persist a notebook, or integrate with other services.

## Next product validation

Test the clarification interaction before investing in automatic detection. This can run independently of the native audio feasibility work below.

- [ ] Compare no assistance with stable, human-selected questions in matched fictional conversations; counterbalance order.
- [ ] Measure useful clarification and listening comprehension together, including already-answered and late cues.
- [ ] Check whether the **Why?** hold is discoverable or needs a separate Hold action.
- [ ] Check the notebook's keyboard route, native VoiceOver, reading time, and announcement preferences with users' normal setups.
- [ ] Test content, timing, and placement separately; keep a simpler manual interaction if automation does not add value.

See the [review findings, current gaps, and experiment](docs/research.md). No user-outcome study has been completed.

## First technical milestone

Prove that audio capture, local transcription, and the floating prompt can coexist with a real meeting app before expanding the dashboard.

- [ ] Start and stop microphone and system-audio capture with explicit permission.
- [ ] Transcribe a synthetic meeting locally without network access after model setup.
- [ ] Measure transcript delay, memory growth, CPU use, and dropped audio.
- [ ] Show a dismissible prompt without taking keyboard focus from the meeting.
- [ ] Confirm stop/pause and device-change behavior, including headphones.

## First usable version

- [ ] Minimal session view with the current question, saved questions, and optional notes.
- [ ] One question at a time, expiry, cooldown, pause, and adjustable sensitivity.
- [ ] Initial cues for missing owners, vague deadlines, and explicit open questions.
- [ ] Suppress questions answered by the conversation before display, and cancel stale or redundant prompts.
- [ ] Prioritize questions clearly addressed to the user; remain quiet for another or uncertain addressee.
- [ ] Preserve a direct question while the user answers, without competing cues, fabricated answers, response scores, or countdown pressure; keep save and dismiss available.
- [ ] Save a question for later; mark a question resolved.
- [ ] Selected-meeting context and a simple meeting goal.
- [ ] Minimal prompt history, Markdown export, and clear retention controls.
- [ ] Accessible keyboard operation and reduced-motion support.
- [ ] Fictional demo mode that never reads the user's meeting store.
- [ ] Compare a short fictional meeting workflow with and without TalkQTE: useful questions, stale or redundant prompts, and distraction.

The [product goal and first proof](PRODUCT.md#goal-and-first-proof) define what this milestone is trying to establish. Use the [research decision notes](docs/research.md) to connect findings to a specific change and a test; adding a study to the reading list does not establish a product benefit.

## Future goal: work with other note-taking apps

TalkQTE should complement an existing note-taking workflow. Evaluate Granola first, Fireflies second, and others when actual demand justifies them. Keep the existing note-taker as the primary meeting record. This is future work, after the clarification experience is useful.

- [ ] Import selected Granola notes through supported exports or documented APIs, after verifying access and plan requirements.
- [ ] Evaluate Fireflies' documented beta live transcript API separately from completed-note import and export.
- [ ] Support other note-takers through common file formats when needed, adding dedicated adapters only for demonstrated use cases.
- [ ] Use imported notes as selected meeting context without requiring a second recording of the original meeting.
- [ ] Export selected notes, questions, and action items with a preview of the content and destination.
- [ ] Preserve source references and handle repeated imports without silently duplicating or overwriting user edits.
- [ ] Give each connection explicit permissions and disconnect controls; apply retention rules to imported copies.

Start with one-way import and export. Consider live context and two-way synchronization only where documented interfaces support them and conflict/deletion behavior is defined. No integration or live transcript access is available or promised yet.

Capability review, 2026-11-08:

- Granola documents [note and transcript access](https://docs.granola.ai/introduction) and [Business or Enterprise API access](https://docs.granola.ai/help-center/sharing/integrations/granola-api). Plan the first connection around selected previous-meeting context while TalkQTE handles live input separately. The reviewed interfaces do not establish a supported live transcript stream or permission to write notes back.
- Fireflies documents a [beta Realtime API](https://docs.fireflies.ai/realtime-api/overview) for live transcript events and a [connection guide](https://docs.fireflies.ai/realtime-api/getting-started) requiring an API token and meeting/transcript ID. Actual account access, timing, reliability, and privacy behavior still need testing before committing to support.

Provider access and capabilities can change; recheck them when implementing each connection.

## Other later candidates

- Broader archives, local search, and summaries only after the prompt experience is useful.
- Read-only calendar integration and pre-meeting context from selected notes.
- A user-scoped, read-only MCP interface for selected meetings.
- Action-item export with a review step before creating an external task.
- Optional local language-model suggestions and source-linked meeting questions.
- Windows support after the platform adapters are proven on macOS.

## Future goal: participate from a phone

Support joining Google Meet on a phone and receiving prompts during the call. Obtaining the conversation and presenting a prompt are separate capabilities; neither is implemented on mobile. See the [mobile feasibility and acceptance plan](docs/mobile.md).

- [ ] Adapt the notebook for mobile notes, review, and explicitly selected imports and exports.
- [ ] Prove a foreground mobile companion receiving an authenticated, explicitly paired live session feed.
- [ ] Validate Meet's own picture-in-picture alongside the companion where the device and app support it.
- [ ] Investigate same-phone capture on real devices, with explicit unsupported states when either side of the call is unavailable.
- [ ] Test platform-specific prompt surfaces, background behavior, accessibility, battery use, and permission denial before making capability claims.

Whisper transcribes speech; it does not produce reliable summaries or understand meeting intent on its own. Semantic summaries and conversational search need a separate model or an explicitly limited rules-based implementation.
