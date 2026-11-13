# Desktop stack decision

Status: accepted for the initial implementation, 2026-11-08.

## Decision

Use Rust for the application core, Tauri 2 for the desktop shell, and React with TypeScript and CSS for the interface. Ship macOS first. Use local Whisper for speech recognition. Keep the native capture adapter separate from transcription and presentation.

## Why this stack

| Option               | Strength for TalkQTE                                               | Main trade-off                                                                                       |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Rust + Tauri + React | Native core, flexible interface, a path to other desktop platforms | Native capture and overlay behavior still require platform-specific work; system webviews differ     |
| Swift + SwiftUI      | Direct access to macOS audio, permissions, and window APIs         | A second desktop UI and platform layer would be needed for Windows                                   |
| Electron + React     | Mature web-based desktop tooling and predictable bundled Chromium  | A bundled browser/runtime and a JavaScript main process; native audio integration is still necessary |
| Rust-only UI         | One primary language and close native integration                  | More UI/toolkit work for this interface and less reuse of web styling experience                     |

Tauri does not turn native audio capture into a solved problem. Its system webview avoids bundling Chromium, but actual memory, package size, responsiveness, and battery use must be measured with the model running. Whisper inference may dominate resource use.

## Boundaries

### Current prototype

`src/demo.json` is a fictional timed conversation. `src-tauri/src/engine.rs` advances it, applies limited phrase rules, and owns the question lifecycle and in-memory notebook. A native timer and commands synchronize elapsed time under a mutex. Native visibility updates do not call blocking window getters while holding that mutex.

The main webview receives session snapshots. The floating webview receives only the current question and display state, and has a smaller Tauri command capability. Revisions keep late snapshots from replacing newer UI state. React sends note edits through an ordered command queue; export preparation waits for those edits.

`src-tauri/src/companion.rs` owns the floating window's compact, question, and context states. It defaults to the bottom-right of the notebook display's work area, with optional top-center, top-left, and top-right presets and a primary-display fallback. Rust-owned, session-only appearance settings travel with both snapshots. Native window queries run on the main thread after releasing the engine lock. Placement is checked on notebook moves and once per second so display and Dock changes can be handled without querying window state in the engine's critical section. Only changed layouts are applied. The window is configured not to take focus; keyboard question controls remain in the notebook. Full-screen apps, Spaces, native assistive access, and screen sharing still require separate verification. Automatic meeting detection is not implemented.

Glance view initially hides the evidence excerpt. The ID-validated `inspect_cue` command updates shared disclosure state and marks the current question held in Rust. Playback and transcript updates continue, but expiry cannot remove a held question and later suggestions do not replace it. Collapsing context retains the hold. The original deadline still supplies an earlier-question label; it is not semantic resolution. Dismiss remains available in the UI whenever that same question exists, including pause and natural playback completion. Explicit End demo and Replay clear it. Untouched questions retain the existing expiry/cooldown policy. Skipped questions are never replayed from a backlog. See [design and evidence](glance-mode.md).

On macOS, `src-tauri/src/companion_macos.rs` selects a native titled frame with full-size content before the window is created. AppKit supplies its rounded outer corners while the webview remains opaque. Setup hides the title and standard window buttons before the companion first appears, using public AppKit APIs on the main thread. This keeps platform window details out of the lifecycle and rendering code; other platforms retain the borderless configuration. Compact and expanded native windows have been visually checked on macOS; this does not verify cross-app keyboard focus or Spaces behavior. The [native validation record](native-validation.md) separates observed notebook behavior, geometry tests, and pending companion checks.

Export preparation stores a Markdown snapshot in Rust. The subsequent native save dialog writes that exact snapshot, not a new version assembled after the user reviews it. The frontend cannot supply an arbitrary filesystem destination to the export command.

The browser preview uses `src/lib/preview.ts`, a development-only simulation. Its UI tests complement the Rust engine tests; they do not test Rust IPC, native dialogs, or native windows. There is currently no full meeting-audio pipeline, system-audio capture, or database. The note-file and Granola adapters are described below.

