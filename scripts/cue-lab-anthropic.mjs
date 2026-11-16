// Parent side of the lab's direct Anthropic API route. It owns one worker
// process per run (cue-lab-anthropic-worker.mjs), hands it the key once over
// stdin, sends one request per evaluation, enforces the call and spend caps,
// keeps content-free receipts and retires the worker's process group at
// close. No key, prompt or reply text is ever logged or kept here.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ANTHROPIC_EFFORT,
  ANTHROPIC_SPEND_CAP_MICRO_USD,
  anthropicEnvironmentNames,
  costMicroUsd,
  isAnthropicModel,
  readAnthropicKeyFile,
  worstCaseMicroUsd,
} from './cue-lab-anthropic-core.mjs';

import { refusedEnvironment } from './cue-lab-key-file.mjs';

const WORKER = fileURLToPath(
  new URL('./cue-lab-anthropic-worker.mjs', import.meta.url),
);
const failure = (category, calls = 0) =>
  Object.assign(new Error(`Lab API provider stopped: ${category}.`), {
    category,
    calls,
  });
// API outcomes that end only the one request (a recorded non-decision): a
// refusal, or a reply that reached the output bound (thinking shares it).
const REQUEST_SCOPED = new Set(['refusal', 'output-limit']);
const TERMINAL = {
  'usage-limit': 'usage-limit',
  auth: 'auth',
  'configuration-mismatch': 'configuration-mismatch',
  'output-limit': 'output-limit',
  protocol: 'protocol',
  provider: 'provider',
};

/**
 * Opens the per-run API session. `offline` is for tests only: a loopback
 * endpoint and a dummy key, so no network or real key is ever involved.
 */
