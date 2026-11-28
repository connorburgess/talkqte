# Explicitly approved prior notes for own-key cues

Status: implementation contract for review; not an enabled capability. This
proposal does not claim that imported notes reached a production cue model or
that missing notes explain a session with no cues. No source policy, provider,
permission, runtime scope or defaults change in this proof-only contribution.

## Proven current path

Trace checked on main `c993d2c` and integration candidate
`11d49d66eb3a0df115f96c4be2adca56dd2a34ab`. Importing notes updates an available
catalog, not a model request or provider registration:

1. `context_runtime::Runtime::merge_imported_notes` merges the fetched copies,
   then `sync_prior_notes` calls `Engine::set_prior_notes` and reconciles native
   review ownership. Removal and refresh use this same synchronization boundary.
2. `ProcessingControl::prepare` submits exact provider/source ID/revision
   selections through `processingApi.review`, never excerpt text. The current
   `acceptsNotes: false` display says prior notes are never sent to this processor.
3. `processing_commands::Runtime::review_processing_scope` validates the session
   and scope revision, then `processing_reviews::Reviews::prepare` calls
   `Engine::review_processing`. It does not construct, replace or reconfigure
   the registered adapter.
4. `Engine::review_processing` rejects a nonempty selection when the existing
   `ProcessorConfiguration.accepts_notes` is false. This happens before an opaque
   review ID exists, so no approval can widen that rejected scope.
5. Approval consumes a native single-use token, checks owner/session/permission
   generation/complete processor configuration/exact source fingerprints, and
   installs a grant on that same engine. `approve_notes` on its lifecycle is an
   optional backend hook; the production `InApp` lifecycle has no override that
   replaces an adapter or supplies notes.
6. `anthropic_api::connected_engine_for`, `openai_api::connected_engine` and
   `gemini_api::connected_engine` use `llm_provider::register_cue_engine`, whose
   configuration calls `without_notes`. The legacy Anthropic test constructor
   also does so; inspecting only that constructor would be insufficient proof.
7. All three production `Evaluator::evaluate` implementations call
   `Request::prompt_input`. That serializer independently rejects any
   `Provenance::PriorNote` before credentials or transport access. It includes
   the explicit Interview mode for ordinary requests.

Thus an explicit imported-note review is currently unavailable on these own-key
routes. There is no later swap or separate approved-note injection in the traced
command path. The development selected-prior-context route uses a different
serializer/registration and is not evidence of production transmission.
Generic fictional evaluator tests that accept notes exercise permission
machinery, not production provider capability. Interview-mode instructions
cannot recover notes that never enter the request.

## Proof and limits

The added fictional constructor regression uses the actual shared production
registration for all three providers and the actual native review store. It
expects a note to remain visible as available while explicit selection fails
with `InvalidScope`; a transcript-only review then succeeds on the unchanged
processor with zero approved notes. A second regression uses the actual
Anthropic adapter and engine with a capturing fake transport: after rejected
note selection and successful transcript-only approval, it asserts an actual
serialized request contains current speech and Interview mode, with no note
ID/text, priorNotes or selected input contract. No credential store or provider
network is involved. Native execution results must be reported separately;
adding these assertions is not passing-test evidence.

These negative tests document the present capability gap. A future feature
change should replace their rejection expectation with reviewed positive wire
assertions, while keeping default transcript-only and no-approval controls.
No live quality, native presentation or interview outcome is established.

## Bounded production contract

### Permission and default

- Start continues to approve only the disclosed current-speech scope with zero
  prior notes. Imports, automatic selection, opening a note, changing Interview
  mode, or a previously approved lab route never authorize note sharing.
- The person explicitly chooses available note copies in the existing native
  review flow. Show destination, provider/model, exact source summaries, known
  or unknown date, revision/freshness caveats and aggregate bounded scope before
  approval. Approval is per session and source snapshot, not an ongoing grant
  to fetch or send future revisions. No new retrieval or cross-meeting scope.
- Trusted Rust registration advertises the reviewed selected-note capability
  and revised disclosure. Old transcript-only reviews/grants cannot become
  selected-note grants. Bind the configuration/policy revision and input
  contract into the same complete native review identity; never toggle a
  frontend flag or secretly replace an adapter after approval.
- Keep no-note request serialization/policy unchanged. A nonempty approved
  selection opts that grant into the explicit selected-note projection. Removing
  the last approved note requires deliberate scope handling rather than silently
  broadening or reusing an old token. No new per-question ceremony or automatic
  provider call is introduced.

### Snapshot identity and withdrawal

- Preserve native review owner/session/generation/configuration identity and
  exact `(provider, source ID, revision, content + metadata fingerprint)` binding.
  Reused revision with changed content is a change; reordered unchanged copies
  are not. Duplicate/unknown/stale IDs fail closed.
- Before dispatch, reconstruct from current granted snapshots under the runtime
  lock. Do not accept note content, provider URLs, executables, keys, model
  destinations or cost decisions from the webview.
