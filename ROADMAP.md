# Roadmap

This is a development plan. An unchecked item may be partly implemented; it remains open until its stated scope and acceptance checks are complete. Checked items establish only the capability and evidence described, not a supported release or demonstrated user benefit.

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
- [x] Establish a Granola capability and authentication decision, source-aware context contract, and fictional adapter fixtures; verify import, live input, and writeback separately. The contract and fictional failure tests exist. The owner's free plan points to MCP with the user's own sign-in (notes from the last 30 days). Granola's page confirms a custom client is permitted (OAuth 2.0 with dynamic client registration, Streamable HTTP) and names the tools, with transcripts paid-only ([readiness notes](docs/product-readiness.md#integration-readiness)); the adapter is built and tested against a fictional server (`src-tauri/src/granola.rs`); the notebook controls, sign-in, and listing have been checked. Tagged detail parsing now passes fictional headless tests; the notebook also keeps Disconnect available during slow listings or Focus suggestions and rejects retired results ([recovery checks](docs/granola-import-validation.md#disconnect-while-notes-are-loading)). The owner confirmed native note import/removal on 11 November ([import evidence](docs/granola-import-validation.md#owner-observed-native-import-and-removal--11-november-2026)); live transcript input and writeback are separately unsupported, and refresh/recovery/privacy acceptance remains open.
- [x] Plan model delivery, integrity, interrupted downloads, offline use, and application/model compatibility. See the [model delivery plan](docs/model-delivery.md). The Settings download is built for `local-whisper` builds; the setup step, update path, and accuracy scoring remain.
- [x] Keep live-session readiness current across speech model installation and removal. [Fictional response-ordering checks](docs/model-delivery.md#readiness-response-ordering--11-november-2026) cover delayed success, delayed failure and a pending check; clean-install and native model acceptance remain separate.
- [ ] Prove a signed, notarized installation and a recoverable upgrade on a clean supported Mac; include data migration and update deferral during calls.
- [ ] Test the path from the website to first useful use without development tools, unnecessary accounts, or unexplained permissions.
- [ ] Verify privacy boundaries, retention/deletion, credential storage, and safe diagnostics for every enabled input or integration. The [Granola privacy checks](docs/granola-import-validation.md#privacy-boundary-checks) now cover disconnect/reconnect, diagnostic redaction, imported-note removal and export exclusion with fictional data; real-account data-flow and native acceptance remain.
- [ ] Define pilot and wider-release acceptance criteria covering user value, accessibility, compatibility, and support readiness. [Proposed criteria](docs/pilot-acceptance.md) with pass/fail checks and current status, awaiting the owner's agreement.
- [ ] Compare acquisition and delivery channels with one bounded experiment at a time; start planning direct website delivery and an invited pilot, then evaluate additional channels.
- [ ] Estimate release/model bandwidth, optional provider costs, and support effort; record when demand would justify additional infrastructure or commercial operations. [First estimate](docs/operating-estimates.md): about 82 MB per first download (measured app and model) and no project-paid inference or hosting for the app; support effort needs pilot data.

## Foundation

- [x] Create the public repository and choose TalkQTE as the working name.
- [x] Choose Rust + Tauri + React, with macOS as the first target.
- [x] Document privacy requirements, contribution sign-offs, licensing and contributor terms, and feature-branch workflow.
- [x] Reconcile current capability descriptions with source and dated validation records, keeping development implementation, fictional checks and native/user acceptance distinct ([11 November checkpoint](docs/product-readiness.md#capability-description-checkpoint--11-november-2026)).
- [x] Add automated contribution metadata, frontend, Rust, and desktop build checks.
- [x] Configure required branch checks and dedicated secret scanning. Since 10 November 2026 a repository ruleset on `main` requires a pull request and all four CI jobs (macOS Rust and desktop build, Windows Arm Rust and desktop build, Frontend and browser behavior, Contribution metadata) on the exact head, and forbids force-pushes and deletion; repository admins can bypass it so the owner is never locked out. GitHub secret scanning and push protection are on; non-provider patterns and Dependabot security updates are off, by choice, because their pull requests would not carry the contributor sign-off this repository requires.
- [ ] Enable external automated review when the prototype is ready for it; currently deferred.

## Runnable prototype

- [x] Simplify the notebook hierarchy while keeping the green and cream palette and existing controls: compact meeting rows, optional setup/focus disclosures, and a paper-like editor. [Fictional browser and UI/UX checks](docs/notebook-simplification.md) cover keyboard access, draft preservation, narrow layouts and save-error recovery; native accessibility and user acceptance remain separate.

- [x] Resize the notebook and notes/question columns with draggable dividers, keyboard controls, a non-drag slider alternative and reset. [Fictional browser and UI/UX evidence](docs/panel-sizing.md) covers limits, cancellation and narrow layouts; native VoiceOver and usefulness remain separate checks.
- [x] Preserve later Focus submissions while an earlier save is pending, including Clear, accepted suggestions and inline rejection recovery. [Fictional browser and UI/UX checks](docs/focus-save-recovery.md) cover the field; live relevance and participation acceptance remain separate.
- [x] Preserve newer session-name drafts and ordered submissions while a save is pending, including clearing the name and recovering from rejection. [Fictional browser and UI/UX checks](docs/name-save-recovery.md) cover the field; direct-address live acceptance remains separate.

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
- [x] Record the owner's bounded microphone activity-monitor acceptance, separating reported passes from unknown device/recovery details ([11 November report](docs/native-validation.md#owner-reported-microphone-acceptance--11-november-2026)).
- [ ] Verify real microphone permission, device release, signal activity, and disconnect behavior on macOS. The owner reports passing the activity-monitor checklist on 11 November; the input/OS, exact disconnect status, fallback and reconnect behavior still need a named configuration. This does not validate the separate local-transcription path.
- [ ] Verify native placement, cross-app focus, Spaces, full-screen meetings, and screen-sharing behavior on macOS.

The [native validation record](docs/native-validation.md) covers a limited macOS notebook keyboard smoke check and lists the remaining companion acceptance checks. It is not a complete accessibility or meeting-app compatibility pass.

The question demo plays synthetic text. Separate microphone monitoring measures signal activity only. A `local-whisper` developer build transcribes the microphone locally and applies phrase rules. The [9 November hardware check](docs/native-validation.md#live-session-check) observed transcription, a timing question, and a reminder from fictional imported notes; it did not establish measured latency, microphone release after Stop, or dependable meeting use. System audio is not captured, and notebooks are not persisted between launches.

The development Granola connection has passed account sign-in, listing, and requested focus-suggestion checks. Selected-note parsing and recovery pass fictional headless checks; [the owner confirmed native note import/removal on 11 November](docs/granola-import-validation.md#owner-observed-native-import-and-removal--11-november-2026). Prior-note access does not establish live transcript input or writeback. No reasoning model is activated for live cues.

## Next product validation

Test the in-conversation interaction before investing in automatic detection. This can run independently of the native audio feasibility work below.

- [ ] Compare no assistance with stable, human-selected questions in matched fictional conversations; counterbalance order.
- [ ] Compare source-backed context reminders in a separate human-cued condition; check orientation and appropriate responses while the topic is still active.
- [ ] Measure useful participation and listening comprehension together, with useful clarification specific to the question condition; include unsupported, already-answered, and late cues. Do not use saves or speaking speed as the success measure.
- [ ] Check whether the **Why?** hold is discoverable or needs a separate Hold action.
- [ ] Check the notebook's keyboard route, native VoiceOver, reading time, and announcement preferences with users' normal setups.
- [ ] Test content, timing, and placement separately; keep a simpler manual interaction if automation does not add value.
- [ ] Label fictional examples of cue use, natural resolution, correction, and topic changes; validate conversation-based outcome signals without equating use with usefulness or dismissal with failure. Eleven labeled fictional cases include at least one for each signal ([outcome labels](docs/cue-intelligence.md#outcome-labels)); each now has three authorized lab runs recorded on 8–10 November, but label review and validation of the signals in real conversations remain.
- [x] Add an explicitly invoked Claude Code lab with bundled fictional cases, subscription-login checks, bounded execution, and offline failure-path tests. This is evaluation tooling, not live cue intelligence or evidence of user benefit.
- [ ] Compare rules with semantic cue suppression and resolution using the [intelligence evaluation plan](docs/cue-intelligence.md) (on all 11 fictional cases, three runs each on 8–10 November 2026: rules 5 of 11; Claude lab 10 of 11 in every pass with no case changing between runs; request times 3.0–5.8 s including CLI start-up, about 155 output tokens per run in the 22-request repeat batch; a false-suppression rate needs a larger suite and real conversations); start with an explicitly initiated subscription-backed fictional lab, without separately billed inference APIs. Measure false suppression, latency, privacy boundaries, and allowance use before choosing a model/runtime.

See the [review findings, current gaps, and experiment](docs/research.md). No user-outcome study has been completed.

## First technical milestone

Prove that audio capture, local transcription, and the floating prompt can coexist with a real meeting app before expanding the dashboard.

- [x] Build a provider-independent Rust cue evaluator worker with bounded input/output, one outstanding evaluation, source validation, cancellation, deadlines, and stale-result rejection. Eight fictional headless tests cover the [contract and failure cases](docs/cue-evaluator.md); no model or app connection is supplied.
- [x] Connect validated transcript-only evaluator proposals to the Rust cue lifecycle through a development constructor. Fictional delayed replies test held cues, pause, dismissal, source eviction, and Stop ([acceptance](docs/cue-evaluator.md#transcript-lifecycle-bridge)); no app command or model provider enables this path.
- [x] Preserve selected-note revisions through engine synchronization and retire reminders quoting refreshed or removed notes, including held cues. Fictional headless checks cover both providers, unchanged/older imports, separate provider IDs, and engine replacement ([acceptance](docs/note-revision-cues.md)); evaluator note reasoning remains separate.
- [x] Extend the development evaluator bridge to selected prior notes with complete source/date disclosure and revision/removal checks. Fictional Rust and browser tests cover the [source boundary](docs/cue-evaluator.md#selected-note-development-bridge); no app/provider activation or semantic-quality claim.
- [x] Measure and tune bounded evaluator scheduling with sustained fictional speech and delayed replies before any provider activation. A single coalesced notification catches up with the latest fresh input after a busy worker returns; controls clear waiting work, and superseded results never appear ([acceptance and remaining latency limits](docs/cue-evaluator.md#coalesced-speech-scheduling)).
- [x] Define concrete cue-processing choices, session permission scope, failure behavior and an acceptance sequence before app activation ([proposal](docs/processing-plan.md)); this is a plan, not processing permission or a selected provider.
- [x] Implement and test a session-scoped evaluator permission boundary with fictional adapters, rejecting unapproved sources, changed scope and delayed work after revocation before any provider activation. Registration starts disabled; exact source grants and revocation pass [headless acceptance](docs/cue-evaluator.md#session-processing-permission). User-facing controls and native/provider activation remain separate.
- [x] Exercise processing location, source selection, availability, pause and Stop controls with fictional IPC and headless keyboard/narrow-layout checks before any provider activation ([acceptance and limits](docs/processing-controls.md)). The original evidence used a standalone fixture; [notebook integration](docs/notebook-processing-controls.md) now shares native status without activating an evaluator.
- [x] Implement the native processing command/event contract over the session grant, proving exact review binding, source changes and Stop races with fictional adapters before mounting the controls in the app. [Engine availability](docs/cue-evaluator.md#evaluation-availability-before-native-controls) distinguishes quiet from failure. [Startup cancellation](docs/live-start-cancellation.md) prevents late installation after Stop. [Native review ownership](docs/native-processing-reviews.md) now bounds opaque IDs, invalidates changed-source reviews and blocks approval during drain; [Native status](docs/native-processing-status.md) supplies trusted disclosure snapshots and monotonic main-window events; [guarded native review/approval/cancellation and Pause/Resume/Disable](docs/native-processing-commands.md) now reject stale UI authority. [Scoped capture Stop](docs/scoped-capture-stop.md) now guards pending startup, live capture and independent monitoring. Native ownership and fictional UI checks pass; app integration remains separate.
- [x] Make Cancel start reachable during local-model preparation and keep the notebook's guarded Stop independent of pending commands. [Actual-app headless acceptance](docs/notebook-capture-controls.md) covers cancellation, delayed permission, replacement operations, recovery and UI/UX; native device release remains unverified.
- [x] Integrate evaluator permission review, pause and disable controls into the notebook; preserve optional setup and unavailable processing without an adapter. The complete start/cancel/review/pause/disable/Stop/recovery flow passes [actual-app headless checks and a UI/UX checkpoint](docs/notebook-processing-controls.md). Native permission, keyboard/focus and actual microphone-release acceptance remain separately open below; no evaluator is activated.
- [ ] Select an explicit processing/provider path and permission flow before enabling evaluated cues in the app; verify latency, privacy, limits and onboarding on that path.

- [x] Compare macOS system-audio API scope and availability, and define a bounded synthetic-source acceptance plan. The [decision record](docs/system-audio-plan.md) proposes a ScreenCaptureKit audio-output-only spike for the macOS 14.0 target, with Core Audio taps as a 14.2+ alternative. This is sourced planning; no system-audio adapter, capture permission or native acceptance is supplied.
- [ ] Start and stop microphone and system-audio capture with explicit permission. A live session started from the microphone after the macOS permission prompt in the [9 November check](docs/native-validation.md#live-session-check); Stop was not checked, and system audio is not captured. Follow the [selected-application scope and acceptance gates](docs/system-audio-plan.md) before any other-app capture experiment.
- [x] Transcribe a synthetic meeting locally without network access after model setup. A real-time developer replay of a fictional two-voice clip with a feature-gated Whisper backend. A developer build routes the microphone into a live session; system audio is not captured.
- [x] Measure transcript delay, memory growth, CPU use, and dropped audio. Synthetic replays of 10, 20, and 60 minutes measured these ([results](docs/local-transcription.md#sustained-session)); the hour-long run showed no memory growth and about 14% of one M5 Pro Max core. Live capture, the companion, and the lowest supported Mac are not yet included.
- [ ] Show a dismissible prompt without taking keyboard focus from the meeting.
- [x] Pause and resume live cues independently of capture and transcription, clearing the current cue and skipping delayed speech from the pause. Rust and headless browser checks cover the [controls and failure cases](docs/live-cue-pause.md); no hardware claim.
- [ ] Confirm stop/pause and device-change behavior, including headphones. Live cue pause is implemented; microphone release, device changes, and native control acceptance remain open.

## First usable version

- [x] Minimal session view centered on the current cue and its controls; optional notes remain a prototype utility, with no Save action or saved-cue archive. The companion shows one question with Why? and Dismiss; the notebook keeps notes and the reviewed export; the saved-cue archive and its export section are removed.
- [x] One cue at a time, expiry, cooldown, pause, and adjustable sensitivity. The engine holds at most one question; an unread suggestion expires after 18 s (45 s for a question asked of you by name); a 10 s pause follows (30 s with the Quiet setting in Settings → Question timing); pausing the demo freezes the clock and the deadline. Engine and browser tests cover each (`quiet_mode_leaves_space_after_expiry`, `pause_freezes_transcript_and_deadline`, the notebook tests). The timings are fixed values; the one setting offers two options.
- [ ] Initial cues for missing owners, vague deadlines, and explicit open questions. Phrase rules raise a missing-owner question ("someone can…", "someone should…", "someone could…") and a vague-deadline question ("soon"), plus a decision question ("either… or"), on the fictional script and live transcripts. An "Open question" cue quotes an explicit question put to the group ("Does anyone…?", "Any thoughts…?", "Who can…?") when the sentence ends with a question mark. All of these are phrase matches, not understanding ([cue intelligence](docs/cue-intelligence.md)). The vague-deadline question was seen once in a [live session on hardware](docs/native-validation.md#live-session-check) on 9 November 2026; the missing-owner rule missed "someone should…" there and was widened the same day, and the open question is unchecked live, so the item stays open.
- [x] Quote a spoken date or commitment word for word, with a one-tap way to keep it. A "Said" cue shows the exact sentence when someone names a day or commits to a time ("ready by Friday", "legal takes two days"), in place of the timing question it answered or on its own; **Keep this line** puts the quote with its time and speaker into the notes, and nothing is kept otherwise. Phrase rules on fictional scripts only; whether people keep such lines is for the pilot comparison.
- [ ] Suppress questions answered by the conversation before display, and cancel stale or redundant prompts. Phrase rules now cover answers, repeats, elapsed time, and sentences that open by changing the topic; reliable judgment of meaning remains in the cue intelligence plan.
- [ ] Prioritize questions clearly addressed to the user; remain quiet for another or uncertain addressee. Phrase rules use a session-only name set in Settings. They are checked only on synthetic text and need a comma or dash beside the name. A question put to someone else by name no longer raises a suggestion. Not yet checked in a live session.
- [ ] Preserve a direct question while the user answers, without competing cues, fabricated answers, response scores, or countdown pressure; keep dismissal available. An "Asked you" question stays for 45 seconds with no countdown shown, and the name is set in Settings for the session. Checked on synthetic text only, not in a live session.
- [ ] Clear or update cues as context changes; do not automatically archive unused suggestions.
- [x] Selected-meeting context and a simple meeting goal. Selected context is the file import above and, since 9 November, Granola. The goal became a focus list of up to five lines the same day: a question whose line uses a focus line's words comes through during the pause after another cue and stays 45 seconds; the Focused timing setting shows only those, questions asked of the user by name, and note reminders; the lines never touched are listed once when the meeting wraps up; a session shows at most three reminders. Word matches on the user's own words, stress-tested on fictional conversations only; whether it helps is for the pilot comparison.
- [ ] Clear retention controls for any retained content; expand prompt history or Markdown export only for a demonstrated use case. Today no user content is retained between launches: notes and the session-only name live in memory, the live transcript is never saved or exported, dismissed questions are let go, and the only export is the reviewed Markdown file the user chooses to save. The optional speech model is the one thing kept on disk, in the app's data folder, removable from Settings ([PRIVACY.md](PRIVACY.md)). Retention controls become necessary only if a future change keeps user content, and the [pilot criteria](docs/pilot-acceptance.md) require that the app retain nothing after quit and that study participant data have a written handling and deletion plan before a pilot.
- [ ] Accessible keyboard operation and reduced-motion support. Browser tests cover keyboard tabs, dismissal, focus return, the export dialog, and reduced motion; a native keyboard pass is recorded twice on one Mac. Not yet checked: VoiceOver in the notebook and companion, and cross-app focus ([pending checks](docs/native-validation.md#remaining-manual-acceptance-checks)). Stays open until those run.
- [x] Fictional demo mode that never reads the user's meeting store. The demo is the fictional script compiled into the app with `include_str!`, so the demo itself opens no file at run time; an engine test pins it to that script. The app keeps no meeting store ([privacy notes](PRIVACY.md)).
- [ ] Compare a short fictional meeting workflow with and without TalkQTE: useful context and participation, listening, stale or redundant prompts, and distraction.

The [product goal and first proof](PRODUCT.md#goal-and-first-proof) define what this milestone is trying to establish. Use the [research decision notes](docs/research.md) to connect findings to a specific change and a test; adding a study to the reading list does not establish a product benefit.

## Future goal: work with other note-taking apps

TalkQTE should complement an existing note-taking workflow. Evaluate Granola first, Fireflies second, and others when actual demand justifies them. Keep the existing note-taker as the primary meeting record. Capability research, adapter contracts, authentication planning, and fictional failure tests begin alongside the core work. Ship each connection only when its end-to-end usefulness and production behavior are verified; the Granola connection is in development and has one owner-confirmed native import/removal; refresh, recovery and data-flow acceptance remain.

- [x] Import selected Granola notes through supported exports or documented APIs, after verifying access and plan requirements. Built on 9–10 November over Granola's MCP server: sign-in, choosing notes of the last 30 days, and, where the plan offers the assistant, suggested focus lines from one fixed question. Sign-in, listing, and suggestions have worked in an account check. The observed tagged private-note/summary format and refresh ordering from provider update timestamps are now covered headlessly; the owner confirmed native import/removal on 11 November ([evidence and limits](docs/granola-import-validation.md#owner-observed-native-import-and-removal--11-november-2026)). This completes the basic import slice, not a supported production integration.
- [ ] Evaluate Fireflies' documented beta live transcript API separately from completed-note import and export.
- [ ] Support other note-takers through common file formats when needed, adding dedicated adapters only for demonstrated use cases.
- [ ] Use imported notes as selected meeting context without requiring a second recording of the original meeting. First slice: notes imported from a fictional JSON file through the context contract, shown beside the notebook with source and date, removable, never exported. A line that uses two or more distinctive title words of a note shows it once as a context reminder, labeled with its source; a phrase rule, seen once by the owner in a [live session](docs/native-validation.md#live-session-check) and otherwise untested with people. Granola basic import/removal is owner-confirmed; reminder usefulness remains unvalidated.
- [ ] Export selected notes, questions, and action items with a preview of the content and destination.
- [x] Keep Granola connection controls current when older status replies arrive. [Fictional browser and UI/UX checks](docs/granola-import-validation.md#connection-status-after-sign-in-or-navigation) cover sign-in, navigation and reconnect races; real-account refresh and recovery remain separate.
- [x] Keep imported-note removal current when an older startup list arrives. [Fictional browser and UI/UX checks](docs/context-list-recovery.md) cover removal, import and late read failure; native/account acceptance remains separate.
- [x] Preserve source references and handle repeated imports without silently duplicating or overwriting user edits. Each imported note keeps its provider, source ID, and date; the date and source are shown beside it. Importing the same notes again reports them as already imported and keeps one copy; a newer revision replaces a note and an older one never rolls it back. Imported notes cannot be edited in TalkQTE, so there are no user edits to overwrite. File and Granola revision paths have fictional Rust checks, and the repeat notice has browser coverage. Granola uses provider update timestamps to reject older copies; [real-account refresh ordering remains unverified](docs/granola-import-validation.md#refreshing-an-imported-note).
- [x] Give each connection explicit permissions and disconnect controls; apply retention rules to imported copies. Imported copies, from a file or from Granola, live only in memory and can be removed one at a time or all at once. The Granola connection is the person's own sign-in; the notebook states what TalkQTE may do with it (list and read chosen notes of the last 30 days, and one question to the assistant when asked; no transcripts, nothing written back) and **Disconnect Granola** forgets the sign-in without touching imported notes. Fictional checks cover connection retirement, late replies, removal and export exclusion. Sign-in, listing and requested suggestions have worked in account checks; basic native import/removal is now owner-confirmed, while real-account disconnect/data-flow acceptance remains pending ([evidence](docs/granola-import-validation.md#privacy-boundary-checks)).

The current Granola connection is a development prior-note import path, with the account-level gaps above. It does not supply live transcript input or provider writeback. Consider live context and two-way synchronization only where documented interfaces support them and conflict/deletion behavior is defined; neither is implemented or promised by this connection.

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

- [ ] Build, install, and launch the Windows prototype in Parallels; record Windows, architecture, WebView2, and toolchain versions. Earlier native Arm launch/demo evidence and the [11 November current build and unsigned NSIS packaging check](docs/platforms.md#current-build-and-installer-packaging-11-november-2026) are recorded. Current installation and native launch/UI acceptance remain open; packaging alone does not complete this item.
- [ ] Validate Windows companion focus, scaling, keyboard access, full-screen meetings, and screen-sharing behavior.
- [ ] Prove both sides of a synthetic call, Stop/recovery, and device changes through a Windows capture adapter.
- [ ] Add Windows build/Rust checks when the build target is established, then validate signed installation and updates on the claimed physical hardware and architectures. Windows Arm Rust tests, Clippy, and the desktop debug build are configured in the [checks workflow](.github/workflows/checks.yml); signed installation, updates, and physical-device acceptance remain unverified.
- [ ] Explore an Ubuntu ARM64 VM: build and run the desktop shell, assess audio and companion behavior, and record the desktop/session configuration. The [11 November headless check](docs/platforms.md#current-headless-build-11-november-2026) passed 297 Rust tests and built current `ab8d369` as a native ARM64 executable. Current desktop launch and companion/audio acceptance remain open; the guest was at its sign-in screen.
- [ ] Decide whether to support a named Linux configuration based on the Ubuntu evidence and maintenance effort. General Linux support remains undecided.

## Future goal: participate from a phone

Support joining Google Meet on a phone and receiving prompts during the call. Obtaining the conversation and presenting a prompt are separate capabilities; neither is implemented on mobile. See the [mobile feasibility and acceptance plan](docs/mobile.md).

- [ ] Validate a readable mobile cue and its controls with fictional context; selected imports may support context, while notes and saving need a separate demonstrated use case.
- [ ] Prove a foreground mobile companion receiving an authenticated, explicitly paired live session feed.
- [ ] Validate Meet's own picture-in-picture alongside the companion where the device and app support it.
- [ ] Investigate same-phone capture on real devices, with explicit unsupported states when either side of the call is unavailable.
- [ ] Test platform-specific prompt surfaces, background behavior, accessibility, battery use, and permission denial before making capability claims.

Whisper transcribes speech; it does not produce reliable summaries or understand meeting intent on its own. Semantic summaries and conversational search need a separate model or an explicitly limited rules-based implementation.
