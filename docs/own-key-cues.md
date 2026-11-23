# Cue decisions with your own Anthropic key

With an Anthropic API key stored ([provider keys](provider-keys.md)), every
build, ordinary and release builds included, registers an in-app cue connection
for live sessions (`src-tauri/src/anthropic_api.rs`). It calls the Anthropic
Messages API directly from the app. There is no TalkQTE server and no lab
broker, and nothing falls back to another service. With a Deepgram key also
stored, an ordinary build can run the whole loop: capture, Deepgram
transcription, a cue decision from Anthropic, and the cue shown and cleared.

This page describes what the code does. No request has reached Anthropic from
this code; the evidence is the offline tests listed at the end.

## Which connection a session uses

1. A lab launch that selects the lab evaluator uses the lab, unchanged.
2. A build with the development `claude-cli` feature uses Claude Code, unchanged.
3. Otherwise, a stored Anthropic key registers this connection.
4. With none of these, a live start is refused: "Add your Anthropic API key in
   Settings to start a live session." A key Anthropic refused gives "Anthropic
   rejected your API key. Replace it in Settings to start a live session."

## When anything is sent

Nothing is sent until the session's processing review is approved. That one
review names both providers: the Anthropic API, for the lines listed below,
and Deepgram, for the session's audio. It also states the billing, the model
and the caps. A launch setting cannot approve it. Pause, Off, Stop and session
replacement behave as the [processing controls](processing-controls.md) and
[cloud transcription](cloud-transcription.md#what-stops-it) describe.

## The request

It is the lab's direct-API request (`buildAnthropicParams` in
`scripts/cue-lab-anthropic-core.mjs`), built in Rust:

- `POST https://api.anthropic.com/v1/messages`, with headers `x-api-key` (the
  key, read from the Keychain for each request), `anthropic-version:
  2026-10-21` (the version the lab's pinned SDK sends), and JSON in,
  server-sent events out. TLS uses rustls with the bundled web roots and
  certificate validation. Redirects are off, and one overall timeout runs to
  the request's 8-second deadline.
- `model`: `claude-haiku-5-5`. The lab's other two models,
  `claude-opus-5-5` and `claude-sonnet-5-5`, are in the table but not
  selectable.
- `max_tokens` 2048, `output_config.effort` `low`, and `stream: true`.
  `thinking` is sent only for Sonnet, as `between_tools`.
- `system`: the byte-stable live prompt from `scripts/fixtures/cue-decision.json`
  (`liveCompact`, `glanceRule`, `nameNote`, `historyNote`, `askedNote`), with
  ephemeral caching.
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
  time.
- **Spend**: at most an estimated $0.50 per session. Before each request, the
  lab's worst case for it is computed (prompt, input and schema at about two
  bytes per token, plus 1,500 tokens, plus the full output bound). If what the
  session has already spent plus that worst case would pass the cap, nothing is
  sent and cues stop.
- **Charging**:
  - A reply that reached `message_stop` with its usage is charged its reported
    tokens at the lab's pinned prices (read 2026-11-16).
  - Any other outcome is charged the worst case, because what was generated
    may still be billed.
  - A missing key, and an HTTP 401 or 403, are charged nothing.
- **Display**: the `cue_usage` main-window command returns the current
  session's `{ model, requests, requestCap, spentMicroUsd, spendCapMicroUsd }`.
  It is an estimate from the person's side, not Anthropic's bill.

## Evidence

Offline Rust tests in `anthropic_api` use a scripted transport and a fixed
key; none reaches the network:

- The shared fixture matches; the Node test checks the same fixture.
- A decision is one streamed request, with the key only in the header, and is
  charged its reported usage.
- Request-scoped and terminal outcomes, with what each is charged.
- 401 and 403 mark the key rejected; a missing key sends nothing.
- The spend cap is checked before sending.
- The broker's reply normalisation, and three unusable replies in a row.
- The review text names both providers, the key, billing, the caps and the
  model, within the review's bound.
- In the engine:
  - nothing is sent before approval, and an approved line raises a cue
  - Pause and Resume continue
  - a refusal skips only its request
  - a refused key and the request cap stop cues with their own reasons

Still unverified: any request to the real API, latency against the
[budgets](budgets.md), cue quality with this model on the lab's cases, the
real Keychain on a signed build, device runs, and both sides of a call.
