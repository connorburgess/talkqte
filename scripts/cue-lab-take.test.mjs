// Offline checks of the take plan dry run and its execute path. Fictional
// receipts, a placeholder helper file and the synthetic media manifest in
// private temporary folders. The execute tests compose the existing
// fixtures (the fixture launcher and its native child, the player and
// recorder fixtures) with a stand-in for the take; nothing real is
// launched, signed, minted or sent, and no key file can be read.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  attemptMarkerPath,
  checkTakePlan,
  DISK_FLOOR_BYTES,
  executeTakePlan,
  main,
  OWNER_TAKE_SCOPE,
  renderTakePlan,
  TakePlanRefused,
} from './cue-lab-take.mjs';
import { fictionalTestMediaManifest } from './fixtures/lab-test-media.mjs';
import {
  assertLabLaunchOptions,
  prepareLabFixtureLauncher,
} from './cue-lab-launcher.mjs';
import {
  createLabPlayerFixture,
  LAB_PLAYER_RUNTIME,
} from './cue-lab-player.mjs';
import { createLabRecorderFixture } from './cue-lab-recorder.mjs';
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';
import { createLabSourceV1 } from './cue-lab-source-v1.mjs';
import { assertFixedModelTakeOptions } from './cue-lab-prepared-take.mjs';
import { createLabEvidenceWriter } from './cue-lab-evidence-writer.mjs';
import { snapshotLabTiming } from './cue-lab-timing-snapshot.mjs';
import { writeEvidenceReport } from './cue-lab-evidence-report.mjs';

