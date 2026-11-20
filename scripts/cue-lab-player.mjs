// Owned fixed-media player only. No desktop controls, fallback or model action.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const FIXTURE = fileURLToPath(
  new URL('./fixtures/lab-player-child.mjs', import.meta.url),
);
import { TextDecoder } from 'node:util';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';

export const LAB_PLAYER_MEDIA_SHA256 =
  '1faf1c404249bed069065f51262abfce6956fa8a31f237e68bb6e9d06cb893e2';
const SCHEMA = 'talkqte.lab.player.v1';
const BASE = ['schema', 'type', 'runId', 'generation', 'mediaSha256'];
const CHECKOUT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const required = (ok) => {
  if (!ok) throw gateFailure('protocol');
};
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const uint = (v, max = 18446744073709551615n) =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= max;
const positive = (v) => uint(v) && v !== '0';
const integer = (v, min, max) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const outside = (path) => {
  const r = relative(CHECKOUT, realpathSync(path));
  return r === '..' || r.startsWith('..' + sep) || isAbsolute(r);
};
const file = (path, max) => {
  required(
    isAbsolute(path ?? '') && realpathSync(path) === path && outside(path),
  );
  const s = lstatSync(path);
  required(s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= max);
  return s;
};
const digest = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const stamp = (s) =>
  [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode].join(':');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

// Separate approval pins the receipt bytes; receipt claims do not approve themselves.
export function verifyLabPlayerBuild({ manifestFile, approved } = {}) {
  try {
    const manifestStat = file(manifestFile, 16384);
    required(
      (manifestStat.mode & 0o777) === 0o600 &&
        manifestStat.uid === process.getuid?.(),
    );
    required(exact(approved, ['manifestSha256', 'executableSha256', 'commit']));
    const raw = readFileSync(manifestFile);
    required(
      createHash('sha256').update(raw).digest('hex') ===
        approved.manifestSha256,
    );
    const v = parseUniqueLabJson(raw.toString('utf8'));
    required(
      exact(v, [
        'schema',
        'executable',
        'bundlePath',
        'sha256',
        'commit',
        'signature',
      ]) &&
        v.schema === 'talkqte.lab.player.build.v1' &&
        v.sha256 === approved.executableSha256 &&
        /^[a-f0-9]{64}$/.test(v.sha256) &&
        v.commit === approved.commit &&
        /^[a-f0-9]{40}$/.test(v.commit) &&
        exact(v.signature, [
          'identifier',
          'authority',
          'designatedRequirement',
        ]) &&
        v.signature.identifier === 'com.talkqte.lab-player' &&
        v.signature.authority === 'TalkQTE Development' &&
        typeof v.signature.designatedRequirement === 'string' &&
        v.signature.designatedRequirement.length < 8192 &&
        v.signature.designatedRequirement.includes('certificate leaf') &&
        typeof v.bundlePath === 'string' &&
        v.bundlePath.endsWith('.app') &&
        realpathSync(v.bundlePath) === v.bundlePath &&
        outside(v.bundlePath) &&
        v.executable === join(v.bundlePath, 'Contents/MacOS/lab-owned-player'),
    );
    const inspect = () => {
      required(realpathSync(v.bundlePath) === v.bundlePath);
      const s = file(v.executable, 64 * 1024 * 1024);
      required((s.mode & 0o111) !== 0);
      const plist = (key) => {
        const r = spawnSync(
          '/usr/libexec/PlistBuddy',
          ['-c', `Print :${key}`, join(v.bundlePath, 'Contents/Info.plist')],
          { encoding: 'utf8', timeout: 3000, maxBuffer: 16384 },
        );
        required(r.status === 0);
        return r.stdout.trim();
      };
      required(
        plist('CFBundleIdentifier') === 'com.talkqte.lab-player' &&
          plist('CFBundleExecutable') === 'lab-owned-player' &&
          plist('CFBundleName') === 'TalkQTE Lab Player',
      );
      const verify = spawnSync(
        '/usr/bin/codesign',
        ['--verify', '--strict', '--deep', v.bundlePath],
        { timeout: 5000, maxBuffer: 16384 },
      );
      required(verify.status === 0);
      const display = spawnSync(
        '/usr/bin/codesign',
        ['--display', '--verbose=4', '--requirements', '-', v.bundlePath],
        { encoding: 'utf8', timeout: 3000, maxBuffer: 16384 },
      );
      required(display.status === 0);
      const lines = (display.stdout + '\n' + display.stderr).split('\n');
      required(
        lines.filter((x) => x.startsWith('Authority=')).join('\n') ===
          'Authority=TalkQTE Development' &&
          lines.includes('Identifier=com.talkqte.lab-player') &&
          lines.includes('designated => ' + v.signature.designatedRequirement),
      );
      required(digest(v.executable) === v.sha256);
      return stamp(s);
    };
    const before = inspect();
    return Object.freeze({
      executable: v.executable,
      bundlePath: v.bundlePath,
      sha256: v.sha256,
      check() {
        required(inspect() === before);
      },
    });
  } catch {
    throw gateFailure('protocol');
  }
}

