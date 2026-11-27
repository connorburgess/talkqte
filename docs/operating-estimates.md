# Operating estimates

Status: refreshed 27 November 2026 against merged main `a26d6ff`; historical artifact measurements retain their original dates. It separates what was measured from what is estimated or still unknown. It is planning input for the [product readiness plan](product-readiness.md#production-and-scaling-approach), not a budget or a commitment. Nothing here is a current call to download.

## Measured

Historical artifact measurements only; these are not current release sizes.

| Item                     | Size                            | How it was measured                                                                                                                       |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| App bundle               | 15.3 MiB on disk, 4.7 MB zipped | `npm run tauri -- build --bundles app --features local-whisper`, ad-hoc signed, Apple silicon (arm64) only, compressed with `ditto -c -k` |
| Speech model (`tiny.en`) | 77.7 MB (77,704,715 bytes)      | The pinned file in [model delivery](model-delivery.md); gzip shrinks it only to 70.5 MB, so compressing it for delivery saves little      |

Derived from these: a first download is about 82 MB (4.7 MB app plus 77.7 MB model), and about 94 MB on disk once installed. At the time of that measurement, the model was optional and needed only for live sessions. Local transcription was removed on 16 November 2026, so the model and its bandwidth on this page no longer apply and the first download is the app alone. The app bundle above was measured with the former `local-whisper` feature; a build without it has not been measured for download size.

A debug bundle without the speech feature or a Developer ID signature measured 46.0 MiB (48,270,947 bytes) on 13 November 2026 ([release path](release-path.md#what-the-debug-bundle-contains)); it is a development artifact, not a download size.

A disk image, a universal build that also runs on Intel Macs, and a notarized build were not measured. A universal build carries a second copy of the executable, so expect a larger app download than the arm64 figure.

## Release bandwidth assumptions

There is no speech-model download in the current app. The former 82 MB first-install estimate and model-download scale table are retired, not current delivery forecasts. Current signed/notarized arm64, universal and disk-image sizes need a fresh measurement from the actual release candidate; neither historical bundle above substitutes for it.

For a measured artifact of `A` MB, `N` new installations and `U` full updates per existing installation, delivery is approximately `A × N` MB initially and `A × N × U` MB for those updates, before retries or mirrors. For illustration only, a hypothetical 50 MB artifact delivered to 1,000 people is 50 GB per full rollout (decimal units). This is arithmetic, not a measured package size or hosting bill. GitHub Releases remains the planned distribution path ([release path](release-path.md)); provider terms, current limits and actual traffic must be reviewed before a release or hosting commitment.

## Provider cost assumptions

Prices checked **27 November 2026**, USD before tax, using public first-party API rates. These are planning inputs, not quotes, account access checks or billing receipts. Alpha users pay their chosen transcription and cue providers through their own keys; there is no TalkQTE-run inference server. Free credits, subscription allowances, negotiated discounts, batch discounts, cached tokens, tools, generation of synthetic voices and support are excluded from the examples. Model availability, region/tier and price changes need rechecking before dispatch or release.

### Transcription: count audio duration per stream

Source uses Nova-3 with `diarize=true` and `mip_opt_out=true` ([request contract](../src-tauri/src/transcription/deepgram.rs)). [Deepgram pricing](https://deepgram.com/pricing) currently lists promotional Pay-as-you-go Nova-3 rates of $0.0048/minute monolingual or $0.0058 multilingual, plus $0.0020/minute for diarization. Its [MIP pricing update](https://developers.deepgram.com/changelog/2026/3/5) states opt-out does not change listed rates. Do not budget from the base transcription price alone.

| Assumed Nova-3 configuration | One stream, 60 audio minutes | Two streams, 60 audio minutes each |
| ---------------------------- | ---------------------------: | ---------------------------------: |
| Monolingual + diarization    |                       $0.408 |                             $0.816 |
| Multilingual + diarization   |                       $0.468 |                             $0.936 |

These are derived totals: `sum(stream minutes) × (base rate + diarization rate)`. Microphone and remote audio can be separate streams, so one wall-clock hour can produce 120 billable audio minutes. Silence, overlap, reconnects and Stop's bounded drain can change submitted duration; a speaker talking for half the call does not by itself halve the audio sent. Promotional rates can end; the same page lists regular base rates of $0.0077/$0.0092 per minute, giving $0.582/$0.672 for one hour with diarization before other charges.

The alternate adapter selects `scribe_v2_realtime`, not a batch model. [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) currently lists Scribe v2 Realtime at $0.22/audio hour, billed per second with no minimum; two fully submitted streams would be $0.44 before optional features/tax. Account terms, actual metering and compatibility need separate validation; this is not a recommendation to switch providers.

### Cues: count every evaluated request, including quiet replies

These are the app's curated Anthropic choices and the default OpenAI/Gemini text choices ([source table](../src-tauri/src/llm_provider.rs)); a configured model ID does not prove current provider availability. Standard uncached input/output rates per million tokens:

| Cue model                                 | Input | Output | Illustrative cue cost per hour below |
| ----------------------------------------- | ----: | -----: | -----------------------------------: |
| Claude Haiku 5.5, prompts ≤100,000 tokens | $0.10 |  $0.50 |                               $0.036 |
| Claude Sonnet 5.5                         | $2.00 | $10.00 |                               $0.720 |
| Claude Opus 5.5                           | $4.00 | $20.00 |                               $1.440 |
| GPT-5 mini                                | $0.25 |  $2.00 |                               $0.108 |
| Gemini 2.5 Flash, text input              | $0.30 |  $2.50 |                               $0.132 |

References: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [official OpenAI GPT-5 mini rates](https://developers.openai.com/api/docs/models/gpt-5-mini), [Google Gemini pricing](https://aistudio.google.com/docs/pricing#gemini-2.5-flash). Haiku prompts over 100,000 tokens have different rates. Google includes thinking tokens in output pricing; budget billable reasoning/output, not just displayed cue text. OpenAI marks GPT-5 mini deprecated. Google marks Gemini 2.5 Flash deprecated and states that on **1 December 2026** its requests will route to Gemini 3.5 Flash-Lite at that model's rates. Review model selection, response compatibility and estimates before that date; do not silently treat this table as durable pricing or verified account access.

**Illustration, not a measured usage rate:** assume 120 evaluations per wall-clock hour, 2,000 uncached input tokens and 200 billable output tokens each. That is 240,000 input and 24,000 output tokens; cost is `requests × (input tokens × input rate + output tokens × output rate) / 1,000,000`. Every repeat of context/system/schema tokens counts. Quiet, rejected or failed work may still incur provider usage; the number of displayed cues is not the request count. The table scales linearly under these fixed assumptions: twice the requests doubles cue cost. Request frequency, token size, reasoning and cache behavior have not been measured for a representative hour.

For example, the monolingual Deepgram + Haiku scenario is $0.444 for one full audio stream or $0.852 for two, plus any excluded charges. These totals combine hypothetical cue usage with submitted-audio assumptions; they are not a TalkQTE hourly price, a cap guarantee, or evidence that either provider meets the latency/quality budget. Separately requested meeting notes add their own full-transcript token usage. Custom models can have no known in-app estimate. Current source cache-rate tables also need periodic reconciliation with provider rates; uncached examples avoid assuming cache savings.

### Bounded lab evidence is not an hourly operating measurement

At this checkpoint, the reported cumulative token-priced estimate for bounded development comparisons is **$0.239555**. It is an estimate from experiment usage, not a verified invoice, complete cloud bill or realistic hour of conversation. Short, selected samples, different request shapes/models and retries do not establish sustained production request rate, transcription cost, useful cues per dollar or participant benefit. Do not divide that total by sample playback length and advertise an hourly cost. No new paid call was made for this documentation review.

Next measurement, only after a separately approved scope/budget: one representative fictional sustained session on an exact build, recording wall duration, each submitted audio stream's duration, provider/model/rate date, evaluations (including quiet/failures), billable input/output/reasoning/cache tokens and bounded-drain/reconnect usage. Compare the estimate with user-reviewed provider metering, separate any voice generation or meeting-note requests, and report uncertainty and quality/latency alongside cost. No account or content access is authorized by this plan.

## Operating costs

- **Inference in the app:** per-stream transcription and per-token cue decisions are core operating costs under the own-key alpha. The scenarios above do not replace a measured sustained-session estimate. A future hosted service needs a separate operating model ([cloud providers](product-readiness.md#cloud-providers-for-a-shipped-product)).
- **Inference in development:** the [cue lab](claude-cue-lab.md) has separately selected subscription and paid API paths. Subscription allowance is not an API budget or a production distribution entitlement. Paid development calls require explicit owner approval and a cumulative cap; no provider calls run in CI/tests.
- **Hosting:** none for app delivery today; see above. The public concept site is a separate repository with its own hosting and domain, outside this estimate.
- **Signing and notarization:** needs a paid annual Apple Developer Program membership, an owner decision that is not yet made. Signed updates also need an update-signing key whose custody (where it is kept, who can use it, and how it is recovered) must be decided before the first signed release.
- **Telemetry:** none, by design ([privacy](../PRIVACY.md)). Usage and failure rates must therefore come from opt-in reports or support conversations, not automatic collection.

## Support effort

Not measured: no completed pilot support dataset is recorded here. The likely first topics, from the features most dependent on each person's setup, are microphone permission, provider setup (keys, the session approval and network access), and companion placement on different displays and meeting apps. A pilot should record, per participant: setup time, the issues raised and their topics, and time spent resolving them. Those numbers, not guesses, should set support capacity.

## When more infrastructure would be justified

Record the evidence first, as the [product readiness plan](product-readiness.md#production-and-scaling-approach) requires. Signals that would justify a change:

- **Provider failures or rate limits** for a noticeable share of sessions: clear per-session messages and caps first, then revisit the operating model ([cloud providers](product-readiness.md#cloud-providers-for-a-shipped-product)).
- **Update traffic or failed updates** becoming a support topic: consider delta updates or a dedicated update host.
- **Support volume** beyond what the owner can answer within a stated response time: a help page and a structured issue template first, then a support channel.
- **Hosted features** such as shared sessions or hosted inference: each needs its own data boundary, cost model, and decision; none is planned.

## Follow-up

- Measure the disk image, universal, and notarized builds when signing is decided; the [release path](release-path.md#remaining-steps-in-order) lists the steps that produce them.
