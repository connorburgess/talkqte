// Historical Listening evidence from one launcher's validated private stream.
// The native event has no operation identity; this does not make it atomic.
import { gateFailure } from './cue-lab-operation-gate.mjs';

export function createLabListening({
  launcher,
  commit,
  features,
  deadlineMs = 5000,
} = {}) {
  if (
    typeof launcher?.subscribe !== 'function' ||
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
  let armed = false,
    session = null,
    started = false,
    acknowledged = false,
    terminal = false,
    waiter = null,
    timer,
    abort,
    signal,
    boundRun = null,
    boundIdentity = null;
  const fail = () => {
    terminal = true;
    waiter?.reject(gateFailure('protocol'));
    clearTimeout(timer);
  };
  const ready = () => {
    const identity = launcher.identity;
    if (!waiter || !started) return;
    if (
      !identity ||
      identity.runId !== boundRun ||
      ['pid', 'executable', 'runId'].some(
        (k) => identity[k] !== boundIdentity?.[k],
      ) ||
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0
    )
      return fail();
    clearTimeout(timer);
    waiter.resolve(
      Object.freeze({
        runId: boundRun,
        listening: true,
        historical: true,
        session,
      }),
    );
  };
  const unsubscribe = launcher.subscribe((event) => {
    if (terminal) return;
    if (event.event === 'dev_stop') {
      if (
        event.step !== 'armed' ||
        armed ||
        event.run_id !== launcher.identity?.runId
      )
        return fail();
      boundIdentity = structuredClone(launcher.identity);
      armed = true;
    } else if (event.event === 'session') {
      if (
        !armed ||
        event.state !== 'started' ||
        session !== null ||
        !Number.isSafeInteger(event.session) ||
        event.session < 0 ||
        event.commit !== commit ||
        !Array.isArray(event.features) ||
        event.features.length !== features.length ||
        new Set(event.features).size !== features.length ||
        !features.every((f) => event.features.includes(f))
      )
        return fail();
      session = event.session;
    } else if (event.event === 'dev_source') {
      if (event.application !== 'QuickTime Player') return fail();
      if (event.step === 'acknowledged' && armed && !acknowledged)
        acknowledged = true;
      else if (
        event.step === 'started' &&
        armed &&
        acknowledged &&
        session !== null &&
        !started
      ) {
        started = true;
        ready();
      } else return fail();
    } else return fail();
  });
  return Object.freeze({
    waitListening({ runId, signal: inputSignal } = {}) {
      if (
        waiter ||
        terminal ||
        inputSignal?.aborted ||
        runId !== launcher.identity?.runId ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(runId ?? '')
      )
        return Promise.reject(gateFailure('protocol'));
      boundRun = runId;
      signal = inputSignal;
      const promise = new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
      timer = setTimeout(fail, deadlineMs);
      abort = fail;
      signal?.addEventListener('abort', abort, { once: true });
      promise
        .finally(() => signal?.removeEventListener('abort', abort))
        .catch(() => {});
      ready();
      return promise;
    },
    close() {
      fail();
      unsubscribe();
      signal?.removeEventListener('abort', abort);
    },
  });
}