// No test here may reach the network: any request fails loudly.
globalThis.fetch = () => {
  throw new Error('No network in the take tests.');
};

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tq-take-plan-')));
chmodSync(root, 0o700);
after(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
const leaf = 'a'.repeat(40);

function writePrivate(path, text, mode = 0o600) {
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return sha(Buffer.from(text));
}

// One complete, valid fictional plan in its own private folder. `change`
// edits the plan object before it is written.
function setup(change = (plan) => plan, { planMode = 0o600 } = {}) {
  const dir = join(root, `case-${++count}`);
  mkdirSync(dir, { mode: 0o700 });
  const commit = 'b'.repeat(40);
  const nativeReceipt = JSON.stringify({
    schema: 'talkqte.lab.build.v1',
    executable: '/fictional/TalkQTE.app/Contents/MacOS/talkqte',
    bundlePath: '/fictional/TalkQTE.app',
    sha256: 'c'.repeat(64),
    commit,
    features: [
      'cloud-transcription',
      'lab-evaluator',
      'native-audio-spike',
      'timing-log',
    ],
    debug: true,
    signature: {
      identifier: 'com.talkqte.desktop',
      authority: 'TalkQTE Development',
      designatedRequirement: `identifier "com.talkqte.desktop" and certificate leaf = H"${leaf}"`,
    },
  });
  const nativeFile = join(dir, 'native-manifest.json');
  const nativeSha = writePrivate(nativeFile, nativeReceipt);
  const playerReceipt = JSON.stringify({
    schema: 'talkqte.lab.player.build.v1',
    executable:
      '/fictional/TalkQTE Lab Player.app/Contents/MacOS/lab-owned-player',
    bundlePath: '/fictional/TalkQTE Lab Player.app',
    sha256: 'd'.repeat(64),
    commit,
    signature: {
      identifier: 'com.talkqte.lab-player',
      authority: 'TalkQTE Development',
      designatedRequirement: `identifier "com.talkqte.lab-player" and certificate leaf = H"${leaf}"`,
    },
  });
  const playerFile = join(dir, 'player-manifest.json');
  const playerSha = writePrivate(playerFile, playerReceipt);
  const helper = join(dir, 'lab-window-capture');
  const helperSha = writePrivate(helper, 'fictional helper placeholder', 0o700);
  const evidence = join(dir, 'evidence');
  mkdirSync(evidence, { mode: 0o700 });
  const plan = change({
    schema: 'talkqte.lab.take-plan.v1',
    runId: 'fictional-take-01',
    fictional: true,
    native: {
      manifestFile: nativeFile,
      approved: {
        manifestSha256: nativeSha,
        executableSha256: 'c'.repeat(64),
        commit,
      },
    },
    player: {
      manifestFile: playerFile,
      approved: {
        manifestSha256: playerSha,
        executableSha256: 'd'.repeat(64),
        commit,
      },
    },
    helper: { path: helper, sha256: helperSha },
    media: fictionalTestMediaManifest(),
    selection: {
      provider: 'anthropic-api',
      model: 'claude-opus-5-5',
      effort: 'low',
      maxCalls: 40,
    },
    transcription: { backend: 'deepgram', minuteCap: 5 },
    evidenceDirectory: evidence,
  });
  const planFile = join(dir, 'plan.json');
  const planSha = writePrivate(
    planFile,
    JSON.stringify(plan, null, 2),
    planMode,
  );
  return { planFile, planSha, dir };
}

const clean = { HOME: '/fictional-home', PATH: '/usr/bin:/bin' };
const refusedAt = (stepName) => (error) =>
  error instanceof TakePlanRefused &&
  error.step === stepName &&
  /Nothing was launched/.test(error.message);

test('a valid model-enabled plan reports what it would launch, send and spend', () => {
  const { planFile, planSha } = setup();
  const s = checkTakePlan(planFile, { environment: clean });
  assert.equal(s.planSha256, planSha);
  assert.equal(s.kind, 'prepared');
  assert.equal(s.runId, 'fictional-take-01');
  assert.equal(
    s.launch.app.executable,
    '/fictional/TalkQTE.app/Contents/MacOS/talkqte',
  );
  assert.deepEqual(s.launch.app.features, [
    'cloud-transcription',
    'lab-evaluator',
    'native-audio-spike',
    'timing-log',
  ]);
  assert.equal(s.launch.media.durationMs, 102480);
  assert.equal(s.launch.media.scenarioId, 'fs-fictional-test');
  assert.deepEqual(s.timing, {
    approvalBudgetMs: 180000,
    nativeStopAfterS: 320,
    takeMsAfterApproval: 135000,
    tailMs: 0,
    turnOffAfterMs: null,
  });
  assert.equal(s.send.anthropic.maxRequests, 40);
  assert.equal(s.send.anthropic.endpoint, 'https://api.anthropic.com');
  assert.equal(s.send.anthropic.keyFileReadAt, 'after the in-app approval');
  assert.match(s.send.deepgram.keyFile, /deepgram\.env$/);
  assert.equal(
    s.send.deepgram.keyFileReadAt,
    'before launch, to mint the token',
  );
  assert.match(s.send.deepgram.query, /mip_opt_out=true/);
  assert.equal(s.spend.anthropicLocalEstimateCapUsd, 1);
  assert.equal(s.spend.deepgramMinutesAtMost, 5);
  assert.equal(Object.isFrozen(s), true);
  const text = renderTakePlan(s);
  assert.match(text, /^Plan valid \(dry run\)\. Nothing was launched/);
  assert.ok(text.includes(`plan sha256: ${planSha}`));
  assert.match(text, /at most 40 requests/);
  assert.match(text, /capped at \$1\.00/);
  assert.ok(text.includes(`--execute --confirm ${planSha}`));
});

test('a smaller model shows its own local spend cap', () => {
  const { planFile } = setup((p) => ({
    ...p,
    selection: { ...p.selection, model: 'claude-haiku-5-5' },
  }));
  const s = checkTakePlan(planFile, { environment: clean });
  assert.equal(s.spend.anthropicLocalEstimateCapUsd, 0.25);
  assert.match(renderTakePlan(s), /capped at \$0\.25/);
});

test('a provider-failure plan names no key file and no Deepgram minutes', () => {
  const { planFile } = setup((p) => ({
    ...p,
    transcription: {
      backend: 'deepgram',
      minuteCap: 2,
      failureProbe: 'refused-token',
    },
  }));
  const s = checkTakePlan(planFile, { environment: clean });
  assert.equal(s.kind, 'provider-failure');
  assert.equal(s.send.deepgram.keyFile, null);
  assert.equal(s.spend.deepgramMinutesAtMost, 0);
  assert.match(renderTakePlan(s), /no key file read/);
});

test('a turn-off plan reports when processing is turned off', () => {
  const { planFile } = setup((p) => ({ ...p, turnOffAfterMs: 45000 }));
  const s = checkTakePlan(planFile, { environment: clean });
  assert.equal(s.kind, 'turn-off');
  assert.equal(s.timing.turnOffAfterMs, 45000);
  assert.match(
    renderTakePlan(s),
    /turn processing off 45000 ms after render start/,
  );
});

test('optional context, user name and tail pass through the existing checks', () => {
  const { planFile } = setup((p) => ({
    ...p,
    contextPolicy: 'bounded-history',
    userName: 'Avery',
    tailMs: 10000,
    transcription: { ...p.transcription, reconnect: true },
  }));
  const s = checkTakePlan(planFile, { environment: clean });
  assert.equal(s.send.anthropic.contextPolicy, 'bounded-history');
  assert.equal(s.send.anthropic.userName, 'Avery');
  assert.equal(s.timing.tailMs, 10000);
  assert.equal(s.send.deepgram.reconnect, true);
});

test('plans the take modules would refuse are refused at the step that fails', () => {
  const cases = [
    ['plan fields', (p) => ({ ...p, fictional: false })],
    ['plan fields', (p) => ({ ...p, schema: 'talkqte.lab.take-plan.v0' })],
    ['plan fields', (p) => ({ ...p, extra: true })],
    ['plan fields', (p) => ({ ...p, runId: 'has space' })],
    [
      'native build receipt',
      (p) => ({
        ...p,
        native: {
          ...p.native,
          approved: { ...p.native.approved, commit: 'e'.repeat(40) },
        },
      }),
    ],
    [
      'native build receipt',
      (p) => ({
        ...p,
        native: {
          ...p.native,
          approved: { ...p.native.approved, manifestSha256: 'f'.repeat(64) },
        },
      }),
    ],
    [
      'player build receipt',
      (p) => ({
        ...p,
        player: {
          ...p.player,
          approved: { ...p.player.approved, executableSha256: 'f'.repeat(64) },
        },
      }),
    ],
    [
      'recorder helper',
      (p) => ({ ...p, helper: { ...p.helper, sha256: 'f'.repeat(64) } }),
    ],
    ['media', (p) => ({ ...p, media: { ...p.media, sha256: 'f'.repeat(64) } })],
    ['media', (p) => ({ ...p, media: { manifestFile: p.media.manifestFile } })],
    // The subscription routes have no transcription.
    [
      'launch options',
      (p) => ({
        ...p,
        selection: {
          provider: 'codex',
          model: 'gpt-6.1-sol',
          effort: 'low',
          maxCalls: 20,
        },
      }),
    ],
    [
      'launch options',
      (p) => ({ ...p, selection: { ...p.selection, effort: 'medium' } }),
    ],
    [
      'launch options',
      (p) => ({ ...p, selection: { ...p.selection, model: 'claude-other' } }),
    ],
    [
      'launch options',
      (p) => ({ ...p, transcription: { ...p.transcription, minuteCap: 61 } }),
    ],
    [
      'launch options',
      (p) => ({ ...p, transcription: { ...p.transcription, grant: {} } }),
    ],
    [
      'launch options',
      (p) => ({
        ...p,
        transcription: { ...p.transcription, failureProbe: 'other' },
      }),
    ],
    // A turn-off is never a provider-failure take.
    [
      'launch options',
      (p) => ({
        ...p,
        turnOffAfterMs: 1000,
        transcription: {
          ...p.transcription,
          failureProbe: 'refused-token',
        },
      }),
    ],
    ['launch options', (p) => ({ ...p, userName: 'R2-D2 <x>' })],
    ['launch options', (p) => ({ ...p, contextPolicy: 'everything' })],
    [
      'take options',
      (p) => ({ ...p, selection: { ...p.selection, maxCalls: 20 } }),
    ],
    ['take options', (p) => ({ ...p, tailMs: 15001 })],
    ['take options', (p) => ({ ...p, turnOffAfterMs: 0 })],
    ['take options', (p) => ({ ...p, turnOffAfterMs: 102480 })],
    ['take options', (p) => ({ ...p, turnOffAfterMs: 1.5 })],
    [
      'evidence directory',
      (p) => ({ ...p, evidenceDirectory: 'relative/evidence' }),
    ],
  ];
  for (const [stepName, change] of cases) {
    const { planFile } = setup(change);
    assert.throws(
      () => checkTakePlan(planFile, { environment: clean }),
      refusedAt(stepName),
      stepName,
    );
  }
});

test('the subscription-route refusal keeps its own reason', () => {
  const { planFile } = setup((p) => ({
    ...p,
    selection: {
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'low',
      maxCalls: 20,
    },
  }));
  assert.throws(
    () => checkTakePlan(planFile, { environment: clean }),
    /launch options: This route has no transcription/,
  );
});

test('private-file and environment rules are checked before anything else', () => {
  const open = setup(undefined, { planMode: 0o644 });
  assert.throws(
    () => checkTakePlan(open.planFile, { environment: clean }),
    refusedAt('plan file'),
  );
  assert.throws(
    () => checkTakePlan('relative/plan.json', { environment: clean }),
    refusedAt('plan file'),
  );
  const { planFile, dir } = setup();
  for (const environment of [
    { ...clean, ANTHROPIC_API_KEY: '' },
    { ...clean, NODE_OPTIONS: '' },
    { ...clean, NODE_EXTRA_CA_CERTS: '/fictional/ca.pem' },
  ])
    assert.throws(
      () => checkTakePlan(planFile, { environment }),
      refusedAt('environment'),
    );
  chmodSync(join(dir, 'evidence'), 0o755);
  assert.throws(
    () => checkTakePlan(planFile, { environment: clean }),
    refusedAt('evidence directory'),
  );
  chmodSync(join(dir, 'native-manifest.json'), 0o644);
  assert.throws(
    () => checkTakePlan(planFile, { environment: clean }),
    refusedAt('native build receipt'),
  );
});

test('the command prints the dry run, refuses a bad plan and needs --execute with --confirm', async () => {
  const lines = { log: [], error: [] };
  const io = {
    log: (x) => lines.log.push(x),
    error: (x) => lines.error.push(x),
  };
  const { planFile, planSha } = setup();
  const saved = process.env.NODE_OPTIONS;
  // The command checks this process's own environment.
  delete process.env.NODE_OPTIONS;
  try {
    const hasAmbient = Object.keys(process.env).some((k) =>
      /^ANTHROPIC_|^NODE_TLS_REJECT_UNAUTHORIZED$|^NODE_EXTRA_CA_CERTS$|^NODE_USE_ENV_PROXY$/.test(
        k,
      ),
    );
    if (!hasAmbient) {
      assert.equal(await main(['--plan', planFile], io), 0);
      assert.ok(lines.log.join('\n').includes(planSha));
    }
    const bad = setup((p) => ({ ...p, fictional: false }));
    assert.equal(await main(['--plan', bad.planFile], io), 1);
    assert.match(
      lines.error.at(-1),
      /Plan refused at (plan fields|environment)/,
    );
    assert.equal(await main([], io), 2);
    // --confirm and --execute only together, each once.
    assert.equal(await main(['--plan', planFile, '--confirm', planSha], io), 2);
    assert.match(lines.error.at(-1), /--execute --confirm <plan sha256>/);
    assert.equal(await main(['--plan', planFile, '--execute'], io), 2);
    assert.equal(await main(['--execute'], io), 2);
    assert.equal(
      await main(
        ['--plan', planFile, '--execute', '--execute', '--confirm', planSha],
        io,
      ),
      2,
    );
  } finally {
    if (saved !== undefined) process.env.NODE_OPTIONS = saved;
  }
  // The plan file itself is left unchanged.
  assert.equal(sha(readFileSync(planFile)), planSha);
});

// --- Execute path -------------------------------------------------------

// The owner's scope, except that the test media is a synthetic manifest:
// the fixed MP4 is not in the repository. The default scope is checked
// separately below.
const fixtureScope = { ...OWNER_TAKE_SCOPE, fixedMediaOnly: false };
const plenty = () => 64 * 1024 ** 3;

// A stand-in for the take (createFixedModelTake), which has its own tests
// (cue-lab-prepared-take.test.mjs). It runs the real option check on what
// the runner passes, launches the fixture native child through the real
// native owner and fixture launcher, reports approval as the take does,
// starts the recorder fixture, and ends with the take's own ordinary Stop
// and cleanup order: native Stop and release, player stop, recorder stop,
// player retirement, observer and launcher close. Its terminal state for
// each kind is the runbook's: provider failure `stopped` after the app
// refuses the probe, turn-off `stopped` with failure `turned-off`.
function standInTake(options, { trace, hold, cloud }) {
  assertFixedModelTakeOptions(options);
  const { launcher, player, recorder, source, runId, signal } = options;
  const kind = launcher.transcription.failureProbe
    ? 'provider-failure'
    : options.turnOffAfterMs !== undefined
      ? 'turn-off'
      : 'prepared';
  const now = () => ({
    clockId: 'node',
    atMs: performance.now(),
    uncertaintyMs: 0,
    basis: 'receipt',
  });
  let phase = 'starting',
    failure = null,
    failedStep = null,
    approval = null,
    turnOff = null,
    step = 'native-start';
  let review;
  const reviewed = new Promise((resolve) => (review = resolve));
  const unsubscribe = launcher.subscribeEvaluator((row) => review(row));
  const stopped = new Promise((resolve) =>
    signal.addEventListener('abort', resolve, { once: true }),
  );
  const cancelled = () => {
    if (signal.aborted) throw Object.assign(Error('x'), { category: 'c' });
  };
  const owner = createLabNativeOwner({
    executable: launcher.executable,
    launch: launcher.launch,
    stopAfterS: options.stopAfterS,
    armingMs: 1200,
    releaseMs: 1000,
    turnOff: kind === 'turn-off',
  });
  const until = async (ok) => {
    for (let n = 0; n < 200 && !ok() && !signal.aborted; n++) await delay(10);
    cancelled();
    assert.ok(ok());
  };
  const done = (async () => {
    try {
      const descriptor = join(launcher.directory, 'descriptor.json');
      writeFileSync(descriptor, '{}', { mode: 0o600 });
      options.observe({
        stage: 'run.started',
        outcome: 'observed',
        ids: {},
        timing: now(),
      });
      trace.push('launch');
      await owner.start({
        descriptorPath: descriptor,
        runId,
        metadata: {
          provider: options.settings.provider,
          model: options.settings.model,
          effort: options.settings.effort,
          maxCalls: options.settings.maxCalls,
          spendCapMicroUsd: 1_000_000,
        },
      });
      step = 'approval-wait';
      options.onApproval({ state: 'waiting', budgetMs: 180000 });
      if (cloud && kind !== 'turn-off') {
        await Promise.race([reviewed, stopped]);
        cancelled();
        step = 'token-release';
        launcher.releaseTranscriptionToken();
      }
      approval = { budgetMs: 180000, waitMs: 5, session: 2 };
      options.onApproval({ state: 'approved', ...approval });
      step = 'recorder-start';
      await recorder.start({ runId, signal });
      options.observe({
        stage: 'recorder.frame-accepted',
        outcome: 'observed',
        ids: {},
        timing: now(),
      });
      // The take's guard, at an uptime where floating-point rounding makes
      // sourceDeadline - nativeStartedAt differ from 320000.
      let nativeStartedAt = 204000.0001;
      while (nativeStartedAt + 320000 - nativeStartedAt === 320000)
        nativeStartedAt += 7.31337;
      const sourceDeadline = nativeStartedAt + 320000;
      const startRequestAt = nativeStartedAt + 40000.25;
      options.onGuard({
        nativeStartedAt,
        sourceDeadline,
        startRequestAt,
        startBudgetMs: 1000,
        mediaDurationMs: options.media.durationMs,
        tailMs: options.tailMs ?? 0,
        completionReserveMs: 1000,
        remainingAtRequestMs: sourceDeadline - startRequestAt,
        approvalBudgetMs: 180000,
        approvalWaitMs: 5,
      });
      step = 'playback';
      trace.push('playing');
      if (hold) {
        hold();
        await stopped;
        cancelled();
      }
      if (kind === 'provider-failure') {
        // The app refuses the probe's fixed text (401, code auth) and
        // ends the stream; nothing connected.
        await until(() =>
          readFileSync(launcher.timingPath, 'utf8').includes('"code":"auth"'),
        );
        assert.equal(launcher.transcription.connectedQuery, null);
        failure = 'protocol';
      } else if (kind === 'turn-off') {
        await owner.turnOff();
        turnOff = { afterMs: options.turnOffAfterMs, outcome: 'done' };
        failure = 'turned-off';
      } else if (cloud)
        await until(() => launcher.transcription.connectedQuery !== null);
    } catch {
      failedStep ??= step;
      failure ??= signal.aborted ? 'cancelled' : 'protocol';
    }
    phase = 'stopping';
    trace.push('native-stop');
    const released = await owner.stop().then(
      (r) => r.released === true,
      () => false,
    );
    await player.stop().catch(() => {});
    const finalized = await recorder.stop().then(
      (r) => r.stopped === true,
      () => false,
    );
    const retired =
      released &&
      finalized &&
      (await player.close({ nativeReleased: true }).then(
        (r) => r.closed === true,
        () => false,
      ));
    unsubscribe();
    source.close();
    launcher.close();
    trace.push('cleanup');
    options.observe({
      stage: 'run.ended',
      outcome:
        failure === 'cancelled'
          ? 'cancelled'
          : failure && failure !== 'turned-off'
            ? 'failure'
            : 'observed',
      ids: {},
      timing: now(),
    });
    phase =
      released && finalized && retired
        ? failure
          ? 'stopped'
          : 'completed'
        : 'failed-cleanup';
    if (phase !== 'completed') throw Error('fictional take did not complete');
    return { completed: true, nativeReleased: true };
  })();
  done.catch(() => {});
  return {
    done,
    stop() {
      failure ??= 'cancelled';
    },
    get phase() {
      return phase;
    },
    get failure() {
      return failure;
    },
    get failedStep() {
      return failedStep;
    },
    get runStopReason() {
      return failure === 'protocol' ? 'session-ended' : null;
    },
    get approval() {
      return approval;
    },
    get turnOff() {
      return turnOff;
    },
    get dispatchesUsed() {
      return 0;
    },
  };
}

// A take whose native release was lost keeps its player, as the real take
// does; the test run must not.
const players = [];
after(() =>
  Promise.all(
    players.map((p) => p.close({ nativeReleased: true }).catch(() => {})),
  ),
);

// The existing modules with the existing fixtures in place of the app,
// player, recorder, grant and duration tool. `calls` lists each module in
// the order the runner used it.
function fixtureModules({
  fixtureCase = 'cloud-transcription',
  hold,
  recorderCase = 'normal',
} = {}) {
  const calls = [],
    trace = [];
  const seen = {};
  const modules = {
    verifyNative({ manifestFile, approved }) {
      calls.push('verify-native');
      assert.ok(manifestFile && approved);
    },
    verifyPlayer({ manifestFile, approved }) {
      calls.push('verify-player');
      assert.ok(manifestFile && approved);
    },
    prepareDuration() {
      calls.push('duration-tool');
      return {
        method: 'fixture duration',
        measure(path) {
          calls.push('duration');
          assert.ok(lstatSync(path).size > 0);
          return 4321.5;
        },
        close() {},
      };
    },
    // The real sweep would look at this machine's temporary folder.
    sweepTokens: () => calls.push('sweep'),
    createWriter(options) {
      calls.push('writer');
      return createLabEvidenceWriter(options);
    },
    createPlayer({ runId, manifestFile, approved, startMs }) {
      calls.push('player');
      assert.ok(manifestFile && approved);
      const player = createLabPlayerFixture({ runId, startMs });
      players.push(player);
      return player;
    },
    async mintGrant() {
      calls.push('key-read-and-mint');
      return {
        ttlSeconds: 900,
        writeTokenFile(path) {
          writeFileSync(path, 'fictional-token-0123456789abcdef', {
            mode: 0o600,
            flag: 'wx',
          });
        },
        discard() {},
      };
    },
    prepareLauncher(options) {
      calls.push('launcher');
      seen.launch = options;
      // The real scope check on exactly what the runner asked for; the
      // fixture launcher then runs the same selection and transcription.
      const {
        manifestFile: _m,
        approved: _a,
        environment: _e,
        ownProcessGroup: _g,
        ...scope
      } = options;
      assertLabLaunchOptions(scope);
      return prepareLabFixtureLauncher({
        fixtureCase,
        selection: options.selection,
        stopAfterS: options.stopAfterS,
        transcription: options.transcription,
        userName: options.userName,
        turnOff: options.turnOff,
        environment: options.environment,
        ownProcessGroup: options.ownProcessGroup,
      });
    },
    createSource(options) {
      calls.push('source');
      return createLabSourceV1(options);
    },
    // A fixture player's identity is never an approved source, so the
    // recorder fixture records the windows its own tests use: the player
    // fixture's process as the emulator, the native child as the companion.
    createSelector({ playerSource, native, nativeApplication }) {
      calls.push('selector');
      seen.nativeApplication = nativeApplication;
      return async () => ({
        emulator: {
          app: 'QuickTime Player',
          pid: playerSource.pid,
          windowId: playerSource.windowId,
        },
        companion: {
          app: nativeApplication,
          pid: native.identity.pid,
          windowId: 52,
        },
      });
    },
    createRecorder(options) {
      calls.push('recorder');
      seen.recorder = options;
      return createLabRecorderFixture({
        ...options,
        playerSource: undefined,
        fixtureCase: recorderCase,
      });
    },
    createTake(options) {
      calls.push('take');
      seen.take = options;
      return standInTake(options, {
        trace,
        hold,
        cloud: fixtureCase.startsWith('cloud'),
      });
    },
    snapshotTiming(options) {
      calls.push('timing-snapshot');
      return snapshotLabTiming(options);
    },
    writeReport(options) {
      calls.push('report');
      return writeEvidenceReport(options);
    },
  };
  return { modules, calls, trace, seen };
}

const quietIo = (lines = []) => ({
  log: (x) => lines.push(x),
  error: (x) => lines.push(x),
});

function execute(planFile, planSha, f, extra = {}) {
  return executeTakePlan(planFile, {
    confirm: planSha,
    environment: clean,
    processEvents: new EventEmitter(),
    modules: f.modules,
    scope: fixtureScope,
    freeBytes: plenty,
    // The owned player's exact runtime; the test's own Node may differ.
    runtime: LAB_PLAYER_RUNTIME,
    io: quietIo(),
    ...extra,
  });
}

test('a full fixture take reaches its terminal state, writes the evidence report, and its plan cannot run again', async () => {
  const { planFile, planSha, dir } = setup((p) => ({
    ...p,
    userName: 'Avery',
    tailMs: 2000,
  }));
  const evidence = join(dir, 'evidence');
  const f = fixtureModules();
  const lines = [];
  const result = await execute(planFile, planSha, f, { io: quietIo(lines) });
  assert.equal(result.outcome.startFailure, null);
  assert.equal(result.state, 'completed');
  assert.equal(result.exitCode, 0);
  // The runbook's order; the key file is read (here: the stand-in grant)
  // after the player is prepared and before the launcher.
  assert.deepEqual(f.calls, [
    'verify-native',
    'verify-player',
    'duration-tool',
    'sweep',
    'writer',
    'player',
    'key-read-and-mint',
    'launcher',
    'source',
    'selector',
    'recorder',
    'take',
    'timing-snapshot',
    'duration',
    'report',
  ]);
  // What the runner passed on: the plan's values and the stated defaults.
  assert.equal(f.seen.launch.stopAfterS, 320);
  assert.equal(f.seen.launch.sourceApplication, 'TalkQTE Lab Player');
  assert.equal(f.seen.launch.userName, 'Avery');
  assert.equal(f.seen.launch.turnOff, undefined);
  // The app gets its own process group, so a terminal Ctrl-C reaches only
  // the runner (cue-lab-launcher.test.mjs shows why).
  assert.equal(f.seen.launch.ownProcessGroup, true);
  assert.deepEqual(Object.keys(f.seen.launch.environment).sort(), [
    'HOME',
    'PATH',
  ]);
  assert.equal(f.seen.nativeApplication, 'TalkQTE');
  assert.equal(f.seen.recorder.seconds, 180);
  assert.equal(f.seen.recorder.startupMs, 3000);
  assert.equal(f.seen.take.settings.deadlineMs, 30000);
  assert.equal(f.seen.take.settings.execution, 'api');
  assert.equal(f.seen.take.tailMs, 2000);
  assert.equal(f.seen.take.approvalBudgetMs, 180000);
  // One clear line while Listening and waiting for the in-app approval.
  const prompt = lines.filter((l) => /Enable for this session NOW/.test(l));
  assert.equal(prompt.length, 1);
  assert.match(
    prompt[0],
    /Press Review processing, Review selected sources, Enable for this session NOW: 180 s remain\./,
  );
  assert.ok(lines.includes('Take ended: completed.'));
  // In execute mode the dry run's "Nothing was launched" is not repeated,
  // and the duration helper's build is announced.
  assert.ok(!lines.some((l) => /Nothing was launched/.test(l)));
  assert.match(lines[0], /^Plan valid\. Checking this attempt/);
  assert.ok(
    lines.some((l) => /^Building the recording-duration helper/.test(l)),
  );
  assert.ok(
    lines.includes(
      `Evidence report: ${join(result.reportDirectory, 'report.md')}`,
    ),
  );
  // The marker, the manifest, the report and the outcome, all owner-only.
  const marker = attemptMarkerPath(evidence, planSha);
  assert.equal(lstatSync(marker).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(marker)).planSha256, planSha);
  for (const file of ['report.md', 'report.json'])
    assert.equal(
      lstatSync(join(result.reportDirectory, file)).mode & 0o777,
      0o600,
    );
  const outcome = JSON.parse(readFileSync(result.outcomePath));
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.native.released, true);
  assert.equal(outcome.native.transcription.tokenRemoved, true);
  assert.equal(outcome.recorder.finalized, true);
  assert.equal(outcome.evidence.timing, 'attached');
  assert.equal(outcome.evidence.recording, 'attached');
  assert.equal(outcome.evidence.recordingDurationMs, 4321.5);
  assert.equal(outcome.player.retired, true);
  const manifest = JSON.parse(readFileSync(outcome.evidence.manifest));
  assert.equal(manifest.recording.durationMs, 4321.5);
  // The guard reached the writer through onGuard at a large uptime.
  assert.equal(manifest.guards.length, 1);
  assert.notEqual(
    manifest.guards[0].sourceDeadline - manifest.guards[0].nativeStartedAt,
    320000,
  );
  assert.deepEqual(manifest.transcription, {
    backend: 'deepgram',
    minuteCap: 5,
    grantTtlS: 900,
    query: manifest.transcription.query,
  });
  assert.ok(
    manifest.artifacts.some(
      (a) => a.kind === 'native-timing' && a.clockId === 'native-logger',
    ),
  );
  assert.ok(!JSON.stringify(outcome).includes('fictional-token'));

  // The same plan again: refused before the duration tool, the player, any
  // key read or any launch, and nothing new is written.
  const again = fixtureModules();
  const before = JSON.stringify(readFileSync(marker, 'utf8'));
  await assert.rejects(execute(planFile, planSha, again), (error) =>
    refusedAt('attempt')(error),
  );
  assert.deepEqual(again.calls, []);
  assert.equal(JSON.stringify(readFileSync(marker, 'utf8')), before);
});

