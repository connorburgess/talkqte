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
  DEEPGRAM_APP_QUERY_MULTI,
  deepgramAppQuery,
  isAllowedSttQuery,
  isAppQuery,
  DEEPGRAM_GRANT_TTL_S,
  mintDeepgramGrant,
  readDeepgramKeyFile,
  REFUSED_PROBE_TOKEN,
  refusedTokenProbe,
} from './cue-lab-deepgram.mjs';
import {
  isLabUserName,
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
async function launchCloud(
  t,
  fixtureCase,
  grant,
  { minuteCap = 5, reconnect, userName, language } = {},
) {
  const launcher = prepareLabFixtureLauncher({
    fixtureCase,
    selection: apiSelection,
    ...(userName === undefined ? {} : { userName }),
    transcription: {
      backend: 'deepgram',
      minuteCap,
      ...(language === undefined ? {} : { language }),
      // `grant: 'refused-token'` here launches the provider-failure probe.
      ...(grant === 'refused-token'
        ? { failureProbe: grant }
        : { grant, ...(reconnect === undefined ? {} : { reconnect }) }),
    },
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

test('a plan asks for multilingual explicitly, and for no other language', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const { launcher, owner, seen } = await launchCloud(
    t,
    'cloud-transcription',
    await mint(api),
    { language: 'multi' },
  );
  assert.equal(seen().TALKQTE_DEV_STT_LANGUAGE, 'multi');
  assert.equal(launcher.transcription.language, 'multi');
  await owner.stop().catch(() => {});
  // Any other value is refused before anything is launched.
  for (const language of ['', 'EN', 'de', 'auto', null])
    assert.throws(() =>
      prepareLabFixtureLauncher({
        fixtureCase: 'cloud-transcription',
        selection: apiSelection,
        transcription: { backend: 'deepgram', minuteCap: 5, language },
      }),
    );
});

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
  // A plan without a language keeps English: no language setting at all.
  assert.equal(Object.hasOwn(env, 'TALKQTE_DEV_STT_LANGUAGE'), false);
  assert.equal(launcher.transcription.language, 'en');
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
    language: 'en',
    grantTtlS: 900,
    failureProbe: null,
    reviewedSession: 2,
    released: true,
    started: true,
    tokenRemoved: true,
    tokenKeptUntilStop: false,
    reconnects: 0,
  });
  assert.deepEqual(await owner.stop(), { released: true });
});

const waitFor = async (check, tries = 200) => {
  for (let n = 0; n < tries && !check(); n++) await delay(10);
};
const reviewThenRelease = async (launcher) => {
  await waitFor(() => launcher.transcription.reviewedSession !== null);
  launcher.releaseTranscriptionToken();
};

test('with reconnect the token stays until Stop, each replacement reconnects with the same query, and close removes it', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const { launcher, owner, failures } = await launchCloud(
    t,
    'cloud-reconnect',
    await mint(api),
    { reconnect: true },
  );
  const tokenFile = join(launcher.directory, 'stt-token');
  await reviewThenRelease(launcher);
  await waitFor(() => launcher.transcription.reconnects === 2);
  await delay(50);
  assert.equal(launcher.transcription.reconnects, 2);
  assert.equal(failures.includes('failed'), false);
  // A valid token is on disk, owner-only, for the length of the run.
  assert.equal(existsSync(tokenFile), true);
  assert.equal(lstatSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(launcher.transcription.tokenKeptUntilStop, true);
  assert.equal(launcher.transcription.tokenRemoved, false);
  assert.deepEqual(await owner.stop(), { released: true });
  launcher.close();
  assert.equal(existsSync(tokenFile), false);
  assert.equal(launcher.transcription.tokenRemoved, true);
});

test('a failed pending replacement spends the second attempt before Connected without losing the token', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const { launcher, owner, failures } = await launchCloud(
    t,
    'cloud-reconnect-pending',
    await mint(api),
    { reconnect: true },
  );
  await reviewThenRelease(launcher);
  await waitFor(() => launcher.transcription.reconnects === 2);
  await delay(50);
  assert.equal(launcher.transcription.reconnects, 2);
  assert.equal(failures.includes('failed'), false);
  const states = readFileSync(launcher.timingPath, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter(
      (r) =>
        r.event === 'stt_state' &&
        ['connected', 'reconnecting'].includes(r.state),
    );
  assert.deepEqual(
    states.map((r) => r.state),
    ['connected', 'reconnecting', 'reconnecting', 'connected'],
  );
  assert.equal(states[0].query, states[3].query);
  assert.equal(existsSync(join(launcher.directory, 'stt-token')), true);
  assert.deepEqual(await owner.stop(), { released: true });
  launcher.close();
  assert.equal(existsSync(join(launcher.directory, 'stt-token')), false);
});

