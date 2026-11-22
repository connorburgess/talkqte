// Offline checks of the take plan dry run. Fictional receipts, a placeholder
// helper file and the synthetic media manifest in private temporary
// folders; nothing is launched, signed, minted or sent.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkTakePlan,
  main,
  renderTakePlan,
  TakePlanRefused,
} from './cue-lab-take.mjs';
import { fictionalTestMediaManifest } from './fixtures/lab-test-media.mjs';

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
  assert.match(text, /No execute path is committed/);
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

test('the command prints the dry run, refuses a bad plan and has no execute path', () => {
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
      assert.equal(main(['--plan', planFile], io), 0);
      assert.ok(lines.log.join('\n').includes(planSha));
    }
    const bad = setup((p) => ({ ...p, fictional: false }));
    assert.equal(main(['--plan', bad.planFile], io), 1);
    assert.match(
      lines.error.at(-1),
      /Plan refused at (plan fields|environment)/,
    );
    assert.equal(main([], io), 2);
    assert.equal(main(['--plan', planFile, '--confirm', planSha], io), 2);
    assert.match(lines.error.at(-1), /no execute path yet/);
    assert.equal(main(['--execute'], io), 2);
  } finally {
    if (saved !== undefined) process.env.NODE_OPTIONS = saved;
  }
  // The plan file itself is left unchanged.
  assert.equal(sha(readFileSync(planFile)), planSha);
});
