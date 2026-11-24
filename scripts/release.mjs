// One command from a checkout to the files a person downloads: build the
// bundle (scripts/release-build.mjs), sign a copy with the hardened runtime
// and the reviewed entitlements, notarize and staple it, package it as a disk
// image and a zip, verify both, and write their SHA-256 checksums and a
// manifest. docs/release-path.md explains each step and the credentials.
//
//   npm run release -- --dry-run       print every step; build, sign and send nothing
//   npm run release                    Developer ID signature and notarization
//   npm run release -- --no-notarize   Developer ID signature only (not installable
//                                      without a warning; for checking the signature)
//   npm run release -- --adhoc         ad-hoc signature: exercises the steps, NOT a release
//   npm run release -- --unsigned      the bundle as built: what CI uploads without secrets
//
//   --app PATH    package this .app instead of building one
//   --universal   build one bundle for Apple silicon and Intel
//   --out DIR     where the files go (default: <cargo target>/release-artifacts)
//   --allow-dirty sign a tree with uncommitted changes (never for a candidate)
//
// Credentials come only from the environment and are never written, printed
// or passed to `tauri build`:
//   APPLE_SIGNING_IDENTITY  "Developer ID Application: Name (TEAMID)" or its SHA-1
//   APPLE_TEAM_ID           the ten-character team the identity must belong to
//   APPLE_NOTARY_PROFILE    a `xcrun notarytool store-credentials` profile, or
//   APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH  an App Store Connect API key
//   APPLE_KEYCHAIN          optional keychain holding the identity (CI)
//
// Exit 0 when every step for the chosen mode passed, 1 when a step failed,
// 2 when the command or the credentials cannot make the chosen mode.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { bundlePath } from './release-build.mjs';
import { preflight } from './release-preflight.mjs';

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What each mode produces, weakest first. Only `notarized` is a release. */
export const MODES = ['unsigned', 'adhoc', 'signed', 'notarized'];

/** Names that label every file a mode writes, so nothing short of a
 * notarized build can be mistaken for one. */
export const LABEL = {
  unsigned: 'unsigned-not-for-release',
  adhoc: 'adhoc-not-for-release',
  signed: 'not-notarized',
  notarized: '',
};

/** Variables `tauri build` reads to sign or notarize by itself. The release
 * signs a copy afterwards instead, so the build must not see them. */
export const TAURI_SIGNING_VARIABLES = [
  'APPLE_SIGNING_IDENTITY',
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY_PATH',
  'APPLE_PROVIDER_SHORT_NAME',
];

export function parseArguments(argv) {
  const options = { mode: 'notarized', dryRun: false };
  const chosen = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      if (index + 1 >= argv.length)
        throw new Error(`${argument} needs a value`);
      return argv[++index];
    };
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--no-notarize') chosen.push('signed');
    else if (argument === '--adhoc') chosen.push('adhoc');
    else if (argument === '--unsigned') chosen.push('unsigned');
    else if (argument === '--universal') options.universal = true;
    else if (argument === '--allow-dirty') options.allowDirty = true;
    else if (argument === '--app') options.app = resolve(value());
    else if (argument === '--out') options.out = resolve(value());
    else throw new Error(`unknown argument ${argument}`);
  }
  if (chosen.length > 1)
    throw new Error(
      'choose at most one of --no-notarize, --adhoc and --unsigned',
    );
  if (chosen.length) options.mode = chosen[0];
  if (options.app && options.universal)
    throw new Error('--universal builds a bundle; it cannot apply to --app');
  return options;
}

/** The signing identity and notary credentials the environment gives for a
 * mode, and every reason it cannot make that mode. Secrets stay in `env`;
 * what is returned names them only where a command needs them. */
