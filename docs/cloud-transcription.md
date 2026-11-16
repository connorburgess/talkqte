# Cloud transcription (development builds)

A development build with the `cloud-transcription` Cargo feature can send a
live session's audio to Deepgram for transcription instead of transcribing it
on the device. The `lab-evaluator` feature switches it on. Release builds
refuse the feature ([release preflight](release-path.md)), and the settings
below are read only in debug builds, so an ordinary or release build has no
cloud transcription. Deepgram is the only provider implemented; the
`StreamingTranscriber` boundary in `src-tauri/src/transcription/cloud.rs`
leaves room for others.

This page describes what the code does. No session has been run against the
real service with this code; the evidence is the offline tests listed at the
end.

## Selecting it

The developer selects it per launch, before the app starts:

| Setting | Meaning |
| --- | --- |
| `TALKQTE_DEV_STT_BACKEND=deepgram` | Use Deepgram for every live session of this launch, microphone and application audio alike. Nothing else is accepted. |
| `TALKQTE_DEV_STT_TOKEN_FILE` | Absolute path of a file holding a short-lived Deepgram access token. The file must be a regular file (not a symlink), mode `0600`, owned by the user running the app, at most 4 KiB, in a directory of mode `0700` owned by that user. |
| `TALKQTE_DEV_STT_MINUTE_CAP` | Most minutes of audio one stream may send, from 1 to 60. |

Only the token reaches the app. The Deepgram API key stays in the owner's
own file; the lab launcher uses it to mint a token (Deepgram's
`/v1/auth/grant`, with a lifetime set by the launcher) and writes that token
into the run folder. The app never logs the token and never passes it on a
command line. The token is read when a stream opens, so it must still be
valid then.

With the backend selected, unusable settings refuse the start of a live
session ("The cloud transcription settings are not usable."). Nothing falls
back to the local recognizer.

## When audio is sent

Nothing is sent until the session's cue processing review is approved
(**Enable for this session**). The review text names Deepgram, what is sent
and the minute cap. Until then the session captures audio and throws it away:
it is not queued for later, and nothing is transcribed. The notebook says
"transcribed by Deepgram once cue processing is enabled", and the companion
says "not transcribing yet".

After approval, each capture source opens one WebSocket stream to
`wss://api.deepgram.com/v1/listen` and sends:

- the source's audio as 16 kHz mono 16-bit PCM in 100 ms frames;
- `KeepAlive` messages during gaps, `Finalize` when a result has stayed
  unfinished for 6 seconds, and `CloseStream` at the end.

The request asks for `model=nova-3`, English, interim results, punctuation,
speaker labels, 300 ms endpointing, utterance-end events and voice-activity
events. Every request carries `mip_opt_out=true`, which opts out of Deepgram's
Model Improvement Program; the request builder refuses a URL without exactly
one such parameter, and a test checks it on the request actually sent. The
token is sent in the `Authorization` header. Notes, names, focus lines,
meeting titles and the transcript are not sent to Deepgram.

Only final results become transcript lines. Interim results are dropped.
Deepgram's speaker label is untrusted: it is never shown or sent to a cue
model, and only the timing log records it.

## What stops it

| Event | What happens |
| --- | --- |
| **Stop live session**, microphone session | The audio already captured is sent, the stream is closed, and the app waits up to 10 seconds for the last results. |
| **Stop live session**, application-audio session | The stream is closed at once. Queued audio is discarded. |
| End, quit, or a source that is not attached | The stream is closed at once. Queued audio is discarded. |
| The review is turned off (**Disable processing**, **Off**, or anything else that withdraws it) | Sending stops at once and the stream is closed. The session ends with "cue processing was turned off, so audio stopped being sent". Approving again does not reopen the stream for that session. |
| Pause cues | Cues stop, the review still holds, and audio is still transcribed. The companion says "Mic still on · audio to Deepgram". |
| The minute cap is reached | The stream is closed and the session ends ("this run's transcription minute limit was reached"). |
| Deepgram refuses the token (401 or 403), the account cannot pay (402), or requests are limited (429) | The session ends with a fixed reason. There is no retry. |
| The connection drops or a reply cannot be read | The session ends with a fixed reason. |

In every case the notebook shows "Transcription by Deepgram stopped: …
nothing fell back to another transcription service." No provider message
reaches the interface or a log; only fixed codes do.

## What is kept

TalkQTE writes no audio and no token to disk. The transcript stays in memory
as for any live session. A `timing-log` build also writes `stt_state` rows
(started, finished, ended or stopped, with a fixed code and the audio sent so
far) and `stt_final` rows (line number, times, and the untrusted speaker
label); recognized text is in the existing `segment` rows. Deepgram
handles the audio under the key holder's Deepgram terms. TalkQTE cannot
recall audio once it is sent.

## Latency and the cue window

A cue is raised only from a line spoken less than 18 seconds earlier
(`CUE_MS`), and a lab model request has an 8 second deadline. A long
utterance with no pause long enough for endpointing gets its final only when
the app sends `Finalize`, 6 seconds after the first interim result, plus the
round trip. That puts the line about 7 to 8 seconds behind its start. A model
request at its 8 second deadline then lands 15 to 16 seconds after the line
began, leaving 2 to 3 seconds of the 18 second window. Anything slower than
that misses the window, and the cue is not shown. A benchmark of fictional
audio through the same Deepgram settings measured a median final delay of
0.65 to 0.8 seconds and a maximum of about 10 seconds. That maximum, with the
full 8 second deadline, would miss the window. Latency on real hardware with
this code has not been measured.

## Evidence

Offline tests with a fake socket and scripted streams only:

- `transcription::deepgram` tests: the opt-out parameter on the request sent,
  framing, finals only, refusals, the cap, `Finalize` and `KeepAlive`, and a
  lost connection.
- `transcription::cloud` tests: nothing sent before approval, finals on the
  capture clock with no speaker label, failure without fallback, withdrawal,
  the last audio sent during Stop but no stream opened by it, the settings,
  and the token file rules.
- `live` and `native_source` tests: both capture paths deliver finals, and an
  unapproved session never opens a stream.
- Browser tests: the companion and notebook wording, and the stop message.

Still unverified: a session against the real service, latency on real
hardware, behaviour with an expired token, and native microphone and
application-audio acceptance.
