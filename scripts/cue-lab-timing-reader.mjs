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

export function watchLabTiming({
  path,
  runId,
  onEvent,
  expectedCommit,
  expectedFeatures,
  expectedApplication,
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
    } else if (value.event === 'session') {
      if (
        !['started', 'ended'].includes(value.state) ||
        typeof value.live !== 'boolean' ||
        !Number.isSafeInteger(value.session) ||
        value.session < 0
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
      onEvent({ event: 'session', state: value.state });
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
    } else if (
      value.event === 'source_ended' &&
      (value.problem ||
        (expectedApplication && value.application !== expectedApplication))
    )
      throw gateFailure('protocol');
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
          emit(parseUniqueLabJson(decoder.decode(frame)));
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
