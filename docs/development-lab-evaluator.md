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
Selection is explicit: `TALKQTE_DEV_CUE_BACKEND=lab-subscription`, with an exact
`TALKQTE_DEV_LAB_PROVIDER` (`codex` or `claude-code`),
`TALKQTE_DEV_LAB_MODEL`, `TALKQTE_DEV_LAB_EFFORT` and absolute
`TALKQTE_DEV_LAB_DESCRIPTOR`. Missing or invalid lab settings refuse processing;
there is no provider fallback. The client currently accepts `gpt-6.1-sol` for Codex,
`claude-opus-5-5` or `claude-haiku-5-5` for Claude Code, and `low` or `medium`
effort. The broker must confirm the identical provider/model/effort at handshake.

Native integration reuses [launch consent](real-app-lab.md#model-connection-without-clicks)
and its session cap, default 100, or the existing explicit session review. The lab
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
fictional-lab-only, uses the explicitly selected subscription, and remains subject
to that account's retention terms.

## Stop for an owned development process

A macOS debug build with `native-audio-spike`, `lab-evaluator` and a private
`timing-log` channel can explicitly opt into a Stop-only signal handshake:
`TALKQTE_DEV_STOP_SIGNAL=usr2` and `TALKQTE_DEV_LAB_RUN_ID` set to the broker's
same opaque run ID (1–64 ASCII letters, digits, hyphens or underscores). Settings
are frozen at setup. Ordinary builds install no handler. Invalid settings, an
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
release, completed ordinary live Stop and settled startup admission. A detached
transcription worker, abandoned operation or cleanup deadline cannot establish
release. A five-second native cleanup observation timeout emits terminal `failed`,
with no later `released`; it does not force cleanup or stop the process. The
launcher allows at least six seconds after signaling and twelve seconds overall
for its Stop lifecycle. These are wait ceilings, not measured release guarantees.

The timing channel is lossy and has no delivery acknowledgement. Missing `armed`
or `released` means unconfirmed cleanup; signal success and process exit are not
release evidence. The first integrated launcher must also set a finite
`TALKQTE_DEV_STOP_AFTER_S` ordinary-Stop guard independently of SIGUSR2. Its Stop
request also needs release evidence. A missing handshake can require owner
intervention; the launcher must not signal blindly or use termination as proof.
Offline tests cover sticky Stop, delayed startup/listing and release fences; this
handshake has not been exercised with a native app or real capture.

## One request and one newest context

New validated speech coalesces while one immutable evaluation completes. It does
not cancel that evaluation. Rust validates its result and checks permission,
session, revision, cue identity and unchanged freshness deadlines under the engine
lock. Valid stale success is discarded; only the newest eligible context can be
submitted next. An error is terminal even when its original speech is stale.
There is no queue of old contexts, unchanged-context retry or freshness extension.

The first timeout, invalid response, provider failure, lost settlement or transport
failure ends the strict lab run. Stop, revoke, replacement, Pause and Dismiss also
end it. Resume does not restart it; a new run/session is required. This policy is
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
`settled` (`current`, `staleSuccess` or `failed`). The global lease remains held
through that acknowledgement, with a fixed one-second validation grace after an
on-time provider result. It permits no second provider call and does not extend
the provider deadline. Missing/mismatched acknowledgement ends every role.

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
