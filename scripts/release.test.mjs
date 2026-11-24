import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  LABEL,
  TAURI_SIGNING_VARIABLES,
  artifactStem,
  buildEnvironment,
  credentials,
  parseArguments,
  parseSubmission,
  release,
} from './release.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'release.mjs');

// Fictional identities and credentials; nothing here signs or sends anything.
const TEAM = 'Q1W2E3R4T5';
const IDENTITY = `Developer ID Application: Fictional Orchard Ltd (${TEAM})`;
const keyDir = mkdtempSync(join(tmpdir(), 'release-test-'));
const KEY_PATH = join(keyDir, 'AuthKey_FICTION123.p8');
writeFileSync(KEY_PATH, 'not a key');
test.after(() => rmSync(keyDir, { recursive: true, force: true }));

const signing = { APPLE_SIGNING_IDENTITY: IDENTITY, APPLE_TEAM_ID: TEAM };
const apiKey = {
  APPLE_API_KEY: 'FICTION123',
  APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
  APPLE_API_KEY_PATH: KEY_PATH,
};

test('arguments choose one mode; notarized is the default', () => {
  assert.equal(parseArguments([]).mode, 'notarized');
  assert.equal(parseArguments(['--no-notarize']).mode, 'signed');
  assert.equal(parseArguments(['--adhoc']).mode, 'adhoc');
  assert.equal(parseArguments(['--unsigned', '--dry-run']).dryRun, true);
  assert.throws(() => parseArguments(['--adhoc', '--unsigned']), /at most one/);
  assert.throws(() => parseArguments(['--sign']), /unknown argument/);
  assert.throws(() => parseArguments(['--app']), /needs a value/);
  assert.throws(
    () => parseArguments(['--app', '/x.app', '--universal']),
    /cannot apply to --app/,
  );
});

test('a notarized build needs an identity, its team and notary credentials', () => {
  const { problems } = credentials('notarized', {});
  assert.equal(problems.length, 3);
  assert.match(problems[0], /APPLE_SIGNING_IDENTITY is not set/);
  assert.match(problems[1], /APPLE_TEAM_ID is not set/);
  assert.match(problems[2], /no notary credentials/);

  const ok = credentials('notarized', { ...signing, ...apiKey });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.notary.kind, 'api-key');
  // What is printed never carries the key's identifiers.
  assert.ok(!ok.notary.shown.includes('FICTION123'));
  assert.ok(ok.notary.args.includes('FICTION123'));

  const profile = credentials('notarized', {
    ...signing,
    APPLE_NOTARY_PROFILE: 'talkqte-notary',
  });
  assert.deepEqual(profile.problems, []);
  assert.deepEqual(profile.notary.args, [
    '--keychain-profile',
    'talkqte-notary',
  ]);
});

test('only a Developer ID Application identity of the named team is accepted', () => {
  const wrong = (identity, team = TEAM) =>
    credentials('signed', {
      APPLE_SIGNING_IDENTITY: identity,
      APPLE_TEAM_ID: team,
    }).problems;
  assert.match(
    wrong('Apple Development: Someone (Q1W2E3R4T5)')[0],
    /Developer ID Application/,
  );
  assert.match(wrong('TalkQTE Development')[0], /Developer ID Application/);
  assert.match(wrong(IDENTITY, 'ZZZZZZZZZZ')[0], /different team/);
  assert.match(wrong(IDENTITY, 'short')[0], /ten capital letters/);
  assert.deepEqual(wrong('A'.repeat(40)), []);
  assert.deepEqual(wrong(IDENTITY), []);
});

test('notary credentials are refused when partial, doubled or a password', () => {
  const problems = (env) =>
    credentials('notarized', { ...signing, ...env }).problems.join('\n');
  assert.match(
    problems({ APPLE_API_KEY: 'FICTION123' }),
    /missing APPLE_API_ISSUER, APPLE_API_KEY_PATH/,
  );
  assert.match(
    problems({ ...apiKey, APPLE_NOTARY_PROFILE: 'p' }),
    /either APPLE_NOTARY_PROFILE or/,
  );
  assert.match(
    problems({ APPLE_ID: 'someone@example.invalid', APPLE_PASSWORD: 'x' }),
    /store-credentials/,
  );
  assert.match(
    problems({ ...apiKey, APPLE_API_KEY_PATH: join(keyDir, 'missing.p8') }),
    /does not name a file/,
  );
  // Signing alone needs no notary credentials; ad-hoc and unsigned need none.
  assert.deepEqual(credentials('signed', signing).problems, []);
  assert.deepEqual(credentials('adhoc', {}), { problems: [], identity: '-' });
  assert.deepEqual(credentials('unsigned', {}).problems, []);
});