export function credentials(mode, env) {
  const problems = [];
  const result = { problems };
  if (mode === 'unsigned') return result;
  if (mode === 'adhoc') {
    result.identity = '-';
    return result;
  }

  const identity = env.APPLE_SIGNING_IDENTITY?.trim();
  const team = env.APPLE_TEAM_ID?.trim();
  if (!identity)
    problems.push(
      'APPLE_SIGNING_IDENTITY is not set: give the name of your Developer ID Application certificate, "Developer ID Application: Name (TEAMID)", or its SHA-1 from `security find-identity -v -p codesigning`.',
    );
  else if (
    !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity) &&
    !/^[0-9A-F]{40}$/i.test(identity)
  )
    problems.push(
      'APPLE_SIGNING_IDENTITY must name a Developer ID Application certificate ("Developer ID Application: Name (TEAMID)") or be its SHA-1. Apple Development, Mac App Store and self-signed identities cannot be notarized for direct download.',
    );
  if (!team)
    problems.push(
      'APPLE_TEAM_ID is not set: give the ten-character team ID of the Apple Developer account TalkQTE is published under. The signature is checked against it so that a certificate from another team on this Mac is never used by mistake.',
    );
  else if (!/^[A-Z0-9]{10}$/.test(team))
    problems.push('APPLE_TEAM_ID must be ten capital letters and digits.');
  else if (
    identity &&
    /^Developer ID Application:/.test(identity) &&
    !identity.endsWith(`(${team})`)
  )
    problems.push(
      `APPLE_SIGNING_IDENTITY belongs to a different team than APPLE_TEAM_ID (${team}).`,
    );
  result.identity = identity;
  result.team = team;
  result.keychain = env.APPLE_KEYCHAIN?.trim() || undefined;
  if (mode === 'signed') return result;

  if (env.APPLE_ID || env.APPLE_PASSWORD)
    problems.push(
      'APPLE_ID and APPLE_PASSWORD are not used: a password on the notarytool command line is visible to other processes. Store them once with `xcrun notarytool store-credentials talkqte-notary --apple-id <id> --team-id <team>` (it asks for the app-specific password) and set APPLE_NOTARY_PROFILE=talkqte-notary.',
    );
  const profile = env.APPLE_NOTARY_PROFILE?.trim();
  const api = ['APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH'];
  const given = api.filter((name) => env[name]?.trim());
  if (profile && given.length)
    problems.push(
      `give either APPLE_NOTARY_PROFILE or the App Store Connect API key (${api.join(', ')}), not both`,
    );
  else if (profile)
    result.notary = {
      kind: 'profile',
      args: ['--keychain-profile', profile],
      shown: ['--keychain-profile', profile],
    };
  else if (given.length === api.length) {
    if (!existsSync(env.APPLE_API_KEY_PATH))
      problems.push(
        `APPLE_API_KEY_PATH does not name a file: ${env.APPLE_API_KEY_PATH}`,
      );
    result.notary = {
      kind: 'api-key',
      args: [
        '--key',
        env.APPLE_API_KEY_PATH,
        '--key-id',
        env.APPLE_API_KEY,
        '--issuer',
        env.APPLE_API_ISSUER,
      ],
      shown: [
        '--key',
        '<APPLE_API_KEY_PATH>',
        '--key-id',
        '<APPLE_API_KEY>',
        '--issuer',
        '<APPLE_API_ISSUER>',
      ],
    };
  } else if (given.length)
    problems.push(
      `the App Store Connect API key needs all of ${api.join(', ')}; missing ${api.filter((name) => !given.includes(name)).join(', ')}`,
    );
  else
    problems.push(
      'no notary credentials: set APPLE_NOTARY_PROFILE (made with `xcrun notarytool store-credentials`), or APPLE_API_KEY, APPLE_API_ISSUER and APPLE_API_KEY_PATH for an App Store Connect API key. Use --no-notarize to stop after signing.',
    );
  return result;
}

/** The build's environment: everything except what would make Tauri sign or
 * notarize the bundle itself. */
export function buildEnvironment(env) {
  const copy = { ...env };
  for (const name of TAURI_SIGNING_VARIABLES) delete copy[name];
  return copy;
}

