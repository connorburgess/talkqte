# Cue decisions with your own API key

With an API key stored for your chosen cue provider — **Anthropic**, **OpenAI**,
or **Gemini** ([provider keys](provider-keys.md)) — every build, ordinary and
release builds included, registers an in-app cue connection for live sessions
(`src-tauri/src/anthropic_api.rs`, `openai_api.rs`, `gemini_api.rs`, coordinated
by `src-tauri/src/llm_provider.rs`). It calls your chosen provider's official
API directly from the app. There is no TalkQTE server and no lab broker, and
nothing falls back to another service. With a Deepgram key also stored, an
ordinary build can run the whole loop: capture, Deepgram transcription, a cue
decision from your selected provider and model, and the cue shown and cleared.

This page describes what the code does. No live session request has reached a
provider from this code; the evidence is the offline tests listed at the end.

## Which connection a session uses

1. A lab launch that selects the lab evaluator uses the lab, unchanged.
2. A build with the development `claude-cli` feature uses Claude Code, unchanged.
3. Otherwise, the active cue provider selected in **Settings → Cue & notes
   provider** (defaulting to **Anthropic**) uses that provider's stored key and
   chosen curated or custom cue model ID.
4. With no key for the selected provider, a live start is refused (for example,
   `"Add your OpenAI API key in Settings to start a live session."`). A refused
   key gives `"<Provider> rejected your API key. Replace it in Settings to start
a live session."`

## When anything is sent

