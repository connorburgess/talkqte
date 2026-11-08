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

The browser preview uses `src/lib/preview.ts`, a development-only simulation. Its UI tests complement the Rust engine tests; they do not test Rust IPC, native dialogs, or native windows. There is currently no full meeting-audio pipeline, system-audio capture, database, or integration adapter.

The engine exposes one transcript input boundary for a future transcription worker: `Engine::ingest(session, segment)`. A worker records `Engine::session()` when it starts and attaches that value to each segment. Ending or replaying issues a new session, so late work for an earlier session is rejected. Input is accepted only while the session is running, at or before the current elapsed time, in order, with a unique short ID, a speaker label up to 80 characters, and 1–1,000 characters of text. Rejected input leaves state unchanged. Times are on the engine's session clock, which advances on native ticks and stops while paused. A worker must convert audio timestamps to that clock, or its segments will be rejected as coming from the future. IDs must not reuse a bundled demo ID. Accepted segments use the same cue, answer, and stale-cue rules as the demo. The in-memory transcript keeps the latest 400 segments; duplicate IDs are detected only within those. Once a session has supplied lines, the Markdown export stops labelling its transcript as fictional demo content. `src-tauri/src/transcription.rs` provides the worker that will call it. It is created for one session ID, and its capture side hands over 16 kHz mono chunks with `submit`, which does not wait for the worker. A full queue, a cancelled worker, or a chunk over 30 seconds is counted as dropped and handed back, so a capture callback can reuse the buffer. A replaceable `Transcriber` runs on the worker thread. Recognized lines are delivered in time order through `ingest`, and lines with offsets outside their chunk are skipped. Segment IDs include a per-worker number, so restarting a worker within a session never repeats one. `cancel` stops delivery at once, discards queued chunks, and is safe to call while holding the engine lock. `stop` also waits up to two seconds for a recognizer call in progress; if it does not return, the thread is detached and delivers nothing more. Call `stop` without holding the engine lock, because delivery takes it. A recognizer error skips one chunk. Segments the engine refuses, for example after End, are counted and change nothing. The worker keeps no audio. The optional `local-whisper` Cargo feature adds `LocalWhisper`, which runs whisper.cpp in-process on the worker thread from a given model file, with no network access or audio files; it is off by default. `Engine::live()` creates a session without scripted demo lines. In `local-whisper` builds, the live session below starts a worker. See the [local transcription check](local-transcription.md).

`src-tauri/src/audio_tap.rs` is the bridge planned between microphone capture and the transcription worker. Its callback side downmixes interleaved samples to mono and pushes them into a fixed four-second lock-free ring (`rtrb`) without allocating, locking, or blocking; when the ring is full, samples are dropped and counted. A chunker on another thread drains the ring, resamples to 16 kHz (averaging when downsampling, which gives only minimal anti-aliasing, and linear interpolation when upsampling), and cuts fixed-length chunks timed on the session clock. Dropped audio leaves a gap so later chunks keep their times, a frame split across callbacks is kept, and stopping returns every remaining chunk once capture has stopped. Chunk times come from counting samples, so device clock drift and pausing the session can still move them off the engine's clock. Tests cover 8–48 kHz input, downmixing, split frames, overruns and the gap they leave, clipping, the remaining chunks on stop, and chunk timing over ten minutes at 48 kHz. An optional local Whisper check fed the fictional meeting at 16 and 48 kHz through the tap and raised the expected question, with no overruns. The live session connects the microphone to the tap.

