# Transcription cost and compatibility evaluation

Evaluated 27 November 2026 against source `a26d6ff9bed0c1555e3fc6540a1d8a1d4a89d908`
and current official documentation. This is a P6 investigation, not an adapter
upgrade, default-provider decision, billing measurement or completed roadmap
item. No credentials, paid requests, native builds or real meetings were used.

The smallest candidate is to stop requesting Deepgram microphone diarization,
which the engine already discards. Evaluate ElevenLabs v3 Live separately: its
speaker events require more than changing a model ID. Existing Deepgram silence
gating means the lower ElevenLabs headline price does not establish a cheaper
meeting in this app.

## Current source and data flow

| Boundary             | Source finding                                                                                                                                                                                                                                                            | Consequence                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deepgram request     | `QUERY_EN` and `QUERY_MULTI` in [deepgram.rs](../src-tauri/src/transcription/deepgram.rs) always contain `diarize=true`; `ListenRequest::for_language` has no source-role argument.                                                                                       | Microphone and application streams request the same paid add-on.                                                                                             |
| Source creation      | [cloud.rs](../src-tauri/src/transcription/cloud.rs) `streams`/`streams_sharing`, called by [lib.rs](../src-tauri/src/lib.rs) and [application_audio_host.rs](../src-tauri/src/application_audio_host.rs), select provider/language and share the session's sample budget. | A second source is a separate mono WebSocket, not a free second input. Reopeners need the same source policy.                                                |
| Speaker admission    | [engine.rs](../src-tauri/src/engine.rs) `ingest_from` clears microphone speaker IDs; application IDs resolve to numbered/custom remote labels. [cloud.rs](../src-tauri/src/transcription/cloud.rs) drops IDs after reconnect.                                             | Paying to diarize the microphone provides no current label benefit. Remote diarization still supports implemented behavior; IDs are not verified identities. |
| Deepgram silence     | [vad.rs](../src-tauri/src/transcription/vad.rs) uses an RMS gate with bounded pre-roll and hangover; [deepgram.rs](../src-tauri/src/transcription/deepgram.rs) sends gated PCM and text KeepAlive messages.                                                               | Cost depends on emitted audio, including tails/noise. Quiet speech can be lost; speech occupancy alone does not predict emitted duration.                    |
| ElevenLabs transport | [elevenlabs.rs](../src-tauri/src/transcription/elevenlabs.rs) pins `scribe_v2_realtime`, VAD commits and timestamps; sends all queued PCM as base64 JSON, including silence.                                                                                              | There is no local ElevenLabs silence gate. Server VAD commits are not client-side audio suppression.                                                         |
| ElevenLabs parser    | `parse` ignores ordinary committed text, emits one final from the timestamp-bearing variant, ignores unknown events, and always sets `untrusted_speaker: None`.                                                                                                           | Changing only the model ID cannot produce speaker labels. The existing duplicate-final protection must survive any upgrade.                                  |

The ordinary own-key cap (`OWN_KEY_MINUTE_CAP`) limits sent audio, shared
across both sources and reconnects, rather than meeting wall time. Local sample
reservation is a safety cap, not an invoice reconciliation. Provider choice,
source disclosure, processing approval, Stop and no-fallback boundaries remain
as described in [cloud transcription](cloud-transcription.md).

## Official rates and billing boundaries

USD, excluding taxes, negotiated terms, credits and unrelated cue/model costs.
Recheck immediately before an authorized paid comparison.

| Streaming transcription              | Published rate           | Equivalent per audio hour |
| ------------------------------------ | ------------------------ | ------------------------- |
| Nova-3 monolingual PAYG              | $0.0048/min, promotional | $0.288                    |
| Nova-3 multilingual PAYG             | $0.0058/min, promotional | $0.348                    |
| Nova-3 speaker diarization PAYG      | additional $0.0020/min   | additional $0.120         |
| Nova-3 English with diarization      | calculated $0.0068/min   | $0.408                    |
| Nova-3 multilingual with diarization | calculated $0.0078/min   | $0.468                    |
| Scribe v2 Realtime or v3 Live        | $0.22/hour               | $0.220                    |