Nothing is sent until the session's processing review is approved. That one
review names both providers: your chosen cue provider (Anthropic, OpenAI, or
Gemini), for the lines listed below, and Deepgram, for the session's audio. It
also states the billing, the model (including whether estimated spend is
unavailable for a custom model ID), and the caps. A launch setting cannot approve
it. Pause, Off, Stop and session replacement behave as the
[processing controls](processing-controls.md) and
[cloud transcription](cloud-transcription.md#what-stops-it) describe.

## The request

Every provider uses the same system prompt (`scripts/fixtures/cue-decision.json`),
same `Request::prompt_input` JSON, same three structured-output JSON schemas,
same 8-second deadline, same 64 KiB / 1 MiB / 4096-byte bounds, and same reply
normalization and validator:

- **Anthropic:** `POST https://api.anthropic.com/v1/messages` (`x-api-key`
  header, `anthropic-version: 2026-10-21`), SSE stream, curated models
  `claude-haiku-5-5` (default), `claude-sonnet-5-5`, `claude-opus-5-5`, or a
  custom model ID.
- **OpenAI:** `POST https://api.openai.com/v1/responses` (`Authorization: Bearer`
  header), `store: false`, `text.format` `json_schema` (`strict: true`), SSE
  stream, curated models `gpt-5-mini` (default), `gpt-4.1-mini`, `gpt-4.1`,
  `gpt-5`, or a custom model ID (without hardcoded `reasoning` parameters so
  non-reasoning and custom models work uniformly).
- **Gemini:** `POST https://generativelanguage.googleapis.com/v1beta/models/{id}:streamGenerateContent?alt=sse`
  with `x-goog-api-key` in the request header only (never in the URL query
  string), `systemInstruction`, `responseMimeType: "application/json"`,
  `responseJsonSchema`, SSE stream ignoring `thought: true` parts, curated models
  `gemini-2.5-flash` (default), `gemini-2.5-flash-lite`, `gemini-2.5-pro`, or a
  custom model ID.

Transport uses TLS with rustls, bundled web roots, certificate validation, HTTPS
only, redirects disabled, and one overall 8-second timeout. Each request sends:

- One user message: the engine's input JSON (`Request::prompt_input`).
  - It contains up to six recent transcript lines, all labelled `Speaker`, and
    any lines the cue on screen cites.
  - It contains the cue on screen, up to four earlier cues with how each
    ended, and the session name if one is set.
  - It never contains audio, the full transcript, notes, imported notes or
    focus lines.
- `output_config.format`: one of the lab's three JSON schemas, chosen by
  whether a cue is on screen and whether it is an "Asked you" cue.

`scripts/fixtures/anthropic-request.json` holds three fictional requests.
The lab's Node test and the app's Rust test both build them and must match
the fixture exactly: model, system text, user message string, schema,
thinking setting and the spend estimate.

## Replies and settlement

The lab adapter's and broker's rules, without a broker:

- **Bounds**:
  - a 64 KiB event line
  - 1 MiB for the whole response
  - 4096 bytes of reply text
  - 64 KiB for the request body
- **A reply that applies**: it streamed to `end_turn` and `message_stop` from
  the same model, and passes the broker's checks:
  - exactly the three fields
  - a known action that fits the cue on screen
  - one to four distinct cited lines from this request
  - a cue of at most 240 characters and 10 words, only with `show`

  With a cue on screen, `show` is settled as `quiet`, keeping the reply's
  cited lines; so is `withdraw` of an "Asked you" cue. Action casing is
  ignored. The engine then checks the reply again and applies it under its
  usual hold, dismissal, cooldown and freshness rules.

- **Skipped, and the session continues**:
  - a refusal
  - a reply at its output bound
  - one of fewer than three unusable replies in a row
  - a reply past the 8-second deadline

  New speech arriving while a request is in flight waits, coalesced, and a
  reply to a transcript that has only grown since is still applied, as in the
  lab.

- **Cues stop for the session**, with a fixed reason:
  - a refused key (401 or 403; issue `keyRejected`)
  - a key removed from the Keychain mid-session, or a Keychain that cannot be
    read (issue `keyUnavailable`, nothing sent)
  - a rate limit (429)
  - any other HTTP status or a failed connection
  - a malformed stream or a reply from another model
  - a third unusable reply in a row
  - the request cap or the spend estimate cap

  There is no retry. Turning cues on again needs a new review.

- **Pause and Dismiss** cancel the request in flight but, unlike a lab run, do
  not end cues for the session; Resume continues with new speech. Pause does
  not end the approval, so the session's audio is still sent to Deepgram and
  billed while cues are paused; the review and the Pause help say so. Turning
  processing off, or Stop, ends both.

No provider text reaches a log, an error or the notebook.

## Caps and the spend estimate

These defaults are an owner decision that is still open:

- **Per session only**: there is no per-launch or per-day cap; each new
  session starts again from zero.
- **Requests**: at most 400 per session, at least two seconds apart, one at a
  time. In a scripted hour with both sources and a line about every three
  seconds (`anthropic_api::sustained_tests`), requests went out about every
  three seconds and the cap ended cues after about 22 minutes, at an estimated
  $0.07 with that test's token counts; the spend estimate was nowhere near its
  cap. A real meeting's rate and request size have not been measured.
- **Spend**: for built-in curated models, at most an estimated $0.50 per session
  computed from TalkQTE's pinned table before each request. Custom model IDs
  outside the built-in price table still enforce the 400-request session cap
  and omit dollar estimates rather than fabricating `$0.00` (nor do they enforce
  a dollar cap).
- **Charging & display**: `cue_usage` returns
  `{ provider, model, requests, requestCap, spentMicroUsd, spendCapMicroUsd, customModel }`.
  For curated models, completed replies charge reported tokens, errors/cuts
  charge the worst case, and missing keys / 401 / 402 / 403 / billing blocks /
  unsent network errors charge nothing. For custom models, `spentMicroUsd` and
  `spendCapMicroUsd` are `null`, and Settings displays `"Estimated spend
unavailable for custom model <id>."`. It is an estimate from the person's side,
  not the provider's bill. **Settings → Your API keys** shows it.

## Evidence

Offline Rust tests in `anthropic_api`, `openai_api`, `gemini_api`, and
`llm_provider` use scripted transports and fixed fictional keys; none reaches
the network:

- The shared Anthropic fixture matches (`scripts/fixtures/anthropic-request.json`); the Node test checks the same fixture.
- OpenAI Responses API (`store: false`, `json_schema`, snapshot model echo matching like `gpt-5-mini-2025-08-07`, 401/403/402/429 mapping) and Gemini REST (`x-goog-api-key` header only, unsafe model path rejection, `thought: true` part skipping, 400 `API_KEY_INVALID`/401/403/429 mapping) pass offline scripted transport tests.
- Custom model ID validation (`[A-Za-z0-9._:/-]+`, max 96 chars, no `..`), request-cap enforcement, and honest `null` spend reporting are verified offline.
- Request-scoped and terminal outcomes, with what each is charged.
- 401 and 403 mark the key rejected; a missing key sends nothing.
- The spend cap is checked before sending for curated models.
- The broker's reply normalisation, and three unusable replies in a row.
- The review text names both providers, the key, billing, the caps and the
  model, within the review's bound.
- In the engine:
  - nothing is sent before approval, and an approved line raises a cue
  - Pause and Resume continue
  - a refusal skips only its request
  - a refused key and the request cap stop cues with their own reasons

Still unverified: any request to the real APIs (Anthropic, OpenAI, or Gemini), latency against the
[budgets](budgets.md), cue quality on real or lab cases across curated and custom models, the
real Keychain on a signed build, device runs, and both sides of a call.