test('the build never sees a variable that would make Tauri sign by itself', () => {
  const env = buildEnvironment({
    PATH: '/usr/bin',
    ...signing,
    ...apiKey,
    APPLE_CERTIFICATE: 'fictional',
  });
  assert.deepEqual(env, { PATH: '/usr/bin' });
  for (const name of Object.keys({ ...signing, ...apiKey }))
    assert.ok(TAURI_SIGNING_VARIABLES.includes(name), name);
});

test('notarytool results are read from its JSON', () => {
  assert.deepEqual(
    parseSubmission(
      'Conducting pre-submission checks\n{"id":"abc","status":"Accepted","message":"ok"}\n',
    ),
    { id: 'abc', status: 'Accepted', accepted: true, message: 'ok' },
  );
  assert.equal(
    parseSubmission('{"id":"abc","status":"Invalid"}').accepted,
    false,
  );
  assert.equal(parseSubmission('Error: HTTP 401').accepted, false);
});

test('every artifact short of notarized is labelled as not a release', () => {
  const stem = (mode) =>
    artifactStem({
      productName: 'TalkQTE',
      version: '0.1.0',
      arch: 'aarch64',
      mode,
    });
  assert.equal(stem('notarized'), 'TalkQTE_0.1.0_aarch64');
  for (const mode of ['unsigned', 'adhoc', 'signed'])
    assert.equal(stem(mode), `TalkQTE_0.1.0_aarch64_${LABEL[mode]}`);
});

/** A recording stand-in for every effect, with scripted answers. */
function fakeTools({ submit = 'Accepted', preflightPasses = true, fail } = {}) {
  const calls = [];
  const written = {};
  return {
    calls,
    written,
    tools: {
      log: () => {},
      run: (command, args) => {
        calls.push([command, ...args]);
        if (fail && fail(command, args))
          return { status: 1, stderr: 'fictional failure' };
        if (command === 'xcrun' && args[1] === 'submit')
          return {
            status: submit === 'Accepted' ? 0 : 1,
            stdout: JSON.stringify({
              id: 'sub-1',
              status: submit,
              message: 'fictional',
            }),
          };
        if (command === 'codesign' && args[0] === '--display')
          return { status: 0, stderr: `TeamIdentifier=${TEAM}\n` };
        return { status: 0, stdout: '', stderr: '' };
      },
      preflight: ({ expect }) => {
        calls.push(['preflight', expect]);
        return {
          passed: preflightPasses,
          findings: preflightPasses
            ? []
            : [{ level: 'fail', check: 'signature', message: 'fictional' }],
        };
      },
      fs: {
        reset: () => {},
        write: (path, text) => (written[path] = text),
        sha256: (path) => `digest-of-${path.split('/').pop()}`,
        size: () => 1,
      },
    },
  };
}

const base = {
  app: '/fictional/build/TalkQTE.app',
  out: '/fictional/out',
  arch: 'aarch64',
  commit: 'f'.repeat(40),
};

