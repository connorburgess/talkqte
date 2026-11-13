// Builds a macOS release candidate the way docs/release-path.md describes:
// the third-party notices must be current, the compilers are told to record
// neutral paths in place of this machine's folders, and the finished bundle
// goes through the release pre-flight with build paths treated as a failure.
// It adds no signing identity or credential of its own; Tauri signs or
// notarizes only if the caller's environment already asks it to.
//
//   npm run build:release -- --bundles app,dmg --features local-whisper
//
// Arguments are passed to `tauri build` unchanged.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight } from './release-preflight.mjs';

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Folder prefixes to hide, least specific first: both rustc and clang let a
 * later, more specific mapping take precedence over an earlier one. */
export function pathRemaps({ home, cargoHome, repository, targetDir }) {
  const remaps = [
    [home, '/build/home'],
    [cargoHome, '/build/cargo'],
    [repository, '/build/talkqte'],
    [targetDir, '/build/target'],
  ];
  const unique = remaps.filter(
    ([from], index) =>
      from && remaps.findIndex(([other]) => other === from) === index,
  );
  // Compiler flag variables are split on whitespace, so such a folder would
  // turn into several broken flags and fail far from its cause.
  const spaced = unique.filter(([from]) => /\s/.test(from));
  if (spaced.length)
    throw new Error(
      `cannot remap a folder whose path contains a space: ${spaced.map(([, to]) => to.replace('/build/', '')).join(', ')} folder. Build from a checkout, home and Cargo folder without spaces.`,
    );
  return unique;
}

/** Whether a bundle was written by a build that began at `startedMs`. The
 * bundler rewrites Info.plist every time, even when cargo had nothing to
 * recompile, so the newer of it and the executable is compared. */
export function builtSince(startedMs, ...modifiedMs) {
  return Math.max(...modifiedMs) >= startedMs;
}

/** The environment for the build: existing flags are kept and extended. */
export function buildEnvironment(env, remaps) {
  const join_ = (current, added) =>
    [current, ...added].filter(Boolean).join(' ');
  const c = remaps.map(([from, to]) => `-ffile-prefix-map=${from}=${to}`);
  return {
    ...env,
    RUSTFLAGS: join_(
      env.RUSTFLAGS,
      remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`),
    ),
    CFLAGS: join_(env.CFLAGS, c),
    CXXFLAGS: join_(env.CXXFLAGS, c),
  };
}

/** Where `tauri build` leaves the .app for these arguments. */
export function bundlePath({ targetDir, args, productName }) {
  const value = (...names) => {
    for (const [index, argument] of args.entries()) {
      for (const name of names) {
        if (argument === name) return args[index + 1];
        if (argument.startsWith(`${name}=`))
          return argument.slice(name.length + 1);
      }
    }
    return undefined;
  };
  const triple = value('--target', '-t');
  const profile =
    args.includes('--debug') || args.includes('-d') ? 'debug' : 'release';
  return join(
    targetDir,
    ...(triple ? [triple] : []),
    profile,
    'bundle',
    'macos',
    `${productName}.app`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const run = (command, commandArgs, options = {}) => {
    const result = spawnSync(command, commandArgs, {
      cwd: REPOSITORY,
      stdio: 'inherit',
      ...options,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  };

  run(process.execPath, ['scripts/third-party-notices.mjs', '--check']);

  // Ask cargo, which honours CARGO_TARGET_DIR and its own configuration.
  const targetDir = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--no-deps',
        '--format-version',
        '1',
        '--manifest-path',
        join(REPOSITORY, 'src-tauri', 'Cargo.toml'),
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  ).target_directory;
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo');
  let remaps;
  try {
    remaps = pathRemaps({
      home: homedir(),
      cargoHome,
      repository: resolve(REPOSITORY),
      targetDir,
    });
  } catch (error) {
    console.error(`release-build: ${error.message}`);
    process.exit(2);
  }
  // File times have coarser resolution than the clock on some volumes.
  const started = Date.now() - 2000;
  run('npm', ['run', 'tauri', '--', 'build', ...args], {
    env: buildEnvironment(process.env, remaps),
  });

  const { productName } = JSON.parse(
    readFileSync(join(REPOSITORY, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  const app = bundlePath({ targetDir, args, productName });
  const produced = [
    join(app, 'Contents', 'Info.plist'),
    ...(existsSync(join(app, 'Contents', 'MacOS'))
      ? readdirSync(join(app, 'Contents', 'MacOS')).map((name) =>
          join(app, 'Contents', 'MacOS', name),
        )
      : []),
  ].filter((path) => existsSync(path));
  if (
    !produced.length ||
    !builtSince(started, ...produced.map((path) => statSync(path).mtimeMs))
  ) {
    console.error(
      `release-build: ${app} was not written by this build (missing, or older than the build's start). Check the bundle arguments; nothing was pre-flighted.`,
    );
    process.exit(1);
  }
  const { findings, passed } = preflight({ app, strictPaths: true });
  const label = { ok: 'ok  ', fail: 'FAIL', note: 'note' };
  for (const { level, check, message } of findings)
    console.log(`${label[level]}  ${check}: ${message}`);
  console.log(
    passed
      ? `\nBuilt ${app}\nPre-flight passed. The bundle is not signed for distribution unless you supplied a Developer ID; see docs/release-path.md.`
      : '\nThe build finished but its pre-flight failed.',
  );
  process.exit(passed ? 0 : 1);
}
