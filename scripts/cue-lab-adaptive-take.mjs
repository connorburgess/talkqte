// Injected adaptive body for createLabPlaybackSession. No app, audio device,
// synthesis process or provider is opened here. The playback session owns Stop.
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { openStream, SCHEMA } from './cue-dialogue-stream.mjs';

const failure = (category) =>
  Object.assign(new Error(`Adaptive take stopped: ${category}.`), { category });
const requireThat = (value) => {
  if (!value) throw failure('protocol');
};
const finite = (n) => Number.isFinite(n) && n >= 0;
const integer = (n, low, high) =>
  Number.isSafeInteger(n) && n >= low && n <= high;
const hash = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const text = (s) => typeof s === 'string' && s.length > 0 && s.length <= 1000;

/** Supply this body and its close hook to ONE createLabPlaybackSession owner.
 * Its neutral voiced calibration prefix must complete before this body runs.
 * clock.now()/playbackStart() use the actual acknowledged playback clock.
 * voice/player are injected offline contracts; no real adapters are supplied. */
export function createAdaptiveBody({
  scenario,
  clock,
  voice,
  player,
  maxCalls,
  deadlineMs = 30000,
  operationMs = 30000,
  budgetMs = 6000,
  maxSteps = 202,
  settings = {},
  briefSource = 'generated',
  observe = () => {},
} = {}) {
  requireThat(
    typeof clock?.now === 'function' &&
      typeof clock.playbackStart === 'function',
  );
  requireThat(
    typeof voice?.synthesizeLine === 'function' &&
      typeof voice.close === 'function',
  );
  requireThat(typeof player?.playLine === 'function');
  requireThat(integer(maxCalls, 1, 100) && integer(deadlineMs, 1, 60000));
  requireThat(integer(operationMs, 1, 60000) && finite(budgetMs));
  requireThat(integer(maxSteps, 1, 202) && typeof observe === 'function');
  const controller = new AbortController();
  const operations = new Set();
  let session,
    closing,
    invoked = false,
    finished = false,
    priorClock = 0;
  let parentSignal, parentAbort, originMonotonicMs, playbackFailure;
  const now = () => {
    const value = clock.now();
    requireThat(finite(value) && value >= priorClock);
    priorClock = value;
    return value;
  };
  const check = () => {
    if (controller.signal.aborted) throw failure('cancelled');
  };
  // Fail promptly on abort/deadline, but retain each underlying operation until
  // body.close has joined it. Late replies can never become transcript entries.
  const owned = async (task) => {
    check();
    let timer, abort;
    let operation;
    try {
      operation = Promise.resolve(task());
    } catch (error) {
      operation = Promise.reject(error);
    }
    operations.add(operation);
    operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    const stopped = new Promise((_, reject) => {
      abort = () => reject(failure('cancelled'));
      controller.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        reject(failure('deadline'));
        controller.abort();
      }, operationMs);
      if (controller.signal.aborted) abort();
    });
    try {
      const result = await Promise.race([operation, stopped]);
      check();
      return result;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
    }
  };
  const body = async ({ run, signal, runId } = {}) => {
    requireThat(text(runId));
    requireThat(!invoked && !closing);
    invoked = true;
    requireThat(
      typeof run?.request === 'function' &&
        typeof run?.gate?.waitIdle === 'function',
    );
    requireThat(
      typeof run.gate.run === 'function' && typeof run.cuesAt === 'function',
    );
    parentSignal = signal;
    parentAbort = () => controller.abort();
    signal?.addEventListener('abort', parentAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let transcript = [],
      state = null,
      reply,
      steps = 0;
    const origin = clock.playbackStart();
    requireThat(
      finite(origin?.monotonicMs) &&
        finite(origin.uncertaintyMs) &&
        origin.uncertaintyMs <= 100,
    );
    originMonotonicMs = origin.monotonicMs;
    priorClock = originMonotonicMs;
    const started = now();
    const emit = (event) => observe({ runId, ...event });
    try {
      await owned(async () => {
        session = await openStream({
          scenario,
          maxCalls,
          settings,
          briefSource,
          deadlineMs,
          signal: controller.signal,
          gate: run.gate,
          run: (role, view, options) => {
            requireThat(options.deadlineMs <= deadlineMs);
            return run.request({ role, ...view, signal: options.signal });
          },
          // Cue text remains in memory. No full request/replay log is persisted.
          log: () => {},
        });
        if (controller.signal.aborted) await session.close();
        check();
      });
      const request = (judge = false) => {
        const monotonicMs = now();
        const nowMs = Math.floor(monotonicMs - originMonotonicMs);
        requireThat(nowMs >= 0);
        return {
          schema: SCHEMA,
          scenario,
          transcript,
          state,
          nowMs,
          budgetMs,
          callsLeft: maxCalls - session.calls,
          cues: judge || scenario.branch === 'B' ? [] : run.cuesAt(nowMs),
        };
      };
      while (true) {
        check();
        requireThat(++steps <= maxSteps);
        const waitingAt = now();
        await owned(() => run.gate.waitIdle({ signal: controller.signal }));
        // No await between the fresh snapshot and stream's synchronous gate
        // admission. The existing gate must not queue participant operations.
        emit({ type: 'resource-pause', elapsedMs: now() - waitingAt });
        const operation = reply?.end ? 'judge' : 'next';
        const req = request(operation === 'judge');
        reply = await owned(() =>
          operation === 'judge'
            ? session.judgeStream(
                { ...req, cues: [] },
                { signal: controller.signal },
              )
            : session.nextLines(req, { signal: controller.signal }),
        );
        state = reply.state;
        emit({
          type: 'generation-pause',
          elapsedMs: reply.elapsedMs,
          overBudget: reply.overBudget,
          operation,
        });
        if (operation === 'judge') {
          finished = true;
          return {
            runId,
            status: 'completed',
            transcript,
            verdicts: reply.verdicts,
            calls: session.calls,
            elapsedMs: now() - started,
          };
        }
        requireThat(Array.isArray(reply.lines) && reply.lines.length <= 1);
        if (!reply.lines.length) {
          emit({ type: 'silent-transition', nextRole: reply.nextRole });
          continue;
        }
        const line = reply.lines[0];
        const synthesisAt = now();
        const deadlineAt = synthesisAt + operationMs;
        const synthesized = await owned(() =>
          voice.synthesizeLine({
            runId,
            lineId: line.lineId,
            speaker: line.speaker,
            text: line.text,
            signal: controller.signal,
            deadlineAt,
          }),
        );
        const clip = Object.freeze(structuredClone(synthesized));
        emit({ type: 'synthesis-pause', elapsedMs: now() - synthesisAt });
        requireThat(
          clip?.runId === runId &&
            clip.lineId === line.lineId &&
            clip.speaker === line.speaker,
        );
        requireThat(
          hash(clip.clipSha256) &&
            clip.textSha256 ===
              createHash('sha256').update(line.text).digest('hex') &&
            text(clip.path) &&
            isAbsolute(clip.path),
        );
        requireThat(
          finite(clip.durationMs) &&
            clip.durationMs > 0 &&
            clip.durationMs <= operationMs,
        );
        requireThat(
          integer(clip.sampleRate, 8000, 192000) && clip.channels === 1,
        );
        const notBeforeMonotonicMs =
          originMonotonicMs + req.nowMs + line.pauseBeforeMs;
        let start;
        const played = await owned(() =>
          player.playLine({
            clip,
            notBeforeMonotonicMs,
            signal: controller.signal,
            deadlineAt: now() + operationMs,
            onStarted(event) {
              try {
                check();
                requireThat(
                  !start &&
                    event?.runId === runId &&
                    event.lineId === line.lineId &&
                    event.clipSha256 === clip.clipSha256,
                );
                requireThat(
                  finite(event.monotonicMs) &&
                    event.monotonicMs >= notBeforeMonotonicMs &&
                    event.monotonicMs <= now(),
                );
                requireThat(
                  finite(event.uncertaintyMs) && event.uncertaintyMs <= 100,
                );
                start = structuredClone(event);
              } catch {
                playbackFailure = failure('protocol');
                controller.abort();
              }
            },
          }),
        );
        requireThat(
          start &&
            played?.completed === true &&
            played.runId === runId &&
            played.lineId === line.lineId &&
            played.clipSha256 === clip.clipSha256,
        );
        requireThat(
          played.startedMonotonicMs === start.monotonicMs &&
            finite(played.endedMonotonicMs) &&
            played.endedMonotonicMs > start.monotonicMs &&
            played.endedMonotonicMs <= now(),
        );
        requireThat(
          played.endedMonotonicMs - start.monotonicMs >= clip.durationMs - 1,
        );
        requireThat(
          played.endedMonotonicMs - start.monotonicMs <= clip.durationMs + 100,
        );
        requireThat(
          played.sampleRate === clip.sampleRate &&
            integer(played.framesPlayed, 1, 192000 * 60),
        );
        requireThat(
          Math.abs(
            (played.framesPlayed / played.sampleRate) * 1000 - clip.durationMs,
          ) <= 1,
        );
        const startMs = Math.floor(start.monotonicMs - originMonotonicMs);
        const endMs = Math.floor(played.endedMonotonicMs - originMonotonicMs);
        requireThat(
          startMs >=
            (transcript.length
              ? transcript.at(-1).startMs + transcript.at(-1).durationMs
              : 0),
        );
        requireThat(endMs > startMs);
        transcript = [
          ...transcript,
          {
            lineId: line.lineId,
            speaker: line.speaker,
            text: line.text,
            startMs,
            durationMs: endMs - startMs,
          },
        ];
        emit({
          type: 'line-completed',
          lineId: line.lineId,
          startMs,
          durationMs: endMs - startMs,
        });
      }
    } catch (error) {
      controller.abort();
      // Only safe categories cross the boundary; never provider/audio text.
      const category = playbackFailure
        ? 'protocol'
        : [
              'cancelled',
              'deadline',
              'protocol',
              'dispatch-limit',
              'call-cap',
              'invalid-reply',
            ].includes(error?.category)
          ? error.category
          : 'operation';
      throw failure(category);
    } finally {
      signal?.removeEventListener('abort', parentAbort);
    }
  };
  body.close = () => {
    if (closing) return closing;
    // Reserve the promise before callbacks, including synchronous abort hooks.
    let resolve, reject;
    closing = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    controller.abort();
    parentSignal?.removeEventListener('abort', parentAbort);
    Promise.allSettled([
      Promise.allSettled([...operations]),
      Promise.resolve().then(() => session?.close()),
      Promise.resolve().then(() => voice.close()),
    ]).then((results) => {
      if (results.some((r) => r.status === 'rejected'))
        reject(failure('cleanup'));
      else resolve({ closed: true, completed: finished });
    });
    return closing;
  };
  return body;
}