test('a notarized release staples the app before packaging it, then the image', () => {
  const { tools, calls, written } = fakeTools();
  const result = release(
    { ...base, mode: 'notarized', env: { ...signing, ...apiKey } },
    tools,
  );
  const steps = calls.map((call) => call.slice(0, 3).join(' '));
  const at = (prefix) => steps.findIndex((step) => step.startsWith(prefix));
  const signApp = steps.findIndex(
    (step, index) =>
      step.startsWith('codesign --force') &&
      index < at('xcrun notarytool submit'),
  );
  assert.ok(signApp >= 0);
  assert.ok(signApp < at('preflight signed'));
  assert.ok(at('preflight signed') < at('xcrun notarytool submit'));
  // The app is submitted, stapled and validated before the zip and image.
  const stapleApp = calls.findIndex(
    (call) =>
      call[1] === 'stapler' && call[2] === 'staple' && call[3].endsWith('.app'),
  );
  const zip = calls.findIndex(
    (call) => call[0] === 'ditto' && call.includes('--sequesterRsrc'),
  );
  const image = calls.findIndex((call) => call[0] === 'hdiutil');
  assert.ok(stapleApp >= 0 && stapleApp < zip && zip < image);
  // The image is signed, submitted and stapled after it is made.
  const imageSubmit = calls.findIndex(
    (call, index) =>
      index > image && call[1] === 'notarytool' && call[3].endsWith('.dmg'),
  );
  const imageStaple = calls.findIndex(
    (call, index) =>
      index > image && call[1] === 'stapler' && call[3].endsWith('.dmg'),
  );
  assert.ok(imageSubmit > image && imageStaple > imageSubmit);
  // The app signature uses the hardened runtime, a timestamp and the entitlements.
  const appSign = calls[signApp];
  assert.ok(appSign.includes('runtime') && appSign.includes('--timestamp'));
  assert.ok(appSign.some((arg) => arg.endsWith('Entitlements.plist')));
  assert.equal(appSign[appSign.indexOf('--sign') + 1], IDENTITY);
  assert.ok(
    calls.some((call) => call[0] === 'preflight' && call[1] === 'notarized'),
  );
  assert.ok(
    calls.some((call) => call[0] === 'spctl' && call.at(-1) === result.dmg),
  );
  // Checksums name both downloads; the manifest says it is a release.
  assert.equal(
    written['/fictional/out/SHA256SUMS'],
    'digest-of-TalkQTE_0.1.0_aarch64.dmg  TalkQTE_0.1.0_aarch64.dmg\ndigest-of-TalkQTE_0.1.0_aarch64.zip  TalkQTE_0.1.0_aarch64.zip\n',
  );
  const manifest = JSON.parse(
    written['/fictional/out/TalkQTE_0.1.0_aarch64.manifest.json'],
  );
  assert.equal(manifest.release, true);
  assert.equal(manifest.team, TEAM);
  assert.equal(manifest.identifier, 'com.talkqte.desktop');
});

test("a rejected submission fetches Apple's log and stops before packaging", () => {
  const { tools, calls } = fakeTools({ submit: 'Invalid' });
  assert.throws(
    () =>
      release(
        { ...base, mode: 'notarized', env: { ...signing, ...apiKey } },
        tools,
      ),
    /notarization of app was not accepted \(Invalid: fictional\)\. Apple's log is in \/fictional\/out\/notary-log-app\.json/,
  );
  assert.ok(
    calls.some(
      (call) =>
        call[1] === 'notarytool' && call[2] === 'log' && call[3] === 'sub-1',
    ),
  );
  assert.ok(!calls.some((call) => call[0] === 'hdiutil'));
});

test('a failed signed pre-flight or a wrong team stops the release', () => {
  assert.throws(
    () =>
      release(
        { ...base, mode: 'signed', env: signing },
        fakeTools({ preflightPasses: false }).tools,
      ),
    /--expect signed failed/,
  );
  const other = fakeTools();
  const run = other.tools.run;
  other.tools.run = (command, args) =>
    command === 'codesign' && args[0] === '--display'
      ? { status: 0, stderr: 'TeamIdentifier=ZZZZZZZZZZ\n' }
      : run(command, args);
  assert.throws(
    () => release({ ...base, mode: 'signed', env: signing }, other.tools),
    /team is ZZZZZZZZZZ, not APPLE_TEAM_ID Q1W2E3R4T5/,
  );
});

test('a failing command names the step', () => {
  const { tools } = fakeTools({ fail: (command) => command === 'hdiutil' });
  assert.throws(
    () => release({ ...base, mode: 'adhoc', env: {} }, tools),
    /making the disk image failed:\nfictional failure/,
  );
});

