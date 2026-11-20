// Read-only exact owned-window discovery through the dedicated helper interface.
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import { checkLabPlayerSource, hashLabOwnedFile } from './cue-lab-player.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const required = (v) => {
  if (!v) throw gateFailure('protocol');
};
const integer = (v) => Number.isSafeInteger(v) && v > 0 && v <= 0x7fffffff;
function verify(binary, sha256, max = 64 * 1024 * 1024) {
  required(
    isAbsolute(binary ?? '') &&
      realpathSync(binary) === binary &&
      /^[a-f0-9]{64}$/.test(sha256 ?? ''),
  );
  const r = relative(root, binary),
    s = lstatSync(binary);
  required(
    (r === '..' || r.startsWith('..' + sep) || isAbsolute(r)) &&
      s.isFile() &&
      !s.isSymbolicLink() &&
      s.size > 0 &&
      s.size <= max &&
      (s.mode & 0o111) !== 0,
  );
  required(hashLabOwnedFile(binary, max) === sha256);
}
export function selectLabOwnedWindowRows(
  rows,
  {
    playerSource,
    nativeIdentity,
    nativeApplication = 'TalkQTE Development',
  } = {},
) {
  required(
    ['TalkQTE', 'TalkQTE Development'].includes(nativeApplication) &&
      integer(nativeIdentity?.pid) &&
      playerSource?.runId === nativeIdentity.runId &&
      integer(playerSource.pid) &&
      integer(playerSource.windowId),
  );
  required(Array.isArray(rows) && rows.length <= 64);
  for (const row of rows)
    required(
      row.event === 'window' &&
        [playerSource.pid, nativeIdentity.pid].includes(row.pid) &&
        ['TalkQTE Lab Player', nativeApplication].includes(row.app) &&
        integer(row.windowId) &&
        typeof row.title === 'string' &&
        row.title.length <= 256 &&
        typeof row.onScreen === 'boolean' &&
        Number.isFinite(row.frame?.width) &&
        Number.isFinite(row.frame?.height),
    );
  const player = rows.filter(
    (r) =>
      r.pid === playerSource.pid &&
      r.windowId === playerSource.windowId &&
      r.app === 'TalkQTE Lab Player' &&
      r.onScreen &&
      r.frame.width > 40 &&
      r.frame.height > 40,
  );
  const companion = rows.filter(
    (r) =>
      r.pid === nativeIdentity.pid &&
      r.app === nativeApplication &&
      r.title === 'TalkQTE companion' &&
      r.onScreen &&
      r.frame.width > 40 &&
      r.frame.height > 40,
  );
  required(
    player.length === 1 &&
      companion.length === 1 &&
      player[0].windowId !== companion[0].windowId,
  );
  return {
    emulator: {
      app: player[0].app,
      pid: player[0].pid,
      windowId: player[0].windowId,
    },
    companion: {
      app: companion[0].app,
      pid: companion[0].pid,
      windowId: companion[0].windowId,
    },
  };
}
function ownedWindowSelector({
  binary,
  sha256,
  playerSource,
  native,
  nativeApplication = 'TalkQTE Development',
  deadlineMs = 2000,
  fixtureCase,
} = {}) {
  const max = fixtureCase ? 256 * 1024 * 1024 : 64 * 1024 * 1024;
  verify(binary, sha256, max);
  if (!fixtureCase) checkLabPlayerSource(playerSource);
  required(
    typeof native === 'object' &&
      ['TalkQTE', 'TalkQTE Development'].includes(nativeApplication) &&
      Number.isSafeInteger(deadlineMs) &&
      deadlineMs > 0 &&
      deadlineMs <= 2000,
  );
  let used = false;
  return async ({ runId, signal } = {}) => {
    required(
      !used &&
        !signal?.aborted &&
        native.identity?.runId === runId &&
        playerSource.runId === runId,
    );
    used = true;
    const identity = structuredClone(native.identity);
    required(
      integer(identity.pid) &&
        integer(playerSource.pid) &&
        integer(playerSource.windowId),
    );
    verify(binary, sha256, max);
    if (!fixtureCase) checkLabPlayerSource(playerSource);
    return new Promise((resolve, reject) => {
      let partial = Buffer.alloc(0),
        bytes = 0,
        stderr = 0,
        settled = false,
        failed = false,
        timer,
        hardTimer;
      const rows = [],
        decoder = new TextDecoder('utf8', { fatal: true });
      const child = spawn(
        binary,
        [
          ...(fixtureCase
            ? [
                fileURLToPath(
                  new URL(
                    './fixtures/lab-window-list-child.mjs',
                    import.meta.url,
                  ),
                ),
                fixtureCase,
              ]
            : []),
          '--list',
          '--strict-windows',
          '--apps',
          `TalkQTE Lab Player,${nativeApplication}`,
          '--emulator-pid',
          String(playerSource.pid),
          '--companion-pid',
          String(identity.pid),
        ],
        {
          shell: false,
          detached: true,
          env: {},
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const group = (signal) => {
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch (error) {
          if (error.code === 'ESRCH') return false;
          throw error;
        }
      };
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        signal?.removeEventListener('abort', fail);
        if (error) reject(gateFailure(error));
        else resolve(value);
      };
      const fail = () => {
        if (failed || settled) return;
        failed = true;
        // Arm cleanup before TERM: a synchronous parent close must not cancel
        // retirement while an owned descendant still holds the process group.
        hardTimer = setTimeout(() => {
          try {
            group('SIGKILL');
          } catch {}
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, 'cleanup');
        }, 100);
        try {
          group('SIGTERM');
        } catch {}
      };
      child.once('error', fail);
      if (!integer(child.pid)) return finish(null, 'cleanup');
      child.stdout.on('data', (chunk) => {
        if (failed || settled) return;
        try {
          bytes += chunk.length;
          required(bytes <= 65536);
          partial = Buffer.concat([partial, chunk]);
          for (let end; (end = partial.indexOf(10)) !== -1;) {
            required(end <= 4096);
            rows.push(
              parseUniqueLabJson(decoder.decode(partial.subarray(0, end))),
            );
            partial = partial.subarray(end + 1);
            required(rows.length <= 64);
          }
          required(partial.length <= 4096);
        } catch {
          fail();
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.length;
        if (stderr > 8192) fail();
      });
      child.once('close', (code, terminated) => {
        if (settled) return;
        if (failed) {
          try {
            if (!group(0)) finish(null, 'cleanup');
          } catch {}
          // Parent exit/closed pipes do not retire surviving descendants.
          // Keep the bounded KILL path armed until group absence is proven.
          return;
        }
        try {
          required(
            code === 0 &&
              !terminated &&
              !partial.length &&
              !group(0) &&
              native.identity?.pid === identity.pid &&
              native.identity?.runId === identity.runId,
          );
          if (!fixtureCase) checkLabPlayerSource(playerSource);
          finish(
            selectLabOwnedWindowRows(rows, {
              playerSource,
              nativeIdentity: identity,
              nativeApplication,
            }),
          );
        } catch {
          fail();
        }
      });
      timer = setTimeout(fail, deadlineMs);
      signal?.addEventListener('abort', fail, { once: true });
      if (signal?.aborted) fail();
    });
  };
}

export function createLabOwnedWindowSelector(options = {}) {
  required(options.fixtureCase === undefined);
  return ownedWindowSelector(options);
}
export function createLabOwnedWindowSelectorFixture({
  fixtureCase = 'normal',
  ...options
} = {}) {
  required(
    [
      'normal',
      'partial',
      'foreign',
      'duplicate',
      'oversize',
      'malformed',
      'held-pipes',
    ].includes(fixtureCase),
  );
  return ownedWindowSelector({
    ...options,
    binary: realpathSync(process.execPath),
    sha256: hashLabOwnedFile(process.execPath, 256 * 1024 * 1024),
    fixtureCase,
  });
}