test('a refused-token fixture take ends stopped after the app refuses the probe, with no key read', async () => {
  const { planFile, planSha } = setup((p) => ({
    ...p,
    transcription: {
      backend: 'deepgram',
      minuteCap: 5,
      failureProbe: 'refused-token',
    },
  }));
  const f = fixtureModules({ fixtureCase: 'cloud-refused' });
  const result = await execute(planFile, planSha, f);
  assert.equal(result.state, 'stopped');
  assert.equal(result.outcome.failure, 'protocol');
  assert.ok(!f.calls.includes('key-read-and-mint'));
  assert.equal(f.seen.launch.transcription.failureProbe, 'refused-token');
  assert.equal(
    result.outcome.native.transcription.failureProbe,
    'refused-token',
  );
  assert.equal(result.outcome.native.transcription.connectedQuery, null);
  assert.equal(result.outcome.native.released, true);
  const manifest = JSON.parse(readFileSync(result.outcome.evidence.manifest));
  assert.equal(manifest.transcription.failureProbe, 'refused-token');
  assert.ok(existsSync(join(result.reportDirectory, 'report.md')));
});

test('a recorder whose stream macOS stopped leaves its reason, code and start timings in the outcome', async () => {
  const { planFile, planSha } = setup();
  const f = fixtureModules({ recorderCase: 'stream-stopped' });
  const lines = [];
  const result = await execute(planFile, planSha, f, { io: quietIo(lines) });
  // A recorder that never started cannot finalize: the take's existing
  // terminal state for that.
  assert.equal(result.state, 'failed-cleanup');
  assert.equal(result.outcome.failedStep, 'recorder-start');
  const outcome = JSON.parse(readFileSync(result.outcomePath));
  const detail = outcome.recorder.failureDetail;
  assert.equal(detail.errorReason, 'stream-stopped');
  assert.equal(detail.errorCode, -3805);
  assert.equal(detail.frameAccepted, false);
  assert.deepEqual(detail.filters, {
    emulator: 'independent',
    companion: 'display',
  });
  assert.ok(Number.isSafeInteger(detail.timings.matchedMs));
  assert.ok(Number.isSafeInteger(detail.timings.filtersMs));
  assert.equal(detail.timings.frameAcceptedMs, null);
  assert.doesNotMatch(JSON.stringify(outcome), /fictional interruption/);
  assert.ok(lines.some((l) => /recorder stream-stopped/.test(l)));
});

