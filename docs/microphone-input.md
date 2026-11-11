# Microphone input visibility

Development checkpoint, 11 November 2026. This responds to the owner's request to identify the microphone while checking capture. It supports an explicit, understandable input choice for the live companion; it does not establish useful cues or meeting comprehension.

## Smallest flow

After **Start microphone** or **Start live session**, the notebook and Settings show **Input: [name]** once the native stream has opened. The name belongs to that opened input, not a periodically refreshed macOS default or a list of connected devices. Permission pending has no invented device name. A missing/blank name does not prevent capture; a listening stream instead says **Input: name unavailable**.

**Change microphone** expands instructions beside status. Stop capture and wait for **Off** (or for Start to become available after an error), choose the desired input in macOS **System Settings → Sound → Input**, then explicitly start again. TalkQTE opens the default input on each start. There is no in-app device picker, enumeration, hot switching or automatic restart. Changing the system default during capture is not the supported switching flow.

**Stop** stays exposed outside the disclosure. While teardown is pending the name says **Releasing input**; Off or an error clears the label. The error still describes the capture problem, and retry remains unavailable until cleanup completes. A source label is not proof of signal, speech, connectivity after a disconnect, or release; status and signal activity remain separate.

## Native boundary and data

The existing macOS adapter reads the description of the same CPAL device used to build the stream, after explicit start and permission. A cached name travels through the existing revision-ordered microphone snapshot. There is no hardware query, event or allocation added to the audio callback. The controller strips control/direction-override characters and bounds the display name to 120 characters. It does not publish a late cancelled start's label.

The name is local, in-memory display metadata. It is not added to notes, transcripts, exports, logs or model/provider input. No device identifier or connected-device inventory is exposed. Both local webviews receive the snapshot; the notebook and Settings render the name. The companion retains its compact status/Stop controls. [Privacy behavior](../PRIVACY.md) and [capture architecture](architecture.md#microphone-activity-on-macos) describe the boundary.

## UI/UX checkpoint

The task is to identify the opened input and find the switching steps without obscuring Stop or adding another permanent setup panel. The experience risk is mistaking a connection label or stale name for an active source, or changing input before release.

| Before | After |
| --- | --- |
| ![Fictional microphone status with no input name](assets/microphone-input-before.png) | ![The same fictional state with its input name and collapsed switching instructions](assets/microphone-input-after.png) |

The before rendering uses the merged notebook implementation at `6c314db`; the after uses this change. Both are browser-rendered synthetic IPC, not hardware observations. The name is fictional. The owner’s desktop screenshot and device identity are not used.

![Narrow layout with a fictional long device name and expanded switching instructions](assets/microphone-input-narrow.png)

Accepted for this bounded implementation: the green/cream palette and existing controls remain; a 390-pixel view wraps the long name and instructions with reachable Stop. Keyboard activation opens/closes the instructions without starting or stopping capture. Native VoiceOver, real device labels and owner usability acceptance remain pending.

## Acceptance evidence and remaining dependency

- Rust microphone checks cover named-stream release, permission/start failures, stalled/error cleanup, cancellation and bounded/unknown labels with fake streams. All 298 default-feature Rust tests pass locally; no real microphone is opened by these checks.
- All 58 targeted Chromium/WebKit checks pass locally and cover initial unknown state, pending permission, ordered device labels, stale updates after Stop, a different label on explicit restart, failure/cleanup, unknown and long names, keyboard disclosure, Settings during a live-session fixture and independent Stop. These mocks exercise the actual React controls, not Tauri IPC or macOS devices.
- Frontend build, formatting, contribution-metadata tests and Clippy with warnings denied pass. These do not establish native device behavior or a production release.

The next acceptance check is a rebuilt native app on a named Mac/OS and input route: compare the displayed name with the chosen input, confirm signal/quiet and release, select another default only after Stop, restart and observe the new label. Disconnect the external input and record the exact message, any fallback, cleanup and reconnect/restart behavior. Repeat the live-transcription path separately in a `local-whisper` build; the default-feature activity-monitor report below does not cover it. Check native keyboard/VoiceOver alongside the visible Stop control.

The [owner's earlier report](native-validation.md#owner-reported-microphone-acceptance--11-november-2026) applies to `4d647e7`, before this UI. No new capture or inference was performed for this change. Unavailable native desktop control prevents the follow-up here; it is not a confirmed TalkQTE defect. The broad capture, companion/Spaces/sharing, provider, signed-delivery and participation/listening gates remain open. Claude remains in the isolated lab.
