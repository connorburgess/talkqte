import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  linkSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  ARCHIVE,
  ARCHIVE_ARGS,
  RECEIPT,
  FEATURES,
  BUILD_ARGS,
  MAX_BYTES,
  commit,
  validateReceipt,
  inventory,
  regularPath,
  sha256,
  verifyArtifacts,
  buildEnvironment,
  verifySource,
} from './lab-build-artifact.mjs';
const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
function receipt() {
  return {
    schema: 'talkqte.lab.ci-build.v1',
    commit: SHA,
    features: [...FEATURES],
    debug: true,
    target: 'aarch64-apple-darwin',
    signing: 'not-performed',
    bundle: {
      name: 'TalkQTE.app',
      identifier: 'com.talkqte.desktop',
      minimumSystemVersion: '14.0',
      bytes: 12,
      files: 1,
      sha256: HASH,
      executableSha256: HASH,
    },
    archive: { name: ARCHIVE, bytes: 12, sha256: HASH },
    lockfiles: { 'Cargo.lock': HASH, 'package-lock.json': HASH },
  };
}
function temp(t) {
  const path = mkdtempSync(join(tmpdir(), 'talkqte-artifact-test-'));
  // macOS /var aliases /private/var; contracts intentionally use canonical paths.
  const canonical = realpathSync(path);
  t.after(() => rmSync(canonical, { recursive: true, force: true }));
  return canonical;
}
import { realpathSync } from 'node:fs';

test('dispatch requires a full immutable commit, not refs or shell expressions', () => {
  assert.equal(commit(SHA), SHA);
  for (const value of [
    undefined,
    '',
    'main',
    'refs/heads/main',
    'HEAD',
    'a'.repeat(7),
    'A'.repeat(40),
    '0'.repeat(40),
    `${SHA}\n`,
    `${SHA};true`,
    `$(echo ${SHA})`,
  ])
    assert.throws(() => commit(value));
});

test('fixed build uses only the four features, locked dependencies and explicit no-sign', () => {
  assert.deepEqual(FEATURES, [
    'lab-evaluator',
    'local-whisper',
    'native-audio-spike',
    'timing-log',
  ]);
  assert.equal(
    BUILD_ARGS[BUILD_ARGS.indexOf('--features') + 1],
    FEATURES.join(','),
  );
  for (const flag of [
    '--debug',
    '--ci',
    '--no-sign',
    '--locked',
    '--no-default-features',
  ])
    assert.ok(BUILD_ARGS.includes(flag));
  assert.ok(!BUILD_ARGS.includes('--all-features'));
  const env = buildEnvironment({ PATH: '/usr/bin' }, SHA, '/temporary/target');
  assert.equal(env.TALKQTE_COMMIT, SHA);
  assert.equal(env.MACOSX_DEPLOYMENT_TARGET, '14.0');
  for (const key of [
    'APPLE_SIGNING_IDENTITY',
    'APPLE_ID',
    'CSC_LINK',
    'TAURI_CONFIG',
    'TAURI_SIGNING_PRIVATE_KEY',
    'RUSTFLAGS',
    'CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS',
    'CARGO_TARGET_DIR',
    'TALKQTE_DEV_MODEL_CONNECTION',
  ])
    assert.throws(
      () => buildEnvironment({ [key]: 'unexpected' }, SHA, '/temporary/target'),
      /unsupported build environment/,
    );
});

test('receipt refuses wrong commit/features, signing claims, path escape and excessive sizes', () => {
  assert.equal(validateReceipt(receipt(), SHA).commit, SHA);
  const changes = [
    (r) => (r.commit = 'c'.repeat(40)),
    (r) => r.features.push('claude-cli'),
    (r) => r.features.pop(),
    (r) => r.features.reverse(),
    (r) => (r.debug = false),
    (r) => (r.signing = 'approved'),
    (r) => (r.target = 'x86_64-apple-darwin'),
    (r) => (r.archive.name = '../archive.zip'),
    (r) => (r.archive.bytes = MAX_BYTES + 1),
    (r) => (r.archive.bytes = -1),
    (r) => (r.archive.sha256 = 'not-a-hash'),
    (r) => (r.bundle.minimumSystemVersion = '15.0'),
    (r) => (r.bundle.files = 4097),
    (r) => (r.lockfiles['Cargo.lock'] = ''),
    (r) => (r.approved = true),
  ];
  for (const change of changes) {
    const r = receipt();
    change(r);
    assert.throws(() => validateReceipt(r, SHA));
  }
});

