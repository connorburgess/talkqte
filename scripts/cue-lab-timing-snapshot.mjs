// A bounded prefix snapshot, never a native writer flush or exit acknowledgement.
import {
  constants,
  realpathSync,
  lstatSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';
const CHECKOUT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const required = (ok) => {
  if (!ok) throw gateFailure('protocol');
};
const integer = (v, min, max) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const outside = (path) => {
  const canonical = realpathSync(path),
    r = relative(CHECKOUT, canonical);
  required(r === '..' || r.startsWith('..' + sep) || isAbsolute(r));
  return canonical;
};
const writeAll = (fd, bytes) => {
  let at = 0;
  while (at < bytes.length) {
    const n = writeSync(fd, bytes, at, bytes.length - at);
    required(n > 0);
    at += n;
  }
};
export function snapshotLabTiming({
  path,
  parentDirectory,
  runId,
  expectedIdentity,
  sourceReleased,
  // Native ended the session itself (its source failed): { problem } with a
  // fixed label.
  nativeEnded,
  // Neither a release nor a native end was observed (a failed take, or
  // cleanup that never confirmed release): the app may still be writing.
  // The snapshot is still bounded by its own cutoff, and says so.
  sourceUnconfirmed,
  // Whether the recorder's finalization was observed; stated either way.
  recorderFinalized,
  maxBytes = 8 * 1024 * 1024,
  maxRows = 10000,
  maxFrameBytes = 65536,
} = {}) {
  const ends = [
    sourceReleased === true,
    nativeEnded !== undefined,
    sourceUnconfirmed === true,
  ].filter(Boolean).length;
  required(
    // Exactly one: released by the lab's Stop, ended by native itself, or
    // explicitly unconfirmed.
    ends === 1 &&
      [sourceReleased, sourceUnconfirmed].every(
        (v) => v === undefined || v === true,
      ) &&
      (nativeEnded === undefined ||
        /^[a-z_]{1,40}$/.test(nativeEnded?.problem ?? '')) &&
      typeof recorderFinalized === 'boolean' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(runId ?? '') &&
      expectedIdentity?.runId === runId &&
      ['dev', 'ino'].every(
        (k) =>
          typeof expectedIdentity[k] === 'string' &&
          /^(0|[1-9]\d*)$/.test(expectedIdentity[k]),
      ) &&
      integer(maxBytes, 1, 16 * 1024 * 1024) &&
      integer(maxRows, 1, 50000) &&
      integer(maxFrameBytes, 16, 65536),
  );
  required(outside(path) === path);
  const parent = outside(parentDirectory);
  required(lstatSync(parent).isDirectory());
  const original = lstatSync(path, { bigint: true });
  required(
    original.isFile() &&
      !original.isSymbolicLink() &&
      original.uid === BigInt(process.getuid()) &&
      (original.mode & 0o777n) === 0o600n,
  );
  required(
    original.dev.toString() === expectedIdentity.dev &&
      original.ino.toString() === expectedIdentity.ino,
  );
  const input = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let output, directory, destination;
  try {
    const before = fstatSync(input, { bigint: true });
    required(
      before.dev === original.dev &&
        before.ino === original.ino &&
        before.size >= original.size &&
        before.size <= BigInt(Number.MAX_SAFE_INTEGER),
    );
    const observedBytes = Number(before.size),
      cutoffBytes = Math.min(observedBytes, maxBytes),
      cutoffReceiptMs = performance.now();
    directory = mkdtempSync(join(parent, 'timing-snapshot-'));
    chmodSync(directory, 0o700);
    destination = join(directory, 'native-snapshot.jsonl');
    output = openSync(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash('sha256'),
      decoder = new TextDecoder('utf8', { fatal: true });
    let at = 0,
      partial = Buffer.alloc(0),
      rows = 0,
      copiedBytes = 0,
      rowLimit = false;
    const chunk = Buffer.alloc(Math.min(65536, maxBytes));
    while (at < cutoffBytes && !rowLimit) {
      const n = readSync(
        input,
        chunk,
        0,
        Math.min(chunk.length, cutoffBytes - at),
        at,
      );
      required(n > 0);
      at += n;
      partial = Buffer.concat([partial, chunk.subarray(0, n)]);
      for (let end; (end = partial.indexOf(10)) !== -1;) {
        if (rows === maxRows) {
          rowLimit = true;
          break;
        }
        required(end > 0 && end <= maxFrameBytes);
        const line = partial.subarray(0, end),
          row = parseUniqueLabJson(decoder.decode(line));
        required(
          row !== null && typeof row === 'object' && !Array.isArray(row),
        );
        if (row.run_id !== undefined) required(row.run_id === runId);
        const complete = partial.subarray(0, end + 1);
        writeAll(output, complete);
        hash.update(complete);
        copiedBytes += complete.length;
        rows++;
        partial = partial.subarray(end + 1);
        // The accepted row boundary, not another newline, closes inspection.
        // Excluded tails may be large, malformed or unterminated.
        if (rows === maxRows && copiedBytes < cutoffBytes) {
          rowLimit = true;
          break;
        }
      }
      if (!rowLimit) required(partial.length <= maxFrameBytes);
    }
    const after = fstatSync(input, { bigint: true }),
      current = lstatSync(path, { bigint: true });
    required(
      after.dev === before.dev &&
        after.ino === before.ino &&
        after.size >= before.size &&
        current.dev === before.dev &&
        current.ino === before.ino &&
        current.size >= before.size &&
        after.size <= BigInt(Number.MAX_SAFE_INTEGER),
    );
    fsyncSync(output);
    closeSync(output);
    output = undefined;
    const sha256 = hash.digest('hex');
    const coverage = {
      schema: 'talkqte.lab.timing-snapshot.v1',
      runId,
      sourcePath: path,
      sourceIdentity: Object.freeze({
        dev: expectedIdentity.dev,
        ino: expectedIdentity.ino,
      }),
      sourceReleaseObserved: sourceReleased === true,
      sourceEnd:
        sourceReleased === true
          ? 'released'
          : nativeEnded
            ? 'native-ended'
            : 'unconfirmed',
      ...(nativeEnded ? { nativeEndProblem: nativeEnded.problem } : {}),
      recorderFinalizationObserved: recorderFinalized,
      nativeWriterMayRemainOpen: true,
      cutoffReceipt: Object.freeze({
        clockId: 'node',
        atMs: cutoffReceiptMs,
        basis: 'receipt',
      }),
      observedBytesAtOpen: observedBytes,
      observedBytesAtEnd: Number(after.size),
      cutoffBytes,
      readBytes: at,
      copiedBytes,
      rows,
      trailingPartialBytes: rowLimit ? null : partial.length,
      omittedBytesAtCutoff: cutoffBytes - copiedBytes,
      unobservedBytesAtOpen: observedBytes - cutoffBytes,
      grewDuringCopy: after.size > before.size,
      rowLimitReached: rowLimit,
      completeRunCoverage: false,
      unknownLateRecords: true,
      sha256,
    };
    const metadata = join(directory, 'SNAPSHOT.json'),
      fd = openSync(
        metadata,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    try {
      writeAll(fd, Buffer.from(JSON.stringify(coverage, null, 2) + '\n'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Only this completed snapshot is sealed. No further writer owns its FD.
    return Object.freeze({
      path: destination,
      metadataPath: metadata,
      sha256,
      bytes: copiedBytes,
      sealed: true,
      coverage: Object.freeze(coverage),
    });
  } catch {
    if (output !== undefined) {
      closeSync(output);
      output = undefined;
    }
    if (destination)
      try {
        unlinkSync(destination);
      } catch {}
    throw gateFailure('protocol');
  } finally {
    closeSync(input);
  }
}