test('a turn-off fixture take ends stopped with failure turned-off', async () => {
  const { planFile, planSha } = setup((p) => ({ ...p, turnOffAfterMs: 1000 }));
  const f = fixtureModules({ fixtureCase: 'turn-off' });
  const result = await execute(planFile, planSha, f);
  assert.equal(result.state, 'stopped');
  assert.equal(result.outcome.failure, 'turned-off');
  assert.equal(f.seen.launch.turnOff, true);
  assert.equal(f.seen.take.turnOffAfterMs, 1000);
  assert.deepEqual(result.outcome.native.turnOff, { step: 'done', repeats: 0 });
  assert.equal(result.outcome.native.released, true);
  assert.ok(existsSync(join(result.reportDirectory, 'report.md')));
});

test('SIGINT during the fixture take goes through the ordinary Stop and cleanup', async () => {
  const { planFile, planSha } = setup();
  const events = new EventEmitter();
  // Ctrl-C while the take plays, then a second one, which changes nothing.
  const f = fixtureModules({
    hold: () => {
      events.emit('SIGINT');
      events.emit('SIGINT');
    },
  });
  const lines = [];
  const io = quietIo(lines);
  const result = await execute(planFile, planSha, f, {
    io,
    processEvents: events,
  });
  assert.equal(result.state, 'stopped');
  assert.equal(result.outcome.failure, 'cancelled');
  assert.equal(result.outcome.stopSignal, 'SIGINT');
  // Released by native's own Stop handshake, then the recorder finalized
  // and the player retired: the take's cleanup, not a kill.
  assert.deepEqual(f.trace, ['launch', 'playing', 'native-stop', 'cleanup']);
  assert.equal(result.outcome.native.released, true);
  assert.equal(result.outcome.recorder.finalized, true);
  assert.equal(lines.filter((l) => /^SIGINT: stopping/.test(l)).length, 1);
  assert.equal(events.listenerCount('SIGINT'), 0);
  assert.equal(events.listenerCount('SIGTERM'), 0);
  assert.ok(existsSync(join(result.reportDirectory, 'report.md')));
});