test('bundle inventory hashes bytes and modes, rejects symlinks, hardlinks and special paths', async (t) => {
  const root = temp(t);
  mkdirSync(join(root, 'Contents'));
  writeFileSync(join(root, 'Contents', 'fixture'), 'fictional build fixture');
  const first = await inventory(root);
  assert.equal(first.files, 1);
  assert.equal(first.bytes, 23);
  assert.deepEqual(await inventory(root), first);
  writeFileSync(join(root, 'Contents', 'fixture'), 'changed');
  assert.notEqual((await inventory(root)).sha256, first.sha256);
  for (const path of [
    '../escape',
    '/absolute',
    'Contents/../fixture',
    'Contents//fixture',
  ])
    assert.throws(() => regularPath(root, path));
  symlinkSync('fixture', join(root, 'Contents', 'alias'));
  await assert.rejects(inventory(root), /symlink/);
  rmSync(join(root, 'Contents', 'alias'));
  linkSync(
    join(root, 'Contents', 'fixture'),
    join(root, 'Contents', 'hardlink'),
  );
  await assert.rejects(inventory(root), /ordinary/);
});

test('artifact verification binds receipt and exact ordinary archive, and detects changes', async (t) => {
  const root = temp(t);
  const archive = join(root, ARCHIVE);
  writeFileSync(archive, 'fictional archive fixture');
  const r = receipt();
  r.archive.bytes = 25;
  r.archive.sha256 = await sha256(archive);
  writeFileSync(join(root, RECEIPT), JSON.stringify(r));
  assert.equal((await verifyArtifacts(root, SHA)).commit, SHA);
  const cli = spawnSync(
    process.execPath,
    [
      join(dirname(fileURLToPath(import.meta.url)), 'lab-build-artifact.mjs'),
      'verify',
      SHA,
    ],
    { env: { ...process.env, LAB_ARTIFACT_DIRECTORY: root }, encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  writeFileSync(archive, 'tampered archive fixture!');
  await assert.rejects(verifyArtifacts(root, SHA), /hash\/size/);
});

test('artifact verification refuses extra files, oversized receipt and path aliases', async (t) => {
  const root = temp(t);
  writeFileSync(join(root, ARCHIVE), 'fixture');
  const r = receipt();
  r.archive.bytes = 7;
  r.archive.sha256 = await sha256(join(root, ARCHIVE));
  writeFileSync(join(root, RECEIPT), JSON.stringify(r));
  writeFileSync(join(root, 'unexpected'), 'not uploadable');
  await assert.rejects(verifyArtifacts(root, SHA), /unexpected artifact/);
  rmSync(join(root, 'unexpected'));
  writeFileSync(join(root, RECEIPT), ' '.repeat(16385));
  await assert.rejects(verifyArtifacts(root, SHA), /oversize/);
  const alias = join(root, 'alias');
  symlinkSync(root, alias);
  await assert.rejects(verifyArtifacts(alias, SHA), /aliased/);
});

test('source must be clean, exact and reachable from main before building', (t) => {
  const root = temp(t);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fictional Maintainer');
  git('config', 'user.email', 'maintainer@example.invalid');
  writeFileSync(join(root, 'fixture'), 'fictional source');
  git('add', '.');
  git('commit', '-qm', 'test: fictional source');
  const main = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', main);
  verifySource(root, main);
  assert.throws(() => verifySource(root, SHA), /does not match/);
  writeFileSync(join(root, 'fixture'), 'dirty source');
  assert.throws(() => verifySource(root, main), /dirty/);
  git('add', '.');
  git('commit', '-qm', 'test: unmerged source');
  assert.throws(() => verifySource(root, git('rev-parse', 'HEAD')));
});

test('bundle size and depth limits fail before archive creation', async (t) => {
  const root = temp(t);
  const huge = join(root, 'sparse-fixture');
  writeFileSync(huge, '');
  truncateSync(huge, MAX_BYTES + 1);
  await assert.rejects(inventory(root), /bounds/);
  rmSync(huge);
  mkdirSync(join(root, ...Array(33).fill('nested')), { recursive: true });
  await assert.rejects(inventory(root), /nesting/);
});

test('workflow stays manual-only and uploads only the bounded archive/receipt', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/lab-build-artifact.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|push:|schedule:|secrets\./);
  assert.match(workflow, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  const upload = workflow.slice(workflow.indexOf('      - name: Upload'));
  assert.match(upload, /TalkQTE-lab-arm64\.zip/);
  assert.match(upload, /build-receipt\.json/);
  assert.doesNotMatch(upload, /path:.*\*|release|publish/);
});

test(
  'macOS packaging contains only the fictional bundle, not resource sidecars',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const root = temp(t);
    const bundle = join(root, 'TalkQTE.app');
    mkdirSync(join(bundle, 'Contents'), { recursive: true });
    writeFileSync(
      join(bundle, 'Contents', 'fixture.txt'),
      'fictional packaging fixture',
    );
    const zip = join(root, 'fixture.zip');
    execFileSync('/usr/bin/ditto', [...ARCHIVE_ARGS, bundle, zip]);
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', zip], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    assert.ok(entries.includes('TalkQTE.app/Contents/fixture.txt'));
    assert.ok(entries.every((path) => path.startsWith('TalkQTE.app/')));
    assert.ok(!entries.some((path) => path.includes('__MACOSX')));
  },
);

