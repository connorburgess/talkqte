// Explicit verified launch only. No shell, environment-derived executable,
// existing-process attachment or provider fallback.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  copyFileSync,
  chmodSync,
  openSync,
  closeSync,
  lstatSync,
  realpathSync,
  readSync,
  fstatSync,
  constants,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSubscriptionEnvironment } from './cue-lab-codex.mjs';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import { watchLabTiming } from './cue-lab-timing-reader.mjs';
import { gateFailure } from './cue-lab-operation-gate.mjs';
import { checkLabPlayerSource } from './cue-lab-player.mjs';
import { outsideCheckout } from './cue-lab-checkout.mjs';
import {
  ANTHROPIC_SPEND_CAP_MICRO_USD,
  isAnthropicModel,
} from './cue-lab-anthropic-core.mjs';

const FEATURES = [
  'lab-evaluator',
  'local-whisper',
  'native-audio-spike',
  'timing-log',
];
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
const hex = (value, n) =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(value);
const requireThat = (condition) => {
  if (!condition) throw gateFailure('protocol');
};
const outside = outsideCheckout;
const stamp = (s) =>
  [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode].join(':');
function digest(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    requireThat(
      before.isFile() && before.size > 0 && before.size <= 512 * 1024 * 1024,
    );
    const hash = createHash('sha256'),
      chunk = Buffer.alloc(64 * 1024);
    let got;
    while ((got = readSync(fd, chunk, 0, chunk.length, null)) > 0)
      hash.update(chunk.subarray(0, got));
    requireThat(stamp(before) === stamp(fstatSync(fd)));
    return { sha256: hash.digest('hex'), stamp: stamp(before) };
  } finally {
    closeSync(fd);
  }
}

