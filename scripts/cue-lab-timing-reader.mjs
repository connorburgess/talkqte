// Bounded observation of one private, owned timing file. The native writer is
// not byte-capped: polling/ordinary Stop can overshoot this observation limit.
import {
  constants,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
} from 'node:fs';
import { TextDecoder } from 'node:util';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';

const canonicalSession = (value) =>
  typeof value === 'string' &&
  /^[1-9][0-9]{0,19}$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;

export function watchLabTiming({
  path,
  runId,
  onEvent,
  expectedCommit,
  expectedFeatures,
  expectedApplication,
  sourceObservation = 'legacy-fixture',
  maxFileBytes = 8 * 1024 * 1024,
  maxFrameBytes = 64 * 1024,
  readBatchBytes = 64 * 1024,
  pollMs = 20,
  partialMs = 1000,
} = {}) {
  if (
    typeof path !== 'string' ||
    typeof runId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(runId) ||
    typeof onEvent !== 'function' ||
    !['v1', 'legacy-fixture'].includes(sourceObservation) ||
    ![
      [maxFileBytes, 1, 16 * 1024 * 1024],
      [maxFrameBytes, 16, 64 * 1024],
      [readBatchBytes, 16, 64 * 1024],
      [pollMs, 1, 100],
      [partialMs, 1, 1000],
    ].every(([n, min, max]) => Number.isSafeInteger(n) && n >= min && n <= max)
  )
    throw gateFailure('protocol');
  let fd,
    timer,
    stopped = false,
    failed = false,
    offset = 0,
    partial = Buffer.alloc(0),
    partialAt = null,
    polling = false,
    session = null;
  const original = lstatSync(path);
  if (
    !original.isFile() ||
    original.isSymbolicLink() ||
    original.uid !== process.getuid?.() ||
    (original.mode & 0o777) !== 0o600 ||
    original.size !== 0
  )
    throw gateFailure('protocol');
  fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const opened = fstatSync(fd);
  if (opened.dev !== original.dev || opened.ino !== original.ino) {
    closeSync(fd);
    throw gateFailure('protocol');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    closeSync(fd);
    partial = Buffer.alloc(0);
  };
  const fail = () => {
    if (failed || stopped) return;
    failed = true;
    close();
    onEvent({ event: 'dropped', count: 1 });
  };
  const emit = (value) => {
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      typeof value.event !== 'string'
    )
      throw gateFailure('protocol');
    if (value.event === 'dev_stop') {
      if (
        Object.keys(value).some(
          (k) => !['event', 'run_id', 'step', 'wall_ms', 'mono_ms'].includes(k),
        ) ||
        value.run_id !== runId ||
        !['armed', 'latched', 'stopping', 'released', 'failed'].includes(
          value.step,
        )
      )
        throw gateFailure('protocol');
      for (const key of ['wall_ms', 'mono_ms'])
        if (
          value[key] !== undefined &&
          (!Number.isSafeInteger(value[key]) || value[key] < 0)
        )
          throw gateFailure('protocol');
      onEvent({ event: 'dev_stop', run_id: runId, step: value.step });
    } else if (value.event === 'dev_source_observation') {
      if (
        sourceObservation !== 'v1' ||
        value.version !== 1 ||
        value.run_id !== runId ||
        value.application !== expectedApplication ||
        !['listening', 'retired'].includes(value.step) ||
        !/^[a-f0-9]{32}$/.test(value.host_operation ?? '') ||
        !/^[a-f0-9]{64}$/.test(value.live_operation ?? '') ||
        !canonicalSession(value.session) ||
        Object.keys(value).some(
          (k) =>
            ![
              'event',
              'version',
              'run_id',
              'application',
              'step',
              'host_operation',
              'live_operation',
              'session',
              'wall_ms',
              'mono_ms',
            ].includes(k),
        )
      )
        throw gateFailure('protocol');
      const {
        event,
        version,
        run_id,
        application,
        step,
        host_operation,
        live_operation,
        session,
      } = value;
      onEvent({
        event,
        version,
        run_id,
        application,
        step,
        host_operation,
        live_operation,
        session,
      });
    } else if (value.event === 'session') {
      if (value.live === false) return;
      if (
        !['started', 'ended'].includes(value.state) ||
        typeof value.live !== 'boolean' ||
        (sourceObservation === 'v1'
          ? !canonicalSession(value.session)
          : !Number.isSafeInteger(value.session) || value.session < 0)
      )
        throw gateFailure('protocol');
      if (!value.live) return;
      if (
        expectedCommit &&
        (value.commit !== expectedCommit ||
          !Array.isArray(value.features) ||
          value.features.length !== expectedFeatures.length ||
          new Set(value.features).size !== expectedFeatures.length ||
          !expectedFeatures.every((feature) =>
            value.features.includes(feature),
          ))
      )
        throw gateFailure('protocol');
      if (value.state === 'started') {
        if (session !== null) throw gateFailure('protocol');
        session = value.session;
      } else if (session !== value.session) throw gateFailure('protocol');
      onEvent({
        event: 'session',
        state: value.state,
        session: value.session,
        ...(expectedCommit
          ? { commit: value.commit, features: [...value.features] }
          : {}),
      });
    } else if (value.event === 'evaluator') {
      // The model connection turning on or off, and how it was approved. Only
      // fixed labels and names pass; the lab's approval gate reads them.
      const name = /^[A-Za-z0-9._-]{1,64}$/;
      if (
        !['review', 'launchSetting'].includes(value.approval) ||
        !['on', 'off'].includes(value.state) ||
        !name.test(value.backend ?? '') ||
        !name.test(value.model ?? '') ||
        (value.effort !== undefined && !name.test(value.effort)) ||
        (sourceObservation === 'v1'
          ? !canonicalSession(value.session)
          : !Number.isSafeInteger(value.session) || value.session < 0)
      )
        throw gateFailure('protocol');
      onEvent({
        event: 'evaluator',
        approval: value.approval,
        state: value.state,
        backend: value.backend,
        model: value.model,
        ...(value.effort !== undefined ? { effort: value.effort } : {}),
        session: value.session,
      });
    } else if (value.event === 'stt_state') {
      // Cloud transcription start and stop, with a fixed code and the
      // audio sent so far. No provider message is ever in the row.
      if (
        !['started', 'dropping', 'finished', 'ended', 'stopped'].includes(
          value.state,
        ) ||
        (value.code !== undefined &&
          ![
            'auth',
            'quota',
            'rate_limited',
            'cap_reached',
            'network',
            'protocol',
            'closed',
            'settings',
            'withdrawn',
            'lab_ended',
          ].includes(value.code)) ||
        (value.state === 'stopped') !== (value.code !== undefined) ||
        !Number.isSafeInteger(value.audio_ms) ||
        value.audio_ms < 0 ||
        (sourceObservation === 'v1'
          ? !canonicalSession(value.session)
          : !Number.isSafeInteger(value.session) || value.session < 0)
      )
        throw gateFailure('protocol');
      onEvent({
        event: 'stt_state',
        state: value.state,
        ...(value.code !== undefined ? { code: value.code } : {}),
        audio_ms: value.audio_ms,
        session: value.session,
      });
    } else if (value.event === 'source_problem' || value.event === 'dropped')
      throw gateFailure('protocol');
    else if (value.event === 'dev_source') {
      if (
        !['acknowledged', 'started', 'refused', 'stopping'].includes(
          value.step,
        ) ||
        (expectedApplication && value.application !== expectedApplication)
      )
        throw gateFailure('protocol');
      if (value.step === 'refused') throw gateFailure('protocol');
      onEvent({
        event: 'dev_source',
        step: value.step,
        application: value.application,
      });
    } else if (
      value.event === 'source_ended' &&
      (value.problem ||
        (expectedApplication && value.application !== expectedApplication))
    )
      throw gateFailure('protocol');
    else if (value.event === 'source_ended')
      onEvent({ event: 'source_ended', application: value.application });
    // Transcript/model payloads are discarded, never forwarded or logged.
  };
  const poll = () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const current = lstatSync(path),
        held = fstatSync(fd);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        held.dev !== original.dev ||
        held.ino !== original.ino ||
        current.uid !== original.uid ||
        (current.mode & 0o777) !== 0o600 ||
        current.size < offset ||
        current.size > maxFileBytes
      )
        throw gateFailure('protocol');
      const remaining = Math.min(current.size - offset, readBatchBytes);
      if (remaining > 0) {
        const chunk = Buffer.alloc(remaining);
        const got = readSync(fd, chunk, 0, remaining, offset);
        offset += got;
        if (got === 0) throw gateFailure('protocol');
        partial = Buffer.concat([partial, chunk.subarray(0, got)]);
        for (let end; (end = partial.indexOf(10)) !== -1;) {
          if (end + 1 > maxFrameBytes) throw gateFailure('protocol');
          const frame = partial.subarray(0, end);
          partial = partial.subarray(end + 1);
          partialAt = null;
          emit(
            parseUniqueLabJson(
              decoder.decode(frame),
              sourceObservation === 'v1'
                ? function (key, value, context) {
                    if (
                      ((this?.event === 'session' && this.live === true) ||
                        this?.event === 'evaluator' ||
                        this?.event === 'stt_state') &&
                      key === 'session'
                    ) {
                      if (!canonicalSession(context?.source))
                        throw gateFailure('protocol');
                      return context.source;
                    }
                    return value;
                  }
                : undefined,
            ),
          );
          if (stopped) return;
        }
        if (partial.length > maxFrameBytes) throw gateFailure('protocol');
        if (partial.length && partialAt === null) partialAt = performance.now();
        if (!partial.length) partialAt = null;
      }
      if (partialAt !== null && performance.now() - partialAt >= partialMs)
        throw gateFailure('protocol');
    } catch {
      fail();
    } finally {
      polling = false;
    }
  };
  timer = setInterval(poll, pollMs);
  return Object.freeze({
    poll,
    finish() {
      poll();
      if (!stopped && (partial.length || fstatSync(fd).size > offset)) fail();
      close();
    },
    close,
    get failed() {
      return failed;
    },
    get bytesRead() {
      return offset;
    },
  });
}
