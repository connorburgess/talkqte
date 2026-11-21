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
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
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

// The reviewed lab build's compiled features. Local transcription is gone
// (#346); `lab-evaluator` implies `cloud-transcription`.
const FEATURES = [
  'cloud-transcription',
  'lab-evaluator',
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
  modelConnection,
  environment,
  fixtureCase,
  mode = 'model-enabled',
  playerSource,
  transcription,
}) {
  // Cloud transcription (Deepgram) runs only on the direct API route, whose
  // in-app session review also approves streaming the audio. A capture-only
  // launch has no review, so nothing is ever streamed; it still needs the
  // setting because the app starts no session without a transcription
  // backend. It gets the empty placeholder only: no grant, never a token.
  requireThat(
    transcription === undefined ||
      (transcription.backend === 'deepgram' &&
        Number.isSafeInteger(transcription.minuteCap) &&
        transcription.minuteCap >= 1 &&
        transcription.minuteCap <= 60 &&
        (mode === 'capture-only'
          ? exact(transcription, ['backend', 'minuteCap'])
          : (exact(transcription, ['backend', 'minuteCap', 'grant']) ||
              (exact(transcription, [
                'backend',
                'minuteCap',
                'grant',
                'reconnect',
              ]) &&
                transcription.reconnect === true)) &&
            typeof transcription.grant?.writeTokenFile === 'function' &&
            mode === 'model-enabled' &&
            selection?.provider === 'anthropic-api')),
  );
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
  const temporaryRoot = realpathSync(tmpdir());
  requireThat(outside(temporaryRoot));
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, 'tq-owned-')));
  chmodSync(directory, 0o700);
  // Lets a later stale-token sweep tell whether this run's runner is alive.
  writeFileSync(join(directory, 'runner.pid'), String(process.pid), {
    mode: 0o600,
    flag: 'wx',
  });
  requireThat(outside(directory));
  const timingPath = join(directory, 'timing.jsonl');
  // The run's transcription token file. At launch it is an empty 0600
  // placeholder, which the app accepts at session start but cannot use; the
  // take replaces it with the token (atomic rename) only after it has
  // accepted the in-app review row. It is deleted once the stream has
  // connected, at close, on a failed launch, or at process exit. With
  // `reconnect` (a build that replaces a failed stream, #357, by reading the
  // file again), it stays until close instead: a valid short-lived token is
  // then on disk in this owner-only folder for the length of the run.
  const tokenPath = transcription ? join(directory, 'stt-token') : null;
  const tokenNext = transcription ? join(directory, 'stt-token.next') : null;
  let tokenRemoved = true,
    tokenReleased = false,
    connectedQuery = null,
    // Replacements of a failed stream seen so far, and whether one is
    // waiting for its new stream's connected row.
    reconnects = 0,
    awaitingReconnect = false;
  const keepToken = transcription?.reconnect === true;
  const removeToken = () => {
    if (tokenRemoved) return;
    let gone = true;
    for (const path of [tokenNext, tokenPath])
      try {
        unlinkSync(path);
      } catch (error) {
        if (error?.code !== 'ENOENT') gone = false;
      }
    tokenRemoved = gone;
  };
  // The session the in-app review approved for this launch's backend and
  // model; a stream may start only in that session.
  let reviewedSession = null,
    transcriptionStarted = false,
    // Set when native reports its source failed and so ends the session
    // itself, without the lab's ordinary Stop.
    nativeEnded = null;
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
    transcription?.grant?.discard?.();
    removeToken();
    if (tokenRemoved) process.off('exit', removeToken);
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
            if (event.event === 'source_problem')
              nativeEnded ??= Object.freeze({
                problem: event.problem,
                osCode: event.os_code ?? null,
              });
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
            // A cloud stream may open only after the in-app review approved
            // the session; the token is not needed once it has opened.
            if (event.event === 'stt_state') {
              if (event.state === 'started') {
                if (
                  !transcription ||
                  reviewedSession === null ||
                  event.session !== reviewedSession ||
                  transcriptionStarted
                ) {
                  onTiming({ event: 'dropped', count: 1 });
                  for (const listener of subscribers)
                    listener({ event: 'dropped', count: 1 });
                  return;
                }
                transcriptionStarted = true;
              } else if (event.state === 'reconnecting') {
                // A failed stream being replaced (#357): only in a build the
                // run allowed to reconnect, after the first connection, in
                // the reviewed session, at most twice. A pending replacement may
                // fail before Connected and spend the second attempt.
                if (
                  !keepToken ||
                  connectedQuery === null ||
                  reconnects >= 2 ||
                  event.session !== reviewedSession
                ) {
                  onTiming({ event: 'dropped', count: 1 });
                  for (const listener of subscribers)
                    listener({ event: 'dropped', count: 1 });
                  return;
                }
                reconnects++;
                awaitingReconnect = true;
              } else if (event.state === 'connected') {
                // The app has read the token and connected. Without
                // reconnect it never rereads it, so the file goes now. A
                // replacement stream must use the first stream's query.
                const first = connectedQuery === null;
                if (
                  !transcriptionStarted ||
                  !tokenReleased ||
                  event.session !== reviewedSession ||
                  (!first &&
                    (!awaitingReconnect || event.query !== connectedQuery))
                ) {
                  onTiming({ event: 'dropped', count: 1 });
                  for (const listener of subscribers)
                    listener({ event: 'dropped', count: 1 });
                  return;
                }
                awaitingReconnect = false;
                connectedQuery = event.query;
                if (!keepToken) removeToken();
              }
              return;
            }
            if (
              event.event === 'evaluator' &&
              event.approval === 'review' &&
              event.state === 'on' &&
              event.backend === 'lab-api' &&
              event.model === pinned?.model &&
              reviewedSession === null
            )
              reviewedSession = event.session;
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
        if (transcription) {
          tokenRemoved = false;
          process.on('exit', removeToken);
          const placeholder = openSync(
            tokenPath,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          closeSync(placeholder);
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
          ...(transcription
            ? {
                TALKQTE_DEV_STT_BACKEND: 'deepgram',
                TALKQTE_DEV_STT_TOKEN_FILE: tokenPath,
                TALKQTE_DEV_STT_MINUTE_CAP: String(transcription.minuteCap),
              }
            : {}),
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
    // Native ended the session itself (source_problem), with its fixed label
    // and OS code; null otherwise. Not a release by the lab's Stop.
    get nativeEnded() {
      return nativeEnded;
    },
    // Content-free transcription facts for evidence: never the token.
    get transcription() {
      return transcription
        ? Object.freeze({
            backend: transcription.backend,
            minuteCap: transcription.minuteCap,
            grantTtlS: transcription.grant?.ttlSeconds ?? null,
            reviewedSession,
            released: tokenReleased,
            started: transcriptionStarted,
            connectedQuery,
            tokenRemoved,
            // Whether the token was kept on disk until close for reconnects,
            // and how many replacement streams the app opened.
            tokenKeptUntilStop: keepToken,
            reconnects,
          })
        : null;
    },
    // Hands the app its token: only once, only after the in-app review row
    // for this launch's backend and model has been seen, by writing it
    // beside the placeholder and renaming it over. The take calls this after
    // it has accepted the review and opened the provider.
    releaseTranscriptionToken() {
      requireThat(
        transcription?.grant &&
          !closed &&
          !tokenRemoved &&
          !tokenReleased &&
          reviewedSession !== null,
      );
      tokenReleased = true;
      try {
        transcription.grant.writeTokenFile(tokenNext);
        renameSync(tokenNext, tokenPath);
      } catch {
        removeToken();
        throw gateFailure('protocol');
      }
    },
    get processStarted() {
      return child !== null;
    },
    get processEnded() {
      return !!child && (child.exitCode !== null || child.signalCode !== null);
    },
  });
}