export function validateLabBuildRecord(value, approved, manifestSha256) {
  requireThat(
    exact(approved, ['manifestSha256', 'executableSha256', 'commit']) &&
      hex(approved.manifestSha256, 64) &&
      hex(approved.executableSha256, 64) &&
      hex(approved.commit, 40) &&
      approved.manifestSha256 === manifestSha256,
  );
  requireThat(
    exact(value, [
      'schema',
      'executable',
      'bundlePath',
      'sha256',
      'commit',
      'features',
      'debug',
      'signature',
    ]) &&
      value.schema === 'talkqte.lab.build.v1' &&
      value.debug === true &&
      typeof value.executable === 'string' &&
      isAbsolute(value.executable) &&
      typeof value.bundlePath === 'string' &&
      isAbsolute(value.bundlePath) &&
      value.bundlePath.endsWith('.app') &&
      hex(value.sha256, 64) &&
      hex(value.commit, 40) &&
      value.sha256 === approved.executableSha256 &&
      value.commit === approved.commit,
  );
  requireThat(
    Array.isArray(value.features) &&
      value.features.length === FEATURES.length &&
      new Set(value.features).size === FEATURES.length &&
      FEATURES.every((f) => value.features.includes(f)),
  );
  requireThat(
    exact(value.signature, [
      'identifier',
      'authority',
      'designatedRequirement',
    ]) &&
      value.signature.identifier === 'com.talkqte.desktop' &&
      value.signature.authority === 'TalkQTE Development' &&
      typeof value.signature.designatedRequirement === 'string' &&
      value.signature.designatedRequirement.length <= 4096 &&
      /certificate leaf = H"[0-9a-fA-F]{40}"/.test(
        value.signature.designatedRequirement,
      ),
  );
  return structuredClone(value);
}
function verifyBuild(manifestFile, approved) {
  requireThat(
    isAbsolute(manifestFile ?? '') &&
      realpathSync(manifestFile) === manifestFile &&
      outside(manifestFile),
  );
  const info = lstatSync(manifestFile);
  requireThat(
    info.isFile() &&
      (info.mode & 0o777) === 0o600 &&
      info.uid === process.getuid?.() &&
      info.size <= 16384,
  );
  const fd = openSync(
    manifestFile,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes;
  try {
    requireThat(stamp(fstatSync(fd)) === stamp(info));
    const buffer = Buffer.alloc(16385);
    const got = readSync(fd, buffer, 0, buffer.length, 0);
    requireThat(
      got === info.size && got <= 16384 && stamp(fstatSync(fd)) === stamp(info),
    );
    bytes = buffer.subarray(0, got);
  } finally {
    closeSync(fd);
  }
  const m = validateLabBuildRecord(
    parseUniqueLabJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    approved,
    createHash('sha256').update(bytes).digest('hex'),
  );
  requireThat(
    realpathSync(m.bundlePath) === m.bundlePath &&
      realpathSync(m.executable) === m.executable &&
      m.executable === join(m.bundlePath, 'Contents', 'MacOS', 'talkqte'),
  );
  requireThat((lstatSync(m.executable).mode & 0o111) !== 0);
  const readPlist = (field) =>
    execFileSync(
      '/usr/bin/plutil',
      [
        '-extract',
        field,
        'raw',
        '-o',
        '-',
        join(m.bundlePath, 'Contents', 'Info.plist'),
      ],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 },
    ).trim();
  // display's stderr is needed as structured input, not a log or shell command.
  const inspect = () => {
    requireThat(
      realpathSync(m.bundlePath) === m.bundlePath &&
        readPlist('CFBundleIdentifier') === 'com.talkqte.desktop' &&
        readPlist('CFBundleExecutable') === 'talkqte',
    );
    execFileSync(
      '/usr/bin/codesign',
      ['--verify', '--strict', '--deep', m.bundlePath],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 65536 },
    );
    const display = spawnSync(
      '/usr/bin/codesign',
      ['--display', '--verbose=4', '--requirements', '-', m.bundlePath],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 65536,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    requireThat(!display.error && display.status === 0 && !display.signal);
    const result = display.stdout + '\n' + display.stderr;
    const lines = result.split(/\r?\n/);
    requireThat(
      lines
        .filter((l) => l.startsWith('Authority='))
        .map((l) => l.slice(10))
        .join('\n') === 'TalkQTE Development',
    );
    requireThat(lines.includes('Identifier=com.talkqte.desktop'));
    const requirement = lines.find((l) => l.startsWith('designated => '));
    requireThat(
      requirement?.slice(14) === m.signature.designatedRequirement &&
        !lines.some((l) => /^Signature=adhoc/.test(l)),
    );
  };
  inspect();
  const original = digest(m.executable);
  requireThat(original.sha256 === m.sha256);
  return {
    manifest: m,
    executable: m.executable,
    check() {
      inspect();
      const current = digest(m.executable);
      requireThat(
        current.sha256 === m.sha256 &&
          current.stamp === original.stamp &&
          realpathSync(m.executable) === m.executable,
      );
    },
  };
}