test('a wrong confirmation, low disk or a plan outside the owner decisions is refused before the marker', async () => {
  const { planFile, planSha, dir } = setup();
  const marker = attemptMarkerPath(join(dir, 'evidence'), planSha);
  const cases = [
    ['confirmation', { confirm: 'f'.repeat(64) }],
    ['confirmation', { confirm: planSha.toUpperCase() }],
    ['disk', { freeBytes: () => DISK_FLOOR_BYTES - 1 }],
    ['runtime', { runtime: { ...LAB_PLAYER_RUNTIME, node: 'v22.0.0' } }],
    ['runtime', { runtime: { ...LAB_PLAYER_RUNTIME, libuv: '1.50.0' } }],
    // The default scope: the fixed meeting only (the test media is a
    // per-run manifest).
    ['owner decisions', { scope: OWNER_TAKE_SCOPE }],
  ];
  for (const [stepName, extra] of cases) {
    const f = fixtureModules();
    await assert.rejects(
      execute(planFile, planSha, f, extra),
      refusedAt(stepName),
      stepName,
    );
    assert.deepEqual(f.calls, [], stepName);
    assert.equal(existsSync(marker), false, stepName);
  }
  for (const change of [
    (p) => ({ ...p, selection: { ...p.selection, model: 'claude-haiku-5-5' } }),
    (p) => ({ ...p, transcription: { ...p.transcription, minuteCap: 2 } }),
  ]) {
    const other = setup(change);
    const f = fixtureModules();
    await assert.rejects(
      execute(other.planFile, other.planSha, f),
      refusedAt('owner decisions'),
    );
    assert.deepEqual(f.calls, []);
  }
  // The command path: a mismatch exits 1 after printing the dry run.
  const lines = [];
  const saved = process.env.NODE_OPTIONS;
  delete process.env.NODE_OPTIONS;
  try {
    assert.equal(
      await main(
        ['--plan', planFile, '--execute', '--confirm', 'f'.repeat(64)],
        quietIo(lines),
      ),
      1,
    );
  } finally {
    if (saved !== undefined) process.env.NODE_OPTIONS = saved;
  }
  assert.match(
    lines.at(-1),
    /Plan refused at (confirmation|environment).*Nothing was launched/,
  );
  assert.equal(existsSync(marker), false);
});