[Deepgram pricing](https://deepgram.com/pricing) identifies the promotional
streaming rates, add-on and per-second billing without normal block rounding;
multichannel billing sums processed channel duration. The crossed-out English
rate is $0.0077/min: do not budget indefinitely against a promotion. The FAQ
answers its combined silence/rounding question with “No” but explains processed
audio duration, without quantifying silence detection. Conservatively count all
transmitted PCM in these estimates; verify silent-audio accounting before
claiming an invoice saving.

The [ElevenLabs 17 November changelog](https://elevenlabs.io/docs/changelog/2026/11/17)
sets realtime at $0.22/audio hour for every Scribe model on self-serve and
Business plans, with Enterprise unchanged. The [current API price page](https://elevenlabs.io/pricing/api)
confirms both realtime models at that rate. This is not $0.22/min, the batch
$0.20/hour rate, or an ElevenAgents conversation price.

[ElevenLabs billing guidance](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)
meters audio sent, including silent seconds. Its [commit/keepalive guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies)
requires continued audio for server keepalives and says the server closes after
15 seconds without client messages. Thus an audio-free Deepgram KeepAlive
strategy cannot simply be copied to ElevenLabs. Keep streaming there until a
separately validated alternative exists. Deepgram's [KeepAlive guide](https://developers.deepgram.com/docs/audio-keep-alive)
permits text keepalives every 3–5 seconds; provider timestamps advance with audio,
not socket wall time, which explains the existing timeline mapping.

No separate ElevenLabs diarization surcharge is specified in the reviewed
realtime reference/pricing table; absence is not a billing receipt. The
[realtime API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
does list premiums for keyterms (20%) and transcript editing (30%, with a
per-commit minimum). Those optional features are outside this proposal.

## Illustrative cost model, not measurements

Let `m` and `r` be **minutes actually sent** by Deepgram's microphone and remote
streams after gating. At the quoted English promotional rates:

```text
current Deepgram      = 0.0068 × (m + r)
mic diarization off   = 0.0048 × m + 0.0068 × r
potential saving      = 0.0020 × m
ElevenLabs base       = 0.22 / 60 × (mic minutes sent + remote minutes sent)
```

These fictional scenarios assume one hour with both sources enabled throughout,
no reconnect replay, and no optional premiums. ElevenLabs sends 60 minutes per
source in the current adapter. Deepgram columns vary emitted duration rather
than pretending both adapters currently send equal audio.

| Deepgram emitted minutes, mic / remote | Current Deepgram | Mic diarization off, proposed | Current ElevenLabs base |
| -------------------------------------- | ---------------- | ----------------------------- | ----------------------- |
| 60 / 60, gate continuously open        | $0.816           | $0.696                        | $0.440                  |
| 15 / 45, illustrative gated case       | $0.408           | $0.378                        | $0.440                  |
| 5 / 10, illustrative quiet case        | $0.102           | $0.092                        | $0.440                  |

An English microphone-only hour with continuous audio would change from $0.408
to $0.288; the remote-only rate stays $0.408. With current requests and two
full-hour ElevenLabs streams, Deepgram's calculated break-even is about 64.71
combined emitted minutes, or 53.92% of the possible 120 source-minutes. This
threshold changes with language, actual gating, promotions and optional features.
None of these rows is an observed saving or accuracy result.

## v2 to v3 Live compatibility

The [model guide](https://elevenlabs.io/docs/overview/models) says v3 Live retains
the v2 Realtime feature set and adds realtime diarization, turn prediction and
multilingual mode. The WebSocket reference accepts `scribe_v3_live` on the same
endpoint with existing PCM/header authentication options. Compatibility on
paper still needs fictional wire tests and then separately approved service
acceptance; the v2 adapter's periodic forced commits may also limit the benefit
of a later turn-prediction experiment.

The [event reference](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference)
distinguishes stable committed text from delayed `diarized_transcript` messages
joined by `segment_index`. Draft labels can change or be null; `speakers_merged`
requires earlier IDs to be reconciled in receive order. The [diarization guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/diarization)
specifies string IDs, unresolved nulls and draft words without timestamps. A
committed segment may contain multiple speakers. Automatic inferred names are
a separate opt-in and must not replace user-entered names implicitly.

Our `SttEvent::Final` admits a single optional numeric speaker per final and has
no segment-revision/merge event. Two bounded upgrade stages are possible:

1. **Text-only compatibility trial:** explicit experimental v3 selection, keep
   current PCM/timestamp/VAD framing and diarization off, validate the selected
   model in the server handshake, and update review/model labels together.
   Preserve v2 as an explicit selection, not automatic fallback. This evaluates
   recognition compatibility without claiming speaker support or changing the
   production default.
2. **Remote speaker support:** separately design bounded segment correlation,
   delayed/null labels, multi-speaker word runs and merge handling. Choose a
   bounded wait/fallback or guarded metadata-update path so delayed labels cannot
   delay cues indefinitely or duplicate transcript text. Preserve microphone
   identity, user renames, reconnect isolation, stable references and Stop guards.
   This is a contract change, not a constant-only upgrade.

The [Deepgram diarization guide](https://developers.deepgram.com/docs/diarization)
now deprecates `diarize` but says it continues to select v1. Streaming supports
`diarize_model=v1` or `latest`, not v2. A compatibility migration should pin v1
separately; do not combine an uncontrolled diarizer upgrade with cost changes.

## Smallest next implementation and acceptance

First propose a validated capture-role argument through `streams`,
`streams_sharing`, `streams_for`, `key_streams`, and `ListenRequest`. Request no
diarization for microphone streams and retain the current remote request,
language, opt-out, endpointing and cap behavior. Carry the role unchanged through
every reopener and development route; do not infer it from stream ordinal because
application-only sessions exist. Keep this separate from v3, local VAD tuning or
a provider-default change.

Required offline acceptance, using fictional fake sockets only:

- Inspect exact English/multilingual requests for microphone-only,
  application-only and paired sessions, including reconnect: no mic add-on,
  unchanged remote add-on, one opt-out and no extra scope/options.
- Feed distinct fictional remote IDs and mic IDs; remote labels persist, mic
  remains You, and reconnect cannot reattach old speaker names.
- Retain shared-budget, approval/withdrawal, Stop and timestamp regressions.
  No stream can open early, outlive its session or receive a fresh reconnect cap.
- For a later v3 trial, cover handshake-model mismatch, duplicate finals,
  delayed/missing/null/out-of-order labels, multi-speaker segments, chained
  merges, user-rename conflicts, reconnect and late replies after Stop. Keep
  inferred names off. Malformed/oversized payloads must stay bounded and fail
  without provider text in diagnostics.

Only after those checks and review: obtain a separate bounded paid-run approval
for synthetic quiet/normal speech, long silence, overlapping remote voices and
Stop/reconnect. Compare emitted PCM seconds, vendor usage/charges, onset loss,
word accuracy, final/cue latency and speaker mistakes on the same material.
Agree thresholds and a hard spend cap before dispatch. Verify language and
retention/account terms separately. Vendor benchmark percentages do not prove
TalkQTE quality, native reliability or participation benefit.

This document is the deliverable. No production request, default, provider
selection, privacy disclosure, README or roadmap checkbox changed. The next
blocker is the reviewed source-role proposal with exact-query offline evidence;
actual savings, v3 compatibility and useful remote labeling remain unverified.
