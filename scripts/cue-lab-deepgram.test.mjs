// Offline only: a loopback stand-in for the grant endpoint and dummy keys.
// No test reaches the network or reads a real key.
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEEPGRAM_APP_QUERY,
  DEEPGRAM_GRANT_TTL_S,
  mintDeepgramGrant,
  readDeepgramKeyFile,
} from './cue-lab-deepgram.mjs';
import {
  prepareLabFixtureLauncher,
  removeStaleTranscriptionTokens,
} from './cue-lab-launcher.mjs';
import { createLabNativeOwner } from './cue-lab-native-owner.mjs';

const KEY = 'offlinefictionalkey0001';
const TOKEN = 'fictional.offline-grant_token.0123456789';

async function fakeGrant(reply = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    requests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body,
    });
    const status = reply.status ?? 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      reply.raw ??
        JSON.stringify(
          status === 200
            ? {
                access_token: reply.token ?? TOKEN,
                expires_in: reply.expiresIn ?? DEEPGRAM_GRANT_TTL_S,
              }
            : { err_msg: 'fictional provider message ' + KEY },
        ),
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}
const mint = (api, extra = {}) =>
  mintDeepgramGrant({ offline: { baseUrl: api.baseUrl, key: KEY }, ...extra });

// An owner-only folder outside the repository and temporary directories, as
// the app requires for its token file's parent.
function privateDir(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tq-stt-')));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a grant is one POST with the key as a Token header and a 900 s TTL; the token is never a property', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const grant = await mint(api);
  assert.equal(api.requests.length, 1);
  const [r] = api.requests;
  assert.deepEqual(
    [r.method, r.path, r.authorization, JSON.parse(r.body)],
    ['POST', '/v1/auth/grant', `Token ${KEY}`, { ttl_seconds: 900 }],
  );
  assert.equal(grant.ttlSeconds, 900);
  assert.equal(grant.expiresInS, 900);
  assert.equal(JSON.stringify(grant).includes(TOKEN), false);
  assert.equal(Object.values(grant).includes(TOKEN), false);
  const dir = privateDir(t);
  const file = join(dir, 'stt-token');
  grant.writeTokenFile(file);
  const stat = lstatSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(readFileSync(file, 'utf8'), TOKEN);
  // One use only.
  assert.throws(() => grant.writeTokenFile(join(dir, 'again')), {
    category: 'token',
  });
});

test('refused, unpaid and rate-limited grants stop with fixed categories and no provider text', async (t) => {
  for (const [status, category] of [
    [401, 'auth'],
    [403, 'auth'],
    [402, 'quota'],
    [429, 'rate-limited'],
    [500, 'provider'],
  ]) {
    const api = await fakeGrant({ status });
    try {
      const error = await mint(api).then(
        () => assert.fail('minted'),
        (e) => e,
      );
      assert.equal(error.category, category);
      assert.equal(String(error.message).includes(KEY), false);
      assert.equal(String(error.message).includes('fictional'), false);
      assert.equal(api.requests.length, 1);
    } finally {
      await api.close();
    }
  }
});

test('a reply without a usable token or TTL is a protocol failure', async (t) => {
  for (const reply of [
    { raw: 'not json' },
    { token: 'short' },
    { token: 'has space in the token value here' },
    { expiresIn: 60 },
    { expiresIn: 1800 },
  ]) {
    const api = await fakeGrant(reply);
    try {
      await assert.rejects(mint(api), { category: 'protocol' });
    } finally {
      await api.close();
    }
  }
});

test('the token file is written only into an owner-only folder, never over an existing file', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const open = privateDir(t);
  chmodSync(open, 0o755);
  const g1 = await mint(api);
  assert.throws(() => g1.writeTokenFile(join(open, 'stt-token')), {
    category: 'token',
  });
  const dir = privateDir(t);
  writeFileSync(join(dir, 'stt-token'), 'x', { mode: 0o600 });
  const g2 = await mint(api);
  assert.throws(() => g2.writeTokenFile(join(dir, 'stt-token')));
  assert.equal(readFileSync(join(dir, 'stt-token'), 'utf8'), 'x');
});