/**
 * Removes transcription token files left by earlier runs whose runner was
 * killed (SIGKILL skips every cleanup path). Only launcher run folders are
 * touched: `tq-owned-*` directories directly in the temporary root, owned by
 * this user, mode 0700, not symlinks. A folder's token files are removed
 * only when its run has provably ended: the runner pid it recorded is gone,
 * or nothing in it changed for longer than the grant's 900 s TTL. A live
 * run (another lane's, or this process's own) is never touched. Returns how
 * many files were removed.
 */
export function removeStaleTranscriptionTokens({
  temporaryRoot = realpathSync(tmpdir()),
  now = Date.now(),
  alive = processAlive,
} = {}) {
  const uid = process.getuid?.();
  let removed = 0;
  for (const name of readdirSync(temporaryRoot)) {
    if (!/^tq-owned-[A-Za-z0-9]{6}$/.test(name)) continue;
    const folder = join(temporaryRoot, name);
    let stat;
    try {
      stat = lstatSync(folder);
    } catch {
      continue;
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o700
    )
      continue;
    if (!runEnded(folder, uid, now, alive)) continue;
    for (const file of ['stt-token', 'stt-token.next']) {
      const path = join(folder, file);
      try {
        const f = lstatSync(path);
        if (f.isFile() && !f.isSymbolicLink() && f.uid === uid) {
          unlinkSync(path);
          removed++;
        }
      } catch {}
    }
  }
  return removed;
}
const STALE_AFTER_MS = 900 * 1000 + 60 * 1000;
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: a process exists under another user; treat as alive.
    return error?.code !== 'ESRCH';
  }
}
function runEnded(folder, uid, now, alive) {
  // Ended if the recorded runner pid no longer exists.
  try {
    const f = lstatSync(join(folder, 'runner.pid'));
    if (f.isFile() && !f.isSymbolicLink() && f.uid === uid && f.size <= 32) {
      const pid = Number(readFileSync(join(folder, 'runner.pid'), 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) return !alive(pid);
    }
  } catch {}
  // Otherwise only if nothing in it changed for longer than the token TTL.
  let newest = 0;
  try {
    for (const entry of readdirSync(folder)) {
      const e = lstatSync(join(folder, entry));
      newest = Math.max(newest, e.mtimeMs);
    }
    newest = Math.max(newest, lstatSync(folder).mtimeMs);
  } catch {
    return false;
  }
  return now - newest > STALE_AFTER_MS;
}

export const NO_TRANSCRIPTION_SUBSCRIPTION =
  'This route has no transcription: cloud transcription is approved only through the in-app review, which the subscription routes do not use.';
export const NO_TRANSCRIPTION_SELECTED =
  'This model run has no transcription: select cloud transcription (Deepgram).';
export const NO_TRANSCRIPTION_CAPTURE =
  'This capture-only run has no transcription setting: the app starts no session without one. Select Deepgram; nothing is streamed without an in-app review.';
const noTranscription = (reason) =>
  Object.assign(new Error(reason), { category: 'no-transcription' });

export function prepareLabLauncher({
  manifestFile,
  approved,
  selection,
  sourceApplication,
  stopAfterS,
  modelConnection,
  mode = 'model-enabled',
  playerSource,
  environment = process.env,
  transcription,
  ...rest
} = {}) {
  // Local transcription is gone: a Whisper model or any other unknown
  // option is refused rather than ignored.
  requireThat(Object.keys(rest).length === 0);
  // A model run needs a transcript, and the only one left is cloud
  // transcription, approved only by the in-app review that the direct API
  // route uses. The subscription routes are refused before anything is
  // verified or launched.
  if (mode === 'model-enabled') {
    if (selection?.provider !== 'anthropic-api')
      throw noTranscription(NO_TRANSCRIPTION_SUBSCRIPTION);
    if (transcription === undefined)
      throw noTranscription(NO_TRANSCRIPTION_SELECTED);
  }
  // The app starts no session at all without a transcription setting, so
  // a capture-only launch carries one too (placeholder only, no grant).
  if (mode === 'capture-only' && transcription === undefined)
    throw noTranscription(NO_TRANSCRIPTION_CAPTURE);
  try {
    return launcher({
      build: verifyBuild(manifestFile, approved),
      mode,
      playerSource,
      selection,
      sourceApplication,
      stopAfterS,
      modelConnection,
      environment,
      transcription,
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
  transcription,
} = {}) {
  requireThat(
    [
      'source-gone',
      'cloud-transcription',
      'cloud-early',
      'cloud-other-session',
      'cloud-reconnect',
      'cloud-reconnect-thrice',
      'cloud-reconnect-pending',
      'cloud-reconnect-pending-thrice',
      'cloud-reconnect-before-first',
      'cloud-reconnect-other-session',
      'cloud-reconnect-changed-query',
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
    transcription,
  });
}