export function labPlayerClockOffset({
  absoluteBeforeTicks,
  continuousTicks,
  absoluteAfterTicks,
}) {
  required(
    positive(absoluteBeforeTicks) &&
      positive(continuousTicks) &&
      positive(absoluteAfterTicks),
  );
  const before = BigInt(absoluteBeforeTicks),
    continuous = BigInt(continuousTicks),
    after = BigInt(absoluteAfterTicks);
  required(after >= before);
  return { low: continuous - after, high: continuous - before };
}

export function mapLabPlayerStart(
  frame,
  bridge,
  { nowMs = performance.now() } = {},
) {
  required(
    exact(bridge, [
      'sentMs',
      'receivedMs',
      'hostTicks',
      'absoluteBeforeTicks',
      'absoluteAfterTicks',
      'timebaseNumer',
      'timebaseDenom',
    ]) &&
      Number.isFinite(bridge.sentMs) &&
      Number.isFinite(bridge.receivedMs) &&
      bridge.sentMs >= 0 &&
      bridge.sentMs <= 2 ** 32 &&
      bridge.receivedMs >= bridge.sentMs &&
      bridge.receivedMs - bridge.sentMs <= 100 &&
      positive(bridge.hostTicks) &&
      integer(bridge.timebaseNumer, 1, 0xffffffff) &&
      integer(bridge.timebaseDenom, 1, 0xffffffff),
  );
  required(
    exact(frame, [
      ...BASE,
      'sampleRate',
      'totalFrames',
      'observations',
      'clockPair',
      'timebaseNumer',
      'timebaseDenom',
      'outputLatencyEstimateMs',
      'outputSampleRate',
      'outputChannels',
      'outputDeviceId',
      'hostTimeValid',
      'sampleTimeValid',
    ]) &&
      frame.type === 'started' &&
      frame.schema === SCHEMA &&
      frame.generation === '1' &&
      frame.mediaSha256 === LAB_PLAYER_MEDIA_SHA256 &&
      frame.sampleRate === 48000 &&
      integer(frame.totalFrames, 1, 105 * 48000) &&
      frame.hostTimeValid === true &&
      frame.sampleTimeValid === true &&
      frame.timebaseNumer === bridge.timebaseNumer &&
      frame.timebaseDenom === bridge.timebaseDenom &&
      Number.isFinite(frame.outputLatencyEstimateMs) &&
      frame.outputLatencyEstimateMs >= 0 &&
      frame.outputLatencyEstimateMs <= 10000 &&
      Number.isFinite(frame.outputSampleRate) &&
      frame.outputSampleRate > 0 &&
      integer(frame.outputChannels, 1, 32) &&
      integer(frame.outputDeviceId, 1, 0xffffffff) &&
      Array.isArray(frame.observations) &&
      frame.observations.length === 2,
  );
  required(
    exact(frame.clockPair, [
      'absoluteBeforeTicks',
      'continuousTicks',
      'absoluteAfterTicks',
    ]),
  );
  const probedOffset = labPlayerClockOffset({
    ...bridge,
    continuousTicks: bridge.hostTicks,
  });
  const currentOffset = labPlayerClockOffset(frame.clockPair);
  required(
    currentOffset.low <= probedOffset.high &&
      currentOffset.high >= probedOffset.low,
  );
  const offsetMid = (currentOffset.low + currentOffset.high) / 2n;
  const n = BigInt(bridge.timebaseNumer),
    d = BigInt(bridge.timebaseDenom),
    rate = 48000n;
  const observations = frame.observations.map((o) => {
    required(
      exact(o, [
        'hostTicks',
        'sampleTime',
        'hostTimeValid',
        'sampleTimeValid',
      ]) &&
        positive(o.hostTicks) &&
        positive(o.sampleTime) &&
        BigInt(o.sampleTime) <= BigInt(frame.totalFrames) + 48000n &&
        o.hostTimeValid === true &&
        o.sampleTimeValid === true,
    );
    const zero =
      BigInt(o.hostTicks) * n * rate - BigInt(o.sampleTime) * 1000000000n * d;
    required(zero >= 0n);
    return { zero, ticks: BigInt(o.hostTicks), sample: BigInt(o.sampleTime) };
  });
  required(
    observations[1].ticks > observations[0].ticks &&
      observations[1].sample > observations[0].sample,
  );
  const denom = d * rate;
  const nsToMs = (q) => {
    required(
      q <= BigInt(Number.MAX_SAFE_INTEGER) * denom &&
        q >= -BigInt(Number.MAX_SAFE_INTEGER) * denom,
    );
    return Number(q / denom) / 1e6;
  };
  const spread = Math.abs(nsToMs(observations[1].zero - observations[0].zero));
  required(spread <= 5);
  const delta = nsToMs(
    observations[1].zero +
      offsetMid * n * rate -
      BigInt(bridge.hostTicks) * n * rate,
  );
  const mid = (bridge.sentMs + bridge.receivedMs) / 2;
  // Explicitly map absolute render ticks into continuous ticks used by libuv.
  // The measured offset brackets must overlap; Swift repeats that check during
  // playback, so a sleep/wake discontinuity is terminal rather than rebased.
  const uncertaintyMs =
    (bridge.receivedMs - bridge.sentMs) / 2 +
    spread +
    Number(((currentOffset.high - currentOffset.low) * n) / d) / 1e6 +
    0.001;
  const monotonicMs = mid + delta;
  required(
    Number.isFinite(monotonicMs) &&
      monotonicMs >= 0 &&
      monotonicMs <= nowMs &&
      nowMs - monotonicMs <= 3000 &&
      uncertaintyMs <= 100 &&
      nowMs - mid <= 110000,
  );
  return Object.freeze({
    monotonicMs,
    uncertaintyMs,
    sha256: LAB_PLAYER_MEDIA_SHA256,
    basis: 'audio-render',
    outputLatencyEstimateMs: frame.outputLatencyEstimateMs,
    outputDeviceId: frame.outputDeviceId,
  });
}