test('a failed build check is refused before the marker; a take that cannot confirm release still has its player retired', async () => {
  const { planFile, planSha, dir } = setup();
  const marker = attemptMarkerPath(join(dir, 'evidence'), planSha);
  for (const which of ['verifyNative', 'verifyPlayer']) {
    const f = fixtureModules();
    f.modules[which] = () => {
      throw new Error('fictional signature failure');
    };
    await assert.rejects(
      execute(planFile, planSha, f),
      refusedAt(
        which === 'verifyNative'
          ? 'native build signature'
          : 'player build signature',
      ),
    );
    assert.ok(!f.calls.includes('duration-tool'));
    assert.equal(existsSync(marker), false);
  }
  // Native never confirms release (the fixture writes no `released`): the
  // take ends in failed cleanup and keeps the player; the runner retires
  // it once the take has settled, so nothing it owns keeps running.
  const f = fixtureModules({ fixtureCase: 'lost-released' });
  const result = await execute(planFile, planSha, f);
  assert.equal(result.state, 'failed-cleanup');
  assert.equal(result.outcome.native.released, false);
  assert.equal(result.outcome.evidence.timing, 'not-released');
  assert.equal(result.outcome.player.retired, true);
  assert.notEqual(result.outcome.player.diagnostics.process, null);
  assert.ok(existsSync(join(result.reportDirectory, 'report.md')));
});
