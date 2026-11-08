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

Export preparation stores a Markdown snapshot in Rust. The subsequent native save dialog writes that exact snapshot, not a new version assembled after the user reviews it. The frontend cannot supply an arbitrary filesystem destination to the export command.

The browser preview uses `src/lib/preview.ts`, a development-only simulation. Its UI tests complement the Rust engine tests; they do not test Rust IPC, native dialogs, or native windows. There is currently no capture adapter, inference worker, database, or integration adapter.

### Planned meeting pipeline

```text
Native capture adapters
        |
bounded audio buffers
        |
Whisper worker -> transcript segments -> prompt rules -> question lifecycle
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
- Any future language model is a separate optional component. Whisper alone does not supply semantic understanding or summaries.

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
- [ScreenCaptureKit Rust bindings](https://docs.rs/screencapturekit/latest/screencapturekit/)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