test('ad-hoc and unsigned runs never notarize, sign the image or run Gatekeeper', () => {
  for (const mode of ['adhoc', 'unsigned']) {
    const { tools, calls, written } = fakeTools();
    release({ ...base, mode, env: { ...signing, ...apiKey } }, tools);
    assert.ok(
      !calls.some(
        (call) =>
          call[1] === 'notarytool' ||
          call[1] === 'stapler' ||
          call[0] === 'spctl',
      ),
    );
    const signs = calls.filter(
      (call) => call[0] === 'codesign' && call[1] === '--force',
    );
    if (mode === 'unsigned') assert.equal(signs.length, 0);
    else {
      assert.equal(signs.length, 1);
      assert.equal(signs[0][signs[0].indexOf('--sign') + 1], '-');
      assert.ok(signs[0].includes('--timestamp=none'));
    }
    const manifest = JSON.parse(
      written[
        `/fictional/out/TalkQTE_0.1.0_aarch64_${LABEL[mode]}.manifest.json`
      ],
    );
    assert.equal(manifest.release, false);
  }
});

test('building passes no signing variable to the build and signs a copy', () => {
  const { tools, calls } = fakeTools();
  let buildEnv;
  const run = tools.run;
  tools.run = (command, args, extra = {}) => {
    if (command === process.execPath) buildEnv = extra.env;
    return run(command, args, extra);
  };
  release(
    {
      ...base,
      app: undefined,
      targetDir: '/fictional/target',
      mode: 'signed',
      env: { PATH: '/usr/bin', ...signing },
    },
    tools,
  );
  assert.deepEqual(buildEnv, { PATH: '/usr/bin' });
  const build = calls.find((call) => call[0] === process.execPath);
  assert.ok(build.includes('--no-sign'));
  const copy = calls.find((call) => call[0] === 'ditto');
  assert.equal(copy[1], '/fictional/target/release/bundle/macos/TalkQTE.app');
  assert.equal(copy[2], '/fictional/out/work/TalkQTE.app');
});

test('the command refuses missing credentials before building and explains them in a dry run', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const real = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
  assert.equal(real.status, 2);
  assert.match(real.stderr, /cannot make a notarized build/);
  assert.match(real.stderr, /APPLE_SIGNING_IDENTITY is not set/);
  assert.doesNotMatch(real.stdout, /Build the bundle/);

  const dry = spawnSync(process.execPath, [SCRIPT, '--dry-run'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(dry.status, 2);
  assert.match(dry.stdout, /Build the bundle/);
  assert.match(dry.stdout, /notarytool submit/);
  assert.match(dry.stdout, /Dry run: nothing was built, signed or sent/);

  const adhoc = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--adhoc'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(adhoc.status, 0, adhoc.stderr);
  assert.match(adhoc.stdout, /NOT A RELEASE/);
  assert.match(adhoc.stdout, /adhoc-not-for-release\.dmg/);
});

test('the downloads are verified as they come out of the zip and the image', () => {
  const { tools, calls } = fakeTools();
  release(
    { ...base, mode: 'notarized', env: { ...signing, ...apiKey } },
    tools,
  );
  const verified = calls
    .filter((call) => call[0] === 'codesign' && call[1] === '--verify')
    .map((call) => call.at(-1));
  assert.ok(verified.includes('/fictional/out/work/from-zip/TalkQTE.app'));
  assert.ok(verified.includes('/fictional/out/work/from-dmg/TalkQTE.app'));
  const attach = calls.findIndex(
    (call) => call[0] === 'hdiutil' && call[1] === 'attach',
  );
  const detach = calls.findIndex(
    (call) => call[0] === 'hdiutil' && call[1] === 'detach',
  );
  assert.ok(attach > 0 && detach > attach);
  // The image is detached even when a check of its copy fails.
  const failing = fakeTools({
    fail: (command, args) =>
      command === 'codesign' &&
      args[0] === '--verify' &&
      args.at(-1).includes('from-dmg'),
  });
  assert.throws(
    () => release({ ...base, mode: 'adhoc', env: {} }, failing.tools),
    /verifying from-dmg/,
  );
  assert.ok(
    failing.calls.some((call) => call[0] === 'hdiutil' && call[1] === 'detach'),
  );
});
