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
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';
import { createLabRun } from './cue-lab-run.mjs';
import {
  prepareLabFixtureLauncher,
  prepareLabLauncher,
  validateLabBuildRecord,
} from './cue-lab-launcher.mjs';
const selection = {
  provider: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'medium',
  maxCalls: 2,
};
function fixture(mode) {
  const launcher = prepareLabFixtureLauncher({ fixtureCase: mode, selection });
  const descriptor = join(launcher.directory, 'descriptor.json');
  writeFileSync(descriptor, '{}', { mode: 0o600 });
  let child, lastLaunch;
  const owner = createLabNativeOwner({
    executable: launcher.executable,
    stopAfterS: 120,
    armingMs: 1200,
    releaseMs: 300,
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
      deadlineMs: 100,
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
  features: ['lab-evaluator', 'native-audio-spike', 'timing-log'],
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
    assert.deepEqual(events, [{ event: 'session', state: 'started' }]);
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
    selection,
    sourceApplication: 'QuickTime Player',
    stopAfterS: 120,
    modelConnection: 'on',
    environment: {},
  };
  const launchOptions = {
    executable,
    metadata: selection,
    onTiming() {},
    environment: {
      TALKQTE_DEV_STOP_SIGNAL: 'usr2',
      TALKQTE_DEV_STOP_AFTER_S: '120',
      TALKQTE_DEV_LAB_RUN_ID: 'fixture-run',
      TALKQTE_DEV_CUE_BACKEND: 'lab-subscription',
      TALKQTE_DEV_LAB_DESCRIPTOR: descriptor,
      TALKQTE_DEV_LAB_PROVIDER: selection.provider,
      TALKQTE_DEV_LAB_MODEL: selection.model,
      TALKQTE_DEV_LAB_EFFORT: selection.effort,
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

test('changed caller cwd cannot admit a repository-local manifest or descriptor via direct or symlink paths', () => {
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
