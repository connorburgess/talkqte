import { selectedIdentity } from './cue-selected-context.mjs';
import assert from 'node:assert/strict';
import { test as nodeTest, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const test = (name, fn) =>
  nodeTest(name, { skip: process.platform === 'win32' }, fn);
import {
  writeFileSync,
  appendFileSync,
  rmSync,
  statSync,
  mkdtempSync,
  chmodSync,
  utimesSync,
  renameSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchLabTiming } from './cue-lab-timing-reader.mjs';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import { once, EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { createLabSourceV1 } from './cue-lab-source-v1.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';
import { createLabRun } from './cue-lab-run.mjs';
import {
  prepareLabFixtureLauncher,
  prepareLabLauncher,
  validateLabBuildRecord,
} from './cue-lab-launcher.mjs';
import {
  NO_TRANSCRIPTION_SELECTED,
  NO_TRANSCRIPTION_SUBSCRIPTION,
} from './cue-lab-launcher.mjs';
const selection = {
  provider: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'medium',
  maxCalls: 2,
};
function fixture(mode, { turnOff = false, ownerTurnOff = turnOff } = {}) {
  const launcher = prepareLabFixtureLauncher({
    fixtureCase: mode,
    selection,
    ...(turnOff ? { turnOff: true } : {}),
  });
  const descriptor = join(launcher.directory, 'descriptor.json');
  writeFileSync(descriptor, '{}', { mode: 0o600 });
  let child, lastLaunch;
  const owner = createLabNativeOwner({
    executable: launcher.executable,
    stopAfterS: 120,
    armingMs: 1200,
    releaseMs: 300,
    turnOff: ownerTurnOff,
    offMs: 1000,
    launch(options) {
      lastLaunch = options;
      child = launcher.launch(options);
      return child;
    },
  });
  const events = [];
  owner.subscribe((event) => events.push(event.type));
  const start = () =>
    owner.start({
      descriptorPath: descriptor,
      runId: 'fixture-run',
      metadata: selection,
    });
  return {
    launcher,
    owner,
    events,
    start,
    get lastLaunch() {
      return lastLaunch;
    },
    get child() {
      return child;
    },
    async close() {
      launcher.close();
      if (child && child.exitCode === null && child.signalCode === null)
        await once(child, 'exit');
      rmSync(launcher.directory, { recursive: true, force: true });
    },
  };
}

for (const mode of ['normal', 'partial'])
  test(`actual harmless child ${mode} readiness and ordinary owned Stop use only content-free evidence`, async () => {
    const f = fixture(mode);
    try {
      await f.start();
      assert.ok(f.child.pid > 0);
      assert.throws(() => f.launcher.launch(f.lastLaunch));
      assert.equal(f.child.spawnfile, process.execPath);
      assert.equal(statSync(f.launcher.directory).mode & 0o777, 0o700);
      assert.equal(statSync(f.launcher.timingPath).mode & 0o777, 0o600);
      assert.deepEqual(await f.owner.stop(), { released: true });
      assert.equal(f.launcher.sourceReleased, true);
      assert.deepEqual(f.events, [
        'stop-requested',
        'stop-requested',
        'session-ended',
      ]);
    } finally {
      await f.close();
    }
  });

for (const mode of [
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
])
  test(`actual harmless child ${mode} cannot establish native release`, async () => {
    const f = fixture(mode);
    try {
      const started = f.start();
      if (
        [
          'wrong-run',
          'lost-armed',
          'bad-utf8',
          'stall-partial',
          'duplicate-fields',
          'frame-oversize',
        ].includes(mode)
      )
        await assert.rejects(started);
      else {
        await started;
        if (mode === 'lost-released') await assert.rejects(f.owner.stop());
        else {
          for (let n = 0; n < 200 && !f.events.includes('failed'); n++)
            await delay(10);
          assert.ok(f.events.includes('failed'));
        }
      }
      await assert.rejects(f.owner.stop());
      assert.equal(f.launcher.sourceReleased, false);
    } finally {
      await f.close();
    }
  });

test('an actual child timing failure aborts the shared lifecycle before authentication with zero dispatches', async () => {
  const launcher = prepareLabFixtureLauncher({
    fixtureCase: 'wrong-run',
    selection,
  });
  const native = createLabNativeOwner({
    executable: launcher.executable,
    launch: launcher.launch,
    stopAfterS: 120,
    armingMs: 1200,
    releaseMs: 300,
  });
  let calls = 0,
    closed = 0;
  const run = createLabRun({
    native,
    settings: {
      ...selection,
      deadlineMs: 30000,
      execution: 'offline-stand-in',
      environment: {},
      openers: {
        codex: async () => ({
          request: async () => {
            calls++;
            return { value: {} };
          },
          close: async () => {
            closed++;
          },
        }),
      },
    },
    startupMs: 2000,
    releaseMs: 1800,
  });
  try {
    await assert.rejects(run.ready);
    await assert.rejects(run.close(), { category: 'cleanup' });
    assert.equal(calls, 0);
    assert.equal(launcher.processStarted, true);
    assert.equal(closed, 1);
    assert.equal(run.phase, 'failed-cleanup');
  } finally {
    launcher.close();
    for (let n = 0; n < 200 && !launcher.processEnded; n++) await delay(10);
    assert.equal(launcher.processEnded, true);
    rmSync(launcher.directory, { recursive: true, force: true });
  }
});

test('fixture launch is single-use and never accepts ambient provider credentials', () => {
  assert.throws(() =>
    prepareLabFixtureLauncher({
      fixtureCase: 'normal',
      selection,
      environment: { OPENAI_API_KEY: 'fictional' },
    }),
  );
  assert.throws(() =>
    prepareLabFixtureLauncher({ fixtureCase: 'arbitrary-command', selection }),
  );
});

const record = {
  schema: 'talkqte.lab.build.v1',
  executable: '/fictional/TalkQTE.app/Contents/MacOS/talkqte',
  bundlePath: '/fictional/TalkQTE.app',
  sha256: 'a'.repeat(64),
  commit: 'b'.repeat(40),
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
    designatedRequirement:
      'identifier "com.talkqte.desktop" and certificate leaf = H"' +
      'C'.repeat(40) +
      '"',
  },
};
const approved = {
  manifestSha256: 'd'.repeat(64),
  executableSha256: 'a'.repeat(64),
  commit: 'b'.repeat(40),
};
test('a build record requires separately supplied exact approval and all four approved features', () => {
  assert.deepEqual(
    validateLabBuildRecord(record, approved, 'd'.repeat(64)),
    record,
  );
  for (const edit of [
    (r) => ({ ...r, extra: true }),
    (r) => ({ ...r, debug: false }),
    (r) => ({ ...r, commit: 'e'.repeat(40) }),
    (r) => ({ ...r, sha256: 'e'.repeat(64) }),
    (r) => ({ ...r, features: [...r.features, 'claude-cli'] }),
    (r) => ({ ...r, features: r.features.slice(1) }),
    (r) => ({
      ...r,
      features: [
        'lab-evaluator',
        'lab-evaluator',
        'native-audio-spike',
        'timing-log',
      ],
    }),
    (r) => ({
      ...r,
      signature: { ...r.signature, authority: 'Other Identity' },
    }),
    (r) => ({
      ...r,
      signature: {
        ...r.signature,
        designatedRequirement: 'identifier "com.talkqte.desktop"',
      },
    }),
  ])
    assert.throws(() =>
      validateLabBuildRecord(edit(record), approved, 'd'.repeat(64)),
    );
  assert.throws(() =>
    validateLabBuildRecord(record, undefined, 'd'.repeat(64)),
  );
  assert.throws(() => validateLabBuildRecord(record, approved, 'e'.repeat(64)));
  assert.throws(() =>
    prepareLabLauncher({
      manifestFile: '/fictional/no-approved-build.json',
      approved,
    }),
  );
});

test('duplicate JSON keys including escaped spellings cannot override a manifest or control identity', () => {
  assert.throws(() => parseUniqueLabJson('{"run_id":"a","run_id":"a"}'));
  assert.throws(() => parseUniqueLabJson('{"run_id":"a","run_\\u0069d":"a"}'));
  assert.throws(() =>
    parseUniqueLabJson('{"signature":{"authority":"a","authority":"b"}}'),
  );
  assert.deepEqual(
    parseUniqueLabJson('{"x":[{"x":1},{"x":2}],"text":"braces { and :"}'),
    { x: [{ x: 1 }, { x: 2 }], text: 'braces { and :' },
  );
});

test('runtime session cross-check discards unrelated simulated ends and rejects a changed reviewed build', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-reader-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'timing.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  const events = [];
  const reader = watchLabTiming({
    path,
    runId: 'fixture-run',
    expectedCommit: record.commit,
    expectedFeatures: record.features,
    onEvent: (e) => events.push(e),
  });
  try {
    appendFileSync(
      path,
      JSON.stringify({
        event: 'session',
        state: 'ended',
        live: false,
        session: 0,
      }) + '\n',
    );
    reader.poll();
    assert.deepEqual(events, []);
    appendFileSync(
      path,
      JSON.stringify({
        event: 'session',
        state: 'started',
        live: true,
        session: 1,
        commit: record.commit,
        features: record.features,
      }) + '\n',
    );
    reader.poll();
    assert.deepEqual(events, [
      {
        event: 'session',
        state: 'started',
        session: 1,
        commit: record.commit,
        features: record.features,
      },
    ]);
    appendFileSync(
      path,
      JSON.stringify({
        event: 'session',
        state: 'ended',
        live: true,
        session: 1,
        commit: 'f'.repeat(40),
        features: record.features,
      }) + '\n',
    );
    reader.poll();
    assert.equal(reader.failed, true);
    assert.deepEqual(events.at(-1), { event: 'dropped', count: 1 });
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v1 timing reads native name rows before Listening without losing numeric u64 sessions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-name-reader-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'timing.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  const events = [];
  const reader = watchLabTiming({
    path,
    runId: 'fictional-name-run',
    sourceObservation: 'v1',
    expectedApplication: 'TalkQTE Lab Player',
    onEvent: (event) => events.push(event),
  });
  try {
    // Match native startup: a numeric session, its name state, then Listening.
    appendFileSync(
      path,
      '{"event":"session","state":"started","live":true,"session":1}\n' +
        '{"event":"user_name_set","session":1,"set":true}\n' +
        JSON.stringify({
          event: 'dev_source_observation',
          version: 1,
          run_id: 'fictional-name-run',
          application: 'TalkQTE Lab Player',
          step: 'listening',
          host_operation: 'a'.repeat(32),
          live_operation: 'b'.repeat(64),
          session: '1',
        }) +
        '\n' +
        '{"event":"user_name_set","session":18446744073709551615,"set":false}\n',
    );
    reader.poll();
    assert.equal(reader.failed, false);
    assert.deepEqual(
      events.map((event) => event.event),
      ['session', 'user_name_set', 'dev_source_observation', 'user_name_set'],
    );
    assert.deepEqual(events[1], {
      event: 'user_name_set',
      session: '1',
      set: true,
    });
    assert.deepEqual(events[3], {
      event: 'user_name_set',
      session: '18446744073709551615',
      set: false,
    });
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v1 name rows still reject malformed sessions and nonboolean name state', () => {
  for (const [session, set] of [
    ['0', 'true'],
    ['-1', 'true'],
    ['1.5', 'true'],
    ['1e0', 'true'],
    ['"1"', 'true'],
    ['18446744073709551616', 'true'],
    ['1', '"true"'],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'tq-name-invalid-'));
    chmodSync(directory, 0o700);
    const path = join(directory, 'timing.jsonl');
    writeFileSync(path, '', { mode: 0o600 });
    const events = [];
    const reader = watchLabTiming({
      path,
      runId: 'fictional-name-run',
      sourceObservation: 'v1',
      onEvent: (event) => events.push(event),
    });
    try {
      appendFileSync(
        path,
        `{"event":"user_name_set","session":${session},"set":${set}}\n`,
      );
      reader.poll();
      assert.equal(reader.failed, true, `session ${session}, set ${set}`);
      assert.deepEqual(events, [{ event: 'dropped', count: 1 }]);
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('the reader passes on connection rows with their approval and refuses a malformed one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-reader-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'timing.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  const events = [];
  const reader = watchLabTiming({
    path,
    runId: 'fixture-run',
    sourceObservation: 'v1',
    onEvent: (event) => events.push(event),
  });
  try {
    // A u64 session larger than a JS number survives as its exact text.
    appendFileSync(
      path,
      '{"event":"evaluator","approval":"review","session":18446744073709551615,"state":"on","backend":"lab-api","model":"claude-opus-5-5","effort":"low","elapsed_ms":9,"wall_ms":1,"mono_ms":2}\n',
    );
    reader.poll();
    assert.deepEqual(events, [
      {
        event: 'evaluator',
        approval: 'review',
        state: 'on',
        backend: 'lab-api',
        model: 'claude-opus-5-5',
        effort: 'low',
        session: '18446744073709551615',
      },
    ]);
    appendFileSync(
      path,
      JSON.stringify({
        event: 'evaluator',
        approval: 'implicit',
        session: 2,
        state: 'on',
        backend: 'lab-api',
        model: 'claude-opus-5-5',
      }) + '\n',
    );
    reader.poll();
    assert.equal(reader.failed, true);
    assert.deepEqual(events.at(-1), { event: 'dropped', count: 1 });
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the reader passes on cloud transcription state rows with fixed codes and refuses a malformed one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-reader-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'timing.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  const events = [];
  const reader = watchLabTiming({
    path,
    runId: 'fixture-run',
    sourceObservation: 'v1',
    onEvent: (event) => events.push(event),
  });
  try {
    appendFileSync(
      path,
      '{"event":"stt_state","session":18446744073709551615,"state":"started","audio_ms":0,"wall_ms":1,"mono_ms":2}\n' +
        '{"event":"stt_state","session":3,"state":"stopped","code":"cap_reached","audio_ms":300000,"wall_ms":1,"mono_ms":3}\n' +
        '{"event":"stt_state","session":3,"state":"dropping","audio_ms":4,"wall_ms":1,"mono_ms":4}\n' +
        '{"event":"stt_state","session":3,"state":"stopped","code":"lab_ended","audio_ms":5,"wall_ms":1,"mono_ms":5}\n' +
        '{"event":"stt_state","session":4,"state":"stopped","code":"stalled","audio_ms":6,"wall_ms":1,"mono_ms":6}\n',
    );
    reader.poll();
    assert.deepEqual(events, [
      {
        event: 'stt_state',
        state: 'started',
        audio_ms: 0,
        session: '18446744073709551615',
      },
      {
        event: 'stt_state',
        state: 'stopped',
        code: 'cap_reached',
        audio_ms: 300000,
        session: '3',
      },
      { event: 'stt_state', state: 'dropping', audio_ms: 4, session: '3' },
      {
        event: 'stt_state',
        state: 'stopped',
        code: 'lab_ended',
        audio_ms: 5,
        session: '3',
      },
      {
        event: 'stt_state',
        state: 'stopped',
        code: 'stalled',
        audio_ms: 6,
        session: '4',
      },
    ]);
    // A stop without its code, or a provider message, is refused.
    appendFileSync(
      path,
      JSON.stringify({
        event: 'stt_state',
        session: 3,
        state: 'stopped',
        audio_ms: 1,
      }) + '\n',
    );
    reader.poll();
    assert.equal(reader.failed, true);
    assert.deepEqual(events.at(-1), { event: 'dropped', count: 1 });
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the reader keeps the query only on a connected row and refuses one carrying a credential', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-reader-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'timing.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  const events = [];
  const reader = watchLabTiming({
    path,
    runId: 'fixture-run',
    sourceObservation: 'v1',
    onEvent: (event) => events.push(event),
  });
  try {
    appendFileSync(
      path,
      '{"event":"stt_state","session":3,"state":"connected","audio_ms":0,"query":"model=nova-3&mip_opt_out=true","wall_ms":1,"mono_ms":2}\n',
    );
    reader.poll();
    assert.deepEqual(events, [
      {
        event: 'stt_state',
        state: 'connected',
        query: 'model=nova-3&mip_opt_out=true',
        audio_ms: 0,
        session: '3',
      },
    ]);
    appendFileSync(
      path,
      '{"event":"stt_state","session":3,"state":"connected","audio_ms":0,"query":"model=nova-3&token=abc","wall_ms":1,"mono_ms":3}\n',
    );
    reader.poll();
    assert.equal(reader.failed, true);
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a native source problem is passed on with its fixed label and code, then ends the observation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-reader-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'timing.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  const events = [];
  const reader = watchLabTiming({
    path,
    runId: 'fixture-run',
    onEvent: (event) => events.push(event),
  });
  try {
    appendFileSync(
      path,
      JSON.stringify({
        event: 'source_problem',
        problem: 'source_gone',
        os_code: -3815,
        detail: 'fictional detail never passed on',
      }) + '\n',
    );
    reader.poll();
    assert.deepEqual(events, [
      { event: 'source_problem', problem: 'source_gone', os_code: -3815 },
      { event: 'dropped', count: 1 },
    ]);
    assert.equal(reader.failed, true);
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a different application acknowledgement fails the QuickTime-only observer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tq-reader-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'timing.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  const events = [];
  const reader = watchLabTiming({
    path,
    runId: 'fixture-run',
    expectedApplication: 'QuickTime Player',
    onEvent: (event) => events.push(event),
  });
  try {
    appendFileSync(
      path,
      JSON.stringify({
        event: 'dev_source',
        step: 'acknowledged',
        application: 'Other application',
      }) + '\n',
    );
    reader.poll();
    assert.equal(reader.failed, true);
    assert.deepEqual(events, [{ event: 'dropped', count: 1 }]);
  } finally {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const mutation of ['content', 'time', 'identity'])
  test(`a changed preverified fixture ${mutation} refuses the owned spawn`, async () => {
    const f = fixture('normal');
    try {
      const path = join(f.launcher.directory, 'fixture-child.mjs');
      if (mutation === 'content') writeFileSync(path, '// changed fixture');
      else if (mutation === 'time')
        utimesSync(path, new Date(), new Date(Date.now() + 5000));
      else {
        renameSync(path, path + '.old');
        copyFileSync(path + '.old', path);
      }
      await assert.rejects(f.start());
      assert.equal(f.launcher.processStarted, false);
      assert.equal(f.child, undefined);
      await assert.rejects(f.owner.stop());
    } finally {
      await f.close();
    }
  });

// Exercise production preparation and final verification with bounded OS-command
// stand-ins only. No signature command or app executable is run by these tests.
const buildSelection = {
  provider: 'anthropic-api',
  model: 'claude-opus-5-5',
  effort: 'low',
  maxCalls: 2,
};
// A grant stand-in: no key, no network; writes a fictional token once.
const stubGrant = () => ({
  ttlSeconds: 900,
  writeTokenFile(path) {
    writeFileSync(path, 'fictional-offline-token-0123456789', {
      mode: 0o600,
      flag: 'wx',
    });
  },
  discard() {},
});
function fakeBuild() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tq-build-')));
  const bundlePath = join(directory, 'Fixture.app');
  mkdirSync(join(bundlePath, 'Contents', 'MacOS'), { recursive: true });
  const executable = join(bundlePath, 'Contents', 'MacOS', 'talkqte');
  const plist = join(bundlePath, 'Contents', 'Info.plist');
  const resource = join(bundlePath, 'Contents', 'resource.txt');
  writeFileSync(executable, 'offline fixture; must never execute', {
    mode: 0o700,
  });
  writeFileSync(plist, 'original');
  writeFileSync(resource, 'original');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const value = {
    ...record,
    executable,
    bundlePath,
    sha256: hash(readFileSync(executable)),
  };
  const bytes = JSON.stringify(value);
  const manifestFile = join(directory, 'manifest.json');
  writeFileSync(manifestFile, bytes, { mode: 0o600 });
  const descriptor = join(directory, 'descriptor.json');
  writeFileSync(descriptor, '{}', { mode: 0o600 });
  let verifies = 0;
  mock.method(childProcess, 'execFileSync', (command, args) => {
    if (command === '/usr/bin/plutil') {
      assert.equal(args.at(-1), plist);
      return args[1] === 'CFBundleIdentifier'
        ? readFileSync(plist, 'utf8') === 'original'
          ? 'com.talkqte.desktop'
          : 'changed.id'
        : 'talkqte';
    }
    assert.equal(command, '/usr/bin/codesign');
    assert.deepEqual(args, ['--verify', '--strict', '--deep', bundlePath]);
    verifies++;
    assert.equal(
      readFileSync(resource, 'utf8'),
      'original',
      'bundle seal mismatch',
    );
    return '';
  });
  mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, '/usr/bin/codesign');
    assert.deepEqual(args, [
      '--display',
      '--verbose=4',
      '--requirements',
      '-',
      bundlePath,
    ]);
    return {
      status: 0,
      stdout: 'designated => ' + value.signature.designatedRequirement,
      stderr: 'Authority=TalkQTE Development\nIdentifier=com.talkqte.desktop',
    };
  });
  syncBuiltinESMExports();
  const options = {
    manifestFile,
    approved: {
      manifestSha256: hash(bytes),
      executableSha256: value.sha256,
      commit: value.commit,
    },
    // The only model route left: the direct API with cloud transcription.
    selection: buildSelection,
    sourceApplication: 'QuickTime Player',
    stopAfterS: 120,
    environment: {},
    transcription: { backend: 'deepgram', minuteCap: 5, grant: stubGrant() },
  };
  const launchOptions = {
    executable,
    metadata: { ...buildSelection, spendCapMicroUsd: 1_000_000 },
    onTiming() {},
    environment: {
      TALKQTE_DEV_STOP_SIGNAL: 'usr2',
      TALKQTE_DEV_STOP_AFTER_S: '120',
      TALKQTE_DEV_LAB_RUN_ID: 'fixture-run',
      TALKQTE_DEV_CUE_BACKEND: 'lab-api',
      TALKQTE_DEV_LAB_DESCRIPTOR: descriptor,
      TALKQTE_DEV_LAB_PROVIDER: buildSelection.provider,
      TALKQTE_DEV_LAB_MODEL: buildSelection.model,
      TALKQTE_DEV_LAB_EFFORT: buildSelection.effort,
      TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD: '1000000',
    },
  };
  return {
    directory,
    options,
    launchOptions,
    resource,
    plist,
    get verifies() {
      return verifies;
    },
    close() {
      mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('history and selected context are explicit API configuration and never inherited approval', () => {
  const f = fakeBuild();
  try {
    let seen;
    mock.method(childProcess, 'spawn', (_command, _args, options) => {
      seen = options.env;
      return new EventEmitter();
    });
    syncBuiltinESMExports();
    for (const contextPolicy of [
      undefined,
      'fresh-only',
      'bounded-history',
      'selected-prior-v2',
    ]) {
      const prepared = prepareLabLauncher({
        ...f.options,
        contextPolicy,
        environment: {
          TALKQTE_DEV_LAB_CONTEXT: 'bounded-history',
          TALKQTE_DEV_MODEL_CONNECTION: 'on',
        },
      });
      try {
        prepared.launch({
          ...f.launchOptions,
          metadata: {
            ...f.launchOptions.metadata,
            ...(contextPolicy === 'selected-prior-v2'
              ? selectedIdentity()
              : {}),
          },
        });
        assert.equal(
          seen.TALKQTE_DEV_LAB_CONTEXT,
          ['bounded-history', 'selected-prior-v2'].includes(contextPolicy)
            ? contextPolicy
            : undefined,
        );
        assert.equal(
          Object.hasOwn(seen, 'TALKQTE_DEV_MODEL_CONNECTION'),
          false,
        );
        assert.equal(prepared.transcription.reviewedSession, null);
        assert.throws(() => prepared.releaseTranscriptionToken());
      } finally {
        prepared.close();
        rmSync(prepared.directory, { recursive: true, force: true });
      }
    }
    for (const contextPolicy of [
      '',
      null,
      false,
      {},
      'history',
      'BOUNDED-HISTORY',
    ])
      assert.throws(() => prepareLabLauncher({ ...f.options, contextPolicy }));
    assert.throws(() =>
      prepareLabLauncher({
        ...f.options,
        contextPolicy: 'bounded-history',
        mode: 'capture-only',
        selection: undefined,
        transcription: { backend: 'deepgram', minuteCap: 5 },
      }),
    );
    assert.throws(() =>
      prepareLabLauncher({
        ...f.options,
        contextPolicy: 'bounded-history',
        selection,
      }),
    );
    const prepared = prepareLabLauncher(f.options);
    try {
      assert.throws(() =>
        prepared.launch({
          ...f.launchOptions,
          environment: {
            ...f.launchOptions.environment,
            TALKQTE_DEV_LAB_CONTEXT: 'bounded-history',
          },
        }),
      );
      assert.equal(prepared.processStarted, false);
    } finally {
      prepared.close();
      rmSync(prepared.directory, { recursive: true, force: true });
    }
  } finally {
    f.close();
  }
});

for (const changed of ['resource', 'plist'])
  test(`production final check rejects changed bundle ${changed} with unchanged executable`, () => {
    const f = fakeBuild();
    let prepared;
    try {
      prepared = prepareLabLauncher(f.options);
      assert.equal(f.verifies, 1);
      writeFileSync(f[changed], 'changed');
      assert.throws(() => prepared.launch(f.launchOptions));
      assert.equal(prepared.processStarted, false);
      if (changed === 'resource') assert.equal(f.verifies, 2);
    } finally {
      prepared?.close();
      if (prepared)
        rmSync(prepared.directory, { recursive: true, force: true });
      f.close();
    }
  });

test('a subscription-route model launch is refused outright: it has no transcription', () => {
  const f = fakeBuild();
  try {
    for (const selection of [
      {
        provider: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'medium',
        maxCalls: 2,
      },
      {
        provider: 'claude-code',
        model: 'claude-opus-5-5',
        effort: 'medium',
        maxCalls: 2,
      },
    ])
      assert.throws(
        () =>
          prepareLabLauncher({
            ...f.options,
            selection,
            transcription: undefined,
            modelConnection: 'on',
          }),
        {
          category: 'no-transcription',
          message: NO_TRANSCRIPTION_SUBSCRIPTION,
        },
      );
    // The direct API route without cloud transcription has none either.
    assert.throws(
      () => prepareLabLauncher({ ...f.options, transcription: undefined }),
      { category: 'no-transcription', message: NO_TRANSCRIPTION_SELECTED },
    );
    // Refused before the build is even verified.
    assert.equal(f.verifies, 0);
  } finally {
    f.close();
  }
});

test('a Whisper model is refused now that local transcription is gone', () => {
  const f = fakeBuild();
  try {
    assert.throws(() =>
      prepareLabLauncher({
        ...f.options,
        whisperModel: '/fictional/model.bin',
      }),
    );
  } finally {
    f.close();
  }
});

test('changed caller cwd cannot admit repository-local manifest or descriptor via direct or symlink paths', () => {
  const f = fakeBuild();
  const cwd = process.cwd();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const inside = mkdtempSync(join(root, '.launcher-test-'));
  let prepared;
  try {
    const manifest = join(inside, 'manifest.json');
    const descriptor = join(inside, 'descriptor.json');
    copyFileSync(f.options.manifestFile, manifest);
    chmodSync(manifest, 0o600);
    writeFileSync(descriptor, '{}', { mode: 0o600 });
    process.chdir(f.directory);
    assert.throws(() =>
      prepareLabLauncher({ ...f.options, manifestFile: manifest }),
    );
    const alias = join(f.directory, 'inside-alias');
    symlinkSync(inside, alias);
    assert.throws(() =>
      prepareLabLauncher({
        ...f.options,
        manifestFile: join(alias, 'manifest.json'),
      }),
    );
    prepared = prepareLabLauncher(f.options);
    for (const path of [descriptor, join(alias, 'descriptor.json')]) {
      // Each rejected launch consumes its instance, as every launch attempt does.
      const candidate =
        path === descriptor ? prepared : prepareLabLauncher(f.options);
      try {
        assert.throws(() =>
          candidate.launch({
            ...f.launchOptions,
            environment: {
              ...f.launchOptions.environment,
              TALKQTE_DEV_LAB_DESCRIPTOR: path,
            },
          }),
        );
        assert.equal(candidate.processStarted, false);
      } finally {
        candidate.close();
        rmSync(candidate.directory, { recursive: true, force: true });
      }
    }
  } finally {
    process.chdir(cwd);
    rmSync(inside, { recursive: true, force: true });
    f.close();
  }
});

test('temporary output under a two-dot checkout descendant or its alias is refused', () => {
  const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
  const inside = mkdtempSync(join(root, '..runtime-'));
  const external = realpathSync(mkdtempSync(join(tmpdir(), 'tq-alias-')));
  const alias = join(external, 'inside');
  symlinkSync(inside, alias);
  const original = process.env.TMPDIR;
  const cwd = process.cwd();
  try {
    process.chdir(external);
    for (const path of [root, inside, alias]) {
      process.env.TMPDIR = path;
      assert.throws(() =>
        prepareLabFixtureLauncher({ fixtureCase: 'normal', selection }),
      );
    }
  } finally {
    process.chdir(cwd);
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
    rmSync(inside, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('actual harmless capture-only launch receives no provider/model/backend/descriptor environment', async () => {
  const launcher = prepareLabFixtureLauncher({
    fixtureCase: 'capture-only',
    mode: 'capture-only',
    stopAfterS: 110,
  });
  const owner = createLabNativeOwner({
    executable: launcher.executable,
    launch: launcher.launch,
    mode: 'capture-only',
    stopAfterS: 110,
    armingMs: 1000,
    releaseMs: 1000,
  });
  try {
    assert.equal(launcher.timingFileIdentity, null);
    await owner.start({ runId: 'capture-only-fixture' });
    const timingStat = statSync(launcher.timingPath, { bigint: true });
    assert.deepEqual(launcher.timingFileIdentity, {
      dev: timingStat.dev.toString(),
      ino: timingStat.ino.toString(),
      runId: 'capture-only-fixture',
    });
    assert.ok(Object.isFrozen(launcher.timingFileIdentity));
    assert.equal(launcher.mode, 'capture-only');
    assert.deepEqual(await owner.stop(), { released: true });
  } finally {
    launcher.close();
    for (let i = 0; i < 100 && !launcher.processEnded; i++) await delay(10);
    rmSync(launcher.directory, { recursive: true, force: true });
  }
});

// Shared offline stack: real broker, real owned launcher and harmless child.
function offlineRun(fixtureCase, startupMs = 4000) {
  const launcher = prepareLabFixtureLauncher({ fixtureCase, selection });
  const native = createLabNativeOwner({
    executable: launcher.executable,
    launch: launcher.launch,
    stopAfterS: 120,
    armingMs: 1200,
    releaseMs: 600,
  });
  let calls = 0;
  const run = createLabRun({
    native,
    sourceSessionMode: 'legacy-fixture',
    settings: {
      ...selection,
      deadlineMs: 30000,
      execution: 'offline-stand-in',
      environment: {},
      openers: {
        codex: async () => ({
          request: async () => {
            calls++;
            return { value: {} };
          },
          close: async () => {},
        }),
      },
    },
    startupMs,
    releaseMs: 1800,
  });
  return {
    launcher,
    run,
    get calls() {
      return calls;
    },
    async close() {
      await run.close().catch(() => {});
      launcher.close();
      for (let n = 0; n < 200 && !launcher.processEnded; n++) await delay(10);
      rmSync(launcher.directory, { recursive: true, force: true });
    },
  };
}

test('under a symlinked temporary root the launched peer accepts the broker descriptor and calibrates', async () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'tq-root-')));
  const holder = realpathSync(mkdtempSync(join(tmpdir(), 'tq-alias-')));
  const alias = join(holder, 'root');
  symlinkSync(real, alias);
  const original = process.env.TMPDIR;
  let f;
  try {
    process.env.TMPDIR = alias;
    assert.notEqual(tmpdir(), realpathSync(tmpdir()));
    f = offlineRun('descriptor-peer');
    f.run.acknowledgePlaybackStart({
      monotonicMs: performance.now(),
      uncertaintyMs: 0,
    });
    // The child exits before HELLO unless the socket in the descriptor is a
    // lexical sibling of the canonical descriptor path the launcher passes.
    await f.run.ready;
    assert.equal(f.launcher.directory.startsWith(real + '/'), true);
    assert.deepEqual(JSON.parse(JSON.stringify(f.run.startupDiagnostics)), {
      stage: 'ready',
      failure: null,
      broker: {
        connectionAccepted: true,
        helloAuthenticated: true,
        clockProbeSent: true,
        clockSampleReceived: true,
        calibrated: true,
        cause: null,
        terminal: null,
      },
    });
    await f.run.stop();
    assert.equal(f.run.phase, 'closed');
    assert.equal(f.launcher.sourceReleased, true);
    assert.equal(f.run.startupDiagnostics.failure, null);
    assert.equal(f.calls, 0);
    assert.equal(f.run.dispatchesUsed, 0);
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
    await f?.close();
    rmSync(holder, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('a launched peer that never connects is reported at the HELLO stage with its first native cause', async () => {
  const f = offlineRun('normal');
  try {
    await assert.rejects(f.run.ready);
    const diagnostics = f.run.startupDiagnostics;
    assert.deepEqual(diagnostics.failure, {
      stage: 'awaiting-hello',
      reason: 'process-ended',
    });
    assert.equal(diagnostics.broker.connectionAccepted, false);
    assert.equal(diagnostics.broker.helloAuthenticated, false);
    assert.equal(diagnostics.broker.cause, null);
    // Teardown records later reasons elsewhere; the first cause is retained.
    await f.run.close().catch(() => {});
    assert.deepEqual(f.run.startupDiagnostics.failure, diagnostics.failure);
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});

test('a startup deadline before any peer connection is retained as the first cause', async () => {
  const f = offlineRun('descriptor-peer', 50);
  try {
    await assert.rejects(f.run.ready);
    assert.equal(f.run.startupDiagnostics.failure.reason, 'deadline');
    assert.notEqual(f.run.startupDiagnostics.failure.stage, 'ready');
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});

test('the direct API route launches with lab-api and its spend cap, and without a model-connection approval', async () => {
  const apiSelection = {
    provider: 'anthropic-api',
    model: 'claude-opus-5-5',
    effort: 'low',
    maxCalls: 2,
  };
  // A model-connection approval is refused for the API route.
  assert.throws(() =>
    prepareLabLauncher({
      ...{
        selection: apiSelection,
        mode: 'model-enabled',
        modelConnection: 'on',
      },
    }),
  );
  const launcher = prepareLabFixtureLauncher({
    fixtureCase: 'normal',
    selection: apiSelection,
  });
  const original = childProcess.spawn;
  let seen;
  mock.method(childProcess, 'spawn', (command, args, options) => {
    seen = options.env;
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  const descriptor = join(launcher.directory, 'descriptor.json');
  writeFileSync(descriptor, '{}', { mode: 0o600 });
  const owner = createLabNativeOwner({
    executable: launcher.executable,
    launch: launcher.launch,
    stopAfterS: 120,
    armingMs: 1200,
    releaseMs: 300,
  });
  try {
    await owner.start({
      descriptorPath: descriptor,
      runId: 'fixture-run',
      metadata: { ...apiSelection, spendCapMicroUsd: 1_000_000 },
    });
    assert.equal(seen.TALKQTE_DEV_CUE_BACKEND, 'lab-api');
    assert.equal(seen.TALKQTE_DEV_LAB_PROVIDER, 'anthropic-api');
    assert.equal(seen.TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD, '1000000');
    assert.equal(Object.hasOwn(seen, 'TALKQTE_DEV_MODEL_CONNECTION'), false);
    assert.equal(
      Object.keys(seen).some((k) => /KEY|TOKEN|ANTHROPIC/.test(k)),
      false,
    );
    assert.deepEqual(await owner.stop(), { released: true });
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    launcher.close();
    rmSync(launcher.directory, { recursive: true, force: true });
  }
});

test('a source that native loses is recorded as ended by native, with its fixed label and code', async () => {
  const f = fixture('source-gone');
  try {
    await f.start();
    for (let n = 0; n < 100 && !f.launcher.nativeEnded; n++) await delay(10);
    assert.deepEqual(
      { ...f.launcher.nativeEnded },
      { problem: 'source_gone', osCode: -3815 },
    );
    // The lab's own Stop never released it.
    assert.equal(f.launcher.sourceReleased, false);
    for (let n = 0; n < 100 && !f.events.includes('failed'); n++)
      await delay(10);
    assert.ok(f.events.includes('failed'));
  } finally {
    await f.close();
  }
});

// Production launcher routing + real SourceV1, owner, run and broker; native
// rows and the UI review are synthetic. No app, media, device or provider.
test('bounded-history production routing connects reviewed source to broker HELLO and clean Stop', async () => {
  const f = fakeBuild();
  const runId = 'fictional-history-startup';
  const trace = [];
  let launcher, run, socket, descriptorPath;
  let opened = false;
  try {
    const child = new EventEmitter();
    Object.assign(child, {
      pid: 42,
      spawnfile: f.launchOptions.executable,
      exitCode: null,
      signalCode: null,
    });
    const emit = (row) =>
      appendFileSync(launcher.timingPath, JSON.stringify(row) + '\n');
    child.kill = (signal) => {
      assert.equal(signal, 'SIGUSR2');
      trace.push('stop');
      for (const step of ['latched', 'stopping', 'released'])
        emit({ event: 'dev_stop', run_id: runId, step });
      return true;
    };
    mock.method(childProcess, 'spawn', (_command, _args, options) => {
      assert.equal(options.env.TALKQTE_DEV_LAB_CONTEXT, 'bounded-history');
      assert.equal(
        Object.hasOwn(options.env, 'TALKQTE_DEV_MODEL_CONNECTION'),
        false,
      );
      descriptorPath = options.env.TALKQTE_DEV_LAB_DESCRIPTOR;
      queueMicrotask(() => {
        emit({ event: 'dev_stop', run_id: runId, step: 'armed' });
        emit({
          event: 'dev_source',
          application: 'QuickTime Player',
          step: 'acknowledged',
        });
        emit({
          event: 'session',
          live: true,
          state: 'started',
          session: 1,
          commit: record.commit,
          features: record.features,
        });
        emit({ event: 'user_name_set', session: 1, set: true });
        emit({
          event: 'dev_source_observation',
          version: 1,
          run_id: runId,
          application: 'QuickTime Player',
          step: 'listening',
          session: '1',
          host_operation: 'a'.repeat(32),
          live_operation: 'b'.repeat(64),
        });
        emit({
          event: 'dev_source',
          application: 'QuickTime Player',
          step: 'started',
        });
      });
      return child;
    });
    syncBuiltinESMExports();
    launcher = prepareLabLauncher({
      ...f.options,
      contextPolicy: 'bounded-history',
      userName: 'Adrian',
    });
    const source = createLabSourceV1({
      launcher,
      application: 'QuickTime Player',
      commit: record.commit,
      features: record.features,
      deadlineMs: 2000,
    });
    const native = createLabNativeOwner({
      executable: launcher.executable,
      launch: launcher.launch,
      stopAfterS: 120,
      armingMs: 2000,
      releaseMs: 2000,
    });
    let reviewed;
    const review = new Promise((yes) => {
      reviewed = yes;
    });
    launcher.subscribeEvaluator((row) => {
      if (row.approval === 'review' && row.state === 'on') reviewed(row);
    });
    run = createLabRun({
      native,
      runId,
      approvalBudgetMs: 180000,
      startupMs: 3000,
      releaseMs: 2000,
      settings: {
        ...buildSelection,
        deadlineMs: 30000,
        execution: 'offline-stand-in',
        environment: {},
        openers: {
          'anthropic-api': async () => {
            opened = true;
            trace.push('provider');
            return {
              request() {
                throw Error('No provider dispatch expected');
              },
              async close() {},
            };
          },
        },
      },
    });
    const launchDeadline = performance.now() + 2000;
    while (run.startupDiagnostics.stage !== 'awaiting-approval') {
      assert.ok(performance.now() < launchDeadline);
      await delay(1);
    }
    const listening = await source.waitListening({ runId });
    assert.equal(listening.sessionId, '1');
    run.expectSourceSession(listening.sessionId);
    assert.equal(opened, false);
    assert.equal(launcher.transcription.reviewedSession, null);
    assert.throws(() => launcher.releaseTranscriptionToken());
    // The app's own expanded-history review/grant is tested natively; this
    // synthetic row exercises the actual launcher/reader routing afterward.
    emit({
      event: 'evaluator',
      approval: 'review',
      session: 1,
      state: 'on',
      backend: 'lab-api',
      model: 'claude-opus-5-5',
      effort: 'low',
    });
    assert.equal((await review).session, '1');
    trace.push('review');
    await run.approve();
    launcher.releaseTranscriptionToken();
    assert.equal(launcher.transcription.released, true);
    const d = JSON.parse(readFileSync(descriptorPath));
    socket = createConnection({ path: d.socketPath });
    socket.on('error', () => {});
    await once(socket, 'connect');
    const frame = (type, rest = {}) => ({
      schema: 'talkqte.lab.v1',
      type,
      runId,
      sessionId: '1',
      ...rest,
    });
    let partial = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      partial += chunk;
      for (let end; (end = partial.indexOf('\n')) !== -1;) {
        const value = JSON.parse(partial.slice(0, end));
        partial = partial.slice(end + 1);
        if (value.type === 'clock_probe') {
          trace.push('clock');
          socket.write(
            JSON.stringify(
              frame('clock_sample', {
                probeId: value.probeId,
                nativeSessionElapsedMs: 10,
              }),
            ) + '\n',
          );
        }
      }
    });
    run.acknowledgePlaybackStart({
      monotonicMs: performance.now(),
      uncertaintyMs: 0,
    });
    trace.push('hello');
    socket.write(
      JSON.stringify(
        frame('hello', {
          nonce: d.nonce,
          expectedProvider: 'anthropic-api',
          expectedModel: 'claude-opus-5-5',
          expectedEffort: 'low',
        }),
      ) + '\n',
    );
    await run.ready;
    trace.push('ready');
    assert.equal(run.dispatchesUsed, 0);
    assert.equal(launcher.userName.held, true);
    await run.close();
    assert.equal(launcher.sourceReleased, true);
    assert.deepEqual(trace, [
      'review',
      'provider',
      'hello',
      'clock',
      'ready',
      'stop',
    ]);
    source.close();
  } finally {
    socket?.destroy();
    await run?.close().catch(() => {});
    launcher?.close();
    if (launcher) rmSync(launcher.directory, { recursive: true, force: true });
    f.close();
  }
});

test('a prepared turn-off is one owned SIGUSR1 whose done row the owner needs; later signals are recorded no-ops', async () => {
  const f = fixture('turn-off', { turnOff: true });
  try {
    assert.equal(f.launcher.turnOff.step, null);
    await f.start();
    assert.equal(f.lastLaunch.environment.TALKQTE_DEV_OFF_SIGNAL, 'usr1');
    assert.deepEqual(await f.owner.turnOff(), { turnedOff: true });
    assert.deepEqual(f.launcher.turnOff, { step: 'done', repeats: 0 });
    // Once only: a second request sends nothing.
    await assert.rejects(f.owner.turnOff(), { category: 'protocol' });
    // A signal from outside the owner changes nothing and is still recorded.
    process.kill(f.child.pid, 'SIGUSR1');
    for (let n = 0; n < 100 && f.owner.offState.repeats === 0; n++)
      await delay(10);
    assert.deepEqual(f.owner.offState, {
      sent: true,
      outcome: 'done',
      repeats: 1,
    });
    assert.deepEqual(f.launcher.turnOff, { step: 'done', repeats: 1 });
    assert.deepEqual(await f.owner.stop(), { released: true });
    assert.equal(f.launcher.sourceReleased, true);
    assert.ok(!f.events.includes('failed'));
  } finally {
    await f.close();
  }
});

test('a turn-off native refuses rejects but leaves the ordinary Stop working', async () => {
  const f = fixture('turn-off-failed', { turnOff: true });
  try {
    await f.start();
    await assert.rejects(f.owner.turnOff(), { category: 'protocol' });
    assert.equal(f.owner.offState.outcome, 'failed');
    assert.deepEqual(f.launcher.turnOff, { step: 'failed', repeats: 0 });
    assert.deepEqual(await f.owner.stop(), { released: true });
  } finally {
    await f.close();
  }
});

test('no turn-off is sent once Stop was asked for, and none without the prepared setting', async () => {
  const f = fixture('turn-off', { turnOff: true });
  try {
    await f.start();
    const released = f.owner.stop();
    await assert.rejects(f.owner.turnOff(), { category: 'protocol' });
    assert.deepEqual(await released, { released: true });
    assert.equal(f.owner.offState.sent, false);
  } finally {
    await f.close();
  }
  const plain = fixture('normal');
  try {
    await plain.start();
    assert.equal(
      plain.lastLaunch.environment.TALKQTE_DEV_OFF_SIGNAL,
      undefined,
    );
    assert.equal(plain.launcher.turnOff, null);
    assert.equal(plain.owner.offState, null);
    await assert.rejects(plain.owner.turnOff(), { category: 'protocol' });
    assert.deepEqual(await plain.owner.stop(), { released: true });
  } finally {
    await plain.close();
  }
});

test('a turn-off row nobody asked for, or a setting the launch was not prepared for, stops the run', async () => {
  const unasked = fixture('turn-off-unasked', { turnOff: true });
  try {
    await unasked.start().catch(() => {});
    for (let n = 0; n < 200 && !unasked.events.includes('failed'); n++)
      await delay(10);
    assert.ok(unasked.events.includes('failed'));
    await assert.rejects(unasked.owner.stop());
  } finally {
    await unasked.close();
  }
  // Owner and launcher must agree in both directions.
  for (const [turnOff, ownerTurnOff] of [
    [true, false],
    [false, true],
  ]) {
    const f = fixture('turn-off', { turnOff, ownerTurnOff });
    try {
      await assert.rejects(f.start());
      assert.equal(f.child, undefined);
    } finally {
      await f.close();
    }
  }
  for (const options of [
    { turnOff: 'yes' },
    { turnOff: false },
    { turnOff: true, mode: 'capture-only', selection: undefined },
  ])
    assert.throws(() =>
      prepareLabFixtureLauncher({
        fixtureCase: 'turn-off',
        selection,
        ...options,
      }),
    );
});

// A terminal's Ctrl-C goes to its whole foreground process group. Here a
// real Node process leads its own group, launches the harmless native
// fixture child through the launcher and owner, and then the whole group
// gets SIGINT, as from a terminal. Its handler asks the ordinary Stop.
async function groupSigint(ownProcessGroup) {
  const url = (name) => new URL(`./${name}`, import.meta.url).href;
  const script = `
    import { prepareLabFixtureLauncher } from ${JSON.stringify(url('cue-lab-launcher.mjs'))};
    import { createLabNativeOwner } from ${JSON.stringify(url('cue-lab-native-owner.mjs'))};
    import { rmSync } from 'node:fs';
    const launcher = prepareLabFixtureLauncher({
      fixtureCase: 'normal',
      mode: 'capture-only',
      ${ownProcessGroup ? 'ownProcessGroup: true,' : ''}
    });
    const owner = createLabNativeOwner({
      executable: launcher.executable,
      launch: launcher.launch,
      stopAfterS: 120,
      mode: 'capture-only',
      armingMs: 1000,
      releaseMs: 1000,
    });
    process.on('SIGINT', async () => {
      const released = await owner.stop().then((r) => r.released === true, () => false);
      launcher.close();
      rmSync(launcher.directory, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ released, sourceReleased: launcher.sourceReleased }) + '\\n');
      process.exit(0);
    });
    await owner.start({ runId: 'fictional-group-run' });
    process.stdout.write('ready\\n');
  `;
  const child = childProcess.spawn(
    process.execPath,
    ['--input-type=module', '-e', script],
    { detached: true, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
    if (out.startsWith('ready\n') && !child.signalled) {
      child.signalled = true;
      process.kill(-child.pid, 'SIGINT');
    }
  });
  await once(child, 'close');
  return JSON.parse(out.split('\n')[1]);
}

test('a terminal Ctrl-C to the runner group reaches only the runner when the app has its own process group', async () => {
  // As the take runner launches it: the app survives the group's SIGINT
  // and is released by the ordinary Stop.
  assert.deepEqual(await groupSigint(true), {
    released: true,
    sourceReleased: true,
  });
  // As before, in the caller's group: the app is ended by the same
  // SIGINT and release can never be shown.
  assert.deepEqual(await groupSigint(false), {
    released: false,
    sourceReleased: false,
  });
});
