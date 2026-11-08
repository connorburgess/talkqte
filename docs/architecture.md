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

The browser preview uses `src/lib/preview.ts`, a development-only simulation. Its UI tests complement the Rust engine tests; they do not test Rust IPC, native dialogs, or native windows. There is currently no full meeting-audio pipeline, inference worker, database, or integration adapter.

The engine exposes one transcript input boundary for a future transcription worker: `Engine::ingest(session, segment)`. A worker records `Engine::session()` when it starts and attaches that value to each segment. Ending or replaying issues a new session, so late work for an earlier session is rejected. Input is accepted only while the session is running, at or before the current elapsed time, in order, with a unique short ID, a speaker label up to 80 characters, and 1–1,000 characters of text. Rejected input leaves state unchanged. Times are on the engine's session clock, which advances on native ticks and stops while paused. A worker must convert audio timestamps to that clock, or its segments will be rejected as coming from the future. IDs must not reuse a bundled demo ID. Accepted segments use the same cue, answer, and stale-cue rules as the demo. The in-memory transcript keeps the latest 400 segments; duplicate IDs are detected only within those. Once a session has supplied lines, the Markdown export stops labelling its transcript as fictional demo content. `src-tauri/src/transcription.rs` provides the worker that will call it. It is created for one session ID, and its capture side hands over 16 kHz mono chunks with a non-blocking `submit`. A full queue, a stopped worker, or a chunk over 30 seconds drops the audio and counts it; it never blocks the caller. A replaceable `Transcriber` runs on the worker thread, and each recognized line goes to the engine through `ingest`. Stopping discards queued chunks and the results of a call in progress. A recognizer error skips one chunk. Segments the engine refuses, for example after End, are counted and change nothing. The worker keeps no audio. No recognizer is connected yet, and the app neither starts a worker nor routes microphone activity to one; tests use a scripted recognizer.

The optional [Claude cue lab](claude-cue-lab.md) is a separate Node development script, not an application inference worker. It sends one bundled fictional case through the official subscription-authenticated CLI, checks the returned decision and source IDs, and prints a report. It cannot mutate Rust cue state, receive captured audio, or supply live app prompts. A later app integration still requires a Rust-owned worker, validated source/version boundaries, resource budgets, cancellation, and an explicit processing decision.

### Microphone activity on macOS

`src-tauri/src/microphone.rs` owns a separate, default-off microphone monitor. Only the main window can invoke `start_microphone`; the main and companion windows can invoke `microphone_snapshot` and `stop_microphone`. The `microphone:changed` event contains only a revision, status (`off`, `starting`, `listening`, `stopping`, or `error`), a `canStart` flag, coarse activity (`quiet` or `active`), and an optional public error message. `canStart` is true only when monitoring is off or a failed stream has finished cleanup; cleanup completion emits a newer revision so the UI can enable retry. Consumers must ignore older revisions. No samples, device names, or precise levels are sent to webviews.

The native adapter checks AVFoundation microphone authorization and requests permission only after the explicit start command. Once authorized, a worker creates a CPAL input stream for the current default microphone in its native format. Status remains `starting` until samples arrive. Cancelling a pending start invalidates its generation, so a late permission result cannot restart monitoring. Microphone commands await controller work on blocking workers; native window/timer reads skip busy state instead of waiting behind device startup. App exit schedules cleanup without blocking the event loop. Once stop is accepted, `stopping` remains visible until teardown completes, then an event reports `off`. New starts are rejected during teardown, including cleanup after an error; errors require an explicit retry. There is no automatic device switching or automatic restart.

The audio callback inspects at most 4,096 samples per buffer and writes only atomic activity, buffer-count, and failure summaries. It does not allocate an audio buffer, lock application state, emit events, log, write files, or retain samples. A native poll reads those summaries every 200 ms, holds the activity indicator briefly to avoid flicker, and requests capture cleanup on a stream error or after three seconds without callbacks. Native stream destruction runs on a blocking worker after publishing the error, so a slow device cannot hold up the demo timer or companion updates. This level threshold detects signal activity, not speech, speakers, or meeting participation.

Microphone monitoring is independent of fictional demo playback; pausing or ending the demo does not stop the microphone. It does not capture system output, other apps' audio, or both sides of a call. It does not transcribe, record, retain audio, use a model, or send audio over the network. The browser preview does not request microphone permission. Synthetic tests cover signal, lifecycle, and deliberately blocked stream teardown behavior without opening a real device; permission prompts, device changes, and real-device operation still need opt-in native verification.

The notebook exposes explicit Start microphone and Stop microphone controls separately from the demo. The compact companion remains available during microphone starting, activity, stopping, and errors even when no demo is running. Its Stop mic action takes priority over demo playback controls. Hide only hides the window; it does not stop monitoring. Question cards and exported transcripts remain labeled as fictional demo content, independent of microphone input. Frontend tests use a test-only mocked IPC entry point; the browser preview itself never simulates microphone activity.

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
