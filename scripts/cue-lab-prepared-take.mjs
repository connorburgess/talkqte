// Prepared fictional media only. Player/recorder/Listening observations must
// come from explicit adapters; this module supplies no desktop or model action.
import { isAbsolute } from 'node:path';
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';
import { createLabRun } from './cue-lab-run.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';
import { isLabMedia } from './cue-lab-media.mjs';
import { isAnthropicModel } from './cue-lab-anthropic-core.mjs';

// How long a direct API take waits, after Listening, for the owner's in-app
// approval before it stops without playing or sending anything.
export const APPROVAL_BUDGET_MS = 180000;
const SOURCE_WINDOW_MS = 110000;
// Direct API route: native Stop also allows for the time from native start to
// Listening, so an approval late in its 180 s budget still leaves the full
// media window. 110 + 180 + 30 = 320 s.
const LAUNCH_ALLOWANCE_MS = 30000;
export const API_STOP_AFTER_S =
  (SOURCE_WINDOW_MS + APPROVAL_BUDGET_MS + LAUNCH_ALLOWANCE_MS) / 1000;
// What must still fit after an approval: recorder start, a margin for the
// approval handling itself, then the media within the source guard.
const APPROVAL_HANDLING_MS = 1000;
const sourceWindowMs = (approvalBudgetMs) =>
  approvalBudgetMs
    ? SOURCE_WINDOW_MS + approvalBudgetMs + LAUNCH_ALLOWANCE_MS
    : SOURCE_WINDOW_MS;
const required = (condition) => {
  if (!condition) throw gateFailure('protocol');
};
export function createPreparedTake(options) {
  required(options?.body === undefined);
  return createLabPlaybackSession(options);
}

