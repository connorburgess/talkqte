// Explicit zero-model first validation. No provider, broker or inference import.
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';
import { LAB_PLAYER_MEDIA_SHA256 } from './cue-lab-player.mjs';
const required = (ok) => {
  if (!ok) throw gateFailure('protocol');
};
export function createLabCaptureTake({
  runId,
  launcher,
  source,
  player,
  recorder,
  media,
  signal,
  takeMs = 135000,
  recorderMs = 3000,
  startBudgetMs = 1000,
  completionReserveMs = 1000,
  nativeReleaseMs = 6000,
  processEvents = process,
} = {}) {
  required(
    typeof processEvents?.on === 'function' &&
      typeof processEvents?.off === 'function' &&
      Number.isSafeInteger(nativeReleaseMs) &&
      nativeReleaseMs >= 1 &&
      nativeReleaseMs <= 6000 &&
      /^[A-Za-z0-9_-]{1,64}$/.test(runId ?? '') &&
      launcher?.mode === 'capture-only' &&
      typeof launcher.launch === 'function' &&
      typeof launcher.close === 'function' &&
      source?.mode === 'v1' &&
      typeof source.waitListening === 'function' &&
      typeof source.subscribe === 'function' &&
      Number.isSafeInteger(player?.startDeadlineMs) &&
      player.startDeadlineMs > 0 &&
      player.startDeadlineMs <= startBudgetMs &&
      ['prepare', 'play', 'stop', 'close', 'subscribe'].every(
        (k) => typeof player?.[k] === 'function',
      ) &&
      ['start', 'stop', 'subscribe'].every(
        (k) => typeof recorder?.[k] === 'function',
      ) &&
      media?.fictional === true &&
      media.sha256 === LAB_PLAYER_MEDIA_SHA256 &&
      media.durationMs === 102480 &&
      Number.isSafeInteger(takeMs) &&
      takeMs > 0 &&
      takeMs <= 135000 &&
      Number.isSafeInteger(recorderMs) &&
      recorderMs > 0 &&
      recorderMs <= 3000 &&
      Number.isSafeInteger(startBudgetMs) &&
      startBudgetMs > 0 &&
      startBudgetMs <= 3000 &&
      Number.isSafeInteger(completionReserveMs) &&
      completionReserveMs >= 1000 &&
      completionReserveMs <= 3000,
  );
  const root = new AbortController(),
    subscriptions = [];
  let phase = 'starting',
    failure = false,
    normal = false,
    closing = null,
    work,
    nativeStartedAt = null,
    anchor = null;
  const owner = createLabNativeOwner({
    executable: launcher.executable,
    launch: (options) => launcher.launch(options),
    stopAfterS: 110,
    mode: 'capture-only',
    armingMs: 5000,
    releaseMs: nativeReleaseMs,
  });
  const close = () => {
    if (closing) return closing;
    let resolve, reject;
    closing = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    closing.catch(() => {});
    phase = 'stopping';
    root.abort();
    (async () => {
      const results = await Promise.allSettled([
        owner.stop(),
        player.stop(),
        work?.catch(() => {}),
      ]);
      let failed =
        results[0].status !== 'fulfilled' ||
        results[0].value?.released !== true ||
        results[1].status !== 'fulfilled' ||
        results[1].value?.stopped !== true;
      const recorded = await Promise.allSettled([recorder.stop()]);
      failed ||=
        recorded[0].status !== 'fulfilled' ||
        recorded[0].value?.stopped !== true;
      // Final player exit cannot race active source identity or recorder finalization.
      if (
        results[0].status === 'fulfilled' &&
        results[0].value?.released === true &&
        recorded[0].status === 'fulfilled' &&
        recorded[0].value?.stopped === true
      ) {
        try {
          required(
            (await player.close({ nativeReleased: true }))?.closed === true,
          );
        } catch {
          failed = true;
        }
      } else failed = true;
      for (const unsubscribe of subscriptions)
        try {
          unsubscribe();
        } catch {
          failed = true;
        }
      try {
        source.close?.();
      } catch {
        failed = true;
      }
      try {
        launcher.close();
      } catch {
        failed = true;
      }
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
      processEvents.off('SIGINT', fail);
      processEvents.off('SIGTERM', fail);
      phase = failed
        ? 'failed-cleanup'
        : normal && !failure
          ? 'completed'
          : 'stopped';
      if (failed) throw gateFailure('cleanup');
      if (failure || !normal) throw gateFailure('cancelled');
      return Object.freeze({
        completed: true,
        captureOnly: true,
        dispatchesUsed: 0,
        nativeReleased: true,
        mediaSha256: media.sha256,
        anchor,
      });
    })().then(resolve, reject);
    return closing;
  };
  const fail = () => {
    if (closing) return;
    failure = true;
    void close().catch(() => {});
  };
  const timer = setTimeout(fail, takeMs);
  signal?.addEventListener('abort', fail, { once: true });
  processEvents.on('SIGINT', fail);
  processEvents.on('SIGTERM', fail);
  try {
    for (const adapter of [owner, source, player, recorder]) {
      const unsubscribe = adapter.subscribe(() => queueMicrotask(fail));
      required(typeof unsubscribe === 'function');
      subscriptions.push(unsubscribe);
    }
  } catch {
    clearTimeout(timer);
    signal?.removeEventListener('abort', fail);
    processEvents.off('SIGINT', fail);
    processEvents.off('SIGTERM', fail);
    for (const unsubscribe of subscriptions)
      try {
        unsubscribe();
      } catch {}
    // Construction did not transfer resource ownership; caller still owns
    // prepared player/launcher/recorder and must close them on this failure.
    throw gateFailure('protocol');
  }
  work = Promise.resolve().then(async () => {
    required(!signal?.aborted && !root.signal.aborted);
    const verified = await player.prepare({ media, signal: root.signal });
    required(
      verified?.path === media.path &&
        verified.sha256 === media.sha256 &&
        verified.durationMs === media.durationMs &&
        player.identity?.runId === runId,
    );
    nativeStartedAt = performance.now();
    await owner.start({ runId, signal: root.signal });
    const listening = await source.waitListening({
      runId,
      signal: root.signal,
    });
    required(
      listening?.runId === runId &&
        listening.version === 1 &&
        listening.listening === true,
    );
    const recordDeadline = setTimeout(fail, recorderMs);
    try {
      const recording = await recorder.start({
        runId,
        media,
        signal: root.signal,
      });
      required(recording?.started === true);
    } finally {
      clearTimeout(recordDeadline);
    }
    const sourceDeadline = nativeStartedAt + 110000;
    // Conservatively measure from before owned spawn, not a late Listening receipt.
    required(
      !root.signal.aborted &&
        performance.now() +
          startBudgetMs +
          media.durationMs +
          completionReserveMs <=
          sourceDeadline,
    );
    phase = 'playing';
    const result = await player.play({
      media,
      signal: root.signal,
      onStarted: (actual) => {
        try {
          required(
            !anchor &&
              !root.signal.aborted &&
              actual?.sha256 === media.sha256 &&
              actual.basis === 'audio-render' &&
              Number.isFinite(actual.monotonicMs) &&
              actual.monotonicMs >= nativeStartedAt &&
              actual.monotonicMs <= performance.now() &&
              Number.isFinite(actual.uncertaintyMs) &&
              actual.uncertaintyMs >= 0 &&
              actual.uncertaintyMs <= 100 &&
              actual.monotonicMs +
                actual.uncertaintyMs +
                media.durationMs +
                completionReserveMs <=
                sourceDeadline,
          );
          anchor = Object.freeze({ ...actual });
        } catch {
          fail();
        }
      },
    });
    required(
      !root.signal.aborted &&
        anchor &&
        result?.completed === true &&
        result.sha256 === media.sha256,
    );
    normal = true;
  });
  const done = work.then(close, () => {
    failure = true;
    return close();
  });
  done.catch(() => {});
  if (signal?.aborted) queueMicrotask(fail);
  return Object.freeze({
    done,
    stop() {
      failure = true;
      return close();
    },
    get phase() {
      return phase;
    },
  });
}