for (const [name, fixtureCase, reconnect] of [
  ['a run that did not allow reconnects', 'cloud-reconnect', undefined],
  ['an eleventh replacement', 'cloud-reconnect-over-cap', true],
  ['an eleventh pending replacement', 'cloud-reconnect-pending-over-cap', true],
  ['before the first confirmed query', 'cloud-reconnect-before-first', true],
  ['another session', 'cloud-reconnect-other-session', true],
  ['a changed query', 'cloud-reconnect-changed-query', true],
  ['pending replacements without opt-in', 'cloud-reconnect-pending', undefined],
])
  test(`a reconnect in ${name} stops the run`, async (t) => {
    const api = await fakeGrant();
    t.after(api.close);
    const { launcher, owner, failures } = await launchCloud(
      t,
      fixtureCase,
      await mint(api),
      reconnect ? { reconnect } : {},
    );
    await reviewThenRelease(launcher);
    await waitFor(() => failures.includes('failed'));
    assert.ok(failures.includes('failed'));
    await owner.stop().catch(() => {});
    launcher.close();
    assert.equal(existsSync(join(launcher.directory, 'stt-token')), false);
  });

test("the listener's name reaches the app only as its name setting, and the app's row says it was in effect", async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const { launcher, owner, seen } = await launchCloud(
    t,
    'cloud-transcription',
    await mint(api),
    { userName: 'Curtis' },
  );
  assert.equal(seen().TALKQTE_DEV_USER_NAME, 'Curtis');
  assert.equal(seen().args.includes('Curtis'), false);
  await waitFor(() => launcher.userName.setAtStart !== null);
  assert.deepEqual(
    { ...launcher.userName },
    { requested: true, setAtStart: true, session: 2, changes: 0, held: true },
  );
  // Evidence is a boolean, never the name.
  assert.equal(JSON.stringify(launcher.userName).includes('Curtis'), false);
  assert.deepEqual(await owner.stop(), { released: true });
});

test('without a name the launch sets none, and the row says so', async (t) => {
  const api = await fakeGrant();
  t.after(api.close);
  const { launcher, owner, seen } = await launchCloud(
    t,
    'cloud-transcription',
    await mint(api),
  );
  assert.equal(Object.hasOwn(seen(), 'TALKQTE_DEV_USER_NAME'), false);
  await waitFor(() => launcher.userName.setAtStart !== null);
  assert.deepEqual(
    { ...launcher.userName },
    { requested: false, setAtStart: false, session: 2, changes: 0, held: null },
  );
  assert.deepEqual(await owner.stop(), { released: true });
});

test("a name the app's own rule would refuse is refused before launch", () => {
  for (const userName of [
    '',
    ' Curtis',
    'Curtis ',
    'Robin<script>',
    '- -',
    'x'.repeat(41),
    7,
  ])
    assert.throws(
      () =>
        prepareLabFixtureLauncher({
          fixtureCase: 'normal',
          selection: apiSelection,
          transcription: {
            backend: 'deepgram',
            minuteCap: 5,
            grant: { writeTokenFile() {} },
          },
          userName,
        }),
      undefined,
      JSON.stringify(userName),
    );
  for (const userName of ['Curtis', 'Anne-Marie', "D'Arcy", 'José', 'Mary Ann'])
    assert.equal(isLabUserName(userName), true, userName);
});

test('a refused-token probe takes no grant, hands the app only its fixed text after the review, and records itself', async (t) => {
  const { launcher, owner, seen } = await launchCloud(
    t,
    'cloud-refused',
    'refused-token',
  );
  const tokenFile = join(launcher.directory, 'stt-token');
  assert.equal(seen().TALKQTE_DEV_STT_BACKEND, 'deepgram');
  assert.equal(lstatSync(tokenFile).size, 0);
  await waitFor(() => launcher.transcription.reviewedSession !== null);
  launcher.releaseTranscriptionToken();
  assert.throws(() => launcher.releaseTranscriptionToken());
  assert.equal(readFileSync(tokenFile, 'utf8'), REFUSED_PROBE_TOKEN);
  assert.equal(lstatSync(tokenFile).mode & 0o777, 0o600);
  await waitFor(() => launcher.transcription.started);
  await delay(100);
  assert.deepEqual(
    { ...launcher.transcription },
    {
      backend: 'deepgram',
      minuteCap: 5,
      language: 'en',
      grantTtlS: null,
      failureProbe: 'refused-token',
      reviewedSession: 2,
      released: true,
      started: true,
      connectedQuery: null,
      tokenRemoved: false,
      tokenKeptUntilStop: false,
      reconnects: 0,
    },
  );
  assert.deepEqual(await owner.stop(), { released: true });
  launcher.close();
  assert.equal(existsSync(tokenFile), false);
});