test('trusted workflow rejects non-main source before any selected-source execution', (t) => {
  const workflow = readFileSync(
    new URL('../.github/workflows/lab-build-artifact.yml', import.meta.url),
    'utf8',
  );
  const marker =
    '      - name: Verify trusted source ancestry before source execution\n        run: |\n';
  const start = workflow.indexOf(marker);
  assert.ok(start > workflow.indexOf('ref: ${{ inputs.source_commit }}'));
  const end = workflow.indexOf('      - run: npm ci', start);
  assert.ok(end > start);
  const shell = workflow
    .slice(start + marker.length, end)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(10))
    .join('\n');
  assert.match(shell, /git merge-base --is-ancestor/);
  assert.ok(end < workflow.indexOf('node --test'));
  const root = temp(t);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fictional Maintainer');
  git('config', 'user.email', 'maintainer@example.invalid');
  writeFileSync(join(root, 'fixture'), 'fictional trusted source');
  git('add', '.');
  git('commit', '-qm', 'test: trusted source');
  const main = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', main);
  const execute = (sha) =>
    spawnSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-eo',
        'pipefail',
        '-c',
        `${shell}\nprintf reached > selected-source-executed`,
      ],
      {
        cwd: root,
        env: { ...process.env, SOURCE_COMMIT: sha },
        encoding: 'utf8',
      },
    );
  assert.equal(execute(main).status, 0);
  assert.ok(existsSync(join(root, 'selected-source-executed')));
  rmSync(join(root, 'selected-source-executed'));
  writeFileSync(join(root, 'fixture'), 'fictional non-main source');
  git('add', '.');
  git('commit', '-qm', 'test: unmerged source');
  assert.notEqual(execute(git('rev-parse', 'HEAD')).status, 0);
  assert.ok(!existsSync(join(root, 'selected-source-executed')));
  assert.notEqual(
    execute(main).status,
    0,
    'wrong checked-out HEAD must also fail',
  );
  assert.ok(!existsSync(join(root, 'selected-source-executed')));
});
