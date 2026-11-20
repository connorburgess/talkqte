# Development lab evaluator client

This is preparation for a fictional, explicitly enabled development experiment.
The development-only native backend selector, consent, clock sampler and
publication/Stop hooks are implemented and tested offline. They do not launch a
provider or establish streamed-meeting acceptance. Ordinary Claude
selection and its existing speech-cancellation/two-timeout policy stay unchanged.

## Enablement boundary

Native selection is restricted to a macOS debug build with
`native-audio-spike` and `lab-evaluator`, outside all release builds. The release
builder refuses `lab-evaluator`, including indirect/configuration feature requests.
`lab-evaluator` also switches on `cloud-transcription`, which since 16 November
2026 is the app's only live transcription; it is selected separately per launch
([cloud transcription](cloud-transcription.md)).
Selection is explicit: `TALKQTE_DEV_CUE_BACKEND=lab-subscription`, with an exact
`TALKQTE_DEV_LAB_PROVIDER` (`codex` or `claude-code`),
`TALKQTE_DEV_LAB_MODEL`, `TALKQTE_DEV_LAB_EFFORT` and absolute
`TALKQTE_DEV_LAB_DESCRIPTOR`. Missing or invalid lab settings refuse processing;
there is no provider fallback. The client currently accepts `gpt-6.1-sol` for Codex,
`claude-opus-5-5` or `claude-haiku-5-5` for Claude Code, and `low` or `medium`
effort. The broker must confirm the identical provider/model/effort at handshake.

A second backend, `TALKQTE_DEV_CUE_BACKEND=lab-api`, sends the same context to the
Anthropic API with the lab owner's API key, through the same broker; the key never
reaches the app. It accepts only provider `anthropic-api`, model
`claude-opus-5-5`, `claude-sonnet-5-5` or `claude-haiku-5-5`, effort `low`, and a
required `TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD` (a decimal from 1 to 1,000,000
micro-dollars). A provider used with the other backend, or a spend cap with the
subscription backend, is refused. The broker's `ready` frame for it must report
`dispatchBudgetKind` `apiRequests`, `spendCapMicroUsd` equal to the launch cap and
`spendUsedMicroUsd` not above it; the subscription backends report
`cliDispatchAttempts` and never send spend fields. A broker `failed` frame with
code `refusal` or `output_limit` for the active request is request-scoped: that
request is retired, recorded as `refused` or `output_limit`, shows no cue, and the
run continues. One request per
check, no retries, no other model, and the spend cap itself are guarantees of the
lab broker, which holds the key; the app cannot see those requests. It only
refuses a broker whose reported cap differs from the launch cap or whose reported
spend exceeds it.