// Fixed saved-meeting model recording. It shares the existing provider/broker
// owner; this wrapper cannot create a second gate, retry or change the media.
//
// The option check is exported so a run package can verify, before approval
// and without launching anything, that its plan matches what this code
// accepts.
export function assertFixedModelTakeOptions(options) {
  required(
    options?.body === undefined &&
      // The Codex subscription route at the efforts the signed native lab
      // build accepts, or the direct API route at its listed models and low.
      (options?.settings?.provider === 'codex'
        ? options.settings.model === 'gpt-6.1-sol' &&
          ['low', 'medium'].includes(options.settings.effort)
        : options?.settings?.provider === 'anthropic-api' &&
          isAnthropicModel(options.settings.model) &&
          options.settings.effort === 'low') &&
      // Codex: 20 calls, native Stop at 110 s, no in-app approval wait.
      // Direct API: 40 calls, and the owner approves in the app after
      // Listening and before playback, within 180 s; native Stop moves out
      // by exactly that budget so the media window after approval is
      // unchanged.
      (options.settings.provider === 'codex'
        ? options.settings.maxCalls === 20 &&
          options.stopAfterS === 110 &&
          (options.approvalBudgetMs ?? 0) === 0
        : options.settings.maxCalls === 40 &&
          options.approvalBudgetMs === APPROVAL_BUDGET_MS &&
          options.stopAfterS === API_STOP_AFTER_S &&
          // The take clock restarts at approval with the usual 135 s.
          options.takeMs === 135000) &&
      // A tail after the media only on the direct API route, up to 15 s.
      (options.tailMs === undefined ||
        (options.settings.provider === 'anthropic-api' &&
          Number.isSafeInteger(options.tailMs) &&
          options.tailMs >= 0 &&
          options.tailMs <= 15000)) &&
      // Approved fictional media (fixed MP4 or a reviewed per-run manifest)
      // within the bounds every timing guard below was set for.
      isLabMedia(options.media),
  );
}
export function createFixedModelTake(options) {
  assertFixedModelTakeOptions(options);
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
  // How long the app keeps running after the media ends, so a cue on a
  // moment near the end can still be decided, painted and recorded. It
  // counts against the same source window as the media.
  tailMs = 0,
  approvalBudgetMs = 0,
  onApproval,
  observe,
  onGuard,
} = {}) {
  required(
    launcher &&
      typeof launcher.launch === 'function' &&
      typeof launcher.close === 'function' &&
      isAbsolute(launcher.executable ?? '') &&
      // Only media approved by cue-lab-media.mjs (manifest or fixed hash).
      isLabMedia(media) &&
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
      [0, APPROVAL_BUDGET_MS].includes(approvalBudgetMs) &&
      // The approval gate is the direct API route's only; it needs the
      // launcher's native connection rows.
      (approvalBudgetMs === 0 ||
        (settings?.provider === 'anthropic-api' &&
          fixedSource &&
          body === undefined &&
          typeof launcher.subscribeEvaluator === 'function' &&
          typeof onApproval === 'function')) &&
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
        stopAfterS * 1000 === sourceWindowMs(approvalBudgetMs) &&
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
        completionReserveMs <= 3000 &&
        Number.isSafeInteger(tailMs) &&
        tailMs >= 0 &&
        tailMs <= 15000 &&
        // On the API route the take clock restarts at approval, and must
        // cover everything after it: recorder start, the start budget, the
        // media, the tail and the completion reserve.
        (approvalBudgetMs === 0 ||
          takeMs >=
            recorderMs +
              startBudgetMs +
              media.durationMs +
              tailMs +
              completionReserveMs),
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
  // The approved, frozen descriptor itself flows to the player and capture.
  const identity = media;
  const root = new AbortController();
  // Which step the take is in, and the step it was in when it first
  // failed, as fixed labels for OUTCOME ("protocol" alone is not enough).
  let step = 'player-prepare',
    failedStep = null;
  let phase = 'starting',
    closing = null,
    failure = null,
    normal = false;
  let run,
    work,
    startObserved = false,
    launchInfo;
  let nativeStartedAt,
    guard = null,
    approval = null;
  // In-app approval, read from the native `evaluator` rows for this run's
  // private timing file. A launch-setting approval, or an approval naming a
  // backend or model this take did not launch, is a fault.
  const approvalGate = {
    row: null,
    fault: false,
    waiter: null,
    settle() {
      if (!this.waiter) return;
      if (this.fault) this.waiter.reject(gateFailure('approval-fault'));
      else if (this.row) this.waiter.resolve(this.row);
      else return;
      this.waiter = null;
    },
    observe(row) {
      if (row.approval === 'launchSetting') this.fault = true;
      else if (row.state === 'on' && !this.row) {
        if (
          row.backend !== 'lab-api' ||
          row.model !== settings.model ||
          (row.effort !== undefined && row.effort !== settings.effort)
        )
          this.fault = true;
        else this.row = row;
      }
      if (this.fault) queueMicrotask(() => fail('approval-fault'));
      this.settle();
    },
  };
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
    failedStep ??= step;
    failure ??= [
      'cancelled',
      'deadline',
      'protocol',
      'approval-not-given',
      'approval-fault',
    ].includes(reason)
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
    if (approvalBudgetMs) {
      const unsubscribe = launcher.subscribeEvaluator((row) =>
        approvalGate.observe(row),
      );
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
      approvalBudgetMs,
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
  // On the API route this clock is paused for the approval wait (bounded
  // separately) and restarts with a full takeMs at approval.
  let timer = setTimeout(() => fail('deadline'), takeMs);
  work = Promise.resolve().then(async () => {
    if (root.signal.aborted) throw gateFailure('cancelled');
    step = 'player-prepare';
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
    step = 'native-start';
    await armed;
    if (root.signal.aborted) throw gateFailure('cancelled');
    step = 'listening';
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
    if (approvalBudgetMs) {
      // Nothing plays and nothing is sent until the owner's review approves
      // the connection. No row in time: ordinary Stop, no attempt used.
      clearTimeout(timer);
      const waitStartedAt = performance.now();
      const sourceDeadline = nativeStartedAt + sourceWindowMs(approvalBudgetMs);
      // The wait ends at its budget, or earlier if a later approval could no
      // longer fit recorder start and the media before native Stop.
      const waitDeadline = Math.min(
        waitStartedAt + approvalBudgetMs,
        sourceDeadline -
          recorderMs -
          APPROVAL_HANDLING_MS -
          startBudgetMs -
          identity.durationMs -
          tailMs -
          completionReserveMs,
      );
      const inTime = () => performance.now() <= waitDeadline;
      if (!inTime()) throw gateFailure('approval-not-given');
      step = 'approval-wait';
      onApproval({ state: 'waiting', budgetMs: approvalBudgetMs });
      let approvalTimer;
      const row = await Promise.race([
        new Promise((resolve, reject) => {
          approvalGate.waiter = { resolve, reject };
          approvalGate.settle();
        }),
        new Promise((_, reject) => {
          approvalTimer = setTimeout(
            () => reject(gateFailure('approval-not-given')),
            Math.max(0, waitDeadline - performance.now()),
          );
          root.signal.addEventListener(
            'abort',
            () => reject(gateFailure('cancelled')),
            { once: true },
          );
        }),
      ]).finally(() => {
        clearTimeout(approvalTimer);
        approvalGate.waiter = null;
      });
      if (root.signal.aborted) throw gateFailure('cancelled');
      if (!inTime()) throw gateFailure('approval-not-given');
      const waitMs = Math.floor(performance.now() - waitStartedAt);
      // Only now is the provider opened (key file, worker). The run's
      // startup clock restarts here with a full startupMs.
      step = 'provider-open';
      await run.approve();
      step = 'timing';
      if (root.signal.aborted) throw gateFailure('cancelled');
      // Opening must not have used up the room the media needs.
      if (!inTime()) throw gateFailure('approval-not-given');
      // Cloud transcription: the app has only an empty placeholder until
      // now, so nothing can stream before this accepted, in-time review.
      step = 'token-release';
      if (launcher.transcription) launcher.releaseTranscriptionToken();
      step = 'attempt-record';
      approval = Object.freeze({
        budgetMs: approvalBudgetMs,
        waitMs,
        session: row.session,
      });
      timer = setTimeout(() => fail('deadline'), takeMs);
      // The runner records the used attempt here, before playback; if it
      // cannot, the take stops.
      onApproval({ state: 'approved', ...approval });
      if (root.signal.aborted) throw gateFailure('cancelled');
    }
    const recordTimer = fixedSource
      ? setTimeout(() => fail('deadline'), recorderMs)
      : undefined;
    let recording;
    try {
      // On expiry root Stop aborts the adapter; retain ownership of its startup
      // until it settles, rather than detaching a late recorder after a race.
      step = 'recorder-start';
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
      const sourceDeadline = nativeStartedAt + sourceWindowMs(approvalBudgetMs);
      const startRequestAt = performance.now();
      required(
        startRequestAt +
          startBudgetMs +
          identity.durationMs +
          tailMs +
          completionReserveMs <=
          sourceDeadline,
      );
      guard = Object.freeze({
        nativeStartedAt,
        sourceDeadline,
        startRequestAt,
        startBudgetMs,
        mediaDurationMs: identity.durationMs,
        tailMs,
        completionReserveMs,
        remainingAtRequestMs: sourceDeadline - startRequestAt,
        approvalBudgetMs,
        approvalWaitMs: approval?.waitMs ?? 0,
      });
      onGuard?.(guard);
    }
    phase = 'playing';
    // Start the actual voiced file BEFORE lazy native authentication/ready.
    // The adapter reports its actual audio-clock start, never request/receipt time.
    step = 'player-start';
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
                    tailMs +
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
    step = 'playback';
    await Promise.all([playback, run.ready]);
    if (tailMs > 0) {
      // The media has ended; the app keeps listening, deciding and showing
      // cues until the tail is over (or the take is stopped).
      step = 'tail';
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(gateFailure('cancelled'));
        };
        const timer = setTimeout(() => {
          root.signal.removeEventListener('abort', onAbort);
          resolve();
        }, tailMs);
        if (root.signal.aborted) onAbort();
        else root.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    step = 'completion';
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
      failedStep ??= step;
      failure ??= [
        'deadline',
        'cancelled',
        'approval-not-given',
        'approval-fault',
      ].includes(error?.category)
        ? error.category
        : 'protocol';
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
      // A recorder that never accepted a frame and whose process has exited
      // recorded nothing, so the player may still be retired (RunB08).
      let neverRecorded = false;
      try {
        const detail = recorder.failureDetail;
        neverRecorded = detail?.frameAccepted === false && detail.exit !== null;
      } catch {}
      if (typeof player.close === 'function') {
        if (
          results[0].status !== 'fulfilled' ||
          (!neverRecorded &&
            (recorded[0].status !== 'fulfilled' ||
              recorded[0].value?.stopped !== true))
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
        approval,
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
    get providerSpentMicroUsd() {
      return run.providerSpentMicroUsd;
    },
    /** The step the take was in when it first failed, or null. */
    get failedStep() {
      return failedStep;
    },
    // The take's first failure cause, before any cleanup failure replaces
    // it in the rejection, and the run's own first stop reason.
    get failure() {
      return failure;
    },
    get runStopReason() {
      return run.stopReason;
    },
    get approval() {
      return approval;
    },
  });
}
