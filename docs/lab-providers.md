# Explicit subscription providers for fictional lab runs

`scripts/cue-lab-provider.mjs` exposes one manually selected provider per run:
`claude-code` or `codex`. It is development tooling, not a production backend or
an automatic change to the desktop app's evaluator. The streaming engine receives
an injected runner and never selects a provider itself.

```js
import { openLabProvider } from '../scripts/cue-lab-provider.mjs';

const provider = await openLabProvider({
  provider: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'medium',
  maxCalls: 20,
  deadlineMs: 30_000,
  execution: 'subscription',
});
try {
  // Inside the orchestrator's shared gate:
  // provider.request({ role, instructions, input, schema, signal })
} finally {
  await provider.close();
}
```

A real run still needs its written reason, fictional input, explicit subscription
authorization and bounds. Nothing in this module authorizes a model run or capture.
Choosing another provider starts a visibly new run/session. It cannot resume a
failed stream, reset that stream's authoritative budget, or silently fall back.
Missing tools, unsupported configuration and unavailable sign-in stop the selected
provider. Claude retains the existing isolated CLI implementation and its current
explicit model/effort allowlist; the selector does not widen it to aliases.
Claude generator and judge requests retain their existing 4,000/1,500 output-token
ceilings; other roles retain the contract default.

Both selections return `request({role,instructions,input,schema,signal})` and
`close()`, immutable metadata and a cumulative `calls` counter. Results contain
only validated `value`, nonnegative `elapsedMs` and allowlisted numeric `usage`.
The schema subset supports strict objects, arrays, primitive types, enums, bounds
and `anyOf`; unsupported keywords fail before dispatch. Semantic/source validation
remains with the dialogue engine or Rust evaluator.

The cap counts **runner/CLI dispatch attempts**, including failed and aborted
attempts. It is not a hard count of underlying model or HTTP requests. Codex can
continue internally after a rejected model tool call or recoverable authentication
error. Its configured HTTP and stream retry budgets are zero, but that does not
disable every internal continuation or authentication recovery. A local deadline
cannot revoke work already submitted to the remote service.

One operation may run at a time. Stop, session cancellation, first failure,
output overflow and the adapter deadline are terminal; no retry is attempted. An
abort of one request's own signal (the broker's per-request evaluator deadline)
retires only that call once its process group is confirmed gone; an unconfirmed
retirement is terminal. Codex calls keep content-free `receipts`: per call, the
millisecond offsets of spawn, first output, decision ready, retirement
requested, exit and process-group retirement, and a fixed outcome. Output bytes are bounded while
streaming, including stderr. Cancellation terminates the owned process group,
escalates to KILL and checks group retirement before returning; unresolved cleanup
fails closed. Late results are rejected. `close()` awaits runner settlement and
removes the owned temporary directory. Injected offline runners must honor their
abort/deadline contract and settle after cleanup.

A Codex call is complete once its event stream has exactly one agent message
followed by the single `turn.completed`. The adapter then stops the CLI's process
group (TERM, then KILL after 100 ms) instead of waiting for the CLI's own
shutdown, and still confirms the group is gone before returning; a group that
survives is a terminal `cleanup` failure. Any event after `turn.completed`, a
second message, or `turn.completed` without a message remains a failure. The CLI
spends about 3.3 s after `turn.completed` before it exits by itself (about 2.3 s
against an offline local endpoint), which alone pushed every measured call past
the 8 s evaluator deadline. Cutting it short skips the CLI's own shutdown work: in
an offline probe with a fresh Codex home it leaves SQLite state databases with
uncheckpointed write-ahead logs (recovered on the next open) and one per-run
`tmp/arg0-macos` directory holding a lock file and two symlinks (removed by the
next Codex start). What the remaining shutdown time does with a signed-in profile
is not observable from the event stream. The lab runs the CLI with the user's
own Codex home, not an isolated profile.

The orchestrator must still supply **one shared operation gate and nonresettable
budget** across participants, judge and real-app evaluator. Do not count gate
admission and its one provider dispatch as two provider attempts, or reacquire the
gate from a provider already running inside it. Evaluator ownership extends through
independent Rust source/schema validation and its bounded settlement acknowledgement;
a raw provider success is insufficient to release that gate.

## Codex profile and checked evidence — 14 November 2026

The subscription path requires `codex-cli 0.163.0` and its inspected feature catalog.
Version or catalog drift is refused. It checks CLI-reported ChatGPT login status,
never reads/copies credentials, and starts no automatic login flow. Inherited API,
endpoint, proxy and runtime overrides are rejected; only approved OS environment
variables reach the subprocess.

The named `lab_subscription` provider uses Responses and CLI-managed ChatGPT auth,
with no custom base URL, token or environment key. The distinct name matters:
this CLI version does not apply provider overrides to its built-in OpenAI entry.
The profile disables all inspected active features, web search and update-plan,
ignores user configuration and rules, uses no daemon and an ephemeral fresh working
directory, supplies no MCP servers and reads no project instructions. The read-only
sandbox alone is not tool denial or proof against arbitrary file/network access.

An unauthenticated loopback check with the same feature profile advertised no tools,
rejected six fabricated tool families without executing their sentinel action, and
accepted a normal structured reply. Fake-provider endpoint/auth differ from saved
ChatGPT auth; source review checked the relevant auth-dependent feature gates.
That combination is targeted evidence, not a universal isolation guarantee.

