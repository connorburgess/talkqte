// Explicit per-run provider selection. The caller's orchestration gate is
// still authoritative across participant, judge and app-evaluator operations.
import { openIsolatedCli, EFFORTS } from './cue-lab.mjs';
import { openAnthropicLab } from './cue-lab-anthropic.mjs';
import {
  ANTHROPIC_EFFORT,
  ANTHROPIC_SPEND_CAP_MICRO_USD,
  isAnthropicModel,
} from './cue-lab-anthropic-core.mjs';
import { ROLE_MODELS, OUTPUT_LIMITS } from './cue-dialogue-agents.mjs';
import {
  CODEX_SUPPORT,
  openCodexLab,
  runBoundedCodexProcess,
  validateCodexSchema,
  assertSubscriptionEnvironment,
  snapshotLabJson,
} from './cue-lab-codex.mjs';

const ROLES = new Set([
  'generator',
  'cast',
  'listener',
  'judge',
  'cue-evaluator',
]);
const failure = (category, calls = 0) =>
  Object.assign(new Error(`Lab provider stopped: ${category}.`), {
    category,
    calls,
    exitCode: null,
    signals: [],
  });
export const PROVIDER_FAILURE_CATEGORIES = new Set([
  'configuration',
  'provider-unavailable',
  'unsupported-cli-version',
  'configuration-mismatch',
  'ambient-credentials',
  'subscription-login-required',
  'deadline',
  'cancelled',
  'output-limit',
  'unexpected-event',
  'protocol',
  'schema',
  'process',
  'cleanup',
  'auth',
  'usage-limit',
  'transient',
  'time-or-output-limit',
  'not-installed',
  'refusal',
]);
const normalizeFailure = (error, calls) =>
  failure(
    PROVIDER_FAILURE_CATEGORIES.has(error?.category)
      ? error.category
      : 'provider',
    calls,
  );

export function requestClaudeRole(
  cli,
  { model, effort },
  { role, instructions, input, schema },
) {
  return cli.request({
    model,
    effort,
    systemPrompt: instructions,
    input: JSON.stringify({ input, outputSchema: schema }),
    ...(OUTPUT_LIMITS[role] ? { maxOutputTokens: OUTPUT_LIMITS[role] } : {}),
    reply(value) {
      validateCodexSchema(schema, value);
      return value;
    },
  });
}

async function openClaude({
  model,
  effort,
  environment,
  signal,
  deadlineMs,
  maxOutputBytes,
}) {
  let operationSignal = signal;
  const cli = await openIsolatedCli({
    environment,
    run: async (command, args, options) => {
      const result = await runBoundedCodexProcess(command, args, {
        ...options,
        signal: operationSignal,
        deadlineMs,
        maxOutputBytes,
      });
      return result.stdout;
    },
  });
  return {
    async request({ signal: requestSignal, ...request }) {
      operationSignal = requestSignal;
      return requestClaudeRole(cli, { model, effort }, request);
    },
    close: cli.close,
  };
}

/** A provider cannot change within a returned session. Starting a new session
 * is explicit; it never resumes a failed stream or resets its external cap.
 * openers are offline-only stand-ins, never a live provider fallback. */
