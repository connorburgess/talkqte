# Notebook states and limits

The idle Notebook emphasizes **Start live session** when live status reports the chosen providers available. It leaves working notes editable, moves **Export** beside Notes and Transcript, and keeps **This meeting** and **Prior context** accessible as optional disclosures. The smaller idle editor grows back to its usual size for a running or ended session. On narrow screens, idle notes precede the cue explanation; running cues retain their existing priority.

The idle cue explanation names the configured cue provider when live status supplies one. It describes a possible source-backed cue, not guaranteed useful output. An unavailable build or configuration keeps its reason visible and points to Settings. Phrase-based rules still exist alongside model cues; a ready own-key session is not described as a phrase-rules-only build.

Starting still immediately enables the capture and provider sending disclosed beside Start. The active microphone/source controls, Cancel start, Stop, cue-processing review, and recovery errors retain their behavior. Export remains disabled until a live session finishes. No new context retrieval, provider request, approval, or data-sharing scope is introduced. Optional navigation callbacks let prior-context availability guidance open the existing Meetings or Settings view.

Working notes are an editable in-memory copy, not a continuously saved document. By default, stopping a non-empty live meeting saves it locally; Settings can change that default. Already kept meetings remain until deleted, while exports and backups have separate lifecycles. Editing the working copy after Stop does not mean an existing kept meeting has been updated: use its explicit save/update control. Storage remains unencrypted. The Notebook footer describes retention without implying that transcription and cue processing stay on-device. See [meeting history](meeting-history.md), [meeting notes](meeting-notes.md), and [privacy](../PRIVACY.md).

## Acceptance and remaining work

Fictional browser checks cover ready, unavailable, preparing, running, paused, stopping, failure/retry, and ended states; keyboard controls, editable notes/export review, and narrow layouts remain part of that journey. [Direction C specimens](brand/notebook-ready.html) show these states using shared tokens and app styles. They are static illustrations, not a running capture implementation.

Browser stand-ins do not establish native capture, key-store access, webview accessibility, successful real provider calls, or live cue usefulness. The next readiness blocker is the complete native start → useful cue → Stop/recovery → saved-meeting journey. Acceptance requires synthetic native calls on supported platforms with provider disclosures, focus, release of capture, and saved content checked explicitly; live cue usefulness needs a separate, consented evaluation.
