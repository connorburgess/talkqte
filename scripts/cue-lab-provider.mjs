// Explicit per-run provider selection. The caller's orchestration gate is
// still authoritative across participant, judge and app-evaluator operations.
import { openIsolatedCli, EFFORTS } from './cue-lab.mjs';
import { ROLE_MODELS } from './cue-dialogue-agents.mjs';
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
const SAFE = new Set([
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
]);
const normalizeFailure = (error, calls) =>
  failure(SAFE.has(error?.category) ? error.category : 'provider', calls);

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
    async request({ instructions, input, schema, signal: requestSignal }) {
      operationSignal = requestSignal;
      return cli.request({
        model,
        effort,
        systemPrompt: instructions,
        input: JSON.stringify({ input, outputSchema: schema }),
        reply(value) {
          validateCodexSchema(schema, value);
          return value;
        },
      });
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
} = {}) {
  if (
    !['claude-code', 'codex'].includes(provider) ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 100 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 10 ||
    deadlineMs > 60000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1024 ||
    maxOutputBytes > 256 * 1024 ||
    !['subscription', 'offline-stand-in'].includes(execution) ||
    (execution === 'subscription' && openers !== undefined) ||
    (provider === 'codex'
      ? model !== CODEX_SUPPORT.model || !CODEX_SUPPORT.efforts.includes(effort)
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
  let adapter;
  try {
    if (execution === 'offline-stand-in') {
      if (typeof openers?.[provider] !== 'function')
        throw failure('provider-unavailable');
      adapter = await openers[provider](options);
    } else {
      adapter =
        provider === 'codex'
          ? await openCodexLab(options)
          : await openClaude(options);
    }
    if (
      !adapter ||
      typeof adapter.request !== 'function' ||
      typeof adapter.close !== 'function'
    )
      throw failure('provider-unavailable');
  } catch (error) {
    await adapter?.close?.();
    throw normalizeFailure(error, 0);
  }
  const metadata = Object.freeze({
    provider,
    model,
    effort,
    execution,
    maxCalls,
    deadlineMs,
    maxInputBytes: 64 * 1024,
    maxOutputBytes,
    budgetUnit: 'runner-dispatch-attempts',
    actualProviderRequestBound: false,
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
    const controller = new AbortController();
    const cancel = () => {
      stop();
      controller.abort();
    };
    request.signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
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
      stop();
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
    close() {
      if (!closing) {
        stop();
        signal?.removeEventListener('abort', stop);
        closing = (async () => {
          if (active) await active.done.catch(() => {});
          try {
            await adapter.close();
          } catch (error) {
            throw normalizeFailure(error, calls);
          }
        })();
      }
      return closing;
    },
  });
}
