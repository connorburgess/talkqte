import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildEnvironment,
  builtSince,
  bundlePath,
  pathRemaps,
  requestedDevelopmentFeatures,
} from './release-build.mjs';

// Fictional folders; nothing is built here.
const folders = {
  home: '/Users/fictional-builder',
  cargoHome: '/Users/fictional-builder/.cargo',
  repository: '/Users/fictional-builder/work/orchard',
  targetDir: '/Users/fictional-builder/work/orchard/src-tauri/target',
};

test('every build folder is remapped, most specific last', () => {
  assert.deepEqual(pathRemaps(folders), [
    ['/Users/fictional-builder', '/build/home'],
    ['/Users/fictional-builder/.cargo', '/build/cargo'],
    ['/Users/fictional-builder/work/orchard', '/build/talkqte'],
    ['/Users/fictional-builder/work/orchard/src-tauri/target', '/build/target'],
  ]);
  // A folder given twice, or not known, is mapped once or not at all.
  assert.deepEqual(
    pathRemaps({ ...folders, cargoHome: undefined, targetDir: folders.home }),
    [
      ['/Users/fictional-builder', '/build/home'],
      ['/Users/fictional-builder/work/orchard', '/build/talkqte'],
    ],
  );
});

test("compiler flags are added to the caller's own, not substituted", () => {
  const env = buildEnvironment(
    { RUSTFLAGS: '-C target-cpu=native', PATH: '/usr/bin' },
    [['/Users/fictional-builder', '/build/home']],
  );
  assert.equal(
    env.RUSTFLAGS,
    '-C target-cpu=native --remap-path-prefix=/Users/fictional-builder=/build/home',
  );
  assert.equal(
    env.CFLAGS,
    '-ffile-prefix-map=/Users/fictional-builder=/build/home',
  );
  assert.equal(env.CXXFLAGS, env.CFLAGS);
  assert.equal(env.PATH, '/usr/bin');
});

test('the bundle is looked for where the given build arguments put it', () => {
  const base = { targetDir: '/t', productName: 'Orchard' };
  assert.equal(
    bundlePath({ ...base, args: ['--bundles', 'app'] }),
    '/t/release/bundle/macos/Orchard.app',
  );
  assert.equal(
    bundlePath({ ...base, args: ['--debug'] }),
    '/t/debug/bundle/macos/Orchard.app',
  );
  assert.equal(
    bundlePath({ ...base, args: ['--target', 'universal-apple-darwin'] }),
    '/t/universal-apple-darwin/release/bundle/macos/Orchard.app',
  );
  assert.equal(
    bundlePath({ ...base, args: ['--target=aarch64-apple-darwin', '-d'] }),
    '/t/aarch64-apple-darwin/debug/bundle/macos/Orchard.app',
  );
});

test('a folder with a space stops the build with its role, not its path', () => {
  assert.throws(
    () => pathRemaps({ ...folders, home: '/Users/fictional builder' }),
    (error) =>
      /cannot remap a folder whose path contains a space: home folder/.test(
        error.message,
      ) && !error.message.includes('fictional builder'),
  );
});

test("a bundle counts as this build's only when all of it is new", () => {
  const started = 1_000_000;
  assert.equal(builtSince(started, started + 4_000, started + 5_000), true);
  assert.equal(builtSince(started, started - 60_000, started - 5), false);
  // A fresh Info.plist around an executable left from an earlier build.
  assert.equal(
    builtSince(started, started + 4_000, started - 86_400_000),
    false,
  );
  assert.equal(builtSince(started), false);
});

test('every way of asking for the development feature is refused', () => {
  const refused = (args, env = {}, files = {}) =>
    requestedDevelopmentFeatures(args, env, (path) => files[path]);
  const feature = 'native-audio-spike';
  for (const args of [
    ['--features', feature],
    ['--features', 'local-whisper', feature],
    ['--features', `local-whisper,${feature}`],
    [`--features=${feature}`],
    ['-f', feature],
    ['--bundles', 'app', '--', '--features', feature],
    ['--', '-F', feature],
    ['--config', `{"build":{"features":["${feature}"]}}`],
    [`-c={"build":{"features":["${feature}"]}}`],
  ])
    assert.deepEqual(
      refused(args).length > 0,
      true,
      `${JSON.stringify(args)} is refused`,
    );
  assert.deepEqual(refused(['--', '--all-features']), [
    '--all-features turns on every feature',
  ]);
  assert.deepEqual(
    refused(
      ['--config', 'orchard.json'],
      {},
      {
        'orchard.json': `{"build":{"features":["${feature}"]}}`,
      },
    ),
    [`the --config file orchard.json names ${feature}`],
  );
  assert.deepEqual(
    refused([], { TAURI_CONFIG: `{"build":{"features":["${feature}"]}}` }),
    [`TAURI_CONFIG names ${feature}`],
  );
  assert.deepEqual(refused([], { RUSTFLAGS: `--cfg feature="${feature}"` }), [
    `RUSTFLAGS names ${feature}`,
  ]);
});

test('ordinary release arguments, and look-alike names, are not refused', () => {
  const refused = (args, env = {}) =>
    requestedDevelopmentFeatures(args, env, () => undefined);
  assert.deepEqual(
    refused(['--bundles', 'app,dmg', '--features', 'local-whisper']),
    [],
  );
  assert.deepEqual(refused(['--features', 'native-audio-spike-free']), []);
  assert.deepEqual(refused(['--config', 'missing.json']), []);
  assert.deepEqual(refused([], { RUSTFLAGS: '-C target-cpu=native' }), []);
});

test('the build script refuses before building anything', (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'no-tools-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    'release-build.mjs',
  );
  const env = { ...process.env, PATH: empty };
  delete env.TAURI_CONFIG;
  // With nothing on PATH, reaching cargo or npm would fail with exit 1.
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--bundles',
      'app',
      '--features',
      'local-whisper,native-audio-spike',
    ],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(
    result.stderr,
    /refusing to build a release with a development feature \(native-audio-spike\):\n {2}argument 4 names native-audio-spike/,
  );
});
