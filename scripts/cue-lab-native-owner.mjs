// Native owns the approved launch and its unique private timing stream.
// This wrapper retains that exact child handle; it never signals an arbitrary PID.
import { isAbsolute } from 'node:path';
import { gateFailure } from './cue-lab-operation-gate.mjs';

export function createLabNativeOwner({
  executable,
  launch,
  stopAfterS,
  armingMs = 5000,
  releaseMs = 6000,
  mode = 'model-enabled',
  // Prepared for one mid-run turn-off (TALKQTE_DEV_OFF_SIGNAL, native
  // dev_off.rs) and how long its outcome row may take after SIGUSR1.
  turnOff = false,
  offMs = 2000,
} = {}) {
  if (
    !['capture-only', 'model-enabled'].includes(mode) ||
    typeof turnOff !== 'boolean' ||
    (turnOff && mode !== 'model-enabled') ||
    !Number.isSafeInteger(offMs) ||
    offMs < 1 ||
    offMs > 10000 ||
    !isAbsolute(executable ?? '') ||
    typeof launch !== 'function' ||
    !Number.isSafeInteger(stopAfterS) ||
    stopAfterS < 1 ||
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
    // The turn-off: signal sent, `latched` seen, and its outcome row.
    offSent = false,
    offLatched = false,
    offOutcome = null,
    offRepeats = 0,
    offTimer,
    settleOff = () => {},
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
    settleOff(gateFailure('cleanup'));
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
    } else if (event?.event === 'dev_off') {
      // Only this owner's single signal may start the turn-off. A later
      // signal from anywhere is a recorded no-op natively, counted here.
      if (event.run_id !== runId || !turnOff) return fail();
      if (event.step === 'latched') {
        if (!offSent || offLatched) return fail();
        offLatched = true;
      } else if (event.step === 'done' || event.step === 'failed') {
        if (!offLatched || offOutcome) return fail();
        offOutcome = event.step;
        settleOff(event.step === 'done' ? null : gateFailure('protocol'));
      } else if (event.step === 'repeated') {
        if (!offOutcome) return fail();
        offRepeats++;
      } else fail();
    } else if (
      event?.event === 'source_problem' ||
      event?.event === 'dropped' ||
      (event?.event === 'dev_source' && event.step === 'refused')
    )
      fail();
    else if (
      (event?.event === 'session' && event.state === 'ended') ||
      event?.event === 'source_ended'
    )
      emit('session-ended');
    else if (event?.event === 'dev_source' && event.step === 'stopping')
      emit('stop-requested');
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
        (mode === 'capture-only'
          ? descriptorPath !== undefined || metadata !== undefined
          : !isAbsolute(descriptorPath ?? '') ||
            !['codex', 'claude-code', 'anthropic-api'].includes(
              metadata?.provider,
            ) ||
            (metadata.provider === 'anthropic-api') !==
              Number.isSafeInteger(metadata.spendCapMicroUsd) ||
            typeof metadata.model !== 'string' ||
            typeof metadata.effort !== 'string')
      )
        throw gateFailure('protocol');
      began = true;
      runId = id;
      try {
        child = launch({
          executable,
          metadata,
          environment: Object.freeze({
            TALKQTE_DEV_STOP_SIGNAL: 'usr2',
            TALKQTE_DEV_STOP_AFTER_S: String(stopAfterS),
            TALKQTE_DEV_LAB_RUN_ID: id,
            ...(turnOff ? { TALKQTE_DEV_OFF_SIGNAL: 'usr1' } : {}),
            ...(mode === 'model-enabled'
              ? {
                  TALKQTE_DEV_CUE_BACKEND:
                    metadata.provider === 'anthropic-api'
                      ? 'lab-api'
                      : 'lab-subscription',
                  TALKQTE_DEV_LAB_DESCRIPTOR: descriptorPath,
                  TALKQTE_DEV_LAB_PROVIDER: metadata.provider,
                  TALKQTE_DEV_LAB_MODEL: metadata.model,
                  TALKQTE_DEV_LAB_EFFORT: metadata.effort,
                  ...(metadata.provider === 'anthropic-api'
                    ? {
                        TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD: String(
                          metadata.spendCapMicroUsd,
                        ),
                      }
                    : {}),
                }
              : {}),
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
        if (!armed) armingTimer = setTimeout(fail, armingMs);
        sendStop(); // Also handles an armed event emitted during launch.
        await ready;
      } catch {
        fail();
        throw gateFailure('cleanup');
      }
    },
    // Asks native once, by SIGUSR1 to the exact owned child, to turn cue
    // processing off. Only after `armed` and before any Stop was asked for:
    // it never races the Stop. Resolves on native's `done` row; rejects on
    // `failed`, on no outcome within offMs, or when not allowed. It starts
    // nothing, and a rejection leaves the ordinary Stop to the caller.
    turnOff() {
      if (
        !turnOff ||
        offSent ||
        !armed ||
        requested ||
        signalled ||
        released ||
        failed ||
        !child
      )
        return Promise.reject(gateFailure('protocol'));
      if (
        child.pid !== pid ||
        child.spawnfile !== executable ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        fail();
        return Promise.reject(gateFailure('cleanup'));
      }
      offSent = true;
      const outcome = new Promise((resolve, reject) => {
        settleOff = (error) => {
          settleOff = () => {};
          clearTimeout(offTimer);
          if (error) reject(error);
          else resolve({ turnedOff: true });
        };
      });
      outcome.catch(() => {});
      offTimer = setTimeout(() => settleOff(gateFailure('deadline')), offMs);
      try {
        if (child.kill('SIGUSR1') !== true) fail();
      } catch {
        fail();
      }
      return outcome;
    },
    // The turn-off so far: null when not prepared for one.
    get offState() {
      return turnOff
        ? Object.freeze({
            sent: offSent,
            outcome: offOutcome,
            repeats: offRepeats,
          })
        : null;
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