export async function openLabProvider({
  provider,
  model,
  effort,
  maxCalls,
  deadlineMs,
  maxOutputBytes = 256 * 1024,
  environment = process.env,
  signal,
  execution = 'subscription',
  openers,
  // Direct API route only: return the session now and open the adapter
  // (key file and worker) only on open(), after the owner's in-app approval.
  deferOpen = false,
} = {}) {
  if (
    !['claude-code', 'codex', 'anthropic-api'].includes(provider) ||
    typeof deferOpen !== 'boolean' ||
    (deferOpen && provider !== 'anthropic-api') ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 100 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 10 ||
    deadlineMs > 60000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1024 ||
    maxOutputBytes > 256 * 1024 ||
    !['subscription', 'api', 'offline-stand-in'].includes(execution) ||
    (execution !== 'offline-stand-in' && openers !== undefined) ||
    // The direct API route runs only as `api` (or an offline stand-in), and
    // the subscription CLIs never as `api`.
    (execution === 'api') !==
      (provider === 'anthropic-api' && execution !== 'offline-stand-in') ||
    (provider === 'codex'
      ? model !== CODEX_SUPPORT.model || !CODEX_SUPPORT.efforts.includes(effort)
      : provider === 'anthropic-api'
        ? !isAnthropicModel(model) || effort !== ANTHROPIC_EFFORT
        : !Object.values(ROLE_MODELS).includes(model) ||
          !EFFORTS.includes(effort))
  )
    throw failure('configuration');
  if (signal?.aborted) throw failure('cancelled');
  try {
    assertSubscriptionEnvironment(environment);
  } catch {
    throw failure('ambient-credentials');
  }
  const options = Object.freeze({
    provider,
    model,
    effort,
    maxCalls,
    deadlineMs,
    maxOutputBytes,
    environment,
    signal,
    execution,
  });
  const openAdapter = async () => {
    let opened;
    try {
      if (execution === 'offline-stand-in') {
        if (typeof openers?.[provider] !== 'function')
          throw failure('provider-unavailable');
        opened = await openers[provider](options);
      } else {
        opened =
          provider === 'codex'
            ? await openCodexLab(options)
            : provider === 'anthropic-api'
              ? await openAnthropicLab(options)
              : await openClaude(options);
      }
      if (
        !opened ||
        typeof opened.request !== 'function' ||
        typeof opened.close !== 'function'
      )
        throw failure('provider-unavailable');
      return opened;
    } catch (error) {
      await opened?.close?.();
      throw normalizeFailure(error, 0);
    }
  };
  let adapter = deferOpen ? null : await openAdapter();
  let opening = null;
  const metadata = Object.freeze({
    provider,
    model,
    effort,
    execution,
    maxCalls,
    deadlineMs,
    maxInputBytes: 64 * 1024,
    maxOutputBytes,
    // One API dispatch is exactly one HTTP request (no retries); a CLI
    // dispatch can hide further requests.
    ...(provider === 'anthropic-api'
      ? {
          budgetUnit: 'api-requests',
          actualProviderRequestBound: true,
          spendCapMicroUsd: ANTHROPIC_SPEND_CAP_MICRO_USD[model],
        }
      : {
          budgetUnit: 'runner-dispatch-attempts',
          actualProviderRequestBound: false,
        }),
  });
  let calls = 0,
    terminal = false,
    active = null,
    closing = null;
  const stop = () => {
    terminal = true;
    active?.controller.abort();
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const request = async (request = {}) => {
    if (terminal) throw failure('terminal', calls);
    if (active) {
      stop();
      throw failure('concurrent-request', calls);
    }
    if (request.signal?.aborted || signal?.aborted) {
      stop();
      throw failure('cancelled', calls);
    }
    let snapshot;
    try {
      if (
        !ROLES.has(request.role) ||
        typeof request.instructions !== 'string' ||
        !request.instructions.trim() ||
        request.instructions.length > 16000
      )
        throw failure('invalid-request');
      snapshot = snapshotLabJson({
        role: request.role,
        instructions: request.instructions,
        input: request.input,
        schema: request.schema,
      });
      if (Buffer.byteLength(JSON.stringify(snapshot)) > metadata.maxInputBytes)
        throw failure('invalid-request');
      validateCodexSchema(snapshot.schema);
    } catch {
      stop();
      throw failure('invalid-request', calls);
    }
    if (calls >= maxCalls) {
      stop();
      throw failure('call-cap', calls);
    }
    // A deferred session sends nothing before open() has completed.
    if (!adapter) {
      stop();
      throw failure('protocol', calls);
    }
    const controller = new AbortController();
    // The caller's request signal retires only this call (for example a
    // per-request evaluator deadline). The adapter ceiling stays terminal.
    let scoped = false;
    const cancel = () => {
      scoped = true;
      controller.abort();
    };
    request.signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      controller.abort();
    }, deadlineMs);
    const operation = { controller, done: null };
    active = operation;
    calls++;
    operation.done = Promise.resolve().then(() =>
      adapter.request({ ...snapshot, signal: controller.signal }),
    );
    try {
      const result = await operation.done;
      if (timedOut) throw failure('deadline');
      if (terminal || controller.signal.aborted) throw failure('cancelled');
      if (
        !result ||
        result.value === undefined ||
        !Number.isFinite(result.elapsedMs) ||
        result.elapsedMs < 0
      )
        throw failure('schema');
      validateCodexSchema(snapshot.schema, result.value);
      const usage = Object.fromEntries(
        [
          'input_tokens',
          'output_tokens',
          'cached_input_tokens',
          'cache_read_input_tokens',
          'cache_creation_input_tokens',
        ]
          .filter(
            (key) =>
              Number.isSafeInteger(result.usage?.[key]) &&
              result.usage[key] >= 0,
          )
          .map((key) => [key, result.usage[key]]),
      );
      return {
        value: structuredClone(result.value),
        elapsedMs: result.elapsedMs,
        usage,
      };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      if (
        scoped &&
        !timedOut &&
        !terminal &&
        !signal?.aborted &&
        error?.category === 'cancelled'
      )
        throw failure('cancelled', calls);
      // An API refusal, or an API reply that reached its output bound, is a
      // recorded non-decision for this request only. On the CLI routes an
      // output limit stays terminal.
      if (
        !timedOut &&
        !terminal &&
        !signal?.aborted &&
        (error?.category === 'refusal' ||
          (provider === 'anthropic-api' && error?.category === 'output-limit'))
      )
        throw failure(error.category, calls);
      stop();
      if (error?.category === 'cleanup') throw failure('cleanup', calls);
      throw normalizeFailure(
        timedOut
          ? failure('deadline')
          : cancelled
            ? failure('cancelled')
            : error,
        calls,
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', cancel);
      active = null;
    }
  };
  return Object.freeze({
    metadata,
    request,
    get calls() {
      return calls;
    },
    get receipts() {
      return adapter?.receipts ?? null;
    },
    get spentMicroUsd() {
      return adapter?.spentMicroUsd ?? null;
    },
    get opened() {
      return adapter !== null;
    },
    // Opens a deferred session once; a no-op for one opened at creation.
    open() {
      if (adapter) return Promise.resolve();
      if (terminal || closing)
        return Promise.reject(failure('terminal', calls));
      opening ??= openAdapter().then(
        (opened) => {
          if (terminal || closing) {
            // Closed while opening: retire what was just opened.
            return Promise.resolve(opened.close()).then(() => {
              throw failure('terminal', calls);
            });
          }
          adapter = opened;
        },
        (error) => {
          stop();
          throw error;
        },
      );
      return opening;
    },
    close() {
      if (!closing) {
        stop();
        signal?.removeEventListener('abort', stop);
        closing = (async () => {
          if (active) await active.done.catch(() => {});
          await opening?.catch(() => {});
          try {
            await adapter?.close();
          } catch (error) {
            throw normalizeFailure(error, calls);
          }
        })();
      }
      return closing;
    },
  });
}
