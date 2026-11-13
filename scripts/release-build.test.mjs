import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEnvironment, bundlePath, pathRemaps } from './release-build.mjs';

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