/** The result of `notarytool submit --output-format json`. */
export function parseSubmission(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '');
  } catch {
    return { accepted: false, message: 'notarytool did not print JSON' };
  }
  return {
    id: typeof parsed.id === 'string' ? parsed.id : undefined,
    status: parsed.status,
    accepted: parsed.status === 'Accepted',
    message: parsed.message,
  };
}

/** The file name every artifact of one release shares. */
export function artifactStem({ productName, version, arch, mode }) {
  return [productName, version, arch, LABEL[mode]].filter(Boolean).join('_');
}

const sha256 = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

class StepFailure extends Error {}

/**
 * Runs the release. `tools` performs everything with an effect, so a dry run
 * and the tests go through the same steps as a real one:
 *   run(command, args, { env, shown }) -> { status, stdout, stderr }
 *   preflight({ app, expect }) -> { passed, findings }
 *   fs: { reset(dir), write(path, text), sha256(path), size(path) }
 *   log(text)
 */
export function release(options, tools) {
  const { mode, root = REPOSITORY, env = {} } = options;
  const config = JSON.parse(
    readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  const { productName, version, identifier } = config;
  const entitlements = join(
    root,
    'src-tauri',
    config.bundle?.macOS?.entitlements ?? 'Entitlements.plist',
  );
  const creds = options.credentials ?? credentials(mode, env);
  const arch = options.universal
    ? 'universal'
    : (options.arch ?? (process.arch === 'arm64' ? 'aarch64' : 'x86_64'));
  const out = options.out ?? join(options.targetDir, 'release-artifacts');
  const work = join(out, 'work');
  const stem = artifactStem({ productName, version, arch, mode });
  const log = tools.log;

  const step = (title) => log(`\n== ${title}`);
  const run = (command, args, extra = {}) => {
    log(`$ ${[command, ...(extra.shown ?? args)].join(' ')}`);
    const result = tools.run(command, args, extra);
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
      throw new StepFailure(
        `${extra.what ?? `${command} ${args[0] ?? ''}`.trim()} failed${detail ? `:\n${detail}` : ` (exit ${result.status}; its output is above)`}`,
      );
    }
    return result;
  };
  const check = (expect, app) => {
    log(`$ release pre-flight --expect ${expect} ${app}`);
    const result = tools.preflight({ app, expect });
    for (const finding of result.findings ?? [])
      if (finding.level === 'fail')
        log(`  FAIL ${finding.check}: ${finding.message}`);
    if (!result.passed)
      throw new StepFailure(`the pre-flight with --expect ${expect} failed`);
  };
  const sign = (path, { runtime }) => {
    const args = [
      '--force',
      ...(runtime
        ? ['--options', 'runtime', '--entitlements', entitlements]
        : []),
      ...(creds.identity === '-' ? ['--timestamp=none'] : ['--timestamp']),
      ...(creds.keychain ? ['--keychain', creds.keychain] : []),
      '--sign',
      creds.identity,
      path,
    ];
    run('codesign', args, { what: `signing ${basename(path)}` });
  };
  const notarize = (path, name) => {
    const args = [
      'notarytool',
      'submit',
      path,
      ...creds.notary.args,
      '--wait',
      '--output-format',
      'json',
    ];
    const shown = [
      'notarytool',
      'submit',
      path,
      ...creds.notary.shown,
      '--wait',
      '--output-format',
      'json',
    ];
    log(`$ xcrun ${shown.join(' ')}`);
    const result = tools.run('xcrun', args, { shown, capture: true });
    const submission = parseSubmission(result.stdout ?? '');
    if (result.status === 0 && submission.accepted) {
      log(`  ${name}: Accepted (submission ${submission.id ?? 'unknown'})`);
      return;
    }
    let where = '';
    if (submission.id) {
      const logFile = join(out, `notary-log-${name}.json`);
      tools.run(
        'xcrun',
        ['notarytool', 'log', submission.id, ...creds.notary.args, logFile],
        {
          shown: [
            'notarytool',
            'log',
            submission.id,
            ...creds.notary.shown,
            logFile,
          ],
        },
      );
      where = ` Apple's log is in ${logFile}.`;
    }
    throw new StepFailure(
      `notarization of ${name} was not accepted (${submission.status ?? `notarytool exit ${result.status}`}${submission.message ? `: ${submission.message}` : ''}).${where}${result.stderr ? `\n${result.stderr.trim()}` : ''}`,
    );
  };
  const staple = (path) => {
    run('xcrun', ['stapler', 'staple', path], {
      what: `stapling ${basename(path)}`,
    });
    run('xcrun', ['stapler', 'validate', path], {
      what: `validating the ticket on ${basename(path)}`,
    });
  };

  if (mode !== 'notarized')
    log(
      `Mode: ${mode}. ${mode === 'signed' ? 'Signed with Developer ID but not notarized: Gatekeeper will refuse it on another Mac.' : 'NOT A RELEASE: Gatekeeper will refuse it on another Mac. Use it only to exercise these steps.'}`,
    );

  // 1. The bundle.
  let built = options.app;
  if (!built) {
    step('Build the bundle (scripts/release-build.mjs)');
    run(
      process.execPath,
      [
        join(root, 'scripts', 'release-build.mjs'),
        '--bundles',
        'app',
        '--no-sign',
        ...(options.universal ? ['--target', 'universal-apple-darwin'] : []),
      ],
      {
        env: buildEnvironment(env),
        shown: [
          'scripts/release-build.mjs',
          '--bundles',
          'app',
          '--no-sign',
          ...(options.universal ? ['--target', 'universal-apple-darwin'] : []),
        ],
        what: 'the release build',
      },
    );
    built = bundlePath({
      targetDir: options.targetDir,
      args: options.universal ? ['--target', 'universal-apple-darwin'] : [],
      productName,
    });
  }

  // 2. A copy to sign, so the build's own output is never altered.
  step('Copy the bundle to the work folder');
  tools.fs.reset(out);
  tools.fs.reset(work);
  const app = join(work, `${productName}.app`);
  run('ditto', [built, app], { what: 'copying the bundle' });

  // 3. Signature.
  if (mode !== 'unsigned') {
    step(
      creds.identity === '-'
        ? 'Sign ad-hoc with the hardened runtime (exercise only)'
        : 'Sign with Developer ID and the hardened runtime',
    );
    sign(app, { runtime: true });
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
      what: 'verifying the signature',
    });
    if (mode === 'signed' || mode === 'notarized') {
      check('signed', app);
      const shown = tools.run('codesign', ['--display', '--verbose=2', app], {
        capture: true,
      });
      const team = /^TeamIdentifier=(.*)$/m.exec(
        `${shown.stdout ?? ''}${shown.stderr ?? ''}`,
      )?.[1];
      if (!options.dryRun && team !== creds.team)
        throw new StepFailure(
          `the signature's team is ${team ?? 'not set'}, not APPLE_TEAM_ID ${creds.team}`,
        );
    }
  }

  // 4. Notarize the app and staple its ticket before packaging, so the copy a
  // person drags out of the disk image or zip opens without a network.
  if (mode === 'notarized') {
    step('Notarize and staple the app');
    const upload = join(work, `${productName}-notarize.zip`);
    run('ditto', ['-c', '-k', '--keepParent', app, upload], {
      what: 'zipping the app for the notary service',
    });
    notarize(upload, 'app');
    staple(app);
  }

  // 5. The downloads.
  step('Package the zip and the disk image');
  const zip = join(out, `${stem}.zip`);
  const dmg = join(out, `${stem}.dmg`);
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], {
    what: 'making the zip',
  });
  const staging = join(work, 'dmg');
  tools.fs.reset(staging);
  run('ditto', [app, join(staging, `${productName}.app`)], {
    what: 'staging the disk image',
  });
  run('ln', ['-s', '/Applications', join(staging, 'Applications')], {
    what: 'adding the Applications link',
  });
  run(
    'hdiutil',
    [
      'create',
      '-volname',
      `${productName} ${version}`,
      '-srcfolder',
      staging,
      '-fs',
      'HFS+',
      '-format',
      'UDZO',
      '-ov',
      dmg,
    ],
    { what: 'making the disk image' },
  );
  if (mode === 'signed' || mode === 'notarized') {
    sign(dmg, { runtime: false });
    if (mode === 'notarized') {
      step('Notarize and staple the disk image');
      notarize(dmg, 'dmg');
      staple(dmg);
    }
  }

  // 6. Verification of what a person receives: the app as it comes out of
  // the zip and out of the mounted disk image, not the copy that was signed.
  step('Verify the downloads');
  const unzipped = join(work, 'from-zip');
  const mounted = join(work, 'from-dmg');
  tools.fs.reset(unzipped);
  run('ditto', ['-x', '-k', zip, unzipped], { what: 'opening the zip' });
  run(
    'hdiutil',
    [
      'attach',
      '-quiet',
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mounted,
      dmg,
    ],
    { what: 'mounting the disk image' },
  );
  try {
    for (const copy of [
      join(unzipped, `${productName}.app`),
      join(mounted, `${productName}.app`),
    ]) {
      if (mode !== 'unsigned')
        run(
          'codesign',
          ['--verify', '--deep', '--strict', '--verbose=2', copy],
          {
            what: `verifying ${relative(work, copy)}`,
          },
        );
      check(
        mode === 'notarized'
          ? 'notarized'
          : mode === 'signed'
            ? 'signed'
            : 'bundle',
        copy,
      );
    }
  } finally {
    tools.run('hdiutil', ['detach', mounted, '-quiet'], {});
  }
  if (mode === 'notarized')
    run(
      'spctl',
      [
        '--assess',
        '--type',
        'open',
        '--context',
        'context:primary-signature',
        '-vv',
        dmg,
      ],
      { what: 'Gatekeeper assessment of the disk image' },
    );
  else
    log(
      `  Skipped Gatekeeper: macOS refuses ${mode === 'adhoc' ? 'an ad-hoc' : mode === 'unsigned' ? 'an unsigned' : `a ${mode}`} build from the internet by design (${mode === 'signed' ? '"Unnotarized Developer ID"' : 'no Developer ID signature'}).`,
    );
  tools.fs.reset(work, { remove: true });

  // 7. Checksums and the manifest.
  step('Checksums');
  const files = [dmg, zip].map((path) => ({
    name: basename(path),
    bytes: tools.fs.size(path),
    sha256: tools.fs.sha256(path),
  }));
  tools.fs.write(
    join(out, 'SHA256SUMS'),
    files.map(({ name, sha256: digest }) => `${digest}  ${name}\n`).join(''),
  );
  const manifest = {
    product: productName,
    identifier,
    version,
    arch,
    mode,
    release: mode === 'notarized',
    commit: options.commit,
    dirty: Boolean(options.dirty),
    team: creds.team,
    files,
  };
  tools.fs.write(
    join(out, `${stem}.manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const { name, sha256: digest } of files) log(`  ${digest}  ${name}`);
  return { out, dmg, zip, manifest };
}

/** Effects for a real run. */
function realTools() {
  return {
    log: (text) => console.log(text),
    run: (command, args, { env, capture } = {}) => {
      const result = spawnSync(command, args, {
        cwd: REPOSITORY,
        env: env ?? process.env,
        encoding: 'utf8',
        // Long steps (the build, notarization) show their progress as it
        // happens; their output is above any failure message.
        stdio: capture ? 'pipe' : ['ignore', 'inherit', 'inherit'],
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.error?.code === 'ENOENT')
        return { status: 127, stderr: `${command} is not installed` };
      return result;
    },
    preflight: ({ app, expect }) => preflight({ app, expect }),
    fs: {
      reset: (dir, { remove } = {}) => {
        if (remove || basename(dir) === 'work' || basename(dir) === 'dmg')
          rmSync(dir, { recursive: true, force: true });
        if (!remove) mkdirSync(dir, { recursive: true });
      },
      write: (path, text) => writeFileSync(path, text),
      sha256,
      size: (path) => statSync(path).size,
    },
  };
}

/** Effects for a dry run: every command is printed and assumed to succeed. */
export function dryRunTools(log = (text) => console.log(text)) {
  return {
    log,
    run: (command, args) =>
      command === 'xcrun' && args[1] === 'submit'
        ? {
            status: 0,
            stdout: '{"id":"dry-run","status":"Accepted","message":"dry run"}',
          }
        : { status: 0, stdout: '', stderr: '' },
    preflight: () => ({ passed: true, findings: [] }),
    fs: {
      reset: () => {},
      write: (path) => log(`  would write ${path}`),
      sha256: () => '(dry run)',
      size: () => 0,
    },
  };
}

if (isMain(import.meta.url)) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`release: ${error.message}`);
    console.error(
      'usage: npm run release -- [--dry-run] [--no-notarize | --adhoc | --unsigned] [--app PATH] [--universal] [--out DIR] [--allow-dirty]',
    );
    process.exit(2);
  }
  const creds = credentials(options.mode, process.env);
  const git = (...args) =>
    spawnSync('git', ['-C', REPOSITORY, ...args], { encoding: 'utf8' });
  const commit = git('rev-parse', 'HEAD').stdout?.trim() || undefined;
  const dirty = Boolean(git('status', '--porcelain').stdout?.trim());
  if (
    dirty &&
    !options.allowDirty &&
    (options.mode === 'signed' || options.mode === 'notarized')
  )
    creds.problems.push(
      'the checkout has uncommitted changes; a signed candidate must be built from a commit. Commit or stash them (or pass --allow-dirty for a throwaway check).',
    );
  if (options.app && !existsSync(join(options.app, 'Contents', 'Info.plist')))
    creds.problems.push(`${options.app} is not an application bundle`);
  if (!options.dryRun && creds.identity && creds.identity !== '-') {
    const found = spawnSync(
      'security',
      [
        'find-identity',
        '-v',
        '-p',
        'codesigning',
        ...(creds.keychain ? [creds.keychain] : []),
      ],
      { encoding: 'utf8' },
    ).stdout;
    if (!found?.includes(creds.identity))
      creds.problems.push(
        "APPLE_SIGNING_IDENTITY is not a valid code-signing identity in this Mac's keychains (or APPLE_KEYCHAIN). Import the Developer ID Application certificate with its private key first.",
      );
  }
  if (creds.problems.length) {
    console.error(
      `release: cannot make a ${options.mode} build:\n  - ${creds.problems.join('\n  - ')}`,
    );
    if (!options.dryRun) process.exit(2);
    console.error('\nThe steps it would take once these are fixed:');
  }
  if (options.universal)
    console.log(
      'Note: the third-party notices list the arm64 build only; a universal release needs them regenerated for both architectures (docs/release-path.md).',
    );
  let targetDir;
  try {
    targetDir = JSON.parse(
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
  } catch {
    targetDir = join(REPOSITORY, 'src-tauri', 'target');
  }
  const placeholder = (value, name) => value ?? `<${name}>`;
  const shownCreds = {
    ...creds,
    identity: placeholder(creds.identity, 'APPLE_SIGNING_IDENTITY'),
    team: creds.team,
    notary: creds.notary ?? {
      args: ['<notary credentials>'],
      shown: ['<notary credentials>'],
    },
  };
  try {
    const result = release(
      {
        ...options,
        env: process.env,
        targetDir,
        commit,
        dirty,
        credentials: options.dryRun ? shownCreds : creds,
      },
      options.dryRun ? dryRunTools() : realTools(),
    );
    if (options.dryRun) {
      console.log(
        `\nDry run: nothing was built, signed or sent. ${creds.problems.length ? 'Fix the problems above first.' : `Without --dry-run this makes a ${options.mode} build.`}`,
      );
      process.exit(creds.problems.length ? 2 : 0);
    }
    console.log(
      `\n${options.mode === 'notarized' ? 'Notarized release' : `${options.mode} build (not a release)`} in ${relative(process.cwd(), result.out) || '.'}`,
    );
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    console.error(`\nrelease: ${error.message}`);
    process.exit(1);
  }
}