test('the Deepgram key file follows the lab key rules and accepts only a plain key', (t) => {
  const root = realpathSync(mkdtempSync(join(homedir(), '.tq-dg-key-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'talkqte-lab');
  mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, 'deepgram.env');
  const put = (text, mode = 0o600) => {
    rmSync(file, { force: true });
    writeFileSync(file, text, { mode });
    chmodSync(file, mode);
  };
  put(`TALKQTE_LAB_DEEPGRAM_KEY=${KEY}\n`);
  assert.equal(readDeepgramKeyFile({ file }), KEY);
  for (const [text, mode] of [
    [`TALKQTE_LAB_DEEPGRAM_KEY=${KEY}\n`, 0o644],
    [`TALKQTE_LAB_ANTHROPIC_KEY=${KEY}\n`, 0o600],
    ['TALKQTE_LAB_DEEPGRAM_KEY=short\n', 0o600],
    ['TALKQTE_LAB_DEEPGRAM_KEY=has-dash-0123456789abc\n', 0o600],
  ]) {
    put(text, mode);
    assert.throws(() => readDeepgramKeyFile({ file }), {
      category: 'credentials',
    });
  }
  // Inside the temporary directory is refused outright.
  const tmp = privateDir(t);
  const inTmp = join(tmp, 'deepgram.env');
  writeFileSync(inTmp, `TALKQTE_LAB_DEEPGRAM_KEY=${KEY}\n`, { mode: 0o600 });
  assert.throws(() => readDeepgramKeyFile({ file: inTmp }), {
    category: 'credentials',
  });
});

// Launcher: the token reaches the app only as a file path; the file goes
// once the stream has opened, and on every other exit.
const apiSelection = {
  provider: 'anthropic-api',
  model: 'claude-opus-5-5',
  effort: 'low',
  maxCalls: 2,
};
async function launchCloud(t, fixtureCase, grant, { minuteCap = 5 } = {}) {
  const launcher = prepareLabFixtureLauncher({
    fixtureCase,
    selection: apiSelection,
    transcription: { backend: 'deepgram', minuteCap, grant },
  });
  t.after(() => {
    launcher.close();
    rmSync(launcher.directory, { recursive: true, force: true });
  });
  const original = childProcess.spawn;
  let seen;
  mock.method(childProcess, 'spawn', (command, args, options) => {
    seen = { ...options.env, args };
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const descriptor = join(launcher.directory, 'descriptor.json');
  writeFileSync(descriptor, '{}', { mode: 0o600 });
  const failures = [];
  const owner = createLabNativeOwner({
    executable: launcher.executable,
    launch: launcher.launch,
    stopAfterS: 120,
    armingMs: 1200,
    releaseMs: 300,
  });
  owner.subscribe((event) => failures.push(event.type));
  await owner.start({
    descriptorPath: descriptor,
    runId: 'fixture-run',
    metadata: { ...apiSelection, spendCapMicroUsd: 1_000_000 },
  });
  return { launcher, owner, seen: () => seen, failures };
}

test('the app gets only an empty placeholder until the review row; the token follows, and goes once the stream connects', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const grant = await mint(api);
  const { launcher, owner, seen } = await launchCloud(
    t,
    'cloud-transcription',
    grant,
  );
  const env = seen();
  const tokenFile = join(launcher.directory, 'stt-token');
  assert.equal(env.TALKQTE_DEV_STT_BACKEND, 'deepgram');
  assert.equal(env.TALKQTE_DEV_STT_TOKEN_FILE, tokenFile);
  assert.equal(env.TALKQTE_DEV_STT_MINUTE_CAP, '5');
  assert.equal(Object.hasOwn(env, 'TALKQTE_WHISPER_MODEL'), false);
  // Neither the key nor the token is in the environment or arguments.
  assert.equal(JSON.stringify(env).includes(TOKEN), false);
  assert.equal(JSON.stringify(env).includes(KEY), false);
  // Before the review: an empty owner-only placeholder, no token anywhere.
  assert.equal(lstatSync(tokenFile).size, 0);
  assert.equal(lstatSync(tokenFile).mode & 0o777, 0o600);
  for (
    let n = 0;
    n < 100 && launcher.transcription.reviewedSession === null;
    n++
  )
    await delay(10);
  assert.equal(launcher.transcription.reviewedSession, 2);
  assert.equal(lstatSync(tokenFile).size, 0);
  // What the take does after accepting the review and opening the provider.
  launcher.releaseTranscriptionToken();
  assert.throws(() => launcher.releaseTranscriptionToken());
  for (
    let n = 0;
    n < 200 && launcher.transcription.connectedQuery === null;
    n++
  )
    await delay(10);
  assert.match(launcher.transcription.connectedQuery, /(^|&)mip_opt_out=true$/);
  assert.equal(existsSync(tokenFile), false);
  assert.equal(existsSync(join(launcher.directory, 'stt-token.next')), false);
  const facts = { ...launcher.transcription };
  delete facts.connectedQuery;
  assert.deepEqual(facts, {
    backend: 'deepgram',
    minuteCap: 5,
    grantTtlS: 900,
    reviewedSession: 2,
    released: true,
    started: true,
    tokenRemoved: true,
  });
  assert.deepEqual(await owner.stop(), { released: true });
});

test('the token cannot be released before the review row', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const { launcher, owner } = await launchCloud(t, 'normal', await mint(api));
  assert.throws(() => launcher.releaseTranscriptionToken());
  assert.equal(lstatSync(join(launcher.directory, 'stt-token')).size, 0);
  assert.deepEqual(await owner.stop(), { released: true });
});

for (const [name, fixtureCase] of [
  ['before the review row', 'cloud-early'],
  ['in a session other than the reviewed one', 'cloud-other-session'],
])
  test(`a stream that opens ${name} stops the run`, async (t) => {
    const api = await fakeGrant();
    t.after(api.close);
    const { launcher, owner, failures } = await launchCloud(
      t,
      fixtureCase,
      await mint(api),
    );
    for (let n = 0; n < 100 && !failures.includes('failed'); n++)
      await delay(10);
    assert.ok(failures.includes('failed'));
    assert.equal(launcher.transcription.started, false);
    await owner.stop().catch(() => {});
    launcher.close();
    assert.equal(existsSync(join(launcher.directory, 'stt-token')), false);
  });

test('the token file is deleted at close when the stream never opened', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const { launcher, owner } = await launchCloud(t, 'normal', await mint(api));
  const tokenFile = join(launcher.directory, 'stt-token');
  assert.equal(existsSync(tokenFile), true);
  assert.deepEqual(await owner.stop(), { released: true });
  launcher.close();
  assert.equal(existsSync(tokenFile), false);
  assert.equal(launcher.transcription.tokenRemoved, true);
});

test('a failed launch leaves no token file', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const launcher = prepareLabFixtureLauncher({
    fixtureCase: 'normal',
    selection: apiSelection,
    transcription: {
      backend: 'deepgram',
      minuteCap: 5,
      grant: await mint(api),
    },
  });
  t.after(() => rmSync(launcher.directory, { recursive: true, force: true }));
  // A launch with the wrong run environment is refused after nothing spawns.
  assert.throws(() =>
    launcher.launch({
      executable: launcher.executable,
      environment: { TALKQTE_DEV_STOP_SIGNAL: 'usr2' },
      onTiming() {},
    }),
  );
  assert.equal(existsSync(join(launcher.directory, 'stt-token')), false);
});

