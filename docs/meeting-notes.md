# Meeting notes with your own key

After a live session ends, **Generate notes** requests a cited summary, decisions, action items and open questions using the configured **Cue & notes provider** (Anthropic, OpenAI or Gemini). The provider bills your account. Generating notes is separate from live cue processing and never happens automatically.

## Generate, check and keep

Choose **Include my notes** only if you want the notebook's written notes included; it is off by default. Generate notes obtains a Rust plan and sends only if the prepared request still matches it. The current initial action does not open a separate confirmation dialog. **Stop waiting** cancels waiting; anything already sent may still be billed. A new live session cancels the old request and drops its result.

Checked notes appear under **Check, edit, then keep or discard**. Inspect **Where each item came from**, edit the text and choose **Keep with this meeting** or **Discard**. Only kept model notes join the reviewed Markdown export. A completed or discarded draft cannot be requested again. A new session clears this memory-only notes state; saving a meeting and export have their separate existing controls.

## A failed validation can be reviewed for one retry

If any reply item fails validation, the entire reply is rejected. No invalid output is shown, repaired, dropped or kept. The fixed failure message explains the check category. “An item cited no line, or too many” covers both zero citations and more than eight supplied IDs; it does not distinguish those cases or establish which occurred in a particular reply. Nine duplicate IDs also fail before deduplication.

**Review one retry** is available only after a validation failure, with at most two sent attempts for the meeting. Review sends nothing. The inline **Review the final retry** shows the transcript and optional written-note counts, destination, model, excluded sources, prior reserved estimate and the retry's likely and worst-case estimates. **Cancel review** sends nothing and restores focus. **Send final retry** explicitly sends the reviewed scope again; another charge is possible. The same validator applies, and another sent failure is final.

Rust conservatively reserves the full estimated worst case for each sent request, even when reported usage is smaller, zero or missing. The sum must fit the existing **$1.00 estimated limit for this meeting's notes**. This is an estimate, not a billing guarantee. A lower-cost notes model in Settings may fit the remaining estimate; changing provider/model requires a fresh review. Unknown pricing on either the previous or proposed request blocks retry. The original custom-model request remains supported with unavailable dollar estimates; it cannot be retried because the combined estimate cannot be bounded.

Nothing retries automatically. Network, key rejection, timeout, cancellation after sending, refusal, output-limit and malformed-stream failures do not unlock recovery. A key/offline/cancel failure known to occur before sending consumes no attempt and restores the previous state. Changing included notes invalidates review; Rust also checks provider, model, speaker names, source text and schema in the request digest. A changed retry returns to explicit review without automatically replanning or sending. Session and request-generation guards drop stale worker results and prevent an old cancellation from releasing a newer attempt.

The transcript remains available to review and export even when generation fails. Retry does not start capture, alter history retention or automatically approve any other processing.

## What is sent and checked

The request contains only the fixed system prompt/schema, nonblank transcript segments numbered `L1`, `L2`, … with times and applicable remote speaker labels or assigned names, and optionally nonblank editor notes numbered `N…`. Grouped transcript display does not change the raw segment citation IDs. Imported prior context, cues, focus, session title, audio and device names are excluded. Source text is untrusted data, never instructions.

The strict Rust validator requires the exact reply shape, at most five summary items and twenty per other section, nonblank item text up to 400 characters, and **one to eight supplied citation IDs per item**, each addressing a sent line. Owners and due dates must match whole words in the cited lines (including a named speaker where applicable); omitted owners/dates use null. These word checks establish presence, not correct responsibility or semantic entailment. Human review remains necessary. Model links/HTML/Markdown are neutralized before editing/export.

The prompt asks for narrow claims supported by at most eight lines, including when hundreds of short speech segments are supplied. It asks the model to split distinct claims within section limits or omit claims that cannot be grounded within bounds, never to remove necessary citations to fit.

The canonical schema declares section and citation `maxItems` for providers that support them. Anthropic receives a compatibility projection without unsupported `maxItems`, retaining descriptions and the prompt limits; local validation is identical for every provider. Official schema references: [Anthropic supported constraints](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output). Custom model compatibility, including fine-tuned model schema subsets, requires separate verification.

## Limits and provider transport

Existing bounds remain: 10,000 transcript segments, 240,000 transcript bytes, 512 KiB request body, 16,000 output tokens, 180-second overall deadline, 1 MiB streamed response, 64 KiB event line and 96 KiB reply text. Overlong input is refused, never silently truncated. Each retry has the same limits. Likely cost assumes about four input bytes per token plus 1,500 structured-output tokens and 3,000 output tokens; worst case uses one token per input byte plus 1,500 and the entire output allowance at the app's configured price table. Neither is measured billing.

Keys are read only for an explicit request and sent only in provider headers. Fixed HTTPS endpoints, certificate validation and no redirects are retained. OpenAI uses Responses with `store: false`; Gemini uses streaming REST; Anthropic uses Messages streaming. No fallback provider/model or tools are added. Fixed safe errors expose no raw provider reply or key. After success, the UI labels reported cost as the **latest request** estimate; prior reserved estimates are separate from reported usage.

## Evidence and remaining acceptance

The shared prompt/schema/fictional cases live in [`scripts/fixtures/meeting-notes.json`](../scripts/fixtures/meeting-notes.json); Rust implementation and offline transport/lifecycle tests live in `src-tauri/src/meeting_notes.rs` and `meeting_notes_tests.rs`. Fictional 236-fragment regressions exercise eight valid citations, zero/nine/duplicate/range/unknown IDs, one reviewed retry, cumulative reservations, unknown pricing, unsent rollback, stale confirmations, late callbacks and replacement sessions. Existing grounding, ownership, date, export and transport tests remain applicable.

Chromium/WebKit stand-ins exercise the actual React component's explicit review, cancellation, excluded/included notes, changed-plan refusal, final failed retry, narrow layout and accessibility. These are scripted browser/transport evidence, not observed model quality or native capture proof.

Next acceptance: a separately authorized fictional provider run on each supported provider must check request acceptance, citation quality, validation frequency, latency and actual usage against estimates. Native keyboard/VoiceOver, stop/cancellation and replacement-session behavior also need platform acceptance. No real interview data or paid call is required for the offline regressions, and no roadmap human/native gate is completed by them.
