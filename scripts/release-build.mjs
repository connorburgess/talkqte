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
import { isMain } from './is-main.mjs';
import {
  DEVELOPMENT_FEATURES,
  configuredDevelopmentFeatures,
  preflight,
} from './release-preflight.mjs';

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

/** Whether a bundle was written by a build that began at `startedMs`. Every
 * run of `tauri build` rebuilds the frontend, recompiles the app crate and
 * rewrites both Info.plist and the executable, even when no source changed
 * (observed on two consecutive runs), so each of them must be new. */
export function builtSince(startedMs, ...modifiedMs) {
  return modifiedMs.length > 0 && Math.min(...modifiedMs) >= startedMs;
}

const names = (feature) =>
  new RegExp(`(^|[^A-Za-z0-9_-])${feature}($|[^A-Za-z0-9_-])`);

/** Why these build arguments and environment would compile a development
 * feature in, as a list of reasons; empty when they would not. Anything that
 * names the feature counts, wherever it appears: `--features`/`-f` lists,
 * cargo arguments after `--`, an inline `--config` or one in a file, Tauri's
 * TAURI_CONFIG and the Rust flags. `--all-features` turns on every feature. */
export function requestedDevelopmentFeatures(
  args,
  env = {},
  readText = (path) =>
    existsSync(path) ? readFileSync(path, 'utf8') : undefined,
) {
  const reasons = [];
  const scan = (text, where) => {
    for (const feature of DEVELOPMENT_FEATURES)
      if (text && names(feature).test(text))
        reasons.push(`${where} names ${feature}`);
  };
  for (const [index, argument] of args.entries()) {
    if (argument === '--all-features')
      reasons.push('--all-features turns on every feature');
    scan(argument, `argument ${index + 1}`);
    const config =
      argument === '--config' || argument === '-c'
        ? args[index + 1]
        : /^(?:--config|-c)=(.*)$/s.exec(argument)?.[1];
    if (config && !config.trimStart().startsWith('{'))
      scan(readText(config), `the --config file ${config}`);
  }
  if (env.TAURI_CONFIG) {
    scan(env.TAURI_CONFIG, 'TAURI_CONFIG');
    if (!env.TAURI_CONFIG.trimStart().startsWith('{'))
      scan(readText(env.TAURI_CONFIG), 'the TAURI_CONFIG file');
  }
  for (const flags of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS'])
    scan(env[flags], flags);
  return reasons;
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

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const run = (command, commandArgs, options = {}) => {
    const result = spawnSync(command, commandArgs, {
      cwd: REPOSITORY,
      stdio: 'inherit',
      ...options,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  };

  // Refuse before anything is built: a development feature in a release
  // candidate is never wanted, and a finished bundle cannot show it yet.
  const reasons = [
    ...requestedDevelopmentFeatures(args, process.env),
    ...configuredDevelopmentFeatures(
      readFileSync(join(REPOSITORY, 'src-tauri', 'Cargo.toml'), 'utf8'),
      JSON.parse(
        readFileSync(join(REPOSITORY, 'src-tauri', 'tauri.conf.json'), 'utf8'),
      ),
    ).map((feature) => `the configuration switches on ${feature}`),
  ];
  if (reasons.length) {
    console.error(
      `release-build: refusing to build a release with a development feature (${DEVELOPMENT_FEATURES.join(', ')}):\n  ${reasons.join('\n  ')}\nBuild it with the ordinary \`npm run tauri -- build --debug\` for development instead.`,
    );
    process.exit(2);
  }

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
  const debug = args.includes('--debug') || args.includes('-d');
  const label = { ok: 'ok  ', fail: 'FAIL', note: 'note' };
  for (const { level, check, message } of findings)
    console.log(`${label[level]}  ${check}: ${message}`);
  console.log(
    passed
      ? `\nBuilt ${app}\nPre-flight passed. The bundle is not signed for distribution unless you supplied a Developer ID; see docs/release-path.md.`
      : `\nThe build finished but its pre-flight failed.${debug ? ' A debug build always fails the build-paths check: its debugging records point at object files in the build folder and the Rust toolchain, which path remapping does not change. Release builds do not carry them.' : ''}`,
  );
  process.exit(passed ? 0 : 1);
}