test('cloud transcription is refused off the direct API route, in capture-only mode and with a Whisper model', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const grant = await mint(api);
  const transcription = { backend: 'deepgram', minuteCap: 5, grant };
  for (const options of [
    {
      selection: {
        provider: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'low',
        maxCalls: 2,
      },
      transcription,
    },
    { mode: 'capture-only', transcription },
    {
      selection: apiSelection,
      transcription: { ...transcription, minuteCap: 0 },
    },
    {
      selection: apiSelection,
      transcription: { ...transcription, minuteCap: 61 },
    },
    {
      selection: apiSelection,
      transcription: { ...transcription, backend: 'whisper' },
    },
  ])
    assert.throws(() =>
      prepareLabFixtureLauncher({ fixtureCase: 'normal', ...options }),
    );
});

test('the grant refuses TLS or code-loading Node settings, even empty, and a substitute fetch without the stand-in', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  for (const name of [
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
    'NODE_USE_ENV_PROXY',
  ])
    await assert.rejects(mint(api, { environment: { [name]: '' } }), {
      category: 'environment',
    });
  // A custom fetch is accepted only with the offline stand-in, so the real
  // key can only ever go through the platform fetch.
  await assert.rejects(
    mintDeepgramGrant({ fetch: async () => new Response('{}') }),
    { category: 'configuration' },
  );
  assert.equal(api.requests.length, 0);
});

// The lab's expected query must be the app's own constant. The app's source
// arrives with #344; in a checkout without it this test says so and skips.
test("the lab's expected query is the app's QUERY constant", (t) => {
  const source = new URL(
    '../src-tauri/src/transcription/deepgram.rs',
    import.meta.url,
  );
  if (!existsSync(source)) {
    t.skip('src-tauri/src/transcription/deepgram.rs is not in this checkout');
    return;
  }
  const match = readFileSync(source, 'utf8').match(
    /const QUERY: &str = "([^"]*)";/,
  );
  assert.ok(match, 'QUERY constant not found');
  assert.equal(match[1], DEEPGRAM_APP_QUERY);
});