`src-tauri/src/context.rs` defines the source-aware contract for prior notes a user selects from a note-taker or a file. It covers validated items with provider, date, excerpt, and revision; separate import, live-input, and writeback capabilities; and connection status. Fetching, with bounded retries and cancellation, runs outside the in-memory store, so no lock is held during network work. The store accepts only selected notes, deduplicates by revision, and deletes copies only on an explicit removal, which is separate from disconnecting. Imported notes are kept apart from live meeting evidence. No adapter, authentication, or network access exists, and the app does not use the store yet. See [integration readiness](product-readiness.md#integration-readiness).

The optional [Claude cue lab](claude-cue-lab.md) is a separate Node development script, not an application inference worker. It sends one bundled fictional case through the official subscription-authenticated CLI, checks the returned decision and source IDs, and prints a report. It cannot mutate Rust cue state, receive captured audio, or supply live app prompts. A later app integration still requires a Rust-owned worker, validated source/version boundaries, resource budgets, cancellation, and an explicit processing decision.

### Microphone activity on macOS

`src-tauri/src/microphone.rs` owns a separate, default-off microphone monitor. Only the main window can invoke `start_microphone`; the main and companion windows can invoke `microphone_snapshot` and `stop_microphone`. During a live session, `stop_microphone` stops the whole session (see below). The `microphone:changed` event contains only a revision, status (`off`, `starting`, `listening`, `stopping`, or `error`), a `canStart` flag, coarse activity (`quiet` or `active`), and an optional public error message. `canStart` is true only when monitoring is off or a failed stream has finished cleanup; cleanup completion emits a newer revision so the UI can enable retry. Consumers must ignore older revisions. No samples, device names, or precise levels are sent to webviews.

The native adapter checks AVFoundation microphone authorization and requests permission only after the explicit start command. Once authorized, a worker creates a CPAL input stream for the current default microphone in its native format. Status remains `starting` until samples arrive. Cancelling a pending start invalidates its generation, so a late permission result cannot restart monitoring. Microphone commands await controller work on blocking workers; native window/timer reads skip busy state instead of waiting behind device startup. App exit schedules cleanup without blocking the event loop. Once stop is accepted, `stopping` remains visible until teardown completes, then an event reports `off`. New starts are rejected during teardown, including cleanup after an error; errors require an explicit retry. There is no automatic device switching or automatic restart.

The audio callback inspects at most 4,096 samples per buffer and writes only atomic activity, buffer-count, and failure summaries. It does not allocate an audio buffer, lock application state, emit events, log, write files, or retain samples. A native poll reads those summaries every 200 ms, holds the activity indicator briefly to avoid flicker, and requests capture cleanup on a stream error or after three seconds without callbacks. Native stream destruction runs on a blocking worker after publishing the error, so a slow device cannot hold up the demo timer or companion updates. This level threshold detects signal activity, not speech, speakers, or meeting participation.

Microphone monitoring is independent of fictional demo playback; pausing or ending the demo does not stop the microphone. It does not capture system output, other apps' audio, or both sides of a call. It does not transcribe, record, retain audio, use a model, or send audio over the network. The browser preview does not request microphone permission. Synthetic tests cover signal, lifecycle, and deliberately blocked stream teardown behavior without opening a real device; permission prompts, device changes, and real-device operation still need opt-in native verification.

The notebook exposes explicit Start microphone and Stop microphone controls separately from the demo. The compact companion remains available during microphone starting, activity, stopping, and errors even when no demo is running. Its Stop mic action takes priority over demo playback controls. Hide only hides the window; it does not stop monitoring. The microphone check never feeds the demo, so demo question cards and exports stay labelled as fictional; a live session (below) is labelled live. Frontend tests use a test-only mocked IPC entry point; the browser preview itself never simulates microphone activity.

### Live session

`src-tauri/src/live.rs` runs a live session without depending on Tauri. In builds with the `local-whisper` feature, the main window's `start_live_session` command loads the speech model on a blocking worker, replaces the engine with `Engine::live()` (keeping display settings and notes), and starts the microphone with a tap of 3-second chunks. The capture callback then also pushes samples into the [audio tap](#current-prototype) without allocating, locking, or blocking. Once capture really starts, a one-shot callback receives the tap's chunker and starts a `LiveSession` only if the engine session is still current; otherwise it releases the microphone. Chunk times start at the engine's elapsed time when capture began. A runner thread drains the tap every 250 ms into a `transcription::Worker` with a queue of four chunks; refused chunks are counted. The worker's lines go to `Engine::ingest` under the engine lock and are published to both windows.

The runtime holds the live session's engine session ID, the microphone start's generation, and the runner. `stop_live_session`, also allowed for the companion, takes these out under the lock, releases that microphone start only (a later capture is never stopped by a stale request), then outside the lock hands the remaining audio to the worker and waits up to 10 seconds before ending the engine session, only if it is still that session. A second Stop finds nothing to stop. `stop_microphone` during a live session does the same. The native timer ends a live session whose microphone start is no longer starting or listening, for example after a refused permission or a device failure; it reads the microphone state without waiting. `end_demo` during a live session ends it at once and cancels the worker before joining its runner, so queued audio is discarded. A replacement engine continues session numbering from the one it replaces, so late lines from a live session are refused by the next session. A live session cannot be paused, and `export_preview` refuses it, so its transcript is never written out. `live_status` reports whether the build includes the feature and whether the model file exists. The model path is `TALKQTE_WHISPER_MODEL` (a developer file, not checksum-checked) or `models/ggml-tiny.en.bin` in the app data folder, which is checked against its pinned SHA-256 before loading. `src-tauri/src/model.rs` downloads that file only on an explicit `download_model` command from the main window, through a `Fetch` interface so tests never use the network; the HTTPS client is compiled only with `local-whisper`. Progress goes to the main window as `model:changed`, and `cancel_model_download` and `remove_model` complete the controls. The cue snapshot carries a `live` flag so the companion can label the session. Tests run the session with synthetic audio and a scripted recognizer; real-hardware checks are pending.

The macOS bundle includes `NSMicrophoneUsageDescription`; the audio-input entitlement is configured in `Entitlements.plist` and is embedded when signing. For a local bundle check, use `APPLE_SIGNING_IDENTITY=- npm run tauri -- build --debug --bundles app` to ad-hoc sign with the configured entitlement. An unsigned development build is not evidence that entitlements were applied. Inspect the built bundle and signature without invoking microphone start automatically. Ad-hoc signing is not Developer ID signing or notarization.

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
- AI cue reasoning is a separate planned evaluator behind a narrow interface. Rust retains lifecycle and permission control; the model returns bounded decisions with source references. No production runtime is selected. Whisper transcribes speech and does not provide cue reasoning. See [cue intelligence](cue-intelligence.md).

## Future integration boundary

Granola and other note-taking apps are future sources of selected meeting context and destinations for user-approved exports. Keep provider-specific authentication and data mapping in separate adapters, using supported file exports or documented APIs. Verify each provider's access, plan, and data availability before committing to an integration.

Imported notes should use the planned Rust-owned selection, persistence, retention, and prompt-context boundaries. Preserve source identity and distinguish imported content from user edits so repeated imports can be reconciled explicitly. External content is meeting data, not permission to execute commands or send data elsewhere.

Start with one-way import/export. Live transcript access and two-way synchronization require separate capability checks and conflict/deletion rules. Connections remain optional; an unavailable provider must not block local capture or notes. No integration is implemented yet.

## Next native spike and acceptance criteria

1. Capture both sides of a synthetic call with headphones, with clear microphone/system permissions.
2. Stop and pause promptly; test device disconnect and permission denial.
3. Measure transcription latency and resource use on the target Mac while the meeting app runs.
4. Show and dismiss one prompt without stealing keyboard focus. Check Spaces, full-screen meeting windows, and screen sharing separately.
5. Run without network access after model installation. Verify that no audio or transcript appears in logs, temporary files, or the repository.

Investigate macOS ScreenCaptureKit/Core Audio through maintained native bindings. A small platform bridge remains an option if required. Select the concrete binding after this spike; do not promise system-audio support based on microphone capture alone.

## References

- [Tauri introduction](https://v2.tauri.app/start/)
- [Tauri process model](https://v2.tauri.app/concept/process-model/)
- [Tauri window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)
- [Tauri macOS bundle configuration](https://v2.tauri.app/distribute/macos-application-bundle/)
- [CPAL input-stream API](https://docs.rs/cpal/0.18.2/cpal/)
- [Apple microphone authorization](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media)
- [ScreenCaptureKit Rust bindings](https://docs.rs/screencapturekit/latest/screencapturekit/)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