export async function openAnthropicLab({
  model,
  effort,
  maxCalls,
  deadlineMs,
  signal,
  environment = process.env,
  keyFile,
  offline,
} = {}) {
  if (
    !isAnthropicModel(model) ||
    effort !== ANTHROPIC_EFFORT ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 100 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 10 ||
    deadlineMs > 60000
  )
    throw failure('configuration');
  if (anthropicEnvironmentNames(environment).length)
    throw failure('ambient-credentials');
  // The worker inherits only PATH, HOME, TMPDIR and LANG, so these never
  // reach it; they are refused anyway, as for the transcription grant.
  if (refusedEnvironment(process.env) || refusedEnvironment(environment))
    throw failure('environment');
  if (signal?.aborted) throw failure('cancelled');
  let key;
  let offlineBaseUrl;
  if (offline) {
    if (
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(offline.baseUrl ?? '') ||
      !/^sk-ant-api-offline-[a-z0-9-]{1,40}$/.test(offline.key ?? '')
    )
      throw failure('configuration');
    key = offline.key;
    offlineBaseUrl = offline.baseUrl;
  } else {
    try {
      key = readAnthropicKeyFile(keyFile ? { file: keyFile } : {});
    } catch {
      throw failure('credentials');
    }
  }
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG']
      .filter((k) => typeof environment[k] === 'string')
      .map((k) => [k, environment[k]]),
  );
  const child = spawn(process.execPath, [WORKER], {
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let exited = false,
    buffer = '',
    pendingReady = null,
    pending = null;
  child.on('exit', () => {
    exited = true;
    pendingReady?.reject(failure('process'));
    pending?.reject(failure('process'));
  });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 512 * 1024) child.kill('SIGKILL');
    for (let end; (end = buffer.indexOf('\n')) !== -1;) {
      let frame;
      try {
        frame = JSON.parse(buffer.slice(0, end));
      } catch {
        frame = null;
      }
      buffer = buffer.slice(end + 1);
      if (frame?.type === 'ready') pendingReady?.resolve();
      else if (frame?.type === 'result' && pending?.id === frame.id)
        pending.resolve(frame);
      else child.kill('SIGKILL');
    }
  });
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
    return { promise, resolve, reject };
  };
  pendingReady = deferred();
  child.stdin.write(
    JSON.stringify({ type: 'init', key, offlineBaseUrl }) + '\n',
  );
  key = null;
  const readyTimer = setTimeout(
    () => pendingReady.reject(failure('process')),
    5000,
  );
  try {
    await pendingReady.promise;
  } catch (error) {
    await retire().catch(() => {});
    throw error;
  } finally {
    clearTimeout(readyTimer);
    pendingReady = null;
  }

  const cap = ANTHROPIC_SPEND_CAP_MICRO_USD[model];
  let calls = 0,
    spent = 0,
    terminal = false,
    capReached = false,
    active = null,
    closing = null,
    nextId = 1;
  const receipts = [];
  const stop = () => {
    terminal = true;
  };
  signal?.addEventListener('abort', stop, { once: true });

  async function retire() {
    try {
      child.stdin.end();
    } catch {}
    for (let n = 0; n < 50 && !exited; n++) await delay(10);
    const kill = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {}
    };
    kill('SIGTERM');
    await delay(100);
    kill('SIGKILL');
    for (let n = 0; n < 100; n++) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') return;
      }
      await delay(10);
    }
    throw failure('cleanup');
  }

  const request = async ({ role, input, signal: requestSignal } = {}) => {
    // After the spend cap ends the run, later requests report it as such.
    if (capReached) throw failure('usage-limit', calls);
    if (terminal || exited) throw failure('terminal', calls);
    if (active) {
      stop();
      throw failure('concurrent-request', calls);
    }
    if (role !== 'cue-evaluator') {
      stop();
      throw failure('invalid-request', calls);
    }
    if (requestSignal?.aborted || signal?.aborted)
      throw failure('cancelled', calls);
    if (calls >= maxCalls) {
      stop();
      throw failure('call-cap', calls);
    }
    // Refuse before dispatch if the worst case for this call could pass the
    // per-run cap; that ends the run as a usage limit.
    const worst = worstCaseMicroUsd(model, input);
    if (spent + worst > cap) {
      capReached = true;
      stop();
      throw failure('usage-limit', calls);
    }
    calls++;
    const id = nextId++;
    const receipt = { call: calls, outcome: null };
    if (receipts.length < 100) receipts.push(receipt);
    pending = { id, ...deferred() };
    active = pending;
    const abort = () => {
      try {
        child.stdin.write(JSON.stringify({ type: 'abort', id }) + '\n');
      } catch {}
    };
    requestSignal?.addEventListener('abort', abort, { once: true });
    try {
      child.stdin.write(
        JSON.stringify({
          type: 'request',
          id,
          model,
          input,
          budgetMs: deadlineMs,
        }) + '\n',
      );
      let settled;
      try {
        settled = await pending.promise;
      } catch (error) {
        // The worker died mid-request: whatever it sent may still be billed.
        spent += worst;
        Object.assign(receipt, { outcome: 'process', costMicroUsd: worst });
        if (spent >= cap) capReached = true;
        throw error;
      }
      const { result, text } = settled;
      const usage = result.usage ?? {};
      // Only a reply that reached message_stop reports its final usage; any
      // other outcome (cancelled, provider error, output bound, a stream cut
      // short) may still be billed for what was generated, so it is charged
      // the full worst case.
      const complete =
        result.messageStopMs !== null &&
        result.messageStopMs !== undefined &&
        Number.isSafeInteger(usage.input_tokens) &&
        Number.isSafeInteger(usage.output_tokens) &&
        result.outcome !== 'output-limit';
      const cost = complete ? costMicroUsd(model, usage) : worst;
      spent += cost;
      Object.assign(receipt, {
        outcome: result.outcome ?? 'provider',
        messageStartMs: result.messageStartMs ?? null,
        firstTextMs: result.firstTextMs ?? null,
        messageStopMs: result.messageStopMs ?? null,
        settledMs: result.settledMs ?? null,
        stopReason: result.stopReason ?? null,
        refusalCategory: result.refusalCategory ?? null,
        status: result.status ?? null,
        usage,
        costMicroUsd: cost,
      });
      if (result.outcome === 'decision') {
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          stop();
          throw failure('schema', calls);
        }
        // Enum casing is not guaranteed by the API; compare case-insensitively.
        if (typeof value?.action === 'string')
          value.action = value.action.toLowerCase();
        // A cap reached by this call ends the run after its decision.
        if (spent >= cap) {
          capReached = true;
          stop();
        }
        return { value, elapsedMs: result.settledMs ?? 0, usage };
      }
      if (spent >= cap) {
        capReached = true;
        stop();
        throw failure('usage-limit', calls);
      }
      if (result.outcome === 'cancelled') throw failure('cancelled', calls);
      if (REQUEST_SCOPED.has(result.outcome))
        throw failure(result.outcome, calls);
      stop();
      throw failure(TERMINAL[result.outcome] ?? 'provider', calls);
    } finally {
      requestSignal?.removeEventListener('abort', abort);
      active = null;
      pending = null;
    }
  };
  return Object.freeze({
    metadata: Object.freeze({
      provider: 'anthropic-api',
      model,
      effort,
      spendCapMicroUsd: cap,
    }),
    request,
    get calls() {
      return calls;
    },
    get spentMicroUsd() {
      return spent;
    },
    get receipts() {
      return Object.freeze(receipts.map((r) => Object.freeze({ ...r })));
    },
    async close() {
      if (!closing) {
        stop();
        signal?.removeEventListener('abort', stop);
        closing = (async () => {
          if (active) await active.promise.catch(() => {});
          await retire();
        })();
      }
      return closing;
    },
  });
}