function playerController({
  runId,
  build,
  fixtureCase,
  environment = process.env,
  prepareMs = 15000,
  startMs = 3000,
  stopMs = 3000,
} = {}) {
  required(
    /^[A-Za-z0-9_-]{1,64}$/.test(runId ?? '') &&
      [prepareMs, startMs, stopMs].every((n) => integer(n, 1, 15000)),
  );

  let child = null,
    identity = null,
    media = null,
    preparing = null,
    playing = null,
    closing = null,
    retiring = null,
    failed = false,
    stopRequested = false,
    prepared = false,
    started = false,
    completed = false,
    bridge = null,
    probeId = null,
    sentMs = null,
    totalFrames = null,
    partial = Buffer.alloc(0),
    bytes = 0,
    partialTimer,
    operationTimer,
    abortSignal,
    abortListener;
  const ready = deferred(),
    clock = deferred(),
    play = deferred(),
    stopped = deferred(),
    ended = deferred();
  const listeners = new Set();
  const notify = () => {
    for (const listener of [...listeners])
      try {
        listener({ type: 'failed' });
      } catch {}
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    for (const p of [ready, clock, play]) p.reject(gateFailure('protocol'));
    notify();
    void stop().catch(() => {});
  };
  const send = (type, fields = {}) => {
    const raw =
      JSON.stringify({
        schema: SCHEMA,
        type,
        runId,
        generation: '1',
        mediaSha256: LAB_PLAYER_MEDIA_SHA256,
        ...fields,
      }) + '\n';
    required(
      child?.stdin?.writable &&
        !child.stdin.destroyed &&
        child.stdin.writableLength + Buffer.byteLength(raw) <= 16384,
    );
    child.stdin.write(raw);
  };
  const receive = (frame) => {
    required(
      frame &&
        frame.schema === SCHEMA &&
        frame.runId === runId &&
        frame.generation === '1' &&
        frame.mediaSha256 === LAB_PLAYER_MEDIA_SHA256,
    );
    if (frame.type === 'failed') {
      required(
        exact(frame, [...BASE, 'code']) && frame.code === 'player_failed',
      );
      return fail();
    }
    if (frame.type === 'stopped') {
      required(
        stopRequested &&
          exact(frame, [...BASE, 'engineRunning', 'completed']) &&
          frame.engineRunning === false &&
          typeof frame.completed === 'boolean',
      );
      stopped.resolve(frame);
      return;
    }
    required(!failed && !stopRequested);
    if (frame.type === 'prepared') {
      required(
        !prepared &&
          exact(frame, [
            ...BASE,
            'pid',
            'windowId',
            'application',
            'bundleId',
            'processStart',
            'sampleRate',
            'channels',
            'totalFrames',
            'durationMs',
            'videoOnly',
          ]) &&
          frame.pid === child.pid &&
          integer(frame.windowId, 1, 0x7fffffff) &&
          frame.application === 'TalkQTE Lab Player' &&
          frame.bundleId === 'com.talkqte.lab-player' &&
          exact(frame.processStart, ['seconds', 'microseconds']) &&
          positive(frame.processStart.seconds) &&
          integer(frame.processStart.microseconds, 0, 999999) &&
          frame.sampleRate === 48000 &&
          frame.channels === 2 &&
          integer(frame.totalFrames, 1, 105 * 48000) &&
          frame.durationMs === frame.totalFrames / 48 &&
          Math.abs(frame.durationMs - media.durationMs) <= 100 &&
          frame.videoOnly === true,
      );
      totalFrames = frame.totalFrames;
      prepared = true;
      identity = Object.freeze({
        pid: child.pid,
        executable: build.executable,
        runId,
        windowId: frame.windowId,
        application: frame.application,
        bundleId: frame.bundleId,
        processStart: Object.freeze({ ...frame.processStart }),
        mediaSha256: LAB_PLAYER_MEDIA_SHA256,
      });
      ready.resolve();
    } else if (frame.type === 'clock_sample') {
      required(
        prepared &&
          !bridge &&
          probeId &&
          exact(frame, [
            ...BASE,
            'probeId',
            'hostTicks',
            'absoluteBeforeTicks',
            'absoluteAfterTicks',
            'timebaseNumer',
            'timebaseDenom',
          ]) &&
          frame.probeId === probeId &&
          positive(frame.hostTicks) &&
          integer(frame.timebaseNumer, 1, 0xffffffff) &&
          integer(frame.timebaseDenom, 1, 0xffffffff),
      );
      bridge = {
        sentMs,
        receivedMs: performance.now(),
        hostTicks: frame.hostTicks,
        absoluteBeforeTicks: frame.absoluteBeforeTicks,
        absoluteAfterTicks: frame.absoluteAfterTicks,
        timebaseNumer: frame.timebaseNumer,
        timebaseDenom: frame.timebaseDenom,
      };
      required(bridge.receivedMs - sentMs <= 100);
      labPlayerClockOffset({ ...bridge, continuousTicks: bridge.hostTicks });
      clock.resolve();
    } else if (frame.type === 'started') {
      required(playing && !started && frame.totalFrames === totalFrames);
      const anchor = mapLabPlayerStart(frame, bridge);
      started = true;
      clearTimeout(operationTimer);
      playing.onStarted(anchor);
    } else if (frame.type === 'completed') {
      required(
        started &&
          !completed &&
          exact(frame, [
            ...BASE,
            'framesPlayed',
            'observedSampleTime',
            'callbackType',
            'engineRunning',
          ]) &&
          frame.framesPlayed === totalFrames &&
          uint(frame.observedSampleTime) &&
          BigInt(frame.observedSampleTime) >= BigInt(totalFrames) &&
          frame.callbackType === 'dataPlayedBack' &&
          frame.engineRunning === false,
      );
      completed = true;
      clearTimeout(operationTimer);
      play.resolve({ completed: true, sha256: media.sha256 });
    } else throw gateFailure('protocol');
  };
  const armAbort = (signal) => {
    required(!signal?.aborted);
    abortSignal?.removeEventListener('abort', abortListener);
    abortSignal = signal;
    abortListener = () => {
      fail();
    };
    signal?.addEventListener('abort', abortListener, { once: true });
  };
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (e) {
      if (e.code === 'ESRCH') return false;
      throw e;
    }
  };
  function stop() {
    if (closing) return closing;
    const done = deferred();
    closing = done.promise;
    stopRequested = true;
    clearTimeout(operationTimer);
    clearTimeout(partialTimer);
    ready.reject(gateFailure('cancelled'));
    clock.reject(gateFailure('cancelled'));
    play.reject(gateFailure('cancelled'));
    (async () => {
      abortSignal?.removeEventListener('abort', abortListener);
      if (!child) return { stopped: true };
      let timer;
      try {
        send('stop');
        await Promise.race([
          stopped.promise,
          new Promise(
            (_, reject) =>
              (timer = setTimeout(
                () => reject(gateFailure('cleanup')),
                stopMs,
              )),
          ),
        ]);

        if (failed) throw gateFailure('cleanup');
        return { stopped: true };
      } catch {
        // Preserve the selected process until actual native release. A timeout
        // is unconfirmed cleanup, never permission to invalidate active capture.
        throw gateFailure('cleanup');
      } finally {
        clearTimeout(timer);
        listeners.clear();
      }
    })().then(done.resolve, done.reject);
    return closing;
  }
  return Object.freeze({
    get identity() {
      return identity;
    },
    subscribe(listener) {
      required(
        !closing &&
          !failed &&
          typeof listener === 'function' &&
          listeners.size < 8,
      );
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepare({ media: input, signal } = {}) {
      required(
        !failed &&
          !closing &&
          input?.fictional === true &&
          input.sha256 === LAB_PLAYER_MEDIA_SHA256 &&
          input.durationMs === 102480,
      );
      if (preparing) {
        required(media.path === input.path);
        return preparing;
      }
      media = Object.freeze({ ...input });
      preparing = (async () => {
        armAbort(signal);
        if (!fixtureCase) {
          file(media.path, 256 * 1024 * 1024);
          required(digest(media.path) === media.sha256);
        }
        build.check();
        const env = Object.fromEntries(
          ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL']
            .filter((k) => typeof environment[k] === 'string')
            .map((k) => [k, environment[k]]),
        );
        child = spawn(
          build.executable,
          fixtureCase ? [FIXTURE, runId, fixtureCase] : [runId, media.path],
          {
            shell: false,
            detached: true,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        required(integer(child.pid, 1, 0x7fffffff));
        child.once('error', fail);
        child.once('close', () => {
          ended.resolve();
          if (!stopRequested) fail();
        });
        child.stdin.on('error', fail);
        let stderrBytes = 0;
        child.stderr.on('data', (chunk) => {
          stderrBytes += chunk.length;
          if (stderrBytes > 8192) fail();
        });
        const decoder = new TextDecoder('utf-8', { fatal: true });
        child.stdout.on('data', (chunk) => {
          if (closing && failed) return;
          try {
            bytes += chunk.length;
            required(bytes <= 128 * 1024);
            partial = Buffer.concat([partial, chunk]);
            for (let end; (end = partial.indexOf(10)) !== -1;) {
              required(end + 1 <= 16384);
              const raw = partial.subarray(0, end);
              partial = partial.subarray(end + 1);
              receive(parseUniqueLabJson(decoder.decode(raw)));
            }
            required(partial.length <= 16384);
            clearTimeout(partialTimer);
            if (partial.length) partialTimer = setTimeout(fail, 1000);
          } catch {
            fail();
          }
        });
        operationTimer = setTimeout(fail, prepareMs);
        await ready.promise;
        clearTimeout(operationTimer);
        probeId = randomUUID();
        sentMs = performance.now();
        send('clock_probe', { probeId });
        operationTimer = setTimeout(fail, 100);
        await clock.promise;
        clearTimeout(operationTimer);
        return Object.freeze({ ...media });
      })().catch((error) => {
        fail();
        throw gateFailure(error.category ?? 'protocol');
      });
      preparing.catch(() => {});
      return preparing;
    },
    play({ media: input, signal, onStarted } = {}) {
      required(
        prepared &&
          bridge &&
          !playing &&
          !closing &&
          !failed &&
          input?.sha256 === media.sha256 &&
          input.path === media.path &&
          typeof onStarted === 'function',
      );
      armAbort(signal);
      playing = { onStarted };
      operationTimer = setTimeout(fail, startMs);
      send('start');
      // Start acknowledgement deadline is replaced by an independent duration bound.
      const durationTimer = setTimeout(fail, 110000);
      return play.promise.finally(() => clearTimeout(durationTimer));
    },
    stop,
    close({ nativeReleased } = {}) {
      required(nativeReleased === true);
      if (retiring) return retiring;
      const done = deferred();
      retiring = done.promise;
      (async () => {
        // A failed stop stays failure, but actual native release now permits
        // bounded retirement of this exact owned process group.
        let stopFailed = false;
        try {
          await stop();
        } catch {
          stopFailed = true;
        }
        if (!child) {
          if (stopFailed) throw gateFailure('cleanup');
          return { closed: true };
        }
        let timer;
        try {
          send('retire');
          await Promise.race([
            ended.promise,
            new Promise(
              (_, reject) =>
                (timer = setTimeout(
                  () => reject(gateFailure('cleanup')),
                  stopMs,
                )),
            ),
          ]);
          required(
            child.exitCode === 0 &&
              child.signalCode === null &&
              !killGroup(0) &&
              !stopFailed,
          );
          return { closed: true };
        } catch {
          try {
            killGroup('SIGTERM');
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 100));
          try {
            killGroup('SIGKILL');
          } catch {}
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
          throw gateFailure('cleanup');
        } finally {
          clearTimeout(timer);
        }
      })().then(done.resolve, done.reject);
      return retiring;
    },
  });
}

export function createLabPlayer(options = {}) {
  return playerController({ ...options, build: verifyLabPlayerBuild(options) });
}
// Explicit harmless protocol fixture: cannot select an app or execute caller code.
export function createLabPlayerFixture({
  runId,
  fixtureCase = 'normal',
  ...bounds
} = {}) {
  required(
    [
      'normal',
      'wrong-pid',
      'wrong-run',
      'no-start',
      'early-complete',
      'duplicate',
      'oversize',
      'held-pipes',
    ].includes(fixtureCase),
  );
  const expected = digest(FIXTURE);
  return playerController({
    ...bounds,
    runId,
    fixtureCase,
    environment: {},
    build: {
      executable: realpathSync(process.execPath),
      check() {
        required(digest(FIXTURE) === expected);
      },
    },
  });
}