test('a probe whose refused text connects stops the run: it is not the take the plan asked for', async (t) => {
  const { launcher, owner, failures } = await launchCloud(
    t,
    'cloud-probe-connects',
    'refused-token',
  );
  await waitFor(() => launcher.transcription.reviewedSession !== null);
  launcher.releaseTranscriptionToken();
  await waitFor(() => failures.includes('failed'));
  assert.ok(failures.includes('failed'));
  assert.equal(launcher.transcription.connectedQuery, null);
  await owner.stop().catch(() => {});
});

test('the probe is its own shape: never beside a grant or reconnect, never capture-only, and a grant cannot pose as one', () => {
  const grant = { writeTokenFile() {} };
  for (const [mode, transcription] of [
    ['model-enabled', { failureProbe: 'refused-token', grant }],
    ['model-enabled', { failureProbe: 'refused-token', reconnect: true }],
    ['model-enabled', { failureProbe: 'unusable' }],
    ['model-enabled', { failureProbe: true }],
    ['model-enabled', { grant: { ...grant, probe: 'refused-token' } }],
    ['model-enabled', { grant: refusedTokenProbe() }],
    ['capture-only', { failureProbe: 'refused-token' }],
  ])
    assert.throws(
      () =>
        prepareLabFixtureLauncher({
          fixtureCase: 'normal',
          mode,
          ...(mode === 'capture-only' ? {} : { selection: apiSelection }),
          transcription: {
            backend: 'deepgram',
            minuteCap: 5,
            ...transcription,
          },
        }),
      undefined,
      JSON.stringify(transcription),
    );
});

test('the probe writes its fixed text once, only into an owner-only folder', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tq-probe-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o755);
  assert.throws(() => refusedTokenProbe().writeTokenFile(join(dir, 'a')), {
    category: 'token',
  });
  chmodSync(dir, 0o700);
  const probe = refusedTokenProbe();
  probe.writeTokenFile(join(dir, 'b'));
  assert.equal(readFileSync(join(dir, 'b'), 'utf8'), REFUSED_PROBE_TOKEN);
  assert.throws(() => probe.writeTokenFile(join(dir, 'c')), {
    category: 'token',
  });
  // The text has the shape the app's token file accepts, and is no grant.
  assert.match(REFUSED_PROBE_TOKEN, /^[A-Za-z0-9_-]{20,4096}$/);
});

test('reconnect is only `true` and only on a model run with a grant', () => {
  for (const reconnect of [false, 'yes', 1])
    assert.throws(() =>
      prepareLabFixtureLauncher({
        fixtureCase: 'normal',
        selection: apiSelection,
        transcription: {
          backend: 'deepgram',
          minuteCap: 5,
          grant: { writeTokenFile() {} },
          reconnect,
        },
      }),
    );
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
  const rust = readFileSync(source, 'utf8');
  const en = rust.match(/const QUERY_EN: &str = "([^"]*)";/);
  const multi = rust.match(/const QUERY_MULTI: &str = "([^"]*)";/);
  assert.ok(en && multi, 'QUERY_EN or QUERY_MULTI constant not found');
  assert.equal(en[1], DEEPGRAM_APP_QUERY);
  assert.equal(multi[1], DEEPGRAM_APP_QUERY_MULTI);
});

test('exactly the two app queries are accepted, and only en or multi selects one', () => {
  assert.equal(deepgramAppQuery(), DEEPGRAM_APP_QUERY);
  assert.equal(deepgramAppQuery('en'), DEEPGRAM_APP_QUERY);
  assert.equal(deepgramAppQuery('multi'), DEEPGRAM_APP_QUERY_MULTI);
  for (const bad of ['', 'EN', 'auto', 'de', null, 'constructor'])
    assert.throws(
      () => deepgramAppQuery(bad),
      /invalid transcription language/,
    );
  assert.ok(isAppQuery(DEEPGRAM_APP_QUERY));
  assert.ok(isAppQuery(DEEPGRAM_APP_QUERY_MULTI));
  for (const near of [
    DEEPGRAM_APP_QUERY.replace('language=en', 'language=multi'),
    DEEPGRAM_APP_QUERY_MULTI.replace('endpointing=100', 'endpointing=600'),
    DEEPGRAM_APP_QUERY.replace('language=en', 'language=de'),
    DEEPGRAM_APP_QUERY + '&detect_language=true',
  ])
    assert.equal(isAppQuery(near), false, near);
  // Both pass the connected-row allowlist; it has no new parameter name.
  assert.ok(isAllowedSttQuery(DEEPGRAM_APP_QUERY_MULTI));
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
