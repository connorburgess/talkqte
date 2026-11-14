// Build-only development artifact. Never launch, sign, notarize or approve it.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const FEATURES = Object.freeze([
  'lab-evaluator',
  'local-whisper',
  'native-audio-spike',
  'timing-log',
]);
export const ARCHIVE = 'TalkQTE-lab-arm64.zip';
export const RECEIPT = 'build-receipt.json';
export const ARCHIVE_ARGS = Object.freeze([
  '-c',
  '-k',
  '--keepParent',
  '--norsrc',
  '--noextattr',
  '--noqtn',
  '--noacl',
]);
export const MAX_BYTES = 512 * 1024 * 1024;
export const MAX_FILES = 4096;
export const BUILD_ARGS = Object.freeze([
  'run',
  'tauri',
  '--',
  'build',
  '--debug',
  '--ci',
  '--no-sign',
  '--bundles',
  'app',
  '--target',
  'aarch64-apple-darwin',
  '--features',
  FEATURES.join(','),
  '--',
  '--locked',
  '--no-default-features',
]);
const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE =
  'src-tauri/target/aarch64-apple-darwin/debug/bundle/macos/TalkQTE.app';
const fail = (why) => {
  throw new Error(why);
};
export function commit(value) {
  if (
    typeof value !== 'string' ||
    value.length !== 40 ||
    !/^[0-9a-f]{40}$/.test(value) ||
    /^0{40}$/.test(value)
  )
    fail('source_commit must be a full nonzero lowercase commit SHA');
  return value;
}
function hashShape(value) {
  return (
    typeof value === 'string' &&
    value.length === 64 &&
    /^[0-9a-f]{64}$/.test(value)
  );
}
function keys(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',')
  );
}
const boundedSize = (size) =>
  Number.isSafeInteger(size) && size > 0 && size <= MAX_BYTES;

export function validateReceipt(value, expectedCommit) {
  commit(expectedCommit);
  if (
    !keys(value, [
      'schema',
      'commit',
      'features',
      'debug',
      'target',
      'signing',
      'bundle',
      'archive',
      'lockfiles',
    ]) ||
    value.schema !== 'talkqte.lab.ci-build.v1' ||
    value.commit !== expectedCommit ||
    JSON.stringify(value.features) !== JSON.stringify(FEATURES) ||
    value.debug !== true ||
    value.target !== 'aarch64-apple-darwin' ||
    value.signing !== 'not-performed' ||
    !keys(value.bundle, [
      'name',
      'identifier',
      'minimumSystemVersion',
      'bytes',
      'files',
      'sha256',
      'executableSha256',
    ]) ||
    value.bundle.name !== 'TalkQTE.app' ||
    value.bundle.identifier !== 'com.talkqte.desktop' ||
    value.bundle.minimumSystemVersion !== '14.0' ||
    !boundedSize(value.bundle.bytes) ||
    !Number.isSafeInteger(value.bundle.files) ||
    value.bundle.files < 1 ||
    value.bundle.files > MAX_FILES ||
    !hashShape(value.bundle.sha256) ||
    !hashShape(value.bundle.executableSha256) ||
    !keys(value.archive, ['name', 'bytes', 'sha256']) ||
    value.archive.name !== ARCHIVE ||
    !boundedSize(value.archive.bytes) ||
    !hashShape(value.archive.sha256) ||
    !keys(value.lockfiles, ['Cargo.lock', 'package-lock.json']) ||
    !Object.values(value.lockfiles).every(hashShape)
  )
    fail('invalid or mismatched build receipt');
  return value;
}

// Reject path aliases at every component, not just the final filename.
export function regularPath(root, relative, directory = false) {
  if (realpathSync(root) !== resolve(root)) fail('aliased artifact root');
  if (
    !relative ||
    relative.startsWith('/') ||
    relative.split('/').some((p) => !p || p === '.' || p === '..')
  )
    fail('invalid artifact path');
  let current = root;
  for (const part of relative.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) fail('symlink in artifact path');
  }
  const st = lstatSync(current);
  if (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)
    fail('artifact is not an ordinary file/directory');
  return current;
}
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function inventory(root) {
  const entries = [];
  let bytes = 0;
  let nodes = 0;
  async function walk(relative = '') {
    if (relative.split('/').length > 32)
      fail('bundle nesting exceeds artifact bounds');
    const parent = relative ? regularPath(root, relative, true) : root;
    for (const name of readdirSync(parent).sort()) {
      if (++nodes > MAX_FILES * 2)
        fail('bundle entries exceed artifact bounds');
      const path = relative ? `${relative}/${name}` : name;
      const full = join(root, path);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) fail('symlink in bundle');
      if (st.isDirectory()) await walk(path);
      else {
        regularPath(root, path);
        bytes += st.size;
        if (entries.length >= MAX_FILES || bytes > MAX_BYTES)
          fail('bundle exceeds artifact bounds');
        entries.push({
          path,
          bytes: st.size,
          mode: st.mode & 0o777,
          sha256: await sha256(full),
        });
      }
    }
  }
  if (realpathSync(root) !== resolve(root)) fail('aliased bundle');
  await walk();
  if (!bytes) fail('empty bundle');
  return {
    bytes,
    files: entries.length,
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
}

export async function verifyArtifacts(root, expectedCommit) {
  const receiptPath = regularPath(root, RECEIPT);
  if (lstatSync(receiptPath).size > 16 * 1024) fail('oversize receipt');
  const receipt = validateReceipt(
    JSON.parse(readFileSync(receiptPath, 'utf8')),
    expectedCommit,
  );
  const archive = regularPath(root, ARCHIVE);
  if (
    lstatSync(archive).size !== receipt.archive.bytes ||
    (await sha256(archive)) !== receipt.archive.sha256
  )
    fail('archive hash/size mismatch');
  if (
    readdirSync(root).sort().join(',') !== [ARCHIVE, RECEIPT].sort().join(',')
  )
    fail('unexpected artifact output');
  return receipt;
}

