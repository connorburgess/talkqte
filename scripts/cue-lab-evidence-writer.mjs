// Explicit private fictional lab output only; never a normal-app logger.
import {
  constants,
  realpathSync,
  lstatSync,
  mkdtempSync,
  chmodSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fstatSync,
  fsyncSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import { TextDecoder } from 'node:util';
import { gateFailure } from './cue-lab-operation-gate.mjs';
const CHECKOUT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const EVENT = 'talkqte.lab.evidence.event.v1';
const MANIFEST = 'talkqte.lab.evidence.manifest.v1';
const STAGES = new Set([
  'speech.render-start',
  'speech.render-end',
  'transcript.arrived',
  'transcript.finalized',
  ...[
    'requested',
    'admitted',
    'dispatched',
    'responded',
    'returned',
    'validated',
    'settled',
    'result',
  ].map((s) => `evaluator.${s}`),
  'cue.decided',
  'cue.published',
  'cue.cleared',
  'video.cue-painted',
  'video.cue-cleared',
  'source.listening',
  'recorder.frame-accepted',
  'run.started',
  'run.ended',
  'gap',
]);
const OUTCOMES = new Set([
  'observed',
  'show',
  'quiet',
  'resolved',
  'withdraw',
  'failure',
  'stale',
  'cancelled',
  'unknown',
]);
const ID_KEYS = new Set([
  'sessionId',
  'requestId',
  'contextRevision',
  'cueId',
  'lineId',
  'segmentId',
]);
const U64 = new Set(['sessionId', 'requestId', 'contextRevision']);
const CONTENT = new Set([
  'spokenText',
  'transcriptText',
  'request',
  'validatedResponse',
]);
const PAYLOAD = new Set([...CONTENT, 'decider', 'dropped']);
const required = (ok) => {
  if (!ok) throw gateFailure('protocol');
};
const object = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) =>
  object(v) && Object.keys(v).every((k) => keys.includes(k));
const token = (v) =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(v);
const number = (v) =>
  Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER / 4;
