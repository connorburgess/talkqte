// Prepared fictional media only. Player/recorder/Listening observations must
// come from explicit adapters; this module supplies no desktop or model action.
import { isAbsolute } from 'node:path';
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';
import { createLabRun } from './cue-lab-run.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';
import { LAB_PLAYER_MEDIA_SHA256 } from './cue-lab-player.mjs';

const required = (condition) => {
  if (!condition) throw gateFailure('protocol');
};
export function createPreparedTake(options) {
  required(options?.body === undefined);
  return createLabPlaybackSession(options);
}

// Fixed saved-meeting model recording. It shares the existing provider/broker
// owner; this wrapper cannot create a second gate, retry or change the media.
export function createFixedModelTake(options) {
  required(
    options?.body === undefined &&
      options?.settings?.provider === 'codex' &&
      options.settings.model === 'gpt-6.1-sol' &&
      // Exactly the efforts the signed native lab build accepts.
      ['low', 'medium'].includes(options.settings.effort) &&
      options.settings.maxCalls === 20 &&
      options.stopAfterS === 110 &&
      options.media?.sha256 === LAB_PLAYER_MEDIA_SHA256 &&
      options.media.durationMs === 102480,
  );
  return createPreparedTake({ ...options, fixedSource: true });
}

// Adaptive follow-up may reuse ownership with an explicitly labelled neutral
// bootstrap media file and a separate body. It cannot alter prepared-take flow.
export function createLabPlaybackSession({
  launcher,
  settings,
  runId,
  stopAfterS,
  media,
  source,
  player,
  recorder,
  body,
  signal,
  processEvents = process,
  startupMs = 10000,
  releaseMs = 12000,
  armingMs = 5000,
  nativeReleaseMs = 6000,
  takeMs = 135000,
  fixedSource = false,
  recorderMs = 3000,
  startBudgetMs = 1000,
  completionReserveMs = 1000,
  observe,
  onGuard,
} = {}) {
  required(
    launcher &&
      typeof launcher.launch === 'function' &&
      typeof launcher.close === 'function' &&
      isAbsolute(launcher.executable ?? '') &&
      media?.fictional === true &&
      isAbsolute(media.path ?? '') &&
      /^[a-f0-9]{64}$/.test(media.sha256 ?? '') &&
      Number.isFinite(media.durationMs) &&
      media.durationMs > 0 &&
      media.durationMs <= 105000 &&
      typeof source?.waitListening === 'function' &&
      (source.mode === 'v1' || settings?.execution === 'offline-stand-in') &&
      (source.mode !== 'v1' || typeof source.subscribe === 'function') &&
      ['prepare', 'play', 'stop', 'subscribe'].every(
        (k) => typeof player?.[k] === 'function',
      ) &&
      ['start', 'stop', 'subscribe'].every(
        (k) => typeof recorder?.[k] === 'function',
      ) &&
      Number.isSafeInteger(takeMs) &&
      takeMs > 0 &&
      takeMs <= 180000 &&
      (body === undefined ||
        (typeof body === 'function' && typeof body.close === 'function')),
  );
  required(
    (observe === undefined || typeof observe === 'function') &&
      (onGuard === undefined || typeof onGuard === 'function'),
  );
  const checkSource = () => {
    if (!fixedSource) return;
    required(
      !body &&
        source.mode === 'v1' &&
        launcher.mode === 'model-enabled' &&
        player.identity?.runId === runId &&
        launcher.playerSource === player.identity &&
        recorder.playerSource === player.identity &&
        typeof player.close === 'function' &&
        Number.isSafeInteger(player.startDeadlineMs) &&
        player.startDeadlineMs > 0 &&
        player.startDeadlineMs <= startBudgetMs &&
        Number.isSafeInteger(recorderMs) &&
        recorderMs >= 1 &&
        recorderMs <= 3000 &&
        Number.isSafeInteger(startBudgetMs) &&
        startBudgetMs >= 1 &&
        startBudgetMs <= 1000 &&
        Number.isSafeInteger(completionReserveMs) &&
        completionReserveMs >= 1000 &&
        completionReserveMs <= 3000,
    );
  };
  checkSource();
  const report = (stage, outcome = 'observed', ids = {}, timing) =>
    observe?.({
      stage,
      outcome,
      ids,
      timing: timing ?? {
        clockId: 'node',
        atMs: performance.now(),
        uncertaintyMs: 0,
        basis: 'receipt',
      },
    });
  if (body)
    required(
      media.purpose === 'neutral-calibration' &&
        typeof media.displayLabel === 'string' &&
        media.displayLabel.trim().length > 0 &&
        media.displayLabel.length <= 120 &&
        !/[\u0000-\u001f\u007f]/.test(media.displayLabel),
    );
  const identity = Object.freeze({ ...media });
  const root = new AbortController();
  let phase = 'starting',
    closing = null,
    failure = null,
    normal = false;
  let run,
    work,
    startObserved = false,
    launchInfo;
  let nativeStartedAt,
    guard = null;
  let resolveArmed, rejectArmed;
  const armed = new Promise((yes, no) => {
    resolveArmed = yes;
    rejectArmed = no;
  });
  armed.catch(() => {});
  root.signal.addEventListener(
    'abort',
    () => rejectArmed(gateFailure('cancelled')),
    { once: true },
  );
  const owner = createLabNativeOwner({
    executable: launcher.executable,
    launch: (options) => launcher.launch(options),
    stopAfterS,
    armingMs,
    releaseMs: nativeReleaseMs,
  });
  const native = {
    subscribe: owner.subscribe,
    async start(options) {
      launchInfo = { runId: options.runId };
      try {
        checkSource();
        nativeStartedAt = performance.now();
        report('run.started');
        await owner.start(options);
        resolveArmed();
      } catch {
        rejectArmed(gateFailure('cleanup'));
        throw gateFailure('cleanup');
      }
    },
    stop: owner.stop,
  };
  const subscriptions = [];
  const fail = (reason = 'protocol') => {
    if (closing) return;
    failure ??= ['cancelled', 'deadline', 'protocol'].includes(reason)
      ? reason
      : 'protocol';
    void close().catch(() => {});
  };
  // Notifications can re-enter cleanup synchronously; close reserves its promise
  // before invoking any adapter, abort handler or unsubscribe callback.
  try {
    for (const adapter of [
      player,
      recorder,
      ...(source.mode === 'v1' ? [source] : []),
    ]) {
      const unsubscribe = adapter.subscribe(() => queueMicrotask(fail));
      required(typeof unsubscribe === 'function');
      subscriptions.push(unsubscribe);
    }
    run = createLabRun({
      settings,
      ...(runId !== undefined ? { runId } : {}),
      sourceSessionMode: source.mode === 'v1' ? 'required' : 'legacy-fixture',
      native,
      signal: root.signal,
      processEvents,
      startupMs,
      releaseMs,
    });
  } catch {
    for (const unsubscribe of subscriptions) unsubscribe();
    launcher.close();
    throw gateFailure('protocol');
  }
  const onAbort = () => fail('cancelled');
  const onRunAbort = () =>
    fail(run.signal.reason === 'cancelled' ? 'cancelled' : 'protocol');
  run.signal.addEventListener('abort', onRunAbort, { once: true });
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => fail('deadline'), takeMs);
  work = Promise.resolve().then(async () => {
    if (root.signal.aborted) throw gateFailure('cancelled');
    const verified = await player.prepare({
      media: identity,
      signal: root.signal,
    });
    required(
      ['path', 'sha256', 'durationMs'].every(
        (k) => verified?.[k] === identity[k],
      ),
    );
    checkSource();
    await armed;
    if (root.signal.aborted) throw gateFailure('cancelled');
    const listening = await source.waitListening({
      ...launchInfo,
      signal: root.signal,
    });
    required(
      listening?.runId === launchInfo.runId && listening.listening === true,
    );
    if (source.mode === 'v1') {
      required(
        listening.version === 1 && typeof listening.sessionId === 'string',
      );
      run.expectSourceSession(listening.sessionId);
    }
    if (fixedSource)
      required(listening.source?.application === 'TalkQTE Lab Player');
    report('source.listening', 'observed', { sessionId: listening.sessionId });
    if (root.signal.aborted) throw gateFailure('cancelled');
    const recordTimer = fixedSource
      ? setTimeout(() => fail('deadline'), recorderMs)
      : undefined;
    let recording;
    try {
      // On expiry root Stop aborts the adapter; retain ownership of its startup
      // until it settles, rather than detaching a late recorder after a race.
      recording = await recorder.start({
        media: identity,
        ...launchInfo,
        signal: root.signal,
      });
    } finally {
      clearTimeout(recordTimer);
    }
    required(recording?.started === true);
    report('recorder.frame-accepted');
    if (root.signal.aborted) throw gateFailure('cancelled');
    if (fixedSource) {
      const sourceDeadline = nativeStartedAt + 110000;
      const startRequestAt = performance.now();
      required(
        startRequestAt +
          startBudgetMs +
          identity.durationMs +
          completionReserveMs <=
          sourceDeadline,
      );
      guard = Object.freeze({
        nativeStartedAt,
        sourceDeadline,
        startRequestAt,
        startBudgetMs,
        mediaDurationMs: identity.durationMs,
        completionReserveMs,
        remainingAtRequestMs: sourceDeadline - startRequestAt,
      });
      onGuard?.(guard);
    }
    phase = 'playing';
    // Start the actual voiced file BEFORE lazy native authentication/ready.
    // The adapter reports its actual audio-clock start, never request/receipt time.
    const playback = Promise.resolve(
      player.play({
        media: identity,
        signal: root.signal,
        onStarted(anchor) {
          try {
            required(
              !startObserved &&
                !root.signal.aborted &&
                anchor?.sha256 === identity.sha256 &&
                (!body || anchor.displayLabel === identity.displayLabel),
            );
            startObserved = true;
            if (fixedSource) {
              required(
                anchor.basis === 'audio-render' &&
                  Number.isFinite(anchor.monotonicMs) &&
                  anchor.monotonicMs >= nativeStartedAt &&
                  anchor.monotonicMs <= performance.now() &&
                  Number.isFinite(anchor.uncertaintyMs) &&
                  anchor.uncertaintyMs >= 0 &&
                  anchor.uncertaintyMs <= 100 &&
                  anchor.monotonicMs +
                    anchor.uncertaintyMs +
                    identity.durationMs +
                    completionReserveMs <=
                    guard.sourceDeadline,
              );
              guard = Object.freeze({
                ...guard,
                actualAnchorMs: anchor.monotonicMs,
                actualUncertaintyMs: anchor.uncertaintyMs,
                remainingAtAnchorMs:
                  guard.sourceDeadline -
                  anchor.monotonicMs -
                  anchor.uncertaintyMs,
              });
              onGuard?.(guard);
            }
            run.acknowledgePlaybackStart({
              monotonicMs: anchor.monotonicMs,
              uncertaintyMs: anchor.uncertaintyMs,
            });
            report(
              'speech.render-start',
              'observed',
              {},
              {
                clockId: 'node',
                atMs: anchor.monotonicMs,
                uncertaintyMs: anchor.uncertaintyMs,
                basis: 'event',
              },
            );
          } catch {
            fail();
          }
        },
      }),
    ).then((result) => {
      required(
        startObserved &&
          result?.completed === true &&
          result.sha256 === identity.sha256,
      );
      report('speech.render-end');
    });
    await Promise.all([playback, run.ready]);
    if (root.signal.aborted) throw gateFailure('cancelled');
    if (body) {
      phase = 'body';
      await body({ run, runId: launchInfo.runId, signal: root.signal });
      if (root.signal.aborted) throw gateFailure('cancelled');
    }
    normal = true;
  });
  // Native failure before Listening must also stop player/recorder, independent
  // of whether the injected observer has delivered its next event.
  run.ready.catch(fail);
  const done = work.then(
    () => close(),
    (error) => {
      failure ??= error?.category === 'deadline' ? 'deadline' : 'protocol';
      return close();
    },
  );
  done.catch(() => {});
  if (signal?.aborted) fail('cancelled');

  function close() {
    if (closing) return closing;
    let resolve, reject;
    closing = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    closing.catch(() => {});
    phase = 'stopping';
    root.abort();
    // Start ordinary Stop/provider cleanup immediately, including before auth.
    const settle = (fn) => Promise.resolve().then(fn);
    const nativeCleanup = settle(() => run.close());
    const playerCleanup = settle(() => player.stop());
    (async () => {
      // Retain ownership of in-progress adapter work until it settles on abort.
      const results = await Promise.allSettled([
        nativeCleanup,
        playerCleanup,
        work?.catch(() => {}),
        settle(() => body?.close()),
      ]);
      const recorded = await Promise.allSettled([
        settle(() => recorder.stop()),
      ]);
      let playerRetirementFailed = false;
      if (typeof player.close === 'function') {
        if (
          results[0].status !== 'fulfilled' ||
          recorded[0].status !== 'fulfilled' ||
          recorded[0].value?.stopped !== true
        )
          playerRetirementFailed = true;
        else
          try {
            required(
              (await player.close({ nativeReleased: true }))?.closed === true,
            );
          } catch {
            playerRetirementFailed = true;
          }
      }
      let cleanupFailed =
        playerRetirementFailed ||
        results[0].status === 'rejected' ||
        results[3].status === 'rejected' ||
        results[1].status === 'rejected' ||
        results[1].value?.stopped !== true ||
        recorded[0].status === 'rejected' ||
        recorded[0].value?.stopped !== true;
      for (const unsubscribe of subscriptions) {
        try {
          unsubscribe();
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        source.close?.();
      } catch {
        cleanupFailed = true;
      }
      try {
        launcher.close();
      } catch {
        cleanupFailed = true;
      }
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      run.signal.removeEventListener('abort', onRunAbort);
      phase = cleanupFailed
        ? 'failed-cleanup'
        : failure || !normal
          ? 'stopped'
          : 'completed';
      try {
        report(
          'run.ended',
          cleanupFailed
            ? 'failure'
            : failure === 'cancelled'
              ? 'cancelled'
              : failure || !normal
                ? 'failure'
                : 'observed',
        );
      } catch {
        cleanupFailed = true;
        phase = 'failed-cleanup';
      }
      if (cleanupFailed) throw gateFailure('cleanup');
      if (failure || !normal) throw gateFailure(failure ?? 'cancelled');
      return Object.freeze({
        completed: true,
        nativeReleased: true,
        dispatchesUsed: run.dispatchesUsed,
        mediaSha256: identity.sha256,
        guard,
        clockCalibration: run.clockCalibration,
      });
    })().then(resolve, reject);
    return closing;
  }
  return Object.freeze({
    done,
    stop() {
      failure ??= 'cancelled';
      return close();
    },
    get phase() {
      return phase;
    },
    get guard() {
      return guard;
    },
    get dispatchesUsed() {
      return run.dispatchesUsed;
    },
    get clockCalibration() {
      return run.clockCalibration;
    },
    get startupDiagnostics() {
      return run.startupDiagnostics;
    },
    get evaluationSummary() {
      return run.evaluationSummary;
    },
    get providerReceipts() {
      return run.providerReceipts;
    },
  });
}
