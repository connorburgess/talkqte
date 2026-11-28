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

This page describes source behavior and offline checks. Those checks do not
establish native acceptance, live provider quality or useful interview timing.

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

Ordinary **Start live session** approves the disclosed new-speech scope with
zero prior notes for the chosen own-key provider. Imports and automatic prior-
context selection never approve model sharing. During active capture, **Cue
processing → Review prior-note sharing** lets you choose exact stored copies,
review their provider/source/date/revision and destination, then **Update sharing
for this session**. Capture continues; cancelling review leaves the existing
scope unchanged. Lab and development routes keep their separate review rules.

Pause cancels pending effects and stops cue requests while retaining unchanged
approval; it does not stop transcription audio. Off, Stop and replacement
withdraw permission. See [processing controls](processing-controls.md) and
[cloud transcription](cloud-transcription.md#what-stops-it).

## The request

Every provider uses the shared cue policy (`scripts/fixtures/cue-decision.json`),
same native-owned bounded input projection, same three structured-output JSON schemas,
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

- One user message: the engine's `own_key_prompt_input` JSON. With no approved
  notes it preserves the existing `Request::prompt_input` bytes and system prompt.
  - It contains up to six recent transcript lines, all labelled `Speaker`, and
    any lines the cue on screen cites.
  - It contains the cue on screen, up to four earlier cues with how each
    ended, and the session name if one is set.
  - It never contains audio, the full transcript, manual meeting notes, unapproved
    imported notes or focus lines. Explicitly approved prior snapshots use the
    `selected-prior-context-v2` projection plus the shared untrusted-snapshot
    rule; this does not change the provider's output grammar.
- `output_config.format`: one of the lab's three JSON schemas, chosen by
  whether a cue is on screen and whether it is an "Asked you" cue.

`scripts/fixtures/anthropic-request.json` holds three fictional requests.
The lab's Node test and the app's Rust test both build them and must match
the fixture exactly: model, system text, user message string, schema,
thinking setting and the spend estimate.

## Usefulness policy and limits

The shared live prompt asks for information that helps now: a relevant sourced
constraint, concrete contradiction or response option, or an unresolved gap
blocking an actual decision or committed next step. An already-spoken question
does not become useful just because nobody answered it yet. Naturally answered
questions, brainstorming and hypothetical options should stay quiet. A tentative
timeline alone is no evidence for a skeptical challenge. Ownership prompts need
an actual task being committed to, not merely a possible idea. Later speech can
give a consequential reason to revisit an older question; the reminder must cite
that new evidence. The existing Asked you priority and resolution rules remain.

The default request still labels all speech `Speaker`. It does not tell the
model which line came from the microphone or who spoke it. The optional session
name identifies the listener for explicit direct address, not a line's author.
No new speaker identity, context lookup, prior-note selection or sharing grant
is added. A reminder may use only the supplied speech, or exact selected notes
through the separately approved selected-context path. A historical note is not
a verified current fact.

Rust also drops a model `show` that copies a supplied question, ignoring case,
punctuation and a few conversational lead-ins, when it cites no substantive
speech later than that question. It does not disable processing, record a shown
cue or affect the engine's own Asked you cue. This is a narrow English question
check, not lexical-overlap scoring or semantic deduplication: negations, dates,
quantities and changed words remain distinct. A later cited line can preserve a
reminder; this structural allowance does not establish that the new line
actually justifies it. Paraphrases, answers, brainstorming and risk still depend
on model judgment and can be wrong. Only the bounded approved request is checked;
speech outside it is not searched.

The fictional `scripts/fixtures/cue-usefulness.json` cases document expected
quiet behavior for already-asked/answered questions, brainstorming, unsupported
facts and unsupported skepticism, plus opportunities for a consequential gap,
source-backed reminder, concrete contradiction and response help. Scripted Rust
replies exercise display, source and permission boundaries; Node checks the
actual request contract. Neither calls a provider or measures model quality.
Next acceptance: a separately authorized comparison on held-out fictional
conversations, across chosen models, checking false interruptions, missed useful
context, timing and listening. Offline tests do not establish that participation
improves.

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

## Explicitly approved prior-note snapshots

The nonempty reviewed grant sends only selected copies, not the entire available
catalog: exact text, provider, source ID/title, opaque local revision and source
date. An undated file stays `date: null` / **Unknown date**; it is never assigned
an invented source date. `sessionMode: "interview"` remains present in Interview
mode. Copies are labeled `freshness: "not_verified"`, not independently verified
facts or instructions. Attribution to the listener is not established by a note.

The exact serialized selected input has a 16 KiB ceiling, including all metadata,
JSON escaping, UTF-8, optional mode and cue/history fields. Existing per-source,
source-count and aggregate limits also apply. A size violation fails the whole
scope before credentials/transport; no selected text is silently dropped or
truncated. New speech can make a reviewed scope too large; processing then stops
with its input-limit status and needs a smaller explicit review.

Changing an approved copy's revision, content, date or title, or withholding/
revoking it, cancels in-flight effects and stops that scope. Explicit removal can
narrow an own-key grant to remaining unchanged approved copies. Removing the last
copy returns to disclosed **new speech only**, invalidates old review ownership
and does not fetch or reapprove anything. Pause retains unchanged approval;
resume accepts new speech only. None of these operations resets cumulative
request/spend limits. A late response, including an authentication failure, must
not affect a withdrawn scope or replacement session.

Every nonquiet proposal still needs a **fresh cited current-speech source**;
notes alone cannot raise, resolve or withdraw a cue. Prior snapshots do not make
the model know the whole meeting. Source/structure validation and fictional
fake-wire/lifecycle tests are not evidence of semantic usefulness or provider
obedience. Native acceptance and a separately authorized live usefulness check
remain open.