const FIXTURE = fileURLToPath(
  new URL('./fixtures/lab-native-child.mjs', import.meta.url),
);
function launcher({
  build,
  selection,
  stopAfterS,
  sourceApplication,
  whisperModel,
  modelConnection,
  environment,
  fixtureCase,
  mode = 'model-enabled',
  playerSource,
}) {
  requireThat(
    ['capture-only', 'model-enabled'].includes(mode) &&
      (mode === 'capture-only'
        ? selection === undefined
        : exact(selection, ['provider', 'model', 'effort', 'maxCalls']) &&
          ['codex', 'claude-code', 'anthropic-api'].includes(
            selection.provider,
          ) &&
          typeof selection.model === 'string' &&
          selection.model.length <= 100 &&
          ['low', 'medium'].includes(selection.effort) &&
          // The direct API route runs only its listed models at effort low.
          (selection.provider !== 'anthropic-api' ||
            (isAnthropicModel(selection.model) &&
              selection.effort === 'low')) &&
          Number.isSafeInteger(selection.maxCalls) &&
          selection.maxCalls >= 1 &&
          selection.maxCalls <= 100),
  );
  requireThat(
    (sourceApplication === 'QuickTime Player'
      ? playerSource === undefined
      : sourceApplication === 'TalkQTE Lab Player' &&
        checkLabPlayerSource(playerSource)) &&
      // The direct API route has no launch approval: the owner approves in
      // the app's session review, which names the API, model and spend cap.
      (mode === 'capture-only' || selection?.provider === 'anthropic-api'
        ? modelConnection === undefined
        : modelConnection === 'on') &&
      Number.isSafeInteger(stopAfterS) &&
      stopAfterS > 0,
  );
  assertSubscriptionEnvironment(environment);
  const pinned = selection ? Object.freeze({ ...selection }) : null;
  const osEnv = Object.fromEntries(
    ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL']
      .filter((key) => typeof environment[key] === 'string')
      .map((key) => [key, environment[key]]),
  );
  if (!fixtureCase)
    requireThat(
      isAbsolute(whisperModel ?? '') &&
        realpathSync(whisperModel) === whisperModel &&
        lstatSync(whisperModel).isFile() &&
        outside(whisperModel),
    );
  const temporaryRoot = realpathSync(tmpdir());
  requireThat(outside(temporaryRoot));
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'tq-owned-')));
  chmodSync(directory, 0o700);
  requireThat(outside(directory));
  const timingPath = join(directory, 'timing.jsonl');
  const fixturePath = fixtureCase ? join(directory, 'fixture-child.mjs') : null;
  let fixtureSnapshot;
  if (fixturePath) {
    copyFileSync(FIXTURE, fixturePath);
    chmodSync(fixturePath, 0o600);
    fixtureSnapshot = digest(fixturePath);
  }
  const created = openSync(timingPath, 'wx', 0o600);
  closeSync(created);
  const timingStamp = lstatSync(timingPath, { bigint: true });
  let used = false,
    child = null,
    reader = null,
    released = false,
    step = null,
    closed = false;
  let activeRunId = null;
  const subscribers = new Set();
  const evaluatorSubscribers = new Set();
  const close = () => {
    if (closed) return;
    closed = true;
    reader?.close();
    for (const listener of subscribers)
      listener({ event: 'observation_closed' });
    subscribers.clear();
    evaluatorSubscribers.clear();
  };
  return Object.freeze({
    playerSource,
    executable: build.executable,
    mode,
    directory,
    timingPath,
    get timingFileIdentity() {
      return activeRunId
        ? Object.freeze({
            dev: timingStamp.dev.toString(),
            ino: timingStamp.ino.toString(),
            runId: activeRunId,
          })
        : null;
    },
    subscribe(listener) {
      requireThat(
        !closed && typeof listener === 'function' && subscribers.size < 8,
      );
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    // The native model connection's on/off rows (`evaluator`), for the
    // approval gate. One listener, attached before launch.
    subscribeEvaluator(listener) {
      requireThat(
        !closed &&
          !used &&
          typeof listener === 'function' &&
          evaluatorSubscribers.size === 0,
      );
      evaluatorSubscribers.add(listener);
      return () => evaluatorSubscribers.delete(listener);
    },
    get identity() {
      return child
        ? Object.freeze({
            pid: child.pid,
            executable: build.executable,
            runId: activeRunId,
          })
        : null;
    },
    launch({ executable, environment: runEnv, onTiming, metadata }) {
      requireThat(
        !used &&
          !closed &&
          executable === build.executable &&
          typeof onTiming === 'function',
      );
      used = true;
      try {
        const baseKeys = [
          'TALKQTE_DEV_STOP_SIGNAL',
          'TALKQTE_DEV_STOP_AFTER_S',
          'TALKQTE_DEV_LAB_RUN_ID',
        ];
        const viaApi = pinned?.provider === 'anthropic-api';
        const modelKeys = [
          'TALKQTE_DEV_CUE_BACKEND',
          'TALKQTE_DEV_LAB_DESCRIPTOR',
          'TALKQTE_DEV_LAB_PROVIDER',
          'TALKQTE_DEV_LAB_MODEL',
          'TALKQTE_DEV_LAB_EFFORT',
          // The API route's per-run spend cap, shown before the first request.
          ...(viaApi ? ['TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD'] : []),
        ];
        requireThat(
          exact(runEnv, [
            ...baseKeys,
            ...(mode === 'model-enabled' ? modelKeys : []),
          ]) &&
            runEnv.TALKQTE_DEV_STOP_SIGNAL === 'usr2' &&
            runEnv.TALKQTE_DEV_STOP_AFTER_S === String(stopAfterS) &&
            /^[A-Za-z0-9_-]{1,64}$/.test(runEnv.TALKQTE_DEV_LAB_RUN_ID),
        );
        let descriptor;
        if (mode === 'model-enabled') {
          requireThat(
            runEnv.TALKQTE_DEV_CUE_BACKEND ===
              (viaApi ? 'lab-api' : 'lab-subscription') &&
              (!viaApi ||
                (runEnv.TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD ===
                  String(ANTHROPIC_SPEND_CAP_MICRO_USD[pinned.model]) &&
                  metadata?.spendCapMicroUsd ===
                    ANTHROPIC_SPEND_CAP_MICRO_USD[pinned.model])) &&
              ['provider', 'model', 'effort', 'maxCalls'].every(
                (key) => metadata?.[key] === pinned[key],
              ) &&
              runEnv.TALKQTE_DEV_LAB_PROVIDER === pinned.provider &&
              runEnv.TALKQTE_DEV_LAB_MODEL === pinned.model &&
              runEnv.TALKQTE_DEV_LAB_EFFORT === pinned.effort,
          );
          descriptor = runEnv.TALKQTE_DEV_LAB_DESCRIPTOR;
          requireThat(
            isAbsolute(descriptor ?? '') &&
              lstatSync(descriptor).isFile() &&
              !lstatSync(descriptor).isSymbolicLink() &&
              (lstatSync(descriptor).mode & 0o777) === 0o600 &&
              lstatSync(descriptor).uid === process.getuid?.() &&
              outside(descriptor),
          );
        } else requireThat(metadata === undefined);
        if (playerSource) {
          checkLabPlayerSource(playerSource);
          requireThat(playerSource.runId === runEnv.TALKQTE_DEV_LAB_RUN_ID);
        }
        reader = watchLabTiming({
          path: timingPath,
          runId: runEnv.TALKQTE_DEV_LAB_RUN_ID,
          sourceObservation: fixtureCase ? 'legacy-fixture' : 'v1',
          expectedCommit: build.manifest?.commit,
          expectedFeatures: build.manifest?.features,
          expectedApplication: sourceApplication,
          onEvent(event) {
            if (event.event === 'dev_stop') {
              const previous = {
                armed: null,
                latched: 'armed',
                stopping: 'latched',
                released: 'stopping',
              };
              if (event.step !== 'failed')
                requireThat(previous[event.step] === step);
              step = event.step;
              if (step === 'released') released = true;
            }
            // Connection rows go only to the approval gate, never to the
            // lifecycle or source observers, which refuse unknown rows.
            if (event.event === 'evaluator') {
              for (const listener of evaluatorSubscribers)
                listener(Object.freeze({ ...event }));
              return;
            }
            onTiming(event);
            for (const listener of subscribers)
              listener(Object.freeze(structuredClone(event)));
            if (released) close();
          },
        });
        // Verification is repeated immediately before the only direct owned spawn.
        build.check();
        if (fixturePath) {
          const current = digest(fixturePath);
          requireThat(
            current.sha256 === fixtureSnapshot.sha256 &&
              current.stamp === fixtureSnapshot.stamp,
          );
        }
        const env = {
          ...osEnv,
          ...runEnv,
          ...(descriptor
            ? { TALKQTE_DEV_LAB_DESCRIPTOR: realpathSync(descriptor) }
            : {}),
          TALKQTE_TIMING_LOG: timingPath,
          TALKQTE_DEV_APPLICATION_SOURCE: sourceApplication,
          ...(mode === 'model-enabled'
            ? {
                ...(modelConnection
                  ? { TALKQTE_DEV_MODEL_CONNECTION: modelConnection }
                  : {}),
                TALKQTE_DEV_MODEL_CALLS: String(pinned.maxCalls),
              }
            : {}),
          ...(playerSource
            ? {
                TALKQTE_DEV_PLAYER_PID: String(playerSource.pid),
                TALKQTE_DEV_PLAYER_START_SEC: playerSource.processStart.seconds,
                TALKQTE_DEV_PLAYER_START_USEC: String(
                  playerSource.processStart.microseconds,
                ),
                TALKQTE_DEV_PLAYER_EXECUTABLE: playerSource.executable,
              }
            : {}),
          ...(whisperModel ? { TALKQTE_WHISPER_MODEL: whisperModel } : {}),
          ...(fixtureCase ? { TALKQTE_FIXTURE_CASE: fixtureCase } : {}),
        };
        child = spawn(executable, fixtureCase ? [fixturePath] : [], {
          cwd: directory,
          env,
          stdio: ['ignore', 'ignore', 'ignore'],
          shell: false,
        });
        activeRunId = runEnv.TALKQTE_DEV_LAB_RUN_ID;
        // Drain already-written final evidence before the owner's exit listener.
        child.once('exit', () => reader.finish());
        child.once('error', () => {
          close();
          onTiming({ event: 'dropped', count: 1 });
          for (const listener of subscribers)
            listener({ event: 'dropped', count: 1 });
        });
        return child;
      } catch {
        close();
        throw gateFailure('protocol');
      }
    },
    close,
    get sourceReleased() {
      return released;
    },
    get processStarted() {
      return child !== null;
    },
    get processEnded() {
      return !!child && (child.exitCode !== null || child.signalCode !== null);
    },
  });
}