One authorized subscription smoke dispatch returned a schema-valid fictional
`quiet`/`null` decision in 6.25 seconds under a 30-second deadline and 16 KiB streamed
output bound, followed by local cleanup. It did not exercise streamed speech,
actual-app cue publication/paint or recording. Underlying request count was not
observed. A single exact pre-turn diagnostic that code-mode host is disabled is
accepted; other error/action/unknown events terminate the operation.

Offline checks do not use a provider or credentials:

```sh
node --test scripts/cue-lab-codex.test.mjs scripts/cue-lab-provider.test.mjs
npm run test:cue-lab
```

The installed-CLI regression is separately opt-in and talks only to loopback with
a fresh empty authentication home:

```sh
TALKQTE_CODEX_OFFLINE_PROBE=1 node --test scripts/cue-lab-codex.test.mjs
```

The next acceptance check is a separately authorized integrated fictional run:
incremental generated speech, actual model cue-versus-silence decisions, timely
companion paint and bounded window-only recording. Provider smoke alone does not
meet that check. README needs no change for these internal lab modules.

## Direct Anthropic API route

`anthropic-api` sends one cue evaluation per request to the Anthropic Messages API with the owner's own API key. It exists only for the development lab evaluator; the subscription routes above are unchanged. The native app's support for it (backend `lab-api`, a per-run export confirmation) is a separate change.

**What leaves the device, per request:** the recent fictional transcript lines the broker received for that evaluation (at most 32 short lines), the existing cue if one is on screen, the optional user name and earlier cue texts, a fixed system prompt and a fixed reply schema. Nothing else: no audio, notes, history, files or identifiers beyond those line ids. The reply is one decision. Requests go only to `https://api.anthropic.com`. Like any client built on the official SDK, each request also carries the SDK's standard `X-Stainless-*` headers: operating system, CPU architecture, Node.js version and SDK version. They carry no content, paths or account details.

**Models and settings:** exactly `claude-opus-5-5` (adaptive thinking), `claude-sonnet-5-5` (thinking `between_tools`) or `claude-haiku-5-5` (adaptive), always at effort `low`; nothing else is accepted. The client uses the pinned official SDK with no retries, a timeout from the request budget, logging off and streaming with abort. No sampling settings or fallbacks are sent. The system prompt is byte-stable; the user name and earlier cues travel only in the user message. Lengths, at most four sources and source membership are still checked client-side.

**Key handling:** the key is read only from `~/.config/talkqte-lab/anthropic.env`, a `0600` file in a `0700` directory owned by the current user and outside any repository or temporary directory, holding exactly `TALKQTE_LAB_ANTHROPIC_KEY=` with a Console API key (`sk-ant-api…` or `sk-ant-usr-…`; admin and OAuth credentials are refused). It goes to a per-run worker process over stdin only, never in arguments, environment, logs, evidence or errors. Any `ANTHROPIC_*` variable in the environment is refused as an ambient credential, even one set to an empty string.

**Limits:** one dispatch is exactly one HTTP request, counted by the shared gate against the dispatch cap. Before each request the adapter applies a local estimated-spend guard: it refuses if recorded spend plus the next request's estimate could exceed $1.00 for Opus or $0.25 for Sonnet and Haiku. This ends the run as a usage limit. Recorded spend uses reported token usage with a pinned price table; these local thresholds do not guarantee a maximum provider bill. Only a reply that reaches `message_stop` is charged its reported usage. Any other outcome is charged the same preflight estimate: a cancelled or timed-out request, a provider error, a reply at the output bound, or a worker that exits mid-request. Whatever was generated before the cut-off may still be billed. Once the cap is reached, every later request in the run reports a usage limit. `max_tokens` is 2,048, shared by adaptive thinking on Opus and Haiku and the reply. Two outcomes are recorded non-decisions for that request only, and the run continues: a refusal from the model (`stop_reason: refusal`, sent to native as `failed` code `refusal`), and a reply that reaches the output bound (sent as `failed` code `output_limit`). Authentication errors, rate limits, a reply from a different model and invalid replies end the run.

The preflight estimate uses `ceil(UTF-8 bytes / 2) + 1,500` input tokens and the existing output-token ceiling with pinned rates. This byte heuristic is not a proven tokenizer bound. On Opus it estimates about $0.053 for a one-line input and $0.074 for the largest input the broker sends; forty such estimates total about $2.14 to $2.97. The $1.00 local threshold can therefore stop the run first. A completed decision uses its reported usage instead. Exact tokenizer coverage, rate validity and reconciliation with account billing remain separate acceptance checks; no remote token-count or billing request is made by this guard.

**Evidence:** per call, content-free receipts keep the time to first byte and first token, the stop reason, a refusal category, token usage and the computed cost. No prompt, reply or key text is kept.

Tests drive the adapter with a fake fetch or a loopback stand-in endpoint and a dummy key; no test reaches the network.

### Parent enforcement of API worker cleanup

The parent independently watches each API request's adapter deadline. At that
ceiling, or on a request abort, root abort or close, it asks the worker to abort.
A cooperative scoped abort can keep the worker usable. If the worker does not
settle within one second, the parent ends the session and retires its owned
process group, using the existing bounded TERM/KILL confirmation. During that
forced retirement, an exit or late reply cannot settle the request before group confirmation;
unconfirmed retirement remains a cleanup failure. An incomplete call keeps its
original abort cause and is charged the existing estimated worst case. No new
request or provider budget is allowed during this cleanup.
