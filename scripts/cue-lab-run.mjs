// Run ownership only: native launch/control is an explicit injected dependency.
// No daemon, desktop controls, provider fallback or implicit native launch.
import { randomUUID } from 'node:crypto';
import { openLabProvider } from './cue-lab-provider.mjs';
import { openLabBroker } from './cue-lab-broker.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';

const EVENTS = new Set([
  'stop-requested',
  'session-ended',
  'process-ended',
  'failed',
]);

export function createLabRun({
  settings,
  native,
  signal,
  processEvents = process,
  startupMs = 10000,
  releaseMs = 12000,
} = {}) {
  if (
    !settings ||
    !native ||
    !['subscribe', 'start', 'stop'].every(
      (method) => typeof native[method] === 'function',
    ) ||
    !Number.isSafeInteger(startupMs) ||
    startupMs < 1 ||
    startupMs > 30000 ||
    !Number.isSafeInteger(releaseMs) ||
    releaseMs < 1 ||
    releaseMs > 20000 ||
    typeof processEvents?.on !== 'function' ||
    typeof processEvents?.off !== 'function'
  )
    throw gateFailure('protocol');
  // Caller-owned settings cannot change provider/model/cap during startup.
  const config = Object.freeze({
    ...settings,
    environment: Object.freeze({ ...(settings.environment ?? process.env) }),
    ...(settings.openers
      ? { openers: Object.freeze({ ...settings.openers }) }
      : {}),
  });
  const root = new AbortController();
  const runId = randomUUID();
  let provider = null,
    broker = null,
    nativeStarted = false,
    phase = 'starting',
    closing = null,
    terminal = null,
    playback = null,
    playbackResolve,
    unsubscribe = () => {},
    initialized = false;
  const played = new Promise((resolve) => (playbackResolve = resolve));
  let rejectStopped;
  const stopped = new Promise((_, reject) => (rejectStopped = reject));
  stopped.catch(() => {});
  const stop = (reason = 'cancelled') => {
    if (!terminal) terminal = reason === 'cleanup' ? 'cleanup' : 'cancelled';
    return close();
  };
  const fail = (reason) => {
    void stop(reason).catch(() => {});
  };
  const onNative = (event) => {
    const handle = () => {
      if (!event || !EVENTS.has(event.type)) return fail('protocol');
      fail(event.type);
    };
    if (initialized) handle();
    else queueMicrotask(handle);
  };
  const abort = () => fail('cancelled');
  // Install these before any provider preflight, broker creation or native start.
  unsubscribe = native.subscribe(onNative);
  if (typeof unsubscribe !== 'function') throw gateFailure('protocol');
  processEvents.on('SIGINT', abort);
  processEvents.on('SIGTERM', abort);
  signal?.addEventListener('abort', abort, { once: true });

  const startup = Promise.resolve().then(async () => {
    if (root.signal.aborted) throw gateFailure('cancelled');
    provider = await openLabProvider({ ...config, signal: root.signal });
    if (root.signal.aborted) throw gateFailure('cancelled');
    broker = await openLabBroker({
      provider,
      runId,
      maxCalls: config.maxCalls,
      signal: root.signal,
      onTerminal: () => queueMicrotask(() => fail('cancelled')),
    });
    if (root.signal.aborted) throw gateFailure('cancelled');
    if (playback) broker.acknowledgePlaybackStart(playback);
    // The native owner gets only the descriptor path and pinned metadata.
    // start must be abort-aware and must retain ownership until stop/release.
    nativeStarted = true;
    await native.start({
      descriptorPath: broker.descriptorPath,
      runId,
      metadata: provider.metadata,
      signal: root.signal,
    });
    if (root.signal.aborted) throw gateFailure('cancelled');
    phase = 'waiting-for-anchors';
    await Promise.race([broker.ready, stopped]);
    await broker.calibrateClock();
    await Promise.race([played, stopped]);
    if (root.signal.aborted || broker.gate.terminal)
      throw gateFailure('cancelled');
    phase = 'ready';
  });
  const timer = setTimeout(() => fail('deadline'), startupMs);
  const ready = Promise.race([startup, stopped]).finally(() =>
    clearTimeout(timer),
  );
  ready.catch(() => fail('cancelled'));

  function close() {
    if (closing) return closing;
    let resolveClosing, rejectClosing;
    // Reserve ownership before abort/native/teardown callbacks can re-enter.
    closing = new Promise((resolve, reject) => {
      resolveClosing = resolve;
      rejectClosing = reject;
    });
    closing.catch(() => {});
    terminal ??= 'cancelled';
    phase = 'stopping';
    // This does not depend on native authentication or signal delivery.
    root.abort();
    broker?.gate.stop(terminal);
    rejectStopped(gateFailure(terminal));
    (async () => {
      // Creation/start callbacks must settle on abort. Never detach a late
      // provider/broker creation and accidentally leak it after cleanup.
      let released = !nativeStarted;
      let releaseFailed = false;
      let releaseTimer;
      let stoppingNative;
      if (nativeStarted) {
        try {
          stoppingNative = Promise.resolve(native.stop());
        } catch (error) {
          stoppingNative = Promise.reject(error);
        }
      }
      const nativeRelease = nativeStarted
        ? Promise.race([
            stoppingNative.then((result) => {
              if (result?.released !== true) throw gateFailure('cleanup');
              released = true;
            }),
            new Promise((_, reject) => {
              releaseTimer = setTimeout(
                () => reject(gateFailure('cleanup')),
                releaseMs,
              );
            }),
          ])
            .catch(() => {
              releaseFailed = true;
            })
            .finally(() => clearTimeout(releaseTimer))
        : Promise.resolve();
      let providerFailed = false;
      const providerRelease = startup
        .catch(() => {})
        .then(() => (broker ? broker.close() : provider?.close()))
        .catch(() => {
          providerFailed = true;
        });
      await Promise.all([nativeRelease, providerRelease]);
      unsubscribe();
      processEvents.off('SIGINT', abort);
      processEvents.off('SIGTERM', abort);
      signal?.removeEventListener('abort', abort);
      clearTimeout(timer);
      if (!released || releaseFailed || providerFailed) {
        terminal = 'cleanup';
        phase = 'failed-cleanup';
        throw gateFailure('cleanup');
      }
      phase = 'closed';
    })().then(resolveClosing, rejectClosing);
    return closing;
  }
  initialized = true;
  if (signal?.aborted) abort();
  const requireReady = () => {
    if (phase !== 'ready' || terminal || broker.gate.terminal) {
      fail('protocol');
      throw gateFailure('protocol');
    }
  };
  return Object.freeze({
    ready,
    stop,
    close,
    get phase() {
      return phase;
    },
    get dispatchesUsed() {
      return broker?.gate.dispatchesUsed ?? 0;
    },
    acknowledgePlaybackStart(anchor) {
      if (terminal || playback) {
        fail('protocol');
        throw gateFailure('protocol');
      }
      // Validate now even if the broker is still being constructed.
      if (
        !Number.isFinite(anchor?.monotonicMs) ||
        anchor.monotonicMs < 0 ||
        anchor.monotonicMs > performance.now() ||
        !Number.isFinite(anchor.uncertaintyMs) ||
        anchor.uncertaintyMs < 0 ||
        anchor.uncertaintyMs > 100
      ) {
        fail('protocol');
        throw gateFailure('protocol');
      }
      playback = Object.freeze({ ...anchor });
      try {
        broker?.acknowledgePlaybackStart(playback);
        playbackResolve();
      } catch {
        fail('protocol');
        throw gateFailure('protocol');
      }
    },
    gate: Object.freeze({
      run(task, options) {
        requireReady();
        return broker.gate.run(task, options);
      },
      waitIdle(options) {
        requireReady();
        return broker.gate.waitIdle(options);
      },
    }),
    request(request) {
      requireReady();
      return broker.gate.request(request);
    },
    cuesAt(nowMs) {
      requireReady();
      try {
        return broker.cuesAt(nowMs);
      } catch {
        fail('protocol');
        throw gateFailure('protocol');
      }
    },
  });
}
