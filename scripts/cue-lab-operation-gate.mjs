// One run-wide lease around participant generation, judge and evaluator
// settlement. No process or transport is constructed here.
import { AsyncLocalStorage } from 'node:async_hooks';

const ROLES = new Set([
  'generator',
  'cast',
  'listener',
  'judge',
  'cue-evaluator',
]);
const CODES = new Set([
  'cancelled',
  'closed',
  'deadline',
  'dispatch-limit',
  'protocol',
  'invalid-reply',
  'provider',
  'cleanup',
]);
export const gateFailure = (category) =>
  Object.assign(new Error(`Lab run stopped: ${category}.`), { category });
const safe = (error) =>
  gateFailure(CODES.has(error?.category) ? error.category : 'provider');

export function createLabOperationGate({
  provider,
  maxCalls,
  signal,
  onTerminal = () => {},
} = {}) {
  if (
    !provider ||
    typeof provider.request !== 'function' ||
    typeof provider.close !== 'function' ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 100 ||
    typeof onTerminal !== 'function'
  )
    throw gateFailure('protocol');
  const context = new AsyncLocalStorage();
  let active = null,
    pending = null,
    terminal = null,
    dispatches = 0,
    closing = null,
    providerCleanup = null;
  const waiters = new Set();
  const retireProvider = () =>
    (providerCleanup ??= Promise.resolve()
      .then(() => provider.close())
      .catch(() => {
        terminal = 'cleanup';
        throw gateFailure('cleanup');
      }));
  // Never detach a rejected cleanup promise; close/lease completion awaits it.
  const stop = (category = 'cancelled') => {
    if (!terminal) {
      terminal = CODES.has(category) ? category : 'provider';
      try {
        onTerminal(terminal);
      } catch {
        terminal = 'protocol';
      }
    }
    active?.controller.abort();
    pending?.controller.abort();
    for (const waiter of waiters) waiter();
  };
  const rootAbort = () => stop('cancelled');
  signal?.addEventListener('abort', rootAbort, { once: true });
  if (signal?.aborted) stop('cancelled');
  const notify = () => {
    for (const waiter of waiters) waiter();
  };
  const request = async ({ signal: requestSignal, ...request } = {}) => {
    const lease = context.getStore();
    if (terminal) throw gateFailure(terminal);
    if (
      !lease ||
      lease !== active ||
      lease.dispatched ||
      request.role !== lease.role
    ) {
      stop('protocol');
      throw gateFailure('protocol');
    }
    if (requestSignal?.aborted || lease.controller.signal.aborted) {
      stop('cancelled');
      throw gateFailure('cancelled');
    }
    if (dispatches >= maxCalls) {
      stop('dispatch-limit');
      throw gateFailure('dispatch-limit');
    }
    const abort = () => stop('cancelled');
    requestSignal?.addEventListener('abort', abort, { once: true });
    lease.dispatched = true;
    dispatches++;
    lease.providerOperation = Promise.resolve().then(() =>
      provider.request({ ...request, signal: lease.controller.signal }),
    );
    try {
      const result = await lease.providerOperation;
      if (terminal || lease.controller.signal.aborted)
        throw gateFailure(terminal ?? 'cancelled');
      return result;
    } catch (error) {
      stop(safe(error).category);
      throw safe(error);
    } finally {
      requestSignal?.removeEventListener('abort', abort);
    }
  };
  const run = async (
    task,
    { role, signal: operationSignal, deadlineMs = 30000 } = {},
  ) => {
    if (terminal) throw gateFailure(terminal);
    if (context.getStore()) {
      stop('protocol');
      throw gateFailure('protocol');
    }
    if (
      typeof task !== 'function' ||
      !ROLES.has(role) ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 60000
    ) {
      stop('protocol');
      throw gateFailure('protocol');
    }
    if (operationSignal?.aborted) {
      stop('cancelled');
      throw gateFailure('cancelled');
    }
    if (
      pending ||
      (active && (role !== 'cue-evaluator' || active.role === 'cue-evaluator'))
    ) {
      stop('protocol');
      throw gateFailure('protocol');
    }
    const controller = new AbortController();
    const lease = {
      role,
      controller,
      dispatched: false,
      providerOperation: null,
      finished: null,
    };
    const abort = () => stop('cancelled');
    operationSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('deadline'), deadlineMs);
    let release;
    lease.finished = new Promise((resolve) => {
      release = resolve;
    });
    try {
      if (active) {
        pending = lease;
        const previous = active;
        await previous.finished;
        if (terminal) throw gateFailure(terminal);
        pending = null;
      }
      active = lease;
      const result = await context.run(lease, task);
      // A caller cannot fire-and-forget the provider and release the lease.
      if (lease.providerOperation) await lease.providerOperation;
      if (terminal) throw gateFailure(terminal);
      if (!lease.dispatched) throw gateFailure('protocol');
      return result;
    } catch (error) {
      stop(safe(error).category);
      if (lease.providerOperation)
        await lease.providerOperation.catch(() => {});
      await retireProvider();
      throw gateFailure(terminal);
    } finally {
      clearTimeout(timer);
      operationSignal?.removeEventListener('abort', abort);
      if (active === lease) active = null;
      if (pending === lease) pending = null;
      release();
      notify();
    }
  };
  const waitIdle = async ({ signal: waiterSignal } = {}) => {
    if (terminal) throw gateFailure(terminal);
    if (waiterSignal?.aborted) throw gateFailure('cancelled');
    if (!active && !pending) return;
    // One orchestration waiter and one control waiter are sufficient; this is
    // not an unbounded role queue. Evaluator admission lives in run() above.
    if (waiters.size >= 2) {
      stop('protocol');
      throw gateFailure('protocol');
    }
    await new Promise((resolve, reject) => {
      const check = () => {
        if (terminal || waiterSignal?.aborted || (!active && !pending)) {
          waiters.delete(check);
          waiterSignal?.removeEventListener('abort', check);
          if (terminal || waiterSignal?.aborted)
            reject(gateFailure(terminal ?? 'cancelled'));
          else resolve();
        }
      };
      waiters.add(check);
      waiterSignal?.addEventListener('abort', check, { once: true });
      check();
    });
  };
  return Object.freeze({
    run,
    request,
    waitIdle,
    stop,
    get dispatchesUsed() {
      return dispatches;
    },
    get terminal() {
      return terminal;
    },
    close() {
      if (!closing) {
        stop('closed');
        signal?.removeEventListener('abort', rootAbort);
        const operations = [active?.finished, pending?.finished].filter(
          Boolean,
        );
        closing = (async () => {
          await Promise.all(operations);
          await retireProvider();
        })();
      }
      return closing;
    },
  });
}
