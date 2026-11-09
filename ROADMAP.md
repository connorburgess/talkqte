# Roadmap

This is a development plan. Unchecked items are not implemented.

The product goal is timely context that helps someone stay grounded and respond during the conversation. Clarification questions are the first bounded cue type. Saving and note-taking are secondary use cases to validate, not required proof of value. Current public presentation should explain a clearly labeled fictional concept and invite people to follow development; recruitment and downloads remain later stages.

## Development milestones

The direction is **proof of concept → live AI companion → connected workflows → broader platform availability**. macOS comes first, Windows is the next planned desktop platform, and iPhone/Android are future companion goals. Ubuntu/Linux is an exploratory track. Each platform must establish reliable conversation access and cue presentation.

| Milestone                 | Delivery target                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Proof of concept, current | Explore the interaction with fictional conversations and a working desktop prototype.                        |
| Live AI companion         | Connect meeting audio, transcription, grounded cue decisions, and dependable controls.                       |
| Connected workflows       | Add supported meeting and note-taking integrations with source-aware context and scoped permissions.         |
| Broader availability      | Deliver maintained releases, straightforward setup and updates, and validated support across more platforms. |

The [milestone acceptance criteria](docs/initial-rollout.md) define what counts as delivered. The sections below track the detailed work. Feasibility and integration planning can proceed alongside core development; each release advertises only its verified capabilities.

## Production, integrations, and distribution

This track runs alongside the feature milestones below. The goal includes a dependable, supportable product that people can discover, install, connect to existing tools, and update with minimal friction. Use the [product readiness plan](docs/product-readiness.md) to choose the next release blocker and record evidence; a demo or successful build alone does not establish readiness.

- [x] Define the first supported macOS/hardware/meeting-app matrix and measurable latency, resource, and recovery budgets. [Agreed](docs/budgets.md) on 9 November 2026; confirmation runs on an M1 Mac and with live capture remain.
- [ ] Establish a Granola capability and authentication decision, source-aware context contract, and fictional adapter fixtures; verify import, live input, and writeback separately. The contract and fictional failure tests exist. The owner's free plan points to MCP with the user's own sign-in (notes from the last 30 days). Granola's page confirms a custom client is permitted (OAuth 2.0 with dynamic client registration, Streamable HTTP) and names the tools, with transcripts paid-only ([readiness notes](docs/product-readiness.md#integration-readiness)); provider-format fixtures, the native sign-in flow, and an authorized account check remain.
- [x] Plan model delivery, integrity, interrupted downloads, offline use, and application/model compatibility. See the [model delivery plan](docs/model-delivery.md). The Settings download is built for `local-whisper` builds; the setup step, update path, and accuracy scoring remain.
- [ ] Prove a signed, notarized installation and a recoverable upgrade on a clean supported Mac; include data migration and update deferral during calls.
- [ ] Test the path from the website to first useful use without development tools, unnecessary accounts, or unexplained permissions.
- [ ] Verify privacy boundaries, retention/deletion, credential storage, and safe diagnostics for every enabled input or integration.
- [ ] Define pilot and wider-release acceptance criteria covering user value, accessibility, compatibility, and support readiness. [Proposed criteria](docs/pilot-acceptance.md) with pass/fail checks and current status, awaiting the owner's agreement.
- [ ] Compare acquisition and delivery channels with one bounded experiment at a time; start planning direct website delivery and an invited pilot, then evaluate additional channels.
- [ ] Estimate release/model bandwidth, optional provider costs, and support effort; record when demand would justify additional infrastructure or commercial operations. [First estimate](docs/operating-estimates.md): about 82 MB per first download (measured app and model) and no project-paid inference or hosting for the app; support effort needs pilot data.

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
- [x] Phrase-based owner, deadline, and decision questions, with source disclosure and dismissal.
- [x] Preserve optional manual notes during replay; keep them in memory until quit.
- [x] Preview Markdown and save exactly the reviewed content to a chosen destination.
- [x] Separate native question window with a restricted command and event surface.
- [x] Compact complete questions, source disclosure that holds a question for reading, larger text, and optional near-camera placement.
- [x] Browser checks for keyboard navigation, narrow layout, and reduced motion.
- [x] Withdraw a question when a later line matches a fixed owner, date, or choice pattern; keep a question being read in place and mark it answered with its source. Phrase rules only.
- [x] Skip a question type within two minutes of when it was last raised and shown, whether it was answered, dismissed, or ignored. Phrase rules only.
- [x] Separate, explicit macOS microphone activity monitoring with a Stop control and no retained audio.
- [ ] Verify real microphone permission, device release, signal activity, and disconnect behavior on macOS.
- [ ] Verify native placement, cross-app focus, Spaces, full-screen meetings, and screen-sharing behavior on macOS.

