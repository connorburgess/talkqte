# Cloud transcription

TalkQTE transcribes live sessions only through Deepgram's streaming service.
On-device transcription was removed on 16 November 2026. Deepgram streaming
is compiled into every build and uses the person's own Deepgram API key from
the Keychain ([provider keys](provider-keys.md)). A debug build with the
development `cloud-transcription` feature (which `lab-evaluator` switches on)
can instead point a launch at a short-lived token file, as the lab does.

Transcription starts only when the session's cue processing review is
approved, so a build also needs a cue connection: the person's own Anthropic
key ([cue decisions](own-key-cues.md)), or in development `claude-cli` or the
lab evaluator. Without one a start is refused with "Add your Anthropic API
key in Settings to start a live session."
Deepgram is the only provider implemented; the `StreamingTranscriber`
boundary in `src-tauri/src/transcription/cloud.rs` leaves room for others.

This page describes what the code does. No session has been run against the
real service with this code; the evidence is the offline tests listed at the
end.

## Selecting it

**The person's own key.** With a Deepgram key stored and no development
selection, every live session uses it. The key is read from the Keychain on
the stream's own thread when the stream opens, after approval, and is sent
once in the handshake as `Authorization: Token …`; replacement streams after
a connection failure read it again. Each stream attempt reads the Keychain
once: a missing key, or a Keychain that refuses, is not asked again while the
stream waits, and the stream stops with `settings`. A session may send at
most 120 minutes of audio (`OWN_KEY_MINUTE_CAP`), across its reconnects;
Deepgram bills the person's account for it. The budget is made once per live
start, after the start gate is taken, and handed to that session's stream and
its replacements only, so another start cannot replace or reuse it. An
application started into a microphone session (both sides of a call) opens its
own stream, but spends that session's budget: the 120 minutes are counted
across both streams, so two streams at once use them twice as fast, as
Deepgram bills each stream. From ten minutes of meeting left (counting both
streams when both are heard) the notebook says how many minutes remain before
the session ends on the cap; it is read out once, when it first appears. A
session for an application alone has no such notice yet; it has a budget
of its own, being a session of its own. The caps are per session only: there is
no per-launch or per-day cap with the person's key. A 401 or 403 marks the key rejected, so Settings
says so and the next start is refused with "Deepgram rejected your API key.
Replace it in Settings to start a live session." Without a key, a start is
refused with "Add your Deepgram API key in Settings to start a live
session."

**A development token file.** The developer selects it per launch, before the
app starts, in a debug build with the `cloud-transcription` feature. It wins
over a stored key, and invalid settings are refused rather than falling back
to the key:

