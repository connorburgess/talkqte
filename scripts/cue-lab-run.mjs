// Run ownership only: native launch/control is an explicit injected dependency.
// No daemon, desktop controls, provider fallback or implicit native launch.
import { randomUUID } from 'node:crypto';
import {
  openLabProvider,
  PROVIDER_FAILURE_CATEGORIES,
} from './cue-lab-provider.mjs';
import { openLabBroker } from './cue-lab-broker.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';

const EVENTS = new Set([
  'stop-requested',
  'session-ended',
  'process-ended',
  'failed',
]);
// Fixed codes only. Provider-preflight categories keep their own code so a
// startup failure says why (for example ambient credentials or a missing CLI).
const STARTUP_REASONS = new Set([
  ...EVENTS,
  ...PROVIDER_FAILURE_CATEGORIES,
  'cancelled',
  'closed',
  'cleanup',
  'deadline',
  'dispatch-limit',
  'invalid-reply',
  'protocol',
  'provider',
]);

export function createLabRun({
  settings,
  native,
  signal,
  processEvents = process,
  startupMs = 10000,
  releaseMs = 12000,
  sourceSessionMode = 'required',
  runId = randomUUID(),
  // Direct API route: after native start, wait (untimed here; the take
  // bounds the wait) for approve(), then open the provider and give the
  // rest of startup a fresh startupMs.
  approvalBudgetMs = 0,
} = {}) {
  if (
    !settings ||
    ![0, 180000].includes(approvalBudgetMs) ||
    (approvalBudgetMs > 0 && settings.provider !== 'anthropic-api') ||
    typeof runId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(runId) ||
    !['required', 'legacy-fixture'].includes(sourceSessionMode) ||
    (sourceSessionMode === 'legacy-fixture' &&
      settings.execution !== 'offline-stand-in') ||
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
  let provider = null,
    broker = null,
    nativeStarted = false,
    phase = 'starting',
    closing = null,
    terminal = null,
    expectedSourceSession = null,
    clockCalibration = null,
    playback = null,
    playbackResolve,
    unsubscribe = () => {},
    initialized = false;
  let controlCancelled = false;
  // Content-free startup diagnostics: a fixed stage and the first fixed failure
  // reason before readiness. Later teardown reasons never replace the first.
  let startupStage = 'provider-preflight',
    startupFailure = null;
  const recordStartupFailure = (reason) => {
    if (startupStage === 'ready' || startupFailure) return;
    startupFailure = Object.freeze({
      stage: startupStage,
      reason: STARTUP_REASONS.has(reason) ? reason : 'protocol',
    });
  };
  const played = new Promise((resolve) => (playbackResolve = resolve));
  let approveResolve,
    approveCalled = false,
    providerOpenedResolve,
    providerOpenedReject;
  const approved = new Promise((resolve) => (approveResolve = resolve));
  const providerOpened = new Promise((resolve, reject) => {
    providerOpenedResolve = resolve;
    providerOpenedReject = reject;
  });
  providerOpened.catch(() => {});
  let rejectStopped;
  const stopped = new Promise((_, reject) => (rejectStopped = reject));
  stopped.catch(() => {});
  // The first reason anything stopped this run, at any stage, as a fixed
  // label: a native owner event, a provider or broker category, cancelled.
  let firstStopReason = null;
  // A mid-run turn-off (native.turnOff): asked, its outcome, and whether
  // the run's first stop came after it was asked.
  let offAsked = false,
    offOutcome = null,
    stoppedAfterOff = null;
  const stop = (reason = 'cancelled') => {
    stoppedAfterOff ??= offAsked;
    firstStopReason ??= STARTUP_REASONS.has(reason) ? reason : 'protocol';
    recordStartupFailure(reason);
    if (!terminal) terminal = reason === 'cleanup' ? 'cleanup' : 'cancelled';
    return close();
  };
  const fail = (reason) => {
    void stop(reason).catch(() => {});
  };
  const onNative = (event) => {
    const handle = () => {
      if (!event || !EVENTS.has(event.type)) return fail('protocol');
      if (event.type === 'stop-requested') controlCancelled = true;
      fail(event.type);
    };
    if (initialized) handle();
    else queueMicrotask(handle);
  };
  const abort = () => {
    controlCancelled = true;
    fail('cancelled');
  };
  // Install these before any provider preflight, broker creation or native start.
  unsubscribe = native.subscribe(onNative);
  if (typeof unsubscribe !== 'function') throw gateFailure('protocol');
  processEvents.on('SIGINT', abort);
  processEvents.on('SIGTERM', abort);
  signal?.addEventListener('abort', abort, { once: true });

  const startup = Promise.resolve().then(async () => {
    if (root.signal.aborted) throw gateFailure('cancelled');
    provider = await openLabProvider({
      ...config,
      contextPolicy:
        config.contextPolicy === 'bounded-history'
          ? 'fresh-only'
          : (config.contextPolicy ?? 'fresh-only'),
      signal: root.signal,
      ...(approvalBudgetMs ? { deferOpen: true } : {}),
    });
    if (root.signal.aborted) throw gateFailure('cancelled');
    startupStage = 'broker-preparation';
    broker = await openLabBroker({
      provider,
      contextPolicy:
        config.contextPolicy === 'bounded-history'
          ? 'fresh-only'
          : (config.contextPolicy ?? 'fresh-only'),
      sourceSessionMode,
      runId,
      maxCalls: config.maxCalls,
      signal: root.signal,
      onTerminal: (category) => {
        recordStartupFailure(category);
        queueMicrotask(() => fail('cancelled'));
      },
    });
    if (root.signal.aborted) throw gateFailure('cancelled');
    if (expectedSourceSession)
      broker.expectSourceSession(expectedSourceSession);
    if (playback) broker.acknowledgePlaybackStart(playback);
    // The native owner gets only the descriptor path and pinned metadata.
    // start must be abort-aware and must retain ownership until stop/release.
    nativeStarted = true;
    startupStage = 'native-start';
    await native.start({
      descriptorPath: broker.descriptorPath,
      runId,
      metadata: provider.metadata,
      signal: root.signal,
    });
    if (root.signal.aborted) throw gateFailure('cancelled');
    if (approvalBudgetMs) {
      // The approval wait is not startup time: pause the startup clock,
      // then open the provider (key file, worker) only once approved.
      clearTimeout(timer);
      startupStage = 'awaiting-approval';
      await Promise.race([approved, stopped]);
      startupStage = 'provider-open';
      timer = setTimeout(() => fail('deadline'), startupMs);
      try {
        await Promise.race([provider.open(), stopped]);
      } catch (error) {
        providerOpenedReject(gateFailure('cancelled'));
        throw error;
      }
      if (root.signal.aborted) throw gateFailure('cancelled');
      providerOpenedResolve();
    }
    phase = 'waiting-for-anchors';
    startupStage = 'awaiting-hello';
    await Promise.race([broker.ready, stopped]);
    startupStage = 'clock-calibration';
    const calibrated = await broker.calibrateClock();
    if (
      sourceSessionMode === 'required' &&
      calibrated.sessionId !== expectedSourceSession
    )
      throw gateFailure('protocol');
    clockCalibration = Object.freeze({ ...calibrated });
    startupStage = 'playback-anchor';
    await Promise.race([played, stopped]);
    if (root.signal.aborted || broker.gate.terminal)
      throw gateFailure('cancelled');
    phase = 'ready';
    startupStage = 'ready';
  });
  let timer = setTimeout(() => fail('deadline'), startupMs);
  const ready = Promise.race([startup, stopped]).finally(() =>
    clearTimeout(timer),
  );
  ready.catch((error) => {
    recordStartupFailure(error?.category);
    fail('cancelled');
  });

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
    recordStartupFailure(controlCancelled ? 'cancelled' : terminal);
    phase = 'stopping';
    // This does not depend on native authentication or signal delivery.
    // A fixed reason crosses the owner boundary without conflating provider or
    // native failure with an explicit owner/host cancellation.
    root.abort(controlCancelled ? 'cancelled' : 'failed');
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
    signal: root.signal,
    ready,
    stop(reason) {
      controlCancelled = true;
      return stop(reason);
    },
    // The owner approved the connection in the app (direct API route only).
    // Resolves once the provider is open, so nothing can be sent before.
    approve() {
      if (!approvalBudgetMs || approveCalled || terminal) {
        fail('protocol');
        return Promise.reject(gateFailure('protocol'));
      }
      approveCalled = true;
      approveResolve();
      return Promise.race([providerOpened, stopped]);
    },
    close,
    get phase() {
      return phase;
    },
    get dispatchesUsed() {
      return broker?.gate.dispatchesUsed ?? 0;
    },
    get clockCalibration() {
      return clockCalibration;
    },
    // Content-free counts and per-call timing receipts for private evidence.
    get evaluationSummary() {
      return broker?.evaluationSummary ?? null;
    },
    get providerReceipts() {
      return provider?.receipts ?? null;
    },
    // Estimated direct API spend so far; null for routes without one.
    get providerSpentMicroUsd() {
      return provider?.spentMicroUsd ?? null;
    },
    get stopReason() {
      return firstStopReason;
    },
    // Asks native once to turn cue processing off, as Disable processing
    // does: only when ready and nothing has stopped the run. The end that
    // may follow (the lab cue run or session ending) stops the run as any
    // native end does; ordinary Stop and cleanup are unchanged.
    turnOff() {
      if (
        offAsked ||
        typeof native.turnOff !== 'function' ||
        phase !== 'ready' ||
        terminal ||
        broker.gate.terminal
      )
        return Promise.reject(gateFailure('protocol'));
      offAsked = true;
      let asked;
      try {
        asked = Promise.resolve(native.turnOff());
      } catch (error) {
        asked = Promise.reject(error);
      }
      return asked.then(
        (result) => {
          if (result?.turnedOff !== true) throw gateFailure('protocol');
          offOutcome = 'done';
          return Object.freeze({ turnedOff: true });
        },
        (error) => {
          offOutcome = error?.category === 'deadline' ? 'no-outcome' : 'failed';
          throw gateFailure(offOutcome === 'failed' ? 'protocol' : 'deadline');
        },
      );
    },
    get turnOffState() {
      return offAsked
        ? Object.freeze({
            outcome: offOutcome,
            stoppedAfter: stoppedAfterOff === true,
          })
        : null;
    },
    get startupDiagnostics() {
      return Object.freeze({
        stage: startupStage,
        failure: startupFailure,
        broker: broker?.startupDiagnostics ?? null,
      });
    },
    expectSourceSession(value) {
      if (
        terminal ||
        expectedSourceSession ||
        sourceSessionMode !== 'required' ||
        typeof value !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(value) ||
        BigInt(value) > 18446744073709551615n
      ) {
        fail('protocol');
        throw gateFailure('protocol');
      }
      expectedSourceSession = value;
      try {
        broker?.expectSourceSession(value);
      } catch {
        fail('protocol');
        throw gateFailure('protocol');
      }
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