The engine exposes one transcript input boundary for a future transcription worker: `Engine::ingest(session, segment)`. A worker records `Engine::session()` when it starts and attaches that value to each segment. Ending or replaying issues a new session, so late work for an earlier session is rejected. Input is accepted only while the session is running, at or before the current elapsed time, in order, with a unique short ID, a speaker label up to 80 characters, and 1–1,000 characters of text. Rejected input leaves state unchanged. Times are on the engine's session clock, which advances on native ticks and stops while paused. A worker must convert audio timestamps to that clock, or its segments will be rejected as coming from the future. IDs must not reuse a bundled demo ID. Accepted segments use the same cue, answer, and stale-cue rules as the demo. The in-memory transcript keeps the latest 400 segments; duplicate IDs are detected only within those. Once a session has supplied lines, the Markdown export stops labelling its transcript as fictional demo content. `src-tauri/src/transcription.rs` provides the worker that calls it. It is created for one session ID, and its capture side hands over 16 kHz mono chunks with `submit`, which does not wait for the worker. A full queue, a cancelled worker, or a chunk over 30 seconds is counted as dropped and handed back, so a capture callback can reuse the buffer. A replaceable `Transcriber` runs on the worker thread. Recognized lines are delivered in time order through `ingest`, and lines with offsets outside their chunk are skipped. Segment IDs include a per-worker number, so restarting a worker within a session never repeats one. `cancel` stops delivery at once, discards queued chunks, and is safe to call while holding the engine lock. `stop` also waits up to two seconds for a recognizer call in progress; if it does not return, the thread is detached and delivers nothing more. Call `stop` without holding the engine lock, because delivery takes it. A recognizer error skips one chunk. Segments the engine refuses, for example after End, are counted and change nothing. The worker keeps no audio. The optional `local-whisper` Cargo feature adds `LocalWhisper`, which runs whisper.cpp in-process on the worker thread from a given model file, with no network access or audio files; it is off by default. `Engine::live()` creates a session without scripted demo lines. In `local-whisper` builds, the live session below starts a worker. See the [local transcription check](local-transcription.md).

`src-tauri/src/audio_tap.rs` is the bridge between microphone capture and the transcription worker. Its callback side downmixes interleaved samples to mono and pushes them into a fixed four-second lock-free ring (`rtrb`) without allocating, locking, or blocking; when the ring is full, samples are dropped and counted. A chunker on another thread drains the ring, resamples to 16 kHz (averaging when downsampling, which gives only minimal anti-aliasing, and linear interpolation when upsampling), and cuts chunks timed on the session clock: fixed-length by default, or, with `cut_at_pauses`, at the first pause after a minimum length and never longer than the set length. Live sessions use pauses with 1–3 s chunks. In that mode a full-length chunk of near-total silence is skipped, not transcribed, and counted; later chunk times are unchanged. Dropped audio leaves a gap so later chunks keep their times, a frame split across callbacks is kept, and stopping returns every remaining chunk once capture has stopped. Chunk times come from counting samples, so device clock drift and pausing the session can still move them off the engine's clock. Tests cover 8–48 kHz input, downmixing, split frames, overruns and the gap they leave, clipping, the remaining chunks on stop, and chunk timing over ten minutes at 48 kHz. An optional local Whisper check fed the fictional meeting at 16 and 48 kHz through the tap and raised the expected question, with no overruns. The live session connects the microphone to the tap.