Native integration reuses [launch consent](real-app-lab.md#model-connection-without-clicks)
and its session cap, default 100, or the existing explicit session review. The
`lab-api` backend is the exception: sending conversation text to a paid API is an
export, so the session review is its per-run confirmation. It names the Anthropic
API, what is sent, billing per token, the per-run spend cap and the model. The
launch setting cannot approve it; that combination fails closed. The lab
backend does not require the separate `claude-cli` feature. No constructor grants
permission. Construction is inert: the transport worker waits
for its first permission-gated evaluation before reading a descriptor or opening
a socket. Before that lazy authentication, the orchestrator must independently
abort/close the shared run on Stop and use the owned-process handshake below; a
nonexistent socket cannot carry cancellation.
There is no public command for injecting a cue or choosing an executable.

The notebook and companion name the selected provider while lines may leave the
device. The lab sends bounded recent/new speech, the optional Your name setting and current/earlier
cues; it refuses prior/imported notes and excludes focus lines. Model-generated
cue text may return to the same provider as current/earlier context. Processing is
fictional-lab-only, uses the explicitly selected subscription or API key, and
remains subject to that account's or API organisation's retention terms.

## Stop for an owned development process

A macOS debug build with `native-audio-spike`, `lab-evaluator` and a private
`timing-log` channel can explicitly opt into a Stop-only signal handshake for a
fictional application-source session:
`TALKQTE_DEV_STOP_SIGNAL=usr2` and `TALKQTE_DEV_LAB_RUN_ID` set to the broker's
same opaque run ID (1–64 ASCII letters, digits, hyphens or underscores). Settings
are frozen at setup, together with the exact `TALKQTE_DEV_APPLICATION_SOURCE`
value `QuickTime Player`, or the separately [identity-pinned owned player](development-owned-player-source.md), and a required finite positive `TALKQTE_DEV_STOP_AFTER_S`.
Other sources, incomplete owned identity or a missing/invalid guard refuse arming. The microphone must be
unused in this process before arming (no admitted start, capture or cleanup
pending, and Off). Idle ordinary Stop may advance control generation/revision
without admitting a microphone start; that alone does not invalidate release. This mode blocks standalone microphone admission and live
microphone reservation before any native request. Any unexpected microphone
history remains unsupported even after teardown; it cannot become release proof.
Ordinary builds and controls outside this opt-in retain their behavior.

Ordinary builds install no handler. Invalid settings, an
existing nondefault SIGUSR2 disposition or failed worker/handler installation
refuse setup before application-source autostart; existing dispositions are not
overwritten. This adds no Start, source-selection, permission or cue command.

The launcher must own the exact child process and its unique timing stream.
It aborts the shared provider gate immediately when Stop is requested, including
before authentication or native readiness. It remembers early Stop intent and
sends SIGUSR2 once only after that child's matching `dev_stop` event with
`run_id` and `step: armed`. Native emits `armed` after handler/worker installation
and before source autostart. The launcher waits at most five seconds for arming;
missing arming fails startup without signaling a default-disposition process.

The raw handler only sets a one-way atomic latch. Off-handler work emits
`latched`, cancels the lab model, then emits `stopping` and requests ordinary
source/live Stop. Admission stays closed, including late startup completion.
`released` requires the source worker's FIFO settlement fence, confirmed host
release, explicit completion acknowledgement for every extracted ordinary Live
drain, settled startup admission and a still-pristine microphone. Removing Live
from Runtime transfers ownership; it is not completion. Earlier concurrent Stop
drains remain pending across replacement until their exact empty source-session
handle is acknowledged. Unknown, microphone-bearing or runner-bearing handles
remain unconfirmed; this handshake does not establish their cleanup. A detached
source transcription worker, abandoned operation or cleanup deadline cannot
establish release. A five-second native cleanup observation timeout emits terminal `failed`,
with no later `released`; it does not force cleanup or stop the process. The
launcher allows at least six seconds after signaling and twelve seconds overall
for its Stop lifecycle. These are wait ceilings, not measured release guarantees.

The timing channel is lossy and has no delivery acknowledgement. Missing `armed`
or `released` means unconfirmed cleanup; signal success and process exit are not
release evidence. The first integrated launcher must also set a finite
`TALKQTE_DEV_STOP_AFTER_S` ordinary-Stop guard independently of SIGUSR2. Its Stop
request also needs release evidence. A missing handshake can require owner
intervention; the launcher must not signal blindly or use termination as proof.
Offline tests cover sticky Stop, delayed startup/listing, overlapping ordinary
Stop/replacement, delayed microphone teardown/history refusal and release fences; this
handshake has not been exercised with a native app or real capture.

The same armed run can publish [versioned selected-source observations](development-source-observation.md)
that bind the host operation, live-start operation and exact session/Control.
These are historical guard-time observations, not atomic current readiness or
native release. The versioned JavaScript consumer/session join remains separate.

## Explicit API lab history selection

In this macOS debug-only lab path, a valid `lab-api` configuration may additionally set `TALKQTE_DEV_LAB_CONTEXT=bounded-history`. Unset keeps the existing fresh-only projection. Empty, unknown, non-Unicode, orphan (no backend) and subscription-backend context selections fail closed as unavailable; invalid text cannot silently select fresh context or another backend. This setting chooses a reviewed context policy, not consent, a model, a prompt or a larger spend allowance. Ordinary registrations and release builds do not select it.

The generated in-app data policy states: “Transcript context: up to 24 segments from the last 90 seconds, subject to a 16384-byte serialized input limit and the approved speech scope. Visible cue evidence may be older. No prior notes.” It remains beside the API destination, model, billing/cap and transcription disclosure. See the [history selection and source guards](cue-evaluator.md#opt-in-bounded-transcript-history-offline-implementation). The byte cap includes the compact input's escaping, current cue, listener name and earlier cues; a fresh cited source is still required at apply, with the existing 18-second deadline.

Selection does not install a grant or authenticate the broker. The owner must use **Review processing → Review selected sources → Enable for this session** and review the expanded data policy. A new-speech-only grant excludes buffered preapproval lines; a recent-and-new grant can include history within its disclosed bounds. Cancel, stale/replayed review IDs, Stop, session replacement and revocation retain their checks. Existing by-setting launch consent cannot authorize this mode; omit automatic connection approval. The launcher must explicitly map its validated context option to this native setting and must not inherit it from the shell. That separate launcher change and exact native artifact need to be pinned together before any run.

Offline Rust checks cover exact API-only parsing/defaults, generated history/API/audio/cap disclosure, oversized disclosure refusal, opaque review cancellation/replay/explicit approval, no buffered send under new-only approval, and isolated actual registration with valid/invalid context settings. They use fictional adapters and no provider or capture. Expanded-history semantic usefulness, owner-visible native approval and the combined ownership prompt remain separate acceptance gates; no new lab execution, build or spending is implied by the setting's implementation.

## One request and one newest context

New validated speech coalesces while one immutable evaluation completes. It does
not cancel that evaluation. Rust validates its result and checks permission,
session, cue identity and freshness deadlines under the engine lock.

**A lab cue reflects speech up to 8 s before it appears; newer speech is checked
next.** A reply in time is applied when the transcript it was evaluated on has
only grown since: same session and permission, the same existing cue, listener
name and earlier cues, and every submitted line still present with identical id,
text and time. A cue it shows can therefore concern something the newer speech
already answered; the next request carries that cue as the existing cue so the
model can resolve or withdraw it. Each applied decision's `evaluation_result`
logs `through_segment` (the `segment.id` of the newest line it was evaluated
through), `lag_lines` (lines that arrived after that line before it was applied)
and `lag_ms` (the newest of those lines' `at_ms` minus the through line's
`at_ms`, on the session clock; 0 when `lag_lines` is 0). `lag_ms` measures how
much speech the decision had not seen, not how late the reply was.

Any edited or removed line, cue change or permission change makes the reply
stale: it is discarded and logged with its action, and only the newest eligible
context can be submitted next. An error is terminal even when its original
speech is stale. There is no queue of old contexts, unchanged-context retry or
freshness extension. Ordinary (non-lab) evaluation is unchanged: new speech
cancels the pending request and only an exact match applies.

A request with no result inside the 8 s deadline is recorded as no decision in
time, and the run continues. Native retires only that request: it sends a
request-scoped `cancel` with reason `deadline`, or settles a result it read too
late as `expired`, and a broker `failed` with code `deadline` retires it the same
way. Late frames for a retired request are ignored. The session call limit and the
broker's dispatch cap still bound the run. A request retired after its provider
call started has spent its broker dispatch; one retired while still queued has
not, though native counted it. Repeated timeouts after dispatch end the run at
the dispatch limit; native's session call limit bounds the rest. The timing log keeps the action code of a decision that arrived but was
not applied, whether stale or read after the deadline; it is never shown.

An invalid response, provider failure, lost settlement, an expiry native cannot
retire, or a transport failure ends the strict lab run. Stop, revoke, replacement,
Pause and Dismiss also end it. Resume does not restart it; a new run/session is required. This policy is
specific to the lab backend. Continuous speech can produce stale-result silence
or starvation, and global serialization can increase latency. Those are measured
acceptance risks, not grounds to publish a stale cue.

## Local transport and settlement

The client accepts only an owner-owned private directory (`0700`), regular
non-symlink descriptor (`0600`, at most 4 KiB) and same-directory Unix socket
(`0600`). The descriptor carries a per-run nonce; credentials and nonce never enter
logs or frontend bundles. There is no TCP listener or reconnect path.

Strict UTF-8 NDJSON frames are bounded to 64 KiB with an independent one-second
partial-frame deadline. Outbound publication/settlement uses a bounded nonblocking
queue; overflow, failed emission or lock contention is terminal. No descriptor,
socket I/O or wait occurs under the Runtime lock. Session/request/context identities encoded as decimal strings, plus the run ID, prevent cross-session acceptance and integer precision loss.

One broker owns the shared provider and nonresettable CLI-dispatch budget across
participants, evaluator and judge. A queued evaluator's original deadline already
runs while waiting for admission. The Rust session cap is a secondary ceiling.
**Dispatch attempts are bounded; underlying provider request count is unobserved
and has no supported hard count.** A dispatch cap does not revoke remote work.

A broker result arrives only after provider cleanup. Rust independently validates
its immutable input/schema/source references and responds with identity-bound
`settled` (`current`, `staleSuccess`, `failed`, or `expired` for a result read
after the deadline). The evaluator lease is held until the request is settled
or retired. Native settles a result within one second of receiving it, and
confirms a request it retired at its deadline within one second of that
deadline; the broker accepts either until one second after the request's
deadline (plus a transit allowance). Neither permits a second provider call or
extends the provider deadline. A missing acknowledgement after that, a `failed`
verdict, or a mismatched or duplicate settlement ends the run.

## Publication and clock evidence

Only the exact successfully emitted native cue snapshot is observed in memory.
The facade filters non-model and note/focus-derived cards, deduplicates revisions,
and preserves clear/replacement order. Held/time/resolved-visible updates retain
the original Show request, decision time and publication time. Resolved-visible
state stays explicit; the listener wrapper omits it from actionable cards.
Publication is evidence of emission, not proof that the companion painted it.

After `ready`, exactly one broker clock probe precedes evaluation. An off-lock
transport worker invokes the native read-only sampler once. Native uses a
nonblocking Runtime lock attempt and estimates its current session clock without
advancing it. Busy, foreign-session, unavailable or late sampling terminates the
run. The broker combines the bounded sample with the actual player's playback-start
acknowledgement, even if that acknowledgement preceded calibration. Combined
uncertainty must be at most 100 ms. Socket receipt cannot reset cue age or stand in
for publication time. Neither anchor alone permits evaluator dispatch.

The client adds no persistent transcript or cue-text log. Model-card observations
stay ephemeral; integrated stream logs must disable/redact model-card text and
cannot claim strict replay from redacted records. Existing opt-in timing logs are
separate: this change does not make their transcript events text-free.

## Acceptance still required

Offline Unix peers and controlled evaluators check framing, identity, clock order,
settlement races, coalescing, cap exhaustion, first failure, publication filtering
and control cancellation. Headless UI fixtures check provider disclosure. These
checks call no model and launch no native app.

Native hook tests also check clock arithmetic, busy/invalid session refusal,
explicit selector failure without fallback and inert engine construction. These
checks do not establish runtime clock accuracy, provider readiness or companion
paint.

The next readiness blocker is reviewed broker/orchestrator startup, including
independent cancellation before lazy authentication. Acceptance requires a bounded
fictional streamed speech → real model cue/silence decision → timely native publication/visible-card
run, checking Stop/revoke/replacement cleanup, clock uncertainty, cap accounting,
latency and starvation. No production readiness or end-to-end success is claimed.