export function buildEnvironment(env, source, targetDir) {
  commit(source);
  // Refuse ambient signing, feature/config injection and launch/provider settings.
  const forbidden = Object.keys(env).filter(
    (key) =>
      /^(APPLE_|CSC_|TAURI_|TALKQTE_|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|CARGO_BUILD_RUSTFLAGS$|CARGO_TARGET_.*_RUSTFLAGS$|CARGO_TARGET_DIR$|CARGO_BUILD_TARGET$|CARGO_PROFILE_|RUSTC$|RUSTC_WRAPPER$|RUSTC_WORKSPACE_WRAPPER$)/.test(
        key,
      ) && env[key],
  );
  if (forbidden.length)
    fail(`unsupported build environment keys: ${forbidden.join(', ')}`);
  return {
    ...env,
    TALKQTE_COMMIT: source,
    CARGO_TARGET_DIR: targetDir,
    MACOSX_DEPLOYMENT_TARGET: '14.0',
  };
}

export function verifySource(repository, source) {
  commit(source);
  const git = (args) =>
    execFileSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  if (git(['rev-parse', 'HEAD']) !== source)
    fail('checkout does not match source_commit');
  git(['merge-base', '--is-ancestor', source, 'origin/main']);
  if (git(['status', '--porcelain']).trim()) fail('source checkout is dirty');
}

async function build(source) {
  commit(source);
  const run = (command, args, env = process.env) =>
    execFileSync(command, args, {
      cwd: REPOSITORY,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    fail('requires macOS arm64');
  verifySource(REPOSITORY, source);
  const config = JSON.parse(
    readFileSync(join(REPOSITORY, 'src-tauri/tauri.conf.json'), 'utf8'),
  );
  if (
    (config.build.features?.length ?? 0) !== 0 ||
    config.identifier !== 'com.talkqte.desktop' ||
    config.bundle.macOS.minimumSystemVersion !== '14.0'
  )
    fail('unexpected bundle configuration');
  const target = join(REPOSITORY, 'src-tauri/target');
  const env = buildEnvironment(process.env, source, target);
  // All build arguments are fixed; no user-supplied flags or executables.
  execFileSync('npm', BUILD_ARGS, {
    cwd: REPOSITORY,
    env,
    stdio: 'inherit',
    timeout: 30 * 60 * 1000,
  });
  verifySource(REPOSITORY, source);
  const bundle = regularPath(REPOSITORY, BUNDLE, true);
  const executable = regularPath(bundle, 'Contents/MacOS/talkqte');
  const plist = regularPath(bundle, 'Contents/Info.plist');
  if (run('/usr/bin/lipo', ['-archs', executable]).trim() !== 'arm64')
    fail('unexpected executable architecture');
  for (const [key, expected] of [
    ['CFBundleIdentifier', 'com.talkqte.desktop'],
    ['CFBundleExecutable', 'talkqte'],
    ['LSMinimumSystemVersion', '14.0'],
  ]) {
    if (
      run('/usr/bin/plutil', [
        '-extract',
        key,
        'raw',
        '-o',
        '-',
        plist,
      ]).trim() !== expected
    )
      fail('unexpected Info.plist');
  }
  const before = await inventory(bundle);
  const output = join(
    realpathSync(process.env.RUNNER_TEMP),
    'talkqte-lab-artifact',
  );
  mkdirSync(output, { mode: 0o700 }); // Refuse pre-existing output, including symlinks.
  const archive = join(output, ARCHIVE);
  run('/usr/bin/ditto', [...ARCHIVE_ARGS, bundle, archive]);
  const bytes = lstatSync(archive).size;
  if (!boundedSize(bytes)) fail('archive exceeds artifact bounds');
  if (JSON.stringify(before) !== JSON.stringify(await inventory(bundle)))
    fail('bundle changed during archive creation');
  const receipt = validateReceipt(
    {
      schema: 'talkqte.lab.ci-build.v1',
      commit: source,
      features: FEATURES,
      debug: true,
      target: 'aarch64-apple-darwin',
      signing: 'not-performed',
      bundle: {
        name: 'TalkQTE.app',
        identifier: config.identifier,
        minimumSystemVersion: '14.0',
        ...before,
        executableSha256: await sha256(executable),
      },
      archive: { name: ARCHIVE, bytes, sha256: await sha256(archive) },
      lockfiles: {
        'Cargo.lock': await sha256(join(REPOSITORY, 'src-tauri/Cargo.lock')),
        'package-lock.json': await sha256(
          join(REPOSITORY, 'package-lock.json'),
        ),
      },
    },
    source,
  );
  writeFileSync(
    join(output, RECEIPT),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await verifyArtifacts(output, source);
  console.log(
    `Build artifact prepared for ${source}; ${bytes} archive bytes. Not approved for launch.`,
  );
}

if (isMain(import.meta.url)) {
  try {
    const [command, value, ...extra] = process.argv.slice(2);
    if (extra.length) fail('unexpected arguments');
    if (command === 'validate-commit') console.log(commit(value));
    else if (command === 'build') await build(value);
    else if (command === 'verify')
      await verifyArtifacts(resolve(process.env.LAB_ARTIFACT_DIRECTORY), value);
    else
      fail(
        'usage: lab-build-artifact.mjs validate-commit|build|verify <full-commit-sha>',
      );
  } catch (error) {
    console.error(`lab-build-artifact: ${error.message}`);
    process.exitCode = 1;
  }
}
