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

One operation may run at a time. Stop, cancellation, first failure, output overflow
and deadline are terminal; no retry is attempted. Output bytes are bounded while
streaming, including stderr. Cancellation terminates the owned process group,
escalates to KILL and checks group retirement before returning; unresolved cleanup
fails closed. Late results are rejected. `close()` awaits runner settlement and
removes the owned temporary directory. Injected offline runners must honor their
abort/deadline contract and settle after cleanup.

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