`src-tauri/src/context.rs` defines the source-aware contract for prior notes a user selects from a note-taker or a file. It covers validated items with provider, date, excerpt, and revision; separate import, live-input, and writeback capabilities; and connection status. Fetching, with bounded retries and cancellation, runs outside the in-memory store, so no lock is held during network work. The store accepts only selected notes, deduplicates by revision, and deletes copies only on an explicit removal, which is separate from disconnecting. Imported notes are kept apart from live meeting evidence. The first adapter is `src-tauri/src/notes_file.rs`: a JSON notes file the user picks through the native dialog (at most 1 MB and 200 notes) is parsed into context items, listed for selection, and only the ticked notes are merged into the store held in the runtime; `context:changed` carries the items to the main window, which can remove them singly or all at once. No authentication or network access exists; the engine reads the store only for the title-word context reminder. See [integration readiness](product-readiness.md#integration-readiness).

The optional [Claude cue lab](claude-cue-lab.md) is a separate Node development script, not an application inference worker. It sends one bundled fictional case through the official subscription-authenticated CLI, checks the returned decision and source IDs, and prints a report. It cannot mutate Rust cue state, receive captured audio, or supply live app prompts. A later app integration still requires a Rust-owned worker, validated source/version boundaries, resource budgets, cancellation, and an explicit processing decision.

### Microphone activity on macOS

`src-tauri/src/microphone.rs` owns a separate, default-off microphone monitor. Only the main window can invoke `start_microphone`; the main and companion windows can invoke `microphone_snapshot` and `stop_microphone`. During a live session, `stop_microphone` stops the whole session (see below). The `microphone:changed` event contains only a revision, status (`off`, `starting`, `listening`, `stopping`, or `error`), a `canStart` flag, coarse activity (`quiet` or `active`), an optional public error message, and the opened input's display name (`deviceName`, or null). `canStart` is true only when monitoring is off or a failed stream has finished cleanup; cleanup completion emits a newer revision so the UI can enable retry. Consumers must ignore older revisions. No samples, device identifiers, or precise levels are sent to webviews. The adapter caches the same opened device's name after explicit start and permission; the controller strips control/direction-override characters and bounds it to 120 characters. It is local display metadata, never persisted, logged, exported or supplied to the transcript/cue evaluator. Name lookup failure does not stop capture. Starting/listening snapshots retain the label, Stop retains it as releasing until teardown, and Off/error clears it. A cancelled late start cannot publish its label. See the [input visibility checkpoint](microphone-input.md).

The native adapter checks AVFoundation microphone authorization and requests permission only after the explicit start command. Once authorized, a worker creates a CPAL input stream for the current default microphone in its native format. Status remains `starting` until samples arrive. Cancelling a pending start invalidates its generation, so a late permission result cannot restart monitoring. Microphone commands await controller work on blocking workers; native window/timer reads skip busy state instead of waiting behind device startup. App exit schedules cleanup without blocking the event loop. Once stop is accepted, `stopping` remains visible until teardown completes, then an event reports `off`. New starts are rejected during teardown, including cleanup after an error; errors require an explicit retry. There is no automatic device switching or automatic restart.

The audio callback inspects at most 4,096 samples per buffer and writes only atomic activity, buffer-count, and failure summaries. It does not allocate an audio buffer, lock application state, emit events, log, write files, or retain samples. A native poll reads those summaries every 200 ms, holds the activity indicator briefly to avoid flicker, and requests capture cleanup on a stream error or after three seconds without callbacks. Native stream destruction runs on a blocking worker after publishing the error, so a slow device cannot hold up the demo timer or companion updates. This level threshold detects signal activity, not speech, speakers, or meeting participation.

Microphone monitoring is independent of fictional demo playback; pausing or ending the demo does not stop the microphone. It does not capture system output, other apps' audio, or both sides of a call. It does not transcribe, record, retain audio, use a model, or send audio over the network. The browser preview does not request microphone permission. Synthetic tests cover signal, lifecycle, and deliberately blocked stream teardown behavior without opening a real device; permission prompts, device changes, and real-device operation still need opt-in native verification.

The notebook exposes explicit Start microphone and Stop microphone controls separately from the demo. The compact companion remains available during microphone starting, activity, stopping, and errors even when no demo is running. Its Stop mic action takes priority over demo playback controls. Hide only hides the window; it does not stop monitoring. The microphone check never feeds the demo, so demo question cards and exports stay labelled as fictional; a live session (below) is labelled live. Frontend tests use a test-only mocked IPC entry point; the browser preview itself never simulates microphone activity.

### Live session

The runtime owns one bounded `processing_reviews::Reviews` store for processing commands. Its opaque ID refers to a single-use Rust engine token, with an additional digest of available notes; reconciliation after control/source changes discards stale reviews without widening a valid grant. `Engine::begin_live_stop` closes processing before transcript drain, and `finish_live_stop(session)` ignores old cleanup completions. The stopping flag does not confirm microphone release. These gates have [fictional native review acceptance](native-processing-reviews.md); the [processing status contract](native-processing-status.md) publishes metadata to the main window. Main-only [processing commands](native-processing-commands.md) bind review preparation, Disable and Pause/Resume to the originating session/scope, with opaque-ID-only approval and cancellation. [Capture Stop](scoped-capture-stop.md) instead uses stable live-operation ownership and an exact microphone generation, checked again by the adapter outside Runtime. Note changes do not block Stop. The [notebook integration](notebook-processing-controls.md) shares native status for capture and permission controls; provider activation and real-device acceptance remain separate.

`src-tauri/src/live_control.rs` reserves a single startup ticket before model loading. Stop cancels it without waiting for the loader; its reservation remains until the blocking worker exits, and a cancelled result cannot install an engine. Microphone startup registers its generation with that session before requesting permission, allowing Stop to retire a pending start. End-session and microphone-loss cleanup use the same early processing revocation before queued transcript drain. See [headless startup acceptance and remaining UI/native checks](live-start-cancellation.md).

`src-tauri/src/live.rs` runs a live session without depending on Tauri. In builds with the `local-whisper` feature, the main window's `start_live_session` command loads the speech model on a blocking worker, replaces the engine with `Engine::live()` (keeping display settings and notes), and starts the microphone with a tap of 3-second chunks. The capture callback then also pushes samples into the [audio tap](#current-prototype) without allocating, locking, or blocking. Once capture really starts, a one-shot callback receives the tap's chunker and starts a `LiveSession` only if the engine session is still current; otherwise it releases the microphone. Chunk times start at the engine's elapsed time when capture began. A runner thread drains the tap every 250 ms into a `transcription::Worker` with a queue of four chunks; refused chunks are counted. The worker's lines go to `Engine::ingest` under the engine lock and are published to both windows.

The runtime holds the live session's engine session ID, the microphone start's generation, and the runner. `stop_live_session`, also allowed for the companion, takes these out under the lock, releases that microphone start only (a later capture is never stopped by a stale request), then outside the lock hands the remaining audio to the worker and waits up to 10 seconds before ending the engine session, only if it is still that session. A second Stop finds nothing to stop. `stop_microphone` during a live session does the same. The native timer ends a live session whose microphone start is no longer starting or listening, for example after a refused permission or a device failure; it reads the microphone state without waiting. `end_demo` during a live session ends it at once and cancels the worker before joining its runner, so queued audio is discarded. A replacement engine continues session numbering from the one it replaces, so late lines from a live session are refused by the next session. The live clock and transcription cannot be paused. The separately validated `set_live_cues_paused` command, available in both windows, clears the current cue (including a held one) and suppresses new cues while transcript ingestion continues. Resume records the current elapsed time; delayed lines at or before that boundary remain in the transcript but cannot raise cues. Both snapshots expose `cuesPaused`, and Stop/new-session resets it. `export_preview` still refuses live sessions, so their transcripts are never written out. See [cue pause acceptance](live-cue-pause.md). `live_status` reports whether the build includes the feature and whether the model file exists. The model path is `TALKQTE_WHISPER_MODEL` (a developer file, not checksum-checked) or `models/ggml-tiny.en.bin` in the app data folder, which is checked against its pinned SHA-256 before loading. `src-tauri/src/model.rs` downloads that file only on an explicit `download_model` command from the main window, through a `Fetch` interface so tests never use the network; the HTTPS client is compiled only with `local-whisper`. Progress goes to the main window as `model:changed`, and `cancel_model_download` and `remove_model` complete the controls. The cue snapshot carries a `live` flag so the companion can label the session. Tests run the session with synthetic audio and a scripted recognizer; real-hardware checks are pending.

The macOS bundle requires macOS 14.0 or later and includes `NSMicrophoneUsageDescription`, which covers both the activity check and live transcription, and the generated third-party notices at `Contents/Resources/THIRD-PARTY-NOTICES.txt` ([release path](release-path.md#third-party-notices)); the audio-input entitlement is configured in `Entitlements.plist` and is embedded when signing. For a local bundle check, use `APPLE_SIGNING_IDENTITY=- npm run tauri -- build --debug --bundles app` to ad-hoc sign with the configured entitlement. An unsigned development build is not evidence that entitlements were applied. Inspect the built bundle and signature without invoking microphone start automatically. Ad-hoc signing is not Developer ID signing or notarization.

### Session clock precision

The native runtime retains sub-millisecond active time between clock updates,
including across demo pause/resume. Ready, paused and ended time does not advance
playback; replay or engine replacement clears the previous session's remainder.
Pausing live cues still leaves the session clock running. Deterministic runtime
tests cover frequent fractional updates, cue expiry, pause, replay and replacement;
all four regressions fail with the previous per-update truncation. This prevents
cumulative rounding loss, but does not establish native audio clock correspondence,
device drift, callback timing or live-meeting usefulness. Those remain separate
acceptance gates before connecting application audio.

### Planned meeting pipeline

```text
Native capture adapters
        |
bounded audio buffers
        |
Whisper worker -> transcript segments -> cue evaluator -> cue lifecycle
                         |                                  |
                  private storage                    Tauri events
                                                            |
                                                 dashboard + overlay
```

- Capture adapters own device selection, permissions, stream lifecycle, timestamps, and platform differences.
- The transcription worker owns model loading, audio conversion, inference, and cancellation. Do not perform this work in audio callbacks or on the UI thread.
- Rust owns prompt expiry, cooldowns, persistence, retention, and session boundaries.
- React owns rendering, keyboard interactions, and presentation. It accesses native behavior only through narrowly scoped, validated commands.
- Local Whisper may use whisper.cpp through Rust bindings. This is a Rust application with a native inference dependency, not a promise of an entirely Rust dependency tree.
- AI cue reasoning has a provider-independent worker and validated contract in `cue_evaluator.rs`, tested with fictional evaluators. It permits one outstanding request, checks source references, and rejects cancelled, expired, or changed-context results. Development constructors connect the worker to the engine; native app commands still use phrase rules. Rust retains lifecycle and permission control. No production runtime is selected. Whisper transcribes speech and does not provide cue reasoning. See the [worker contract and remaining integration](cue-evaluator.md) and [cue intelligence plan](cue-intelligence.md).

## Future integration boundary

Granola and other note-taking apps are future sources of selected meeting context and destinations for user-approved exports. Keep provider-specific authentication and data mapping in separate adapters, using supported file exports or documented APIs. Verify each provider's access, plan, and data availability before committing to an integration.

Imported notes should use the planned Rust-owned selection, persistence, retention, and prompt-context boundaries. Preserve source identity and distinguish imported content from user edits so repeated imports can be reconciled explicitly. External content is meeting data, not permission to execute commands or send data elsewhere.

Start with one-way import/export. Live transcript access and two-way synchronization require separate capability checks and conflict/deletion rules. Connections remain optional; an unavailable provider must not block local capture or notes. `src-tauri/src/granola.rs` (9 November 2026) is the first adapter: the person signs in to Granola in the browser (OAuth 2.0 with PKCE and dynamic client registration, a loopback return), the app opens an MCP session and uses `list_meetings`, `get_meetings`, and the fixed `query_granola_meetings` question only when requested; tokens stay in process memory, and the notes a person ticks go through the same store as a file's. The notebook offers it; account checks have confirmed sign-in and listing. The observed tagged detail fields (`private_notes` and `summary`) are mapped and tested through a fictional MCP server and the context store; the owner confirmed basic native import and removal on 11 November. Real-account refresh, recovery and data-flow checks remain. Unknown nested content formats fail explicitly. Missing selected IDs fail the request before any notes are merged, allowing a retry with fewer notes. `context_import.rs` retains the pending source after a failed fetch, prevents concurrent attempts from the same chooser, and invalidates late results when the chooser is cancelled, replaced, or disconnected. Fetching and retry waits run outside the runtime lock; cancellation stops further retries and discards the response but does not abort an already-sent HTTP request.

`src-tauri/src/context_refresh.rs` holds one explicit update check of the Granola notes already selected, reached through the notebook-only `check_granola_updates` and `stop_granola_update_check` commands; it needs a provider-supported workspace identity, which the Granola adapter does not report, so the signed-in connection neither offers nor runs it ([scope and rules](selected-note-refresh-plan.md#first-slice-one-explicit-check-simulated-provider-only)).

### Retiring Granola sessions and removing context

`granola::Shared` carries a retirement flag across every clone. Disconnect sets it without waiting for the connection mutex, drops idle credentials, and prevents queued calls from using the old connection. A call already holding the connection discards its result and drops credentials when it returns; an HTTP request already sent is not aborted. Listing and suggestion commands also compare the originating shared connection with the current one before accepting a result, so reconnecting cannot make a retired result current. Disconnect cancels pending sign-in and the Granola chooser, while existing imported copies remain in the context store until explicit removal.

Synchronizing the context store passes complete `ContextItem` values to the engine, preserving provider identity, source ID, revision, date, title, and excerpt across engine replacement. A newer revision, changed metadata/text, or removal clears a reminder quoting the previous item even when held open; the snapshot revision advances and both windows receive the new state. The reminder is not rewritten or re-armed for this session. Unchanged and older imports, updates to another provider's note with the same source ID, unrelated transcript cues, and manual notes remain unchanged. See the [headless acceptance record](note-revision-cues.md). The generated Markdown contains manual notes and transcript text, not imported excerpts or cue payloads. Optional provider diagnostics use a bounded, allowlisted structural projection; tool schemas and arbitrary JSON keys are not presumed public.

## Next native spike and acceptance criteria

Before that spike, `application_audio.rs` supplies a development-only single-source
review/start/cancel boundary. It binds an immutable application selection to a
one-use review and scoped Stop, reserving the operation until its pending start
and returned stream have been released. Adapter work and destruction occur
outside the state lock. [Synthetic acceptance](application-audio-boundary.md)
establishes ownership only. Its `handoff` submodule carries bounded synthetic
audio with exact operation identity, immutable format, absolute frame positions
and explicit gaps. Its `timing` submodule binds one reader to a session and an
explicit frame-zero origin, with checked absolute-frame conversion and
frame-level discontinuities. Returned work still requires source/session guards.
Native filtering, clock origin/drift, deadlines and actual source release remain
unimplemented or unverified. The optional [native owner](native-audio-owner.md)
now has a dedicated-worker loop and a sendable control handle. Native objects stay
on their constructing thread through cleanup; host-handle loss requests Stop,
and abandonment remains distinct from release. No app command enables this path. Its worker-side `chunks` submodule accepts only
16 kHz mono, cuts continuous audio at three seconds and partial audio at every
gap or clean EOF, and discards pending samples on cancellation/session changes.
Returned chunks retain source/session guards, and the microphone path is unchanged.

`src-tauri/src/live_source.rs`, compiled in every build, lets the runtime hold at
most one application-audio source attached to the running live session. Stopping
or replacing that session cancels the attached source under the runtime lock,
and a line from a source that is not attached is refused. In an ordinary build
nothing ever attaches a source, so this changes no app behavior.
`src-tauri/src/native_source.rs` is the development-only host loop that would
attach one: it is compiled only on macOS with the `native-audio-spike` feature,
and moves native blocks through the chunker and a transcription worker to that
source sink. No command, picker, enumeration or permission request calls it, and
it has not been run against a device, so nothing in the app starts application
audio. See [ownership, sink and tests](native-audio-owner.md#live-session-ownership-of-the-source--13-november-2026).

1. Capture both sides of a synthetic call with headphones, with clear microphone/system permissions.
2. Stop and pause promptly; test device disconnect and permission denial.
3. Measure transcription latency and resource use on the target Mac while the meeting app runs.
4. Show and dismiss one prompt without stealing keyboard focus. Check Spaces, full-screen meeting windows, and screen sharing separately.
5. Run without network access after model installation. Verify that no audio or transcript appears in logs, temporary files, or the repository.

The [system-audio decision record](system-audio-plan.md) compares ScreenCaptureKit's application-wide audio with Core Audio process taps and their different OS requirements. It proposes a consented, selected-source audio-output-only spike before combining another app's sound with the microphone. A small platform bridge remains an option if required. Select the concrete binding after this spike; do not promise system-audio support based on microphone capture alone. The plan changes no capture behavior or deployment minimum.

## References

- [Tauri introduction](https://v2.tauri.app/start/)
- [Tauri process model](https://v2.tauri.app/concept/process-model/)
- [Tauri window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)
- [Tauri macOS bundle configuration](https://v2.tauri.app/distribute/macos-application-bundle/)
- [CPAL input-stream API](https://docs.rs/cpal/0.18.2/cpal/)
- [Apple microphone authorization](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media)
- [ScreenCaptureKit Rust bindings](https://docs.rs/screencapturekit/latest/screencapturekit/)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)

### Evaluator lifecycle development boundary

The [bounded evaluator](cue-evaluator.md) has a source-aware engine bridge in `engine/evaluation.rs`. `Engine::live_with_evaluator` registers an explicitly supplied worker and immutable processor configuration, initially disabled. A Rust-owned session review/grant separately approves new or recent speech and exact prior notes, preserving provider/date/title/revision. Changed approved notes, revocation and session replacement cancel work and clear copied cue evidence; imports never widen permission. The [permission acceptance record](cue-evaluator.md#session-processing-permission) describes the boundary and remaining UI/adapter gates. Native session commands still construct the phrase-rule engine. The alternative path ingests the same validated transcript, applies the same controls and clock, and polls under the engine lock. New eligible speech requests evaluation; one boolean notification coalesces speech received while the worker is occupied, and a normal clock poll dispatches current context once it is free. Controls discard waiting work. The engine uses a separate eligibility revision from snapshot time, cancels obsolete work, and rejects late results before mutating the visible cue. Transcript and provider-note IDs occupy separate namespaces. State-changing proposals require a fresh cited transcript anchor, while selected notes remain prior context. Cue and resolution snapshots include only the cited sources, rendered individually with source labels; refreshing/removing a cited note invalidates delayed results and clears held evidence. Provider/app activation and user-facing permission controls remain separate; no network or model capability is introduced.
