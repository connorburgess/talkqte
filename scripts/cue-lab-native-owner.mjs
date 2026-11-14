// Native owns the approved launch and its unique private timing stream.
// This wrapper retains that exact child handle; it never signals an arbitrary PID.
import { isAbsolute } from 'node:path';
import { gateFailure } from './cue-lab-operation-gate.mjs';

export function createLabNativeOwner({
  executable,
  launch,
  armingMs = 5000,
  releaseMs = 6000,
} = {}) {
  if (
    !isAbsolute(executable ?? '') ||
    typeof launch !== 'function' ||
    ![armingMs, releaseMs].every(
      (n) => Number.isSafeInteger(n) && n >= 1 && n <= 10000,
    )
  )
    throw gateFailure('protocol');
  const listeners = new Set();
  let child = null,
    pid = null,
    runId = null,
    began = false,
    armed = false,
    requested = false,
    signalled = false,
    released = false,
    failed = false,
    armingTimer,
    releaseTimer,
    resolveArmed,
    rejectArmed,
    resolveReleased,
    rejectReleased;
  const ready = new Promise((yes, no) => {
    resolveArmed = yes;
    rejectArmed = no;
  });
  const release = new Promise((yes, no) => {
    resolveReleased = yes;
    rejectReleased = no;
  });
  ready.catch(() => {});
  release.catch(() => {});
  const emit = (type) => {
    for (const listener of listeners) listener({ type });
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    clearTimeout(armingTimer);
    clearTimeout(releaseTimer);
    rejectArmed(gateFailure('cleanup'));
    rejectReleased(gateFailure('cleanup'));
    emit('failed');
  };
  const sendStop = () => {
    if (!requested || !armed || signalled || released || failed || !child)
      return;
    if (
      child.pid !== pid ||
      child.spawnfile !== executable ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return fail();
    signalled = true;
    releaseTimer ??= setTimeout(fail, releaseMs);
    try {
      if (child.kill('SIGUSR2') !== true) fail();
    } catch {
      fail();
    }
  };
  const onTiming = (event) => {
    if (failed || !began) return;
    if (event?.event === 'dev_stop') {
      // launch must bind this callback to the exact child's private stream.
      if (event.run_id !== runId) return fail();
      if (event.step === 'armed') {
        if (armed || released) return fail();
        armed = true;
        clearTimeout(armingTimer);
        resolveArmed();
        sendStop();
      } else if (event.step === 'released') {
        if (!armed || released) return fail();
        released = true;
        clearTimeout(releaseTimer);
        resolveReleased({ released: true });
        emit('session-ended');
      } else if (event.step === 'latched' || event.step === 'stopping') {
        if (!armed) return fail();
        emit('stop-requested');
      } else fail();
    } else if (
      event?.event === 'source_problem' ||
      event?.event === 'dropped' ||
      (event?.event === 'dev_source' && event.step === 'refused')
    )
      fail();
    else if (event?.event === 'session' && event.state === 'ended')
      emit('session-ended');
    // Transcript/cue text and receipt clocks never enter the lifecycle.
  };
  return Object.freeze({
    subscribe(listener) {
      if (typeof listener !== 'function' || listeners.size)
        throw gateFailure('protocol');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start({ descriptorPath, runId: id, metadata, signal }) {
      if (
        began ||
        requested ||
        failed ||
        signal?.aborted ||
        typeof id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
        !isAbsolute(descriptorPath ?? '') ||
        !['codex', 'claude-code'].includes(metadata?.provider) ||
        typeof metadata.model !== 'string' ||
        typeof metadata.effort !== 'string'
      )
        throw gateFailure('protocol');
      began = true;
      runId = id;
      armingTimer = setTimeout(fail, armingMs);
      try {
        child = launch({
          executable,
          environment: Object.freeze({
            TALKQTE_DEV_STOP_SIGNAL: 'usr2',
            TALKQTE_DEV_LAB_RUN_ID: id,
            TALKQTE_DEV_CUE_BACKEND: 'lab-subscription',
            TALKQTE_DEV_LAB_DESCRIPTOR: descriptorPath,
            TALKQTE_DEV_LAB_PROVIDER: metadata.provider,
            TALKQTE_DEV_LAB_MODEL: metadata.model,
            TALKQTE_DEV_LAB_EFFORT: metadata.effort,
          }),
          onTiming,
        });
        // A synchronous owned ChildProcess is required, never an existing PID.
        if (
          !child ||
          !Number.isSafeInteger(child.pid) ||
          child.pid <= 0 ||
          child.pid === process.pid ||
          child.spawnfile !== executable ||
          typeof child.kill !== 'function' ||
          typeof child.once !== 'function'
        )
          throw gateFailure('protocol');
        pid = child.pid;
        child.once('exit', () => {
          emit('process-ended');
          if (!released) fail();
        });
        child.once('error', fail);
        sendStop(); // Also handles an armed event emitted during launch.
        await ready;
      } catch {
        fail();
        throw gateFailure('cleanup');
      }
    },
    stop() {
      requested = true;
      if (!began) {
        released = true; // This owner never launched a native source/process.
        resolveReleased({ released: true });
      } else if (!released && !failed) {
        sendStop(); // Arming keeps its own deadline; release begins after signal.
      }
      return release;
    },
  });
}