const integer = (v, min, max) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const stamp = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
function outside(path) {
  const canonical = realpathSync(path),
    r = relative(CHECKOUT, canonical);
  required(r === '..' || r.startsWith('..' + sep) || isAbsolute(r));
  return canonical;
}
function safeValue(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  budget.bytes += 8;
  required(depth <= 12 && ++budget.nodes <= 4096 && budget.bytes <= 60000);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    required(Number.isFinite(value));
    return;
  }
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value);
    required(budget.bytes <= 60000);
    required(
      Buffer.byteLength(value) <= 16384 &&
        !/[\x00-\x08\x0b-\x1f\x7f]/.test(value),
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) safeValue(item, depth + 1, budget);
    return;
  }
  required(object(value));
  for (const [key, item] of Object.entries(value)) {
    budget.bytes += Buffer.byteLength(key);
    required(budget.bytes <= 60000);
    // Defense in depth for trusted fictional inputs, not a secret detector.
    required(
      !/auth|credential|nonce|token|password|secret|api.?key|environment|(^|_)env($|_)|reasoning|chain.?of.?thought/i.test(
        key,
      ),
    );
    safeValue(item, depth + 1, budget);
  }
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    required(n > 0);
    offset += n;
  }
}
export function createLabEvidenceWriter({
  parentDirectory,
  runId,
  mode = 'prepared',
  fictional,
  contentMode = 'metadata',
  retentionMs = 7 * 86400000,
  limits = {
    maxFileBytes: 4 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    maxEvents: 10000,
  },
  onFailure,
} = {}) {
  required(
    fictional === true &&
      token(runId) &&
      ['prepared', 'adaptive'].includes(mode) &&
      ['metadata', 'fictional-content'].includes(contentMode) &&
      integer(retentionMs, 1, 30 * 86400000) &&
      exact(limits, ['maxFileBytes', 'maxTotalBytes', 'maxEvents']) &&
      integer(limits.maxFileBytes, 4096, 16 * 1024 * 1024) &&
      integer(limits.maxTotalBytes, limits.maxFileBytes, 64 * 1024 * 1024) &&
      integer(limits.maxEvents, 2, 50000) &&
      (onFailure === undefined || typeof onFailure === 'function'),
  );
  limits = Object.freeze({ ...limits });
  const parent = outside(parentDirectory);
  required(lstatSync(parent).isDirectory());
  const directory = mkdtempSync(join(parent, 'tq-evidence-'));
  chmodSync(directory, 0o700);
  const eventPath = join(directory, 'events.jsonl');
  const fd = openSync(
    eventPath,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const createdAt = new Date().toISOString();
  const clocks = [],
    guards = [],
    artifacts = [];
  let bytes = 0,
    count = 0,
    rawRows = 0,
    totalBytes = 0,
    terminal = false,
    closed = false,
    result,
    closeError;
  let dropped = 0;
  const append = (event) => {
    const line = Buffer.from(JSON.stringify(event) + '\n');
    required(
      line.length <= 65536 &&
        bytes + line.length <= limits.maxFileBytes &&
        totalBytes + bytes + line.length <= limits.maxTotalBytes,
    );
    writeAll(fd, line);
    bytes += line.length;
    count++;
  };
  const fail = () => {
    if (terminal) return;
    terminal = true;
    dropped++;
    try {
      append({
        schema: EVENT,
        eventId: `event:${count + 1}`,
        runId,
        stage: 'gap',
        outcome: 'failure',
        ids: {},
        payload: { dropped: 1 },
      });
    } catch {
      /* Manifest retains failure/dropped even when the filesystem fails. */
    }
    try {
      onFailure?.(gateFailure('protocol'));
    } catch {
      /* Abort delivery cannot prevent finalization. */
    }
  };
  const api = {
    directory,
    addClock(clock) {
      required(
        !terminal &&
          !closed &&
          clocks.length < 64 &&
          exact(clock, ['id', 'kind', 'sessionId', 'anchor']) &&
          token(clock.id) &&
          !clocks.some((c) => c.id === clock.id) &&
          ['recording', 'monotonic', 'native-session'].includes(clock.kind),
      );
      if (clock.kind === 'native-session')
        required(
          typeof clock.sessionId === 'string' &&
            /^[1-9]\d{0,19}$/.test(clock.sessionId) &&
            BigInt(clock.sessionId) <= 18446744073709551615n,
        );
      else required(clock.sessionId === undefined);
      if (clock.anchor)
        required(
          exact(clock.anchor, [
            'clockMs',
            'recordingMs',
            'uncertaintyMs',
            'validFromMs',
            'validToMs',
          ]) &&
            [
              'clockMs',
              'recordingMs',
              'uncertaintyMs',
              'validFromMs',
              'validToMs',
            ].every((k) => number(clock.anchor[k])) &&
            clock.anchor.validFromMs <= clock.anchor.clockMs &&
            clock.anchor.clockMs <= clock.anchor.validToMs,
        );
      clocks.push(structuredClone(clock));
    },
    recordGuard(guard) {
      const base = [
        'nativeStartedAt',
        'sourceDeadline',
        'startRequestAt',
        'startBudgetMs',
        'mediaDurationMs',
        'completionReserveMs',
        'remainingAtRequestMs',
      ];
      const actual = [
        'actualAnchorMs',
        'actualUncertaintyMs',
        'remainingAtAnchorMs',
      ];
      required(
        !closed &&
          !terminal &&
          guards.length < 2 &&
          exact(guard, [...base, ...actual]) &&
          base.every((k) => number(guard[k])),
      );
      required(
        guard.sourceDeadline - guard.nativeStartedAt === 110000 &&
          guard.mediaDurationMs === 102480 &&
          guard.startRequestAt >= guard.nativeStartedAt &&
          guard.remainingAtRequestMs ===
            guard.sourceDeadline - guard.startRequestAt,
      );
      required(
        guard.remainingAtRequestMs >=
          guard.startBudgetMs +
            guard.mediaDurationMs +
            guard.completionReserveMs,
      );
      if (guards.length) {
        required(
          base.every((k) => guard[k] === guards[0][k]) &&
            actual.every((k) => number(guard[k])) &&
            guard.actualUncertaintyMs <= 100 &&
            guard.remainingAtAnchorMs ===
              guard.sourceDeadline -
                guard.actualAnchorMs -
                guard.actualUncertaintyMs &&
            guard.remainingAtAnchorMs >=
              guard.mediaDurationMs + guard.completionReserveMs,
        );
      } else required(actual.every((k) => guard[k] === undefined));
      guards.push(structuredClone(guard));
    },
    emit(input) {
      if (closed || terminal) return false;
      try {
        required(
          exact(input, ['stage', 'outcome', 'ids', 'timing', 'payload']) &&
            STAGES.has(input.stage) &&
            OUTCOMES.has(input.outcome),
        );
        const ids = input.ids ?? {};
        required(object(ids));
        for (const [key, value] of Object.entries(ids)) {
          required(ID_KEYS.has(key));
          required(
            U64.has(key)
              ? typeof value === 'string' &&
                  /^[1-9]\d{0,19}$/.test(value) &&
                  BigInt(value) <= 18446744073709551615n
              : token(value),
          );
        }
        if (input.timing) {
          const t = input.timing,
            c = clocks.find((c) => c.id === t.clockId);
          required(
            exact(t, ['clockId', 'atMs', 'uncertaintyMs', 'basis']) &&
              c &&
              number(t.atMs) &&
              number(t.uncertaintyMs) &&
              ['event', 'receipt', 'frame', 'scheduled'].includes(t.basis),
          );
          if (c.kind === 'native-session')
            required(c.sessionId === ids.sessionId);
          if (input.stage.startsWith('video.'))
            required(t.basis === 'frame' && c.kind === 'recording');
        } else required(!input.stage.startsWith('video.'));
        if (input.payload !== undefined) {
          required(
            object(input.payload) &&
              Object.keys(input.payload).every((k) => PAYLOAD.has(k)),
          );
          for (const [key, value] of Object.entries(input.payload)) {
            if (CONTENT.has(key)) required(contentMode === 'fictional-content');
            if (key === 'decider')
              required(['phrase_rule', 'model'].includes(value));
            if (key === 'dropped') required(integer(value, 1, 50000));
            if (key === 'spokenText' || key === 'transcriptText')
              required(typeof value === 'string');
            if (key === 'request')
              required(
                exact(value, ['role', 'instructions', 'input']) &&
                  token(value.role) &&
                  typeof value.instructions === 'string' &&
                  Object.hasOwn(value, 'input'),
              );
          }
          safeValue(input.payload);
        }
        // Reserve one event and 1KiB for a terminal gap rather than silently truncate.
        required(
          count + rawRows < limits.maxEvents - 1 &&
            bytes < limits.maxFileBytes - 1024,
        );
        const event = {
          schema: EVENT,
          eventId: `event:${count + 1}`,
          runId,
          ...structuredClone(input),
          ids: { ...ids },
        };
        const encoded = Buffer.byteLength(JSON.stringify(event) + '\n');
        required(
          bytes + encoded <= limits.maxFileBytes - 1024 &&
            totalBytes + bytes + encoded <= limits.maxTotalBytes - 1024,
        );
        append(event);
        return true;
      } catch {
        fail();
        return false;
      }
    },
    attach({
      id,
      kind,
      path,
      clockId,
      durationMs,
      sealed,
      snapshotCoverage,
    } = {}) {
      required(
        !closed &&
          !terminal &&
          sealed === true &&
          token(id) &&
          id !== 'events' &&
          !artifacts.some((a) => a.id === id) &&
          artifacts.length < 126 &&
          ['native-timing', 'recording'].includes(kind),
      );
      required(kind !== 'native-timing' || contentMode === 'fictional-content');
      required(clockId === undefined || clocks.some((c) => c.id === clockId));
      required(kind !== 'native-timing' || clockId !== undefined);
      required(kind !== 'recording' || number(durationMs));
      required(
        kind !== 'recording' || !artifacts.some((a) => a.kind === 'recording'),
      );
      if (snapshotCoverage !== undefined) {
        const c = snapshotCoverage;
        required(
          kind === 'native-timing' &&
            exact(c, [
              'schema',
              'runId',
              'sourcePath',
              'sourceIdentity',
              'sourceReleaseObserved',
              'recorderFinalizationObserved',
              'nativeWriterMayRemainOpen',
              'cutoffReceipt',
              'observedBytesAtOpen',
              'observedBytesAtEnd',
              'cutoffBytes',
              'readBytes',
              'copiedBytes',
              'rows',
              'trailingPartialBytes',
              'omittedBytesAtCutoff',
              'unobservedBytesAtOpen',
              'grewDuringCopy',
              'rowLimitReached',
              'completeRunCoverage',
              'unknownLateRecords',
              'sha256',
            ]) &&
            c.schema === 'talkqte.lab.timing-snapshot.v1' &&
            c.runId === runId &&
            typeof c.sourcePath === 'string' &&
            isAbsolute(c.sourcePath) &&
            exact(c.sourceIdentity, ['dev', 'ino']) &&
            ['dev', 'ino'].every(
              (k) =>
                typeof c.sourceIdentity[k] === 'string' &&
                /^(0|[1-9]\d*)$/.test(c.sourceIdentity[k]),
            ) &&
            c.sourceReleaseObserved === true &&
            c.recorderFinalizationObserved === true &&
            c.nativeWriterMayRemainOpen === true &&
            c.completeRunCoverage === false &&
            c.unknownLateRecords === true &&
            exact(c.cutoffReceipt, ['clockId', 'atMs', 'basis']) &&
            clocks.some((clock) => clock.id === c.cutoffReceipt.clockId) &&
            number(c.cutoffReceipt.atMs) &&
            c.cutoffReceipt.basis === 'receipt' &&
            [
              'observedBytesAtOpen',
              'observedBytesAtEnd',
              'cutoffBytes',
              'readBytes',
              'copiedBytes',
              'rows',
              'omittedBytesAtCutoff',
              'unobservedBytesAtOpen',
            ].every((k) => Number.isSafeInteger(c[k]) && c[k] >= 0) &&
            typeof c.grewDuringCopy === 'boolean' &&
            typeof c.rowLimitReached === 'boolean' &&
            (c.rowLimitReached
              ? c.trailingPartialBytes === null
              : Number.isSafeInteger(c.trailingPartialBytes) &&
                c.trailingPartialBytes >= 0) &&
            c.observedBytesAtEnd >= c.observedBytesAtOpen &&
            c.copiedBytes <= c.readBytes &&
            c.readBytes <= c.cutoffBytes &&
            c.cutoffBytes <= c.observedBytesAtOpen &&
            c.omittedBytesAtCutoff === c.cutoffBytes - c.copiedBytes &&
            c.unobservedBytesAtOpen === c.observedBytesAtOpen - c.cutoffBytes &&
            /^[a-f0-9]{64}$/.test(c.sha256),
        );
      }
      const source = outside(path);
      required(source === path && !lstatSync(path).isSymbolicLink());
      const max = kind === 'recording' ? 4 * 1024 ** 3 : limits.maxFileBytes;
      const input = openSync(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const destination = join(
        directory,
        `${id}.${kind === 'recording' ? 'mov' : 'jsonl'}`,
      );
      let output,
        size = 0,
        rows = 0,
        partial = Buffer.alloc(0);
      const decoder = new TextDecoder('utf8', { fatal: true });
      const hash = createHash('sha256');
      try {
        const before = fstatSync(input);
        required(before.isFile() && before.size > 0 && before.size <= max);
        output = openSync(
          destination,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        const chunk = Buffer.alloc(65536);
        let n;
        while ((n = readSync(input, chunk, 0, chunk.length, null)) > 0) {
          size += n;
          required(size <= max);
          if (kind !== 'recording') {
            partial = Buffer.concat([partial, chunk.subarray(0, n)]);
            for (let end; (end = partial.indexOf(10)) !== -1;) {
              required(end > 0 && end <= 65536);
              const row = parseUniqueLabJson(
                decoder.decode(partial.subarray(0, end)),
              );
              required(object(row));
              safeValue(row);
              if (row.run_id !== undefined) required(row.run_id === runId);
              partial = partial.subarray(end + 1);
              rows++;
            }
            required(partial.length <= 65536);
            required(
              totalBytes + bytes + size <= limits.maxTotalBytes - 1024 &&
                count + rawRows + rows < limits.maxEvents,
            );
          }
          hash.update(chunk.subarray(0, n));
          writeAll(output, chunk.subarray(0, n));
        }
        required(
          size === before.size &&
            stamp(before) === stamp(fstatSync(input)) &&
            (kind === 'recording' || partial.length === 0),
        );
        fsyncSync(output);
      } catch (error) {
        if (output !== undefined) {
          closeSync(output);
          output = undefined;
          try {
            unlinkSync(destination);
          } catch {}
        }
        fail();
        throw error;
      } finally {
        closeSync(input);
        if (output !== undefined) closeSync(output);
      }
      const sha256 = hash.digest('hex');
      if (
        snapshotCoverage &&
        (snapshotCoverage.sha256 !== sha256 ||
          snapshotCoverage.copiedBytes !== size ||
          snapshotCoverage.rows !== rows)
      ) {
        try {
          unlinkSync(destination);
        } catch {}
        fail();
        throw gateFailure('protocol');
      }
      const artifact = {
        id,
        kind,
        path: destination.slice(directory.length + 1),
        sha256,
        bytes: size,
        ...(snapshotCoverage
          ? { snapshotCoverage: structuredClone(snapshotCoverage) }
          : {}),
        ...(clockId ? { clockId } : {}),
      };
      artifacts.push(artifact);
      if (kind !== 'recording') {
        totalBytes += size;
        rawRows += rows;
      } else artifact.durationMs = durationMs;
      return Object.freeze({ ...artifact });
    },
    close() {
      if (closed) {
        if (closeError) throw closeError;
        return result;
      }
      closed = true;
      try {
        const eventHash = createHash('sha256');
        try {
          fsyncSync(fd);
          const size = fstatSync(fd).size;
          required(size <= limits.maxFileBytes);
          const chunk = Buffer.alloc(65536);
          let at = 0,
            n;
          while ((n = readSync(fd, chunk, 0, chunk.length, at)) > 0) {
            at += n;
            required(at <= limits.maxFileBytes);
            eventHash.update(chunk.subarray(0, n));
          }
          if (at !== bytes) {
            terminal = true;
            bytes = at;
          }
        } finally {
          closeSync(fd);
        }
        const recording = artifacts.find((a) => a.kind === 'recording');
        const manifest = {
          schema: MANIFEST,
          runId,
          mode,
          fictional: true,
          contentMode,
          createdAt,
          expiresAt: new Date(
            Date.parse(createdAt) + retentionMs,
          ).toISOString(),
          limits: { ...limits },
          clocks,
          artifacts: [
            {
              id: 'events',
              kind: 'events',
              path: 'events.jsonl',
              sha256: eventHash.digest('hex'),
              bytes,
            },
            ...artifacts.map(({ durationMs: _duration, ...a }) => a),
          ],
          ...(recording
            ? {
                recording: {
                  artifactId: recording.id,
                  durationMs: recording.durationMs,
                },
              }
            : {}),
          guards,
          runtime: {
            node: process.version,
            libuv: process.versions.uv,
            platform: process.platform,
          },
          writer: {
            failed: terminal,
            dropped,
            events: count,
            nativeRows: rawRows,
            retentionEnforced: false,
          },
        };
        const manifestPath = join(directory, 'manifest.json');
        const manifestFd = openSync(
          manifestPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeAll(
            manifestFd,
            Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
          );
          fsyncSync(manifestFd);
        } finally {
          closeSync(manifestFd);
        }
        result = Object.freeze({ manifestPath, failed: terminal, dropped });
        return result;
      } catch {
        closeError = gateFailure('cleanup');
        throw closeError;
      }
    },
  };
  return Object.freeze(api);
}
