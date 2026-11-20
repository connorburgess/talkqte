// Identity-bound guard-time evidence; delivery remains lossy and non-atomic.
import { gateFailure } from './cue-lab-operation-gate.mjs';

const u64 = (v) =>
  typeof v === 'string' &&
  /^[1-9][0-9]{0,19}$/.test(v) &&
  BigInt(v) <= 18446744073709551615n;
export function createLabSourceV1({
  launcher,
  commit,
  features,
  deadlineMs = 5000,
  application = 'QuickTime Player',
} = {}) {
  if (
    typeof launcher?.subscribe !== 'function' ||
    !['QuickTime Player', 'TalkQTE Lab Player'].includes(application) ||
    !/^[a-f0-9]{40}$/.test(commit ?? '') ||
    !Array.isArray(features) ||
    features.length !== 4 ||
    new Set(features).size !== 4 ||
    ![
      'lab-evaluator',
      'local-whisper',
      'native-audio-spike',
      'timing-log',
    ].every((f) => features.includes(f)) ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 10000
  )
    throw gateFailure('protocol');
  let identity = null,
    session = null,
    tuple = null,
    acknowledged = false,
    legacyStarted = false,
    terminal = false,
    closed = false,
    waiter = null,
    timer,
    signal,
    abort;
  const listeners = new Set();
  const fail = () => {
    if (terminal) return;
    terminal = true;
    clearTimeout(timer);
    waiter?.reject(gateFailure('protocol'));
    // Snapshot before callbacks: throwing or reentrant unsubscription cannot
    // suppress another owner's terminal notification. Preserve the failure.
    for (const listener of [...listeners]) {
      try {
        listener(Object.freeze({ type: 'failed' }));
      } catch {
        // Observers cannot veto root Stop or replace the protocol failure.
      }
    }
  };
  const sameOwner = () =>
    identity &&
    ['pid', 'executable', 'runId'].every(
      (k) => launcher.identity?.[k] === identity[k],
    );
  const ready = () => {
    if (!tuple || !waiter || terminal) return;
    if (!sameOwner() || waiter.runId !== identity.runId) return fail();
    clearTimeout(timer);
    waiter.resolve(
      Object.freeze({
        runId: identity.runId,
        listening: true,
        historical: true,
        version: 1,
        sessionId: session,
        source: Object.freeze({ ...tuple }),
      }),
    );
  };
  const unsubscribe = launcher.subscribe((event) => {
    if (terminal) return;
    if (event.event === 'dev_stop') {
      if (
        event.step !== 'armed' ||
        identity ||
        !launcher.identity ||
        event.run_id !== launcher.identity.runId ||
        !Number.isSafeInteger(launcher.identity.pid) ||
        launcher.identity.pid <= 0 ||
        typeof launcher.identity.executable !== 'string'
      )
        return fail();
      identity = { ...launcher.identity };
    } else if (event.event === 'session') {
      if (
        !sameOwner() ||
        session ||
        event.state !== 'started' ||
        !u64(event.session) ||
        event.commit !== commit ||
        !Array.isArray(event.features) ||
        event.features.length !== features.length ||
        new Set(event.features).size !== features.length ||
        !features.every((f) => event.features.includes(f))
      )
        return fail();
      session = event.session;
    } else if (event.event === 'dev_source') {
      if (!sameOwner() || event.application !== application) return fail();
      if (event.step === 'acknowledged' && !acknowledged) acknowledged = true;
      // Legacy started is historical only, never readiness in v1.
      else if (event.step === 'started' && acknowledged && !legacyStarted)
        legacyStarted = true;
      else return fail();
    } else if (event.event === 'dev_source_observation') {
      if (
        !sameOwner() ||
        event.version !== 1 ||
        event.run_id !== identity.runId ||
        event.application !== application ||
        !acknowledged ||
        !session ||
        event.session !== session ||
        !u64(event.session) ||
        !/^[a-f0-9]{32}$/.test(event.host_operation ?? '') ||
        !/^[a-f0-9]{64}$/.test(event.live_operation ?? '') ||
        event.step !== 'listening' ||
        tuple
      )
        return fail();
      tuple = { ...event };
      ready();
    } else return fail();
  });
  return Object.freeze({
    mode: 'v1',
    subscribe(listener) {
      if (terminal || typeof listener !== 'function' || listeners.size >= 8)
        throw gateFailure('protocol');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitListening({ runId, signal: inputSignal } = {}) {
      if (
        waiter ||
        terminal ||
        inputSignal?.aborted ||
        runId !== launcher.identity?.runId
      )
        return Promise.reject(gateFailure('protocol'));
      signal = inputSignal;
      const promise = new Promise(
        (resolve, reject) => (waiter = { resolve, reject, runId }),
      );
      timer = setTimeout(fail, deadlineMs);
      abort = fail;
      signal?.addEventListener('abort', abort, { once: true });
      // Keep abort subscription after readiness: retirement/Stop must abort root.
      ready();
      return promise;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        fail();
      } finally {
        try {
          unsubscribe();
        } finally {
          listeners.clear();
          signal?.removeEventListener('abort', abort);
        }
      }
    },
  });
}