test('the stale-token sweep removes tokens only from runs that have provably ended, never a live one', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tq-stale-root-')));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const DEAD = 2147480001;
  const run = (name, { mode = 0o700, pid } = {}) => {
    const path = join(root, name);
    mkdirSync(path);
    chmodSync(path, mode);
    if (pid !== undefined)
      writeFileSync(join(path, 'runner.pid'), String(pid), { mode: 0o600 });
    writeFileSync(join(path, 'stt-token'), TOKEN, { mode: 0o600 });
    return path;
  };
  const ended = run('tq-owned-dead01', { pid: DEAD });
  writeFileSync(join(ended, 'stt-token.next'), TOKEN, { mode: 0o600 });
  // A concurrent run in this very process: its runner is alive.
  const live = run('tq-owned-live01', { pid: process.pid });
  const recent = run('tq-owned-new001');
  const open = run('tq-owned-open01', { mode: 0o755, pid: DEAD });
  const other = run('not-a-run-folder', { pid: DEAD });
  const alive = (pid) => pid !== DEAD;
  assert.equal(
    removeStaleTranscriptionTokens({ temporaryRoot: root, alive }),
    2,
  );
  assert.equal(existsSync(join(ended, 'stt-token')), false);
  assert.equal(existsSync(join(ended, 'stt-token.next')), false);
  assert.equal(existsSync(join(live, 'stt-token')), true);
  assert.equal(existsSync(join(recent, 'stt-token')), true);
  assert.equal(existsSync(join(open, 'stt-token')), true);
  assert.equal(existsSync(join(other, 'stt-token')), true);
  // Without a pid record, only a folder untouched for longer than the
  // 900 s token TTL counts as ended; the live run still never does.
  const later = Date.now() + 2 * 3600 * 1000;
  assert.equal(
    removeStaleTranscriptionTokens({ temporaryRoot: root, alive, now: later }),
    1,
  );
  assert.equal(existsSync(join(recent, 'stt-token')), false);
  assert.equal(existsSync(join(live, 'stt-token')), true);
});

test('a launcher run folder records its runner pid for the sweep', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const launcher = prepareLabFixtureLauncher({
    fixtureCase: 'normal',
    selection: apiSelection,
    transcription: {
      backend: 'deepgram',
      minuteCap: 5,
      grant: await mint(api),
    },
  });
  t.after(() => {
    launcher.close();
    rmSync(launcher.directory, { recursive: true, force: true });
  });
  const pidFile = join(launcher.directory, 'runner.pid');
  assert.equal(readFileSync(pidFile, 'utf8'), String(process.pid));
  assert.equal(lstatSync(pidFile).mode & 0o777, 0o600);
});

test("the grant checks this process's own environment even when a clean one is passed", async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  process.env.NODE_EXTRA_CA_CERTS = '';
  t.after(() => delete process.env.NODE_EXTRA_CA_CERTS);
  await assert.rejects(mint(api, { environment: { PATH: '/bin' } }), {
    category: 'environment',
  });
  assert.equal(api.requests.length, 0);
});

test('a capture-only launch gets the transcription setting with an empty placeholder only, never a token', async (t) => {
  const launcher = prepareLabFixtureLauncher({
    fixtureCase: 'capture-only',
    mode: 'capture-only',
    stopAfterS: 110,
    transcription: { backend: 'deepgram', minuteCap: 5 },
  });
  t.after(() => rmSync(launcher.directory, { recursive: true, force: true }));
  const original = childProcess.spawn;
  let seen;
  mock.method(childProcess, 'spawn', (command, args, options) => {
    seen = options.env;
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const owner = createLabNativeOwner({
    executable: launcher.executable,
    launch: launcher.launch,
    mode: 'capture-only',
    stopAfterS: 110,
    armingMs: 1000,
    releaseMs: 1000,
  });
  const tokenFile = join(launcher.directory, 'stt-token');
  try {
    await owner.start({ runId: 'capture-only-fixture' });
    assert.equal(seen.TALKQTE_DEV_STT_BACKEND, 'deepgram');
    assert.equal(seen.TALKQTE_DEV_STT_TOKEN_FILE, tokenFile);
    assert.equal(seen.TALKQTE_DEV_STT_MINUTE_CAP, '5');
    assert.equal(
      Object.keys(seen).some((k) =>
        /CUE_BACKEND|MODEL_CONNECTION|LAB_PROVIDER|DESCRIPTOR/.test(k),
      ),
      false,
    );
    assert.equal(lstatSync(tokenFile).size, 0);
    // There is no grant, so no token can ever be released.
    assert.throws(() => launcher.releaseTranscriptionToken());
    assert.equal(launcher.transcription.grantTtlS, null);
    assert.deepEqual(await owner.stop(), { released: true });
  } finally {
    launcher.close();
  }
  assert.equal(existsSync(tokenFile), false);
  // A grant is refused in capture-only mode, and the setting is required.
  const api = await fakeGrant();
  t.after(api.close);
  const grant = await mint(api);
  assert.throws(() =>
    prepareLabFixtureLauncher({
      fixtureCase: 'capture-only',
      mode: 'capture-only',
      transcription: { backend: 'deepgram', minuteCap: 5, grant },
    }),
  );
});
