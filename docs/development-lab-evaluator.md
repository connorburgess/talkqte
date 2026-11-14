# Development lab evaluator client

This is preparation for a fictional, explicitly enabled development experiment.
The native backend selector, clock sampler and publication/Stop hooks are a
separate dependency. This change alone does not make Codex available in the app,
launch a provider or establish streamed-meeting acceptance. Ordinary Claude
selection and its existing speech-cancellation/two-timeout policy stay unchanged.

## Enablement boundary

The native integration must restrict selection to a macOS debug build with
`native-audio-spike` and `lab-evaluator`, outside all release builds. The release
builder refuses `lab-evaluator`, including indirect/configuration feature requests.
Selection is explicit: `TALKQTE_DEV_CUE_BACKEND=lab-subscription`, with an exact
`TALKQTE_DEV_LAB_PROVIDER` (`codex` or `claude-code`),
`TALKQTE_DEV_LAB_MODEL`, `TALKQTE_DEV_LAB_EFFORT` and absolute
`TALKQTE_DEV_LAB_DESCRIPTOR`. Missing or invalid lab settings refuse processing;
there is no provider fallback. The client currently accepts `gpt-6.1-sol` for Codex,
`claude-opus-5-5` or `claude-haiku-5-5` for Claude Code, and `low` or `medium`
effort. The broker must confirm the identical provider/model/effort at handshake.

Native integration must reuse [launch consent](real-app-lab.md#model-connection-without-clicks)
and its session cap, default 100, or the existing explicit session review. No
constructor grants permission. Construction is inert: the transport worker waits
for its first permission-gated evaluation before reading a descriptor or opening
a socket. Before that lazy authentication, the orchestrator must independently
abort/close the shared run on Stop; a nonexistent socket cannot carry cancellation.
There is no public command for injecting a cue or choosing an executable.

The notebook and companion name the selected provider while lines may leave the
device. The lab sends bounded recent/new speech, the optional Your name setting and current/earlier
cues; it refuses prior/imported notes and excludes focus lines. Model-generated
cue text may return to the same provider as current/earlier context. Processing is
fictional-lab-only, uses the explicitly selected subscription, and remains subject
to that account's retention terms.

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
transport worker invokes the native read-only sampler once. Native must use a
nonblocking Runtime lock attempt and estimate its current session clock without
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

The next readiness blocker is the dependent native integration plus reviewed
broker/orchestrator startup. Acceptance requires a bounded fictional streamed
speech → real model cue/silence decision → timely native publication/visible-card
run, checking Stop/revoke/replacement cleanup, clock uncertainty, cap accounting,
latency and starvation. No production readiness or end-to-end success is claimed.