The [native validation record](docs/native-validation.md) covers a limited macOS notebook keyboard smoke check and lists the remaining companion acceptance checks. It is not a complete accessibility or meeting-app compatibility pass.

The question demo plays synthetic text. Separate microphone monitoring measures signal activity only. In developer builds, a live session transcribes the microphone locally and runs the phrase-based questions on it; it has not been checked on real hardware or in a real meeting. The prototype does not capture system audio, persist a notebook, or integrate with other services.

## Next product validation

Test the in-conversation interaction before investing in automatic detection. This can run independently of the native audio feasibility work below.

- [ ] Compare no assistance with stable, human-selected questions in matched fictional conversations; counterbalance order.
- [ ] Compare source-backed context reminders in a separate human-cued condition; check orientation and appropriate responses while the topic is still active.
- [ ] Measure useful participation and listening comprehension together, with useful clarification specific to the question condition; include unsupported, already-answered, and late cues. Do not use saves or speaking speed as the success measure.
- [ ] Check whether the **Why?** hold is discoverable or needs a separate Hold action.
- [ ] Check the notebook's keyboard route, native VoiceOver, reading time, and announcement preferences with users' normal setups.
- [ ] Test content, timing, and placement separately; keep a simpler manual interaction if automation does not add value.
- [ ] Label fictional examples of cue use, natural resolution, correction, and topic changes; validate conversation-based outcome signals without equating use with usefulness or dismissal with failure. Eleven labeled fictional cases include at least one for each signal ([outcome labels](docs/cue-intelligence.md#outcome-labels)); validating the signals still needs evaluator runs and real conversations.
- [x] Add an explicitly invoked Claude Code lab with bundled fictional cases, subscription-login checks, bounded execution, and offline failure-path tests. This is evaluation tooling, not live cue intelligence or evidence of user benefit.
- [ ] Compare rules with semantic cue suppression and resolution using the [intelligence evaluation plan](docs/cue-intelligence.md) (on the first 8 of 11 fictional cases, run once each: rules 2 of 8, Claude lab 7 of 8; the other three are not yet run in the lab; latency, false suppression, and allowance use still need repeated runs); start with an explicitly initiated subscription-backed fictional lab, without separately billed inference APIs. Measure false suppression, latency, privacy boundaries, and allowance use before choosing a model/runtime.

See the [review findings, current gaps, and experiment](docs/research.md). No user-outcome study has been completed.

## First technical milestone

Prove that audio capture, local transcription, and the floating prompt can coexist with a real meeting app before expanding the dashboard.

- [ ] Start and stop microphone and system-audio capture with explicit permission. A live session started from the microphone after the macOS permission prompt in the [9 November check](docs/native-validation.md#live-session-check); Stop was not checked, and system audio is not captured.
- [x] Transcribe a synthetic meeting locally without network access after model setup. A real-time developer replay of a fictional two-voice clip with a feature-gated Whisper backend. A developer build routes the microphone into a live session; system audio is not captured.
- [x] Measure transcript delay, memory growth, CPU use, and dropped audio. Synthetic replays of 10, 20, and 60 minutes measured these ([results](docs/local-transcription.md#sustained-session)); the hour-long run showed no memory growth and about 14% of one M5 Pro Max core. Live capture, the companion, and the lowest supported Mac are not yet included.
- [ ] Show a dismissible prompt without taking keyboard focus from the meeting.
- [ ] Confirm stop/pause and device-change behavior, including headphones.

## First usable version

- [x] Minimal session view centered on the current cue and its controls; optional notes remain a prototype utility, with no Save action or saved-cue archive. The companion shows one question with Why? and Dismiss; the notebook keeps notes and the reviewed export; the saved-cue archive and its export section are removed.
- [x] One cue at a time, expiry, cooldown, pause, and adjustable sensitivity. The engine holds at most one question; an unread suggestion expires after 18 s (45 s for a question asked of you by name); a 10 s pause follows (30 s with the Quiet setting in Settings → Question timing); pausing the demo freezes the clock and the deadline. Engine and browser tests cover each (`quiet_mode_leaves_space_after_expiry`, `pause_freezes_transcript_and_deadline`, the notebook tests). The timings are fixed values; the one setting offers two options.
- [ ] Initial cues for missing owners, vague deadlines, and explicit open questions. Phrase rules raise a missing-owner question ("someone can…", "someone should…", "someone could…") and a vague-deadline question ("soon"), plus a decision question ("either… or"), on the fictional script and live transcripts. An "Open question" cue quotes an explicit question put to the group ("Does anyone…?", "Any thoughts…?", "Who can…?") when the sentence ends with a question mark. All of these are phrase matches, not understanding ([cue intelligence](docs/cue-intelligence.md)). The vague-deadline question was seen once in a [live session on hardware](docs/native-validation.md#live-session-check) on 9 November 2026; the missing-owner rule missed "someone should…" there and was widened the same day, and the open question is unchecked live, so the item stays open.
- [ ] Suppress questions answered by the conversation before display, and cancel stale or redundant prompts. Phrase rules now cover answers, repeats, elapsed time, and sentences that open by changing the topic; reliable judgment of meaning remains in the cue intelligence plan.
- [ ] Prioritize questions clearly addressed to the user; remain quiet for another or uncertain addressee. Phrase rules use a session-only name set in Settings. They are checked only on synthetic text and need a comma or dash beside the name. A question put to someone else by name no longer raises a suggestion. Not yet checked in a live session.
- [ ] Preserve a direct question while the user answers, without competing cues, fabricated answers, response scores, or countdown pressure; keep dismissal available. An "Asked you" question stays for 45 seconds with no countdown shown, and the name is set in Settings for the session. Checked on synthetic text only, not in a live session.
- [ ] Clear or update cues as context changes; do not automatically archive unused suggestions.
- [x] Selected-meeting context and a simple meeting goal. Selected context is the file import above. A one-line meeting goal in Settings is used by the engine: a question whose line uses the goal's words comes through during the pause after another cue, with either timing setting, and stays 45 seconds, the length given to a question asked of the user by name; the companion labels it as about the goal. A word match on the user's own words, checked on synthetic text only; whether it helps is for the pilot comparison.
- [ ] Clear retention controls for any retained content; expand prompt history or Markdown export only for a demonstrated use case. Today no user content is retained between launches: notes and the session-only name live in memory, the live transcript is never saved or exported, dismissed questions are let go, and the only export is the reviewed Markdown file the user chooses to save. The optional speech model is the one thing kept on disk, in the app's data folder, removable from Settings ([PRIVACY.md](PRIVACY.md)). Retention controls become necessary only if a future change keeps user content, and the [pilot criteria](docs/pilot-acceptance.md) require that the app retain nothing after quit and that study participant data have a written handling and deletion plan before a pilot.
- [ ] Accessible keyboard operation and reduced-motion support. Browser tests cover keyboard tabs, dismissal, focus return, the export dialog, and reduced motion; a native keyboard pass is recorded twice on one Mac. Not yet checked: VoiceOver in the notebook and companion, and cross-app focus ([pending checks](docs/native-validation.md#remaining-manual-acceptance-checks)). Stays open until those run.
- [x] Fictional demo mode that never reads the user's meeting store. The demo is the fictional script compiled into the app with `include_str!`, so the demo itself opens no file at run time; an engine test pins it to that script. The app keeps no meeting store ([privacy notes](PRIVACY.md)).
- [ ] Compare a short fictional meeting workflow with and without TalkQTE: useful context and participation, listening, stale or redundant prompts, and distraction.

The [product goal and first proof](PRODUCT.md#goal-and-first-proof) define what this milestone is trying to establish. Use the [research decision notes](docs/research.md) to connect findings to a specific change and a test; adding a study to the reading list does not establish a product benefit.

## Future goal: work with other note-taking apps

TalkQTE should complement an existing note-taking workflow. Evaluate Granola first, Fireflies second, and others when actual demand justifies them. Keep the existing note-taker as the primary meeting record. Capability research, adapter contracts, authentication planning, and fictional failure tests begin alongside the core work. Ship each connection only when its end-to-end usefulness and production behavior are verified; no connection is implemented yet.

- [ ] Import selected Granola notes through supported exports or documented APIs, after verifying access and plan requirements.
- [ ] Evaluate Fireflies' documented beta live transcript API separately from completed-note import and export.
- [ ] Support other note-takers through common file formats when needed, adding dedicated adapters only for demonstrated use cases.
- [ ] Use imported notes as selected meeting context without requiring a second recording of the original meeting. First slice: notes imported from a fictional JSON file through the context contract, shown beside the notebook with source and date, removable, never exported. A line that uses two or more distinctive title words of a note shows it once as a context reminder, labeled with its source; a phrase rule, seen once by the owner in a [live session](docs/native-validation.md#live-session-check) and otherwise untested with people. No note-taker is connected.
- [ ] Export selected notes, questions, and action items with a preview of the content and destination.
- [x] Preserve source references and handle repeated imports without silently duplicating or overwriting user edits. Each imported note keeps its provider, source ID, and date; the date and source are shown beside it. Importing the same notes again reports them as already imported and keeps one copy; a newer revision replaces a note and an older one never rolls it back. Imported notes cannot be edited in TalkQTE, so there are no user edits to overwrite. The revision rules are checked with the file source in an engine test, and the repeat notice in a browser test; the Granola path is not built.
- [ ] Give each connection explicit permissions and disconnect controls; apply retention rules to imported copies. For the file source, imported copies live only in memory and can be removed one at a time or all at once; permissions and disconnect apply once a real connection exists.

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
- Additional local reasoning models after the first cue runtime meets the personal-alpha criteria.

## Desktop platform expansion

Windows is the next planned desktop platform after the macOS foundation. Parallels provides an initial Windows test environment and a route to explore Ubuntu. VM results apply to the tested guest architecture and virtual devices; they do not establish support for physical PCs or every Linux distribution. See the [platform validation plan](docs/platforms.md).

- [ ] Build, install, and launch the Windows prototype in Parallels; record Windows, architecture, WebView2, and toolchain versions.
- [ ] Validate Windows companion focus, scaling, keyboard access, full-screen meetings, and screen-sharing behavior.
- [ ] Prove both sides of a synthetic call, Stop/recovery, and device changes through a Windows capture adapter.
- [ ] Add Windows build/Rust checks when the build target is established, then validate signed installation and updates on the claimed physical hardware and architectures.
- [ ] Explore an Ubuntu ARM64 VM: build and run the desktop shell, assess audio and companion behavior, and record the desktop/session configuration.
- [ ] Decide whether to support a named Linux configuration based on the Ubuntu evidence and maintenance effort. General Linux support remains undecided.

## Future goal: participate from a phone

Support joining Google Meet on a phone and receiving prompts during the call. Obtaining the conversation and presenting a prompt are separate capabilities; neither is implemented on mobile. See the [mobile feasibility and acceptance plan](docs/mobile.md).

- [ ] Validate a readable mobile cue and its controls with fictional context; selected imports may support context, while notes and saving need a separate demonstrated use case.
- [ ] Prove a foreground mobile companion receiving an authenticated, explicitly paired live session feed.
- [ ] Validate Meet's own picture-in-picture alongside the companion where the device and app support it.
- [ ] Investigate same-phone capture on real devices, with explicit unsupported states when either side of the call is unavailable.
- [ ] Test platform-specific prompt surfaces, background behavior, accessibility, battery use, and permission denial before making capability claims.

Whisper transcribes speech; it does not produce reliable summaries or understand meeting intent on its own. Semantic summaries and conversational search need a separate model or an explicitly limited rules-based implementation.
