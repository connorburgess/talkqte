// Prepared fictional media only. Player/recorder/Listening observations must
// come from explicit adapters; this module supplies no desktop or model action.
import { isAbsolute } from 'node:path';
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';
import { createLabRun } from './cue-lab-run.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';

const required = (condition) => {
  if (!condition) throw gateFailure('protocol');
};
export function createPreparedTake(options) {
  required(options?.body === undefined);
  return createLabPlaybackSession(options);
}

// Adaptive follow-up may reuse ownership with an explicitly labelled neutral
// bootstrap media file and a separate body. It cannot alter prepared-take flow.
export function createLabPlaybackSession({
  launcher,
  settings,
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
  const fail = () => {
    if (closing) return;
    failure ??= 'cancelled';
    void close().catch(() => {});
  };
  // Notifications can re-enter cleanup synchronously; close reserves its promise
  // before invoking any adapter, abort handler or unsubscribe callback.
  try {
    for (const adapter of [player, recorder]) {
      const unsubscribe = adapter.subscribe(() => queueMicrotask(fail));
      required(typeof unsubscribe === 'function');
      subscriptions.push(unsubscribe);
    }
    run = createLabRun({
      settings,
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
  const onAbort = () => fail();
  run.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(fail, takeMs);
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
    await armed;
    if (root.signal.aborted) throw gateFailure('cancelled');
    const listening = await source.waitListening({
      ...launchInfo,
      signal: root.signal,
    });
    required(
      listening?.runId === launchInfo.runId && listening.listening === true,
    );
    if (root.signal.aborted) throw gateFailure('cancelled');
    const recording = await recorder.start({
      media: identity,
      ...launchInfo,
      signal: root.signal,
    });
    required(recording?.started === true);
    if (root.signal.aborted) throw gateFailure('cancelled');
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
            run.acknowledgePlaybackStart({
              monotonicMs: anchor.monotonicMs,
              uncertaintyMs: anchor.uncertaintyMs,
            });
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
    () => {
      failure ??= 'cancelled';
      return close();
    },
  );
  done.catch(() => {});
  if (signal?.aborted) fail();

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
      let cleanupFailed =
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
        launcher.close();
      } catch {
        cleanupFailed = true;
      }
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      run.signal.removeEventListener('abort', onAbort);
      phase = cleanupFailed
        ? 'failed-cleanup'
        : failure || !normal
          ? 'stopped'
          : 'completed';
      if (cleanupFailed) throw gateFailure('cleanup');
      if (failure || !normal) throw gateFailure('cancelled');
      return Object.freeze({
        completed: true,
        nativeReleased: true,
        dispatchesUsed: run.dispatchesUsed,
        mediaSha256: identity.sha256,
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
  });
}
