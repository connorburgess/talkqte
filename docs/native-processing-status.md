# Native processing status

This read-only contract supports dependable control of future evaluated cues. `processing_snapshot` and `processing:changed` provide the main window with native status; the companion receives neither the command permission nor the event. The normal app still registers no evaluator and does not mount the proposed processing controls. No provider or capture is activated by reading status.

## Authority and data boundary

A trusted Rust processor configuration now requires a bounded display name and data-policy description. Destination comes from its registered processing location. These strings are part of the immutable configuration bound to review/approval; the webview cannot supply or change them. A description reports the registered adapter's declared policy, not independent verification of its retention or privacy behavior. No production adapter is selected.

Snapshots contain processor metadata, available prior-note titles/dates/provider/ID/revision, exact approved conversation/source scope, processing phase, capture state and bounded issue/decision labels. They contain no transcript, speaker, manual notes, focus, name, note excerpts, raw worker errors or private configuration keys. Normal engines report no processor, no approval and no evaluated quiet result.

Runtime owns the latest snapshot and its monotonically increasing revision across engine replacement. A separate scope revision changes with engine identity, session, permission, pause/Stop, or the complete available-note fingerprint, including content changed with a reused source revision. Unrelated imports do not widen an existing grant. Reordering the same notes and editing manual notebook text do not change scope. Fingerprints are computed when context changes, rather than repeatedly hashing excerpts on clock polls. There is no event history or added persistence.

Changed approved sources revoke permission and remain explicitly unavailable with `scopeChanged` until an explicit reset or new approval. A validated quiet decision differs from an idle or pending worker and from input/worker failure; absence of a cue alone is never reported as quiet. Unchanged status produces no new event. Status reads do not advance the engine or dispatch evaluations.

## Capture and finishing a session

Capture is observed independently from the microphone adapter through a nonblocking snapshot. It reports `unknown`, `starting`, `running`, `stopping` or confirmed `off`. A busy/unavailable controller lock remains unknown. An error whose native cleanup is pending remains stopping; only completed cleanup confirms off. Ending the engine does not prove that an independently running microphone stopped.

The processing phase can remain `stopping` while queued transcription finishes after microphone release. This prevents the UI from offering a new review during drain. The test-mounted controls keep Stop available during startup or unknown capture and distinguish “Finishing session” from “Microphone is off.” The normal notebook's Cancel-during-model-loading interaction is still unfinished.

## Acceptance and remaining dependency

Eight new fictional Rust tests cover disclosure bounds/destinations, no implicit adapter, metadata-only serialization, exact provider-separated approved scope, monotonic revisions across source changes and replacement, persistent source failure, pause/Stop/drain and quiet versus failure. The existing blocked-device test additionally checks that status reads do not wait on the microphone lock. The complete Rust suite has 282 passing tests. Twenty-one headless Chromium processing checks cover the proposed UI, including the two new capture states; the screenshots in [control acceptance](processing-controls.md) are fictional fixtures, not a running provider.

Review preparation, approval/cancellation and scoped Pause/Resume/Disable now have [native command acceptance](native-processing-commands.md). The next gate is capture Stop bound to its originating session/capture generation, without letting unrelated source changes prevent stopping. Preserve independent microphone Stop and account for its state even outside a live transcription session. Only then mount the controls and review a concrete adapter for any separately authorized trial.

Real-device capture/Stop, native accessibility, Granola account import, signed installation, resource budgets on supported hardware, and useful participation with preserved listening remain separate acceptance gates. Headless success and a developer bundle do not establish them.