| Setting | Meaning |
| --- | --- |
| `TALKQTE_DEV_STT_BACKEND=deepgram` | Use Deepgram for every live session of this launch, microphone and application audio alike. Nothing else is accepted. |
| `TALKQTE_DEV_STT_TOKEN_FILE` | Absolute path of a file holding a short-lived Deepgram access token. The file must be a regular file (not a symlink), mode `0600`, owned by the user running the app, at most 4 KiB, in a directory of mode `0700` owned by that user. |
| `TALKQTE_DEV_STT_MINUTE_CAP` | Most minutes of audio this launch may send, across all its sessions and both capture sources, from 1 to 60. |
| `TALKQTE_DEV_STT_LANGUAGE` | Optional. Absent or `en` for English, `multi` for Multilingual ([language](#language)). Anything else is refused. |

With this selection only the token reaches the app. The Deepgram API key
stays in the owner's own file; the lab launcher uses it to mint a token
(Deepgram's `/v1/auth/grant`, with a lifetime set by the launcher) and writes
that token into the run folder. The token is sent as `Authorization: Bearer
…`. The app never logs a key or token and never passes one on a command line.
The token is read when a stream opens, so it must still be valid then.

With the backend selected, unusable settings refuse the start of a live
session ("The cloud transcription settings are not usable."). There is no
other recognizer to fall back to.

## When audio is sent

Nothing is sent until the person approves the session's cue processing review
in the app (**Enable for this session**). A launch setting never opens the
stream: `TALKQTE_DEV_MODEL_CONNECTION=on` fails closed whenever cloud
transcription is selected, whatever the cue backend, and even a grant made by a
launch setting is not accepted for audio. The review lists Deepgram under
**Audio**, beside the cue destination, and its text says what is sent, the
opt-out request and the launch's minute cap. Until approval the session
captures audio and throws it away: it is not queued for later, and nothing is
transcribed. Audio captured before the approval is never sent, even when it
reaches the stream after it; the first audio sent starts at the approval's
time on the session clock. The notebook says "transcribed by Deepgram once cue
processing is enabled", and the companion says "not transcribing yet".

With a development selection, the token file's presence and permissions are checked, without reading the
token, when Settings checks readiness and when a session starts, so a bad
setup is refused before anyone is asked to approve. The token itself is read
on the stream's own thread after approval. The file may still be an empty
placeholder then: the lab launcher writes the token only after it has seen
the review, by renaming a new file over the placeholder. The stream looks for
a valid token every 50 ms for up to 10 seconds after approval, keeping the
audio captured since approval in its bounded queue, and stops with `settings`
if none arrives. The queue holds 128 pushes. For the microphone, which pushes
100 ms chunks, that is 12.8 seconds, more than the wait. Application audio is
pushed as it arrives from the system, in smaller blocks, so the queue holds
less of it, possibly less than the 10 second wait. Audio that does not fit is
dropped and reported, as described under [what stops it](#what-stops-it).
Because more than a second of audio dropped within 5 seconds counts as a
stalled connection, an application-audio session whose token arrives late in
the wait can end as `stalled` rather than wait it out.

After approval, each capture source opens one WebSocket stream to
`wss://api.deepgram.com/v1/listen` and sends:

- the source's audio as 16 kHz mono 16-bit PCM in 100 ms frames;
- `KeepAlive` messages during gaps, `Finalize` when a result has stayed
  unfinished for 6 seconds, and `CloseStream` at the end.

The request asks for `model=nova-3`, the session's language (below),
interim results, punctuation, speaker labels, endpointing, utterance-end
events and voice-activity events.

### Language

Deepgram cannot detect a language on a live stream (`detect_language` is for
recorded audio only, per its
[language detection](https://developers.deepgram.com/docs/language-detection)
page), so the app cannot start in English and switch by itself. **Settings →
Transcription language** offers two exact requests:

| Choice | Query |
| --- | --- |
| **English** (default) | `model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&diarize=true&endpointing=300&utterance_end_ms=1000&vad_events=true&mip_opt_out=true` |
| **Multilingual** | `model=nova-3&language=multi&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&diarize=true&endpointing=100&utterance_end_ms=1000&vad_events=true&mip_opt_out=true` |

Multilingual is Deepgram's code-switching mode for Nova-3: several languages,
following switches within one stream
([multilingual code-switching](https://developers.deepgram.com/docs/multilingual-code-switching)).
It uses the 100 ms endpointing that page recommends; nothing else differs.
Deepgram bills it at a higher rate than English
([pricing](https://deepgram.com/pricing)); the review says so and states no
price.

- The choice applies to the next live session. A session's streams and
  reconnects keep the language they started with, and the setting cannot be
  changed while a session is starting, running or finishing ("Change the
  transcription language when no live session is running."), so the review
  and the stream always name the same one.
- The session review names it: "Deepgram (US, model Nova-3, English)" or
  "Deepgram (US, model Nova-3, Multilingual, which Deepgram bills at a higher
  rate than English)".
- Like the other settings it is kept for the app run and is English again
  after the app restarts; nothing is written to disk.
- The fixed phrase-rule questions (an owner, a date, a choice, a date said)
  match English words only, so lines in other languages raise none of them.
  The "Asked you" rule needs only the person's name opening a sentence that
  ends in a question mark, so a question put to them by name raises it in any
  language and quotes the line as said; its other English question openers
  do not apply. Model cues work on whatever the model understands.
- A development launch with a token file takes its language from
  `TALKQTE_DEV_STT_LANGUAGE` instead (absent or `en`: English; `multi`:
  Multilingual; anything else refuses the start). A lab plan keeps English
  unless its `transcription.language` is `multi`; the lab's evidence accepts
  exactly these two queries and checks that the one used matches the plan. Every request carries `mip_opt_out=true`, which asks Deepgram to opt
out of its Model Improvement Program; what Deepgram keeps is set by its
[terms](https://deepgram.com/terms). The request builder refuses a URL without
exactly one such parameter, and a test checks it on the request a fake
connector received. No request has reached Deepgram from this code yet: the
first live run's evidence must record the URL parameters actually sent,
without the token. The
token is sent in the `Authorization` header. Notes, names, focus lines,
meeting titles and the transcript are not sent to Deepgram.

Only final results become transcript lines. Interim results are dropped.
Deepgram's speaker label is untrusted: it is never shown or sent to a cue
model, and only the timing log records it.

**What the review says.** The review's Deepgram sentence names exactly the
session's capture sources, fixed when the session starts: "the live audio
from your microphone"; "the live audio of *App* (audio from all of its
windows may be included), not your microphone"; or, for both, "the live audio
from your microphone and, as a second stream, from *App* (audio from all of its
windows may be included)", with the cap "counted across both streams". One
approval covers both streams; turning processing off or Stop ends both. An
application can join only a session started with it, and only that exact
reviewed selection (its listing identity and bundle identifier, never a
name), once: after it ends, the session takes no other application. An
approval therefore never covers a source it did not name. With the person's
key a joining application must spend the session's budget; without it the
application is refused rather than given a fresh cap.

**Both sides of a call.** In a session with both sources, lines are labelled
by where they were heard: **You** for the microphone, **Them** for the
application. The labels are not speaker identity (several people can be on
either side) and they stay on the Mac: the cue model still receives the
fixed label "Speaker". A kept meeting writes them, with a sentence saying so.
When the microphone also hears the application through the speakers, the same
words arrive twice. A microphone line is treated as a likely echo only when it
is a close copy of one application line timed within 4 seconds: at least six
words, the shorter line at least 70% of the longer, and the longest run of the
same words in the same order at least 85% of the longer line
(`engine/sources.rs`). Lines are compared one at a time, never pooled, so
replies such as "I don't know", "yes I agree" or a repeated figure are kept.
A likely echo is never silent: it stays in the transcript, marked "Likely an
echo of Them · not used for cues", with **It was me** and **Remove**, and is
kept in the meeting marked "You (likely an echo of Them)" unless the person
removes it. It is never sent to a cue model, even after **It was me**. The
guard cannot catch a microphone copy that arrives before the application's
line, short copies, copies Deepgram recognises very differently, or copies
split across lines; headphones avoid the problem. If the application's stream fails, or the application stops or
never starts, the session runs on with the microphone and says "Audio from
*App* stopped. Only your microphone is heard now"; a microphone stream failure
ends the session and its application as before.

## What stops it

| Event | What happens |
| --- | --- |
| **Stop live session**, microphone session | The audio already captured is sent, the stream is closed, and the app waits up to 10 seconds for the last results. |
| **Stop live session**, application-audio session | The stream is closed at once. Queued audio is discarded. |
| **Stop live session**, both sources | The microphone's stream is drained as above; the application's is closed at once. |
| The application's stream fails, in a session with both sources | That stream ends; the microphone's continues. The session says the application stopped and why. |
| End, quit, or a source that is not attached | The stream is closed at once. Queued audio is discarded. |
| The review is turned off (**Disable processing**, **Off**, or anything else that withdraws it) | Sending stops at once, including audio already queued for the socket, and the stream is closed. The session ends with "cue processing was turned off, so audio stopped being sent". Approving again does not reopen the stream for that session. |
| Pause cues, with your own Anthropic key | Cue requests stop and the review still holds, so audio is still sent to Deepgram and billed to your account, and the transcript continues (a kept meeting stays complete). The review, the Pause help in the notebook and the companion ("Mic still on · audio to Deepgram") say so. Turning processing off or Stop ends the audio. |
| Pause cues, with the `claude-cli` backend | Cues stop, the review still holds, and audio is still transcribed. The companion says "Mic still on · audio to Deepgram". |
| Pause cues, or any end of the run, with the lab evaluator | The lab's cue run ends, which ends its approval, so sending stops and the session ends with "the lab run ended, so audio stopped being sent". With the lab evaluator, turning the review off also ends the lab's cue run, so the code there is `lab_ended`, not `withdrawn` (`invalidate_evaluation` in `engine/evaluation.rs`). |
| The minute cap is reached | The stream is closed and the session ends ("the transcription minute limit was reached"). With the person's key the cap is the session's 120 minutes; with a development token file it counts all sessions and both sources of the launch. |
| The send queue is full because the connection fell behind | The audio that does not fit is dropped, not sent later. The session continues, and the notebook says "Some audio was not sent to Deepgram because the connection fell behind; lines from it are missing." |
| Deepgram refuses the key or token (401 or 403), the account cannot pay (402), or requests are limited (429) | The session ends with a fixed reason. There is no retry. |
| Deepgram answers the connection with a server error (5xx) | Treated as an outage on Deepgram's side (code `unavailable`) and replaced like a lost connection; if it cannot be, the session ends with "the service is having a problem on its side". |
| The person's Deepgram key cannot be read from the Keychain when a stream opens (for example after the Mac locked it), or it was removed | The stream stops at once with "your Deepgram key could not be read from the Keychain, or it was removed" (code `key_unavailable`). It is not retried. |
| The connection drops, closes, or a reply cannot be read | The stream is replaced, as described under [reconnecting](#reconnecting). If it cannot be, the session ends with a fixed reason. |
| The connection stops keeping up: no reply of any kind for 10 s while audio is going out (after one `Finalize` at 5 s asking for one), one 100 ms frame taking more than 3 s to send, or more than 1 s of audio dropped for a full send queue within 5 s | The stream is closed (code `stalled`) and replaced, as described under [reconnecting](#reconnecting). If it cannot be, the session ends with "the connection stopped responding". Audio is sent at most a second at a time between reads, so replies and a close are not left unread while audio is backed up, and at most two seconds wait on the socket thread beyond the send queue: audio a slow connection cannot take backs up in the queue, where it is dropped and disclosed, never collected without limit. Any reply counts, including results with no words: in one lab measurement (17 November 2026, 20 s of digital silence, one sample per case) Deepgram sent an empty interim result about every second and an empty final about every 3 s, with no gap over 1.4 s, and answered a `Finalize` in 332 ms. Room noise and other network paths were not measured. |

### Reconnecting

A stream that fails for a network reason (lost, closed, `stalled`, a server
error, or an unreadable reply) is replaced by a new one, under the same approval, the same
session and the same minute budget, at most twice per session for each
capture source. A refused token, a spent budget, rate limiting, a withdrawn
review and the end of a lab run are not retried.

- Speech the failed stream had been sent but had not yet returned as a line is
  lost: it is not sent again. The time between its last line and its last audio
  is recorded as the gap.
- Audio captured after the failure goes to the new stream, so the transcript
  carries on from there. Line numbers continue, so line ids stay unique.
- Only a replacement's confirmed connection reports a successful reconnect;
  starting its worker does not. A pending or refused connection cannot report
  success. Loss across failed pending attempts is included when a later
  replacement connects. A retired approval or Stop cannot publish a late success.
- The notebook says "Transcription by Deepgram reconnected once after a
  connection problem. About N s of speech was not transcribed." A positive
  subsecond gap is described as less than one second; a zero or unavailable
  measurement leaves the amount unknown instead of inventing a one-second loss.
- The timing log writes `stt_state` `reconnecting` with the failure's code and
  `gap_ms`, then `connected` for the new stream.
- The new stream reads the token file again, so the token must still be there.
  For a lab run that means the launcher keeps the short-lived token in the
  owner-only run folder until Stop, rather than deleting it once connected.
  That is a trade: a valid token on disk, in a 0700 folder, for the length of
  the run, in exchange for surviving a network drop.
- A third failure in the same session ends it, as before.

In every case the notebook shows "Transcription by Deepgram stopped: …
nothing fell back to another transcription service." No provider message
reaches the interface or a log; only fixed codes do.

## What is kept

TalkQTE writes no audio, key or token to disk. The transcript stays in memory
as for any live session. A `timing-log` build also writes `stt_state` rows
(started, connected, dropping, finished, ended or stopped, with a fixed code
and the audio sent so far; the connected row also holds the query string of
the URL the connection actually used, which never contains the token) and `stt_final` rows (line number, times, and the untrusted speaker
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
- `transcription::cloud` tests: nothing sent before approval, audio captured
  before the approval never sent however late it arrives, finals on the
  capture clock with no speaker label, failure without fallback, withdrawal,
  the lab run ending as its own reason, the last audio sent during Stop but no
  stream opened by it, a full queue reported once, one budget shared by the
  launch, the settings, and the token file rules.
- `transcription::deepgram` tests also cover queued audio not going out once
  the stream is stopped, two streams sharing the launch's cap, a token handed
  over after approval being waited for with no audio lost, the connected
  event carrying the query used, and a token that never arrives stopping the
  stream with `settings`.
- Engine and launch tests: a launch setting approves nothing when cloud
  transcription is selected and a launch-setting grant never opens audio
  (`dev_model`), and Pause in the lab ends audio with the lab reason
  (`lab_tests`).
- `live` and `native_source` tests: both capture paths deliver finals only,
  Stop sends the last audio, End discards it, a block from another capture
  operation is never sent, and an unapproved session never opens a stream.
- Browser tests: the companion and notebook wording, and the stop message.

- `transcription::cloud` and `transcription::deepgram` tests also cover the
  person's key: a development selection wins over it, a missing or rejected
  key refuses the start, the review names the key, billing and the
  per-session cap, the key is read after approval and sent only as a `Token`
  header on the opt-out URL, a removed key opens no stream, and only a
  refusal of the key (not of a lab token) marks it rejected.

Still unverified: a session against the real service, latency on real
hardware, behaviour with an expired token or a real refused key, and native
microphone and application-audio acceptance.