- Removal, revision/content/date/title change, source revocation/withholding,
  processing Off, Stop, pause and session replacement invalidate applicable
  in-flight tickets. No late reply may show a cue, mutate replacement-session
  state, reject credentials or restore permission. Already sent bytes cannot
  be recalled. Do not automatically approve/refetch/retry a changed source.
- Keep existing rules for unrelated catalog changes explicit: invalidate a
  pending review when its source set changed, while unchanged already-approved
  sources retain only the scope existing reconciliation permits. Never infer
  validity from a source title or ID alone.

### Wire contract, bounds and provenance

- Reuse a reviewed shared projection based on the selected-prior-context-v2
  semantics after integration, with anonymous current transcript events,
  immutable prior-note snapshots, current cue/earlier cues and explicit optional
  sessionMode. Treat notes as untrusted source data, not instructions or proof
  of speaker identity. Do not infer the listener owns a first-person claim.
- Unknown source dates remain explicitly unknown according to the integrated
  note contract; do not invent dates or substitute import time as source date.
  Known dates, revisions, provider and freshness caveats remain visible to the
  model and review. Preserve undated and Interview-mode fields on wire; never
  strip them to satisfy an older validator.
- Enforce existing Request limits (32 sources, 4096 UTF-8 bytes per source,
  32768 aggregate source/metadata bytes) plus the selected projection's exact
  16384-byte serialized-input ceiling and provider request/reply bounds. Count
  every field, escape, UTF-8 byte, unknown-date representation, sessionMode,
  name/history/cue metadata and newline where the chosen envelope requires it.
  A grant's mandatory selected scope must fit atomically; reject before
  credentials/transport rather than silently dropping/truncating notes. Do not
  increase limits merely to make an example fit.
- Use provider-compatible structured-output schemas on Anthropic, OpenAI and
  Gemini. Keep their existing supported schema restrictions and action-state
  semantics, at most four unique known source IDs, allowed cue length/output
  bounds and no invented fields. Validate actual serialized provider body, not
  just an intermediate projection. No generic chat relay or unbounded context.
- The engine still requires at least one **fresh cited current-speech source**
  for every nonquiet action; selected notes alone cannot show, resolve or
  withdraw a cue. A fresh uncited line elsewhere in input does not satisfy the
  anchor. Preserve Asked you, source lifecycle, gating and cooldown behavior.
- Existing fixed destination, own-key transport, request/spend/deadline caps,
  serial worker, cancellation and no-fallback policy apply. Include selected
  projection/system prompt bytes in the conservative preflight estimate. Never
  reset session caps when note scope is approved again.

## Required fictional acceptance before capability claims

1. For each actual provider adapter, capture a fake transport wire request after
   native explicit review/approval: exact selected text, IDs, metadata/revisions,
   unknown date and sessionMode arrive; unselected copies, manual notes, transcript
   history outside approval, focus and review-only expectations do not. Assert
   default Start/empty grant keeps existing no-note wire bytes and prompt.
2. Reject no review, forged/replayed/replaced IDs, changed/reused revision, source
   replacement, cross-provider/session/configuration tokens and aggregate/per-
   source byte overflow **before any key access or fake transport call**.
3. Hold a fake provider response while each note is removed, revoked, updated,
   withheld or reimported, and while Off/pause/Stop/new session runs. Verify late
   success and late auth failure cannot affect old or replacement state. Preserve
   ordinary active auth rejection behavior and shared caps.
4. Check UTF-8/escaping and exactly-at/one-over serialized limits with unknown
   date, Interview mode, visible cue and history. Verify invalid mode/date/schema
   fails closed rather than stripping fields or truncating a note.
5. Fake decisions citing note-only or expired speech cannot show/resolve/withdraw;
   a fresh cited speech plus approved note can, with visible provenance. Preserve
   Asked you and valid resolution cases. Injections in notes do not alter command
   scope or pass unknown source IDs; tests cannot prove semantic obedience.
6. Render explicit source review, default-no-notes, rejection/recovery and source
   change states at desktop/narrow widths, keyboard and supported webviews. Scope
   disclosure and actual body must match. No claim that mock answers prove live
   provider usefulness, speaker attribution or native cue timing.

## Integration ownership and next blocker

PR490 owns shared context, review, engine, serializers and UI integration. This
proof-only branch changes its own test file and this separate proposal; it does
not edit those shared files or enable a capability. Root reviews this contract
before allocating the runtime/adapter integration. Implementation should begin
from the accepted combined source, not a speculative merge or frozen lab export.

Next acceptance: execute the production-constructor negative regressions on the
exact proof commit through hosted native checks or an explicitly coordinated
local Rust slot. Then review the selected-note contract and implement provider-
specific positive wire/lifecycle regressions before advertising approved prior
notes on own-key cues. An empty saved cue list remains insufficient to infer a
session's configuration, failures, gates or model decisions.