export function prepareLabLauncher({
  manifestFile,
  approved,
  selection,
  sourceApplication,
  stopAfterS,
  whisperModel,
  modelConnection,
  mode = 'model-enabled',
  playerSource,
  environment = process.env,
} = {}) {
  try {
    return launcher({
      build: verifyBuild(manifestFile, approved),
      mode,
      playerSource,
      selection,
      sourceApplication,
      stopAfterS,
      whisperModel,
      modelConnection,
      environment,
    });
  } catch {
    throw gateFailure('protocol');
  }
}

// Explicit offline test route: fixed Node executable + committed harmless
// fixture, never caller-provided arguments, executable, app or provider command.
export function prepareLabFixtureLauncher({
  fixtureCase,
  selection,
  mode = 'model-enabled',
  stopAfterS = 120,
  environment = {},
} = {}) {
  requireThat(
    [
      'capture-only',
      'normal',
      'partial',
      'exit',
      'truncate',
      'rotate',
      'oversize',
      'wrong-run',
      'lost-armed',
      'lost-released',
      'bad-utf8',
      'stall-partial',
      'duplicate-fields',
      'frame-oversize',
      'listening',
      'descriptor-peer',
    ].includes(fixtureCase),
  );
  const before = digest(process.execPath),
    fixtureDigest = digest(FIXTURE);
  return launcher({
    build: {
      executable: process.execPath,
      ...(fixtureCase === 'listening'
        ? { manifest: { commit: 'b'.repeat(40), features: FEATURES } }
        : {}),
      check() {
        requireThat(
          digest(process.execPath).sha256 === before.sha256 &&
            digest(FIXTURE).sha256 === fixtureDigest.sha256,
        );
      },
    },
    selection,
    mode,
    stopAfterS,
    sourceApplication: 'QuickTime Player',
    modelConnection:
      mode === 'capture-only' || selection?.provider === 'anthropic-api'
        ? undefined
        : 'on',
    environment,
    fixtureCase,
  });
}
