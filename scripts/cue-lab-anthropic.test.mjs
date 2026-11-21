import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, mock } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_CUE_ON_SCREEN_SCHEMA,
  ANTHROPIC_DECISION_SCHEMA,
  ANTHROPIC_SPEND_CAP_MICRO_USD,
  anthropicEnvironmentNames,
  anthropicSystemPrompt,
  buildAnthropicParams,
  costMicroUsd,
  readAnthropicKeyFile,
  runAnthropicRequest,
  worstCaseMicroUsd,
} from './cue-lab-anthropic-core.mjs';
import { openAnthropicLab } from './cue-lab-anthropic.mjs';
import { openLabProvider } from './cue-lab-provider.mjs';
import { assertSubscriptionEnvironment } from './cue-lab-codex.mjs';
import { CONTRACT, systemPromptFor } from './cue-lab.mjs';

// Fictional inputs only; the key is a dummy that never reaches a network.
const KEY = 'sk-ant-api-offline-fictional';
const input = {
  events: [
    { id: 's1', speaker: 'Speaker', text: 'The fictional rota has two gaps.' },
  ],
  existingCue: null,
};
const decision = { action: 'quiet', cue: null, sourceIds: ['s1'] };

// Server-sent events of one streamed Messages API reply.
function sse({
  model = 'claude-opus-5-5',
  text = JSON.stringify(decision),
  stopReason = 'end_turn',
  stopDetails,
  inputTokens = 900,
} = {}) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_fictional',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    ...(text
      ? [
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          },
        ]
      : []),
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        ...(stopDetails ? { stop_details: stopDetails } : {}),
      },
      usage: { output_tokens: 40 },
    },
    { type: 'message_stop' },
  ];
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
}
function fakeFetch(reply = {}, { status = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (status !== 200)
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'x', message: 'x' } }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    return new Response(sse(reply), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return { fetch, calls };
}
const client = (fetch) =>
  new Anthropic({
    apiKey: KEY,
    authToken: null,
    baseURL: 'https://api.anthropic.com',
    maxRetries: 0,
    logLevel: 'off',
    fetch,
  });

test('the request is one streamed call with the fixed schema, stable system prompt and no sampling settings', async () => {
  const f = fakeFetch();
  const { result, text } = await runAnthropicRequest({
    client: client(f.fetch),
    model: 'claude-opus-5-5',
    input,
    budgetMs: 5000,
  });
  assert.equal(result.outcome, 'decision');
  assert.deepEqual(JSON.parse(text), decision);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.anthropic.com/v1/messages');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.output_config, {
    effort: 'low',
    format: { type: 'json_schema', schema: ANTHROPIC_DECISION_SCHEMA },
  });
  for (const k of ['temperature', 'top_p', 'top_k', 'fallbacks', 'thinking'])
    assert.equal(Object.hasOwn(body, k), false, k);
  assert.equal(body.system[0].text, anthropicSystemPrompt());
  assert.deepEqual(JSON.parse(body.messages[0].content), input);
  // The key travels in exactly one header and nowhere else.
  const headers = new Headers(f.calls[0].init.headers);
  const carrying = [...headers].filter(([, v]) => v.includes(KEY));
  assert.deepEqual(carrying, [['authorization', `Bearer ${KEY}`]]);
  assert.equal(headers.has('x-api-key'), false);
  assert.equal(f.calls[0].url.includes(KEY), false);
  assert.equal(f.calls[0].init.body.includes(KEY), false);
  assert.ok(Number.isSafeInteger(result.messageStartMs));
  assert.ok(Number.isSafeInteger(result.firstTextMs));
  assert.deepEqual(result.usage, { input_tokens: 900, output_tokens: 40 });
});

test('thinking is fixed per model and nothing else is accepted', () => {
  assert.equal(
    buildAnthropicParams('claude-opus-5-5', input).thinking,
    undefined,
  );
  assert.equal(
    buildAnthropicParams('claude-haiku-5-5', input).thinking,
    undefined,
  );
  assert.deepEqual(buildAnthropicParams('claude-sonnet-5-5', input).thinking, {
    type: 'between_tools',
  });
  for (const model of ['claude-opus-4-1', 'gpt-6.1-sol', 'claude-haiku-5-5-x'])
    assert.throws(() => buildAnthropicParams(model, input));
});

test('the system prompt is byte-stable and carries no user name or earlier cues', () => {
  const withName = {
    ...input,
    userName: 'Fictional Freya',
    earlierCues: [{ text: 'Fictional cue', state: 'expired' }],
  };
  const a = buildAnthropicParams('claude-opus-5-5', input).system[0].text;
  const b = buildAnthropicParams('claude-opus-5-5', withName).system[0].text;
  assert.equal(a, b);
  assert.equal(a.includes('Fictional Freya'), false);
  // The live prompt with the glance rule and both notes; the subscription
  // routes keep the shared compact prompt.
  const p = CONTRACT.prompts;
  assert.equal(a, p.liveCompact + p.glanceRule + p.nameNote + p.historyNote);
  assert.notEqual(
    a,
    systemPromptFor(withName, { compact: true, glance: true }),
  );
  assert.equal(
    a.includes('a question already asked but still unanswered'),
    false,
  );
  assert.match(a, /With an existing cue, answer quiet to keep it on screen/);
});

test('the schema follows the cue state: no show while a cue is on screen', () => {
  const none = buildAnthropicParams('claude-opus-5-5', input);
  assert.equal(none.output_config.format.schema, ANTHROPIC_DECISION_SCHEMA);
  assert.deepEqual(ANTHROPIC_DECISION_SCHEMA.properties.action.enum, [
    'show',
    'quiet',
  ]);
  const onScreen = buildAnthropicParams('claude-opus-5-5', {
    ...input,
    existingCue: { text: 'Fictional cue?', sourceIds: [input.events[0].id] },
  });
  assert.equal(
    onScreen.output_config.format.schema,
    ANTHROPIC_CUE_ON_SCREEN_SCHEMA,
  );
  assert.deepEqual(ANTHROPIC_CUE_ON_SCREEN_SCHEMA.properties.action.enum, [
    'quiet',
    'resolved',
    'withdraw',
  ]);
  assert.deepEqual(ANTHROPIC_CUE_ON_SCREEN_SCHEMA.properties.cue, {
    type: 'null',
  });
  // Each state's schema is one constant, so its grammar compiles once.
  assert.equal(
    buildAnthropicParams('claude-opus-5-5', input).output_config.format.schema,
    none.output_config.format.schema,
  );
});

test('a refusal, a different model, max tokens and HTTP errors are classified without content', async () => {
  const cases = [
    [
      { stopReason: 'refusal', stopDetails: { category: 'cyber' }, text: '' },
      'refusal',
    ],
    [{ model: 'claude-sonnet-5-5' }, 'configuration-mismatch'],
    [{ stopReason: 'max_tokens' }, 'output-limit'],
  ];
  for (const [reply, outcome] of cases) {
    const f = fakeFetch(reply);
    const { result, text } = await runAnthropicRequest({
      client: client(f.fetch),
      model: 'claude-opus-5-5',
      input,
      budgetMs: 5000,
    });
    assert.equal(result.outcome, outcome);
    assert.equal(text, null);
    if (outcome === 'refusal') assert.equal(result.refusalCategory, 'cyber');
  }
  for (const [status, outcome] of [
    [401, 'auth'],
    [429, 'usage-limit'],
    [500, 'provider'],
  ]) {
    const f = fakeFetch({}, { status });
    const { result } = await runAnthropicRequest({
      client: client(f.fetch),
      model: 'claude-opus-5-5',
      input,
      budgetMs: 5000,
    });
    assert.equal(result.outcome, outcome);
    assert.equal(result.status, status);
    // No retries: exactly one request even for a retryable status.
    assert.equal(f.calls.length, 1);
  }
});

test('an aborted request settles as cancelled', async () => {
  const controller = new AbortController();
  const fetch = (_url, init) =>
    new Promise((_, reject) =>
      init.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      ),
    );
  const pending = runAnthropicRequest({
    client: client(fetch),
    model: 'claude-haiku-5-5',
    input,
    budgetMs: 5000,
    signal: controller.signal,
  });
  controller.abort();
  const { result } = await pending;
  assert.equal(result.outcome, 'cancelled');
});

test('cost and the worst case use the pinned price table; caps are per model', () => {
  assert.equal(
    costMicroUsd('claude-opus-5-5', { input_tokens: 1000, output_tokens: 100 }),
    6000,
  );
  assert.ok(worstCaseMicroUsd('claude-opus-5-5', input) > 20000);
  assert.deepEqual(ANTHROPIC_SPEND_CAP_MICRO_USD, {
    'claude-opus-5-5': 1_000_000,
    'claude-sonnet-5-5': 250_000,
    'claude-haiku-5-5': 250_000,
  });
});

test('every ANTHROPIC_* setting is refused as an ambient credential', () => {
  assert.deepEqual(
    anthropicEnvironmentNames({
      PATH: '/bin',
      ANTHROPIC_PROFILE: 'x',
      ANTHROPIC_LOG: 'debug',
      anthropic_base_url: 'x',
      ANTHROPIC_API_KEY: '',
    }).sort(),
    [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_LOG',
      'ANTHROPIC_PROFILE',
      'anthropic_base_url',
    ],
  );
  // Set but empty still counts, here and in the shared subscription guard.
  assert.throws(
    () => assertSubscriptionEnvironment({ ANTHROPIC_API_KEY: '' }),
    {
      category: 'ambient-credentials',
    },
  );
  assert.doesNotThrow(() => assertSubscriptionEnvironment({ HOME: '' }));
});

// A private key file in an owner-only directory outside any repository.
function keyDir(content, { dirMode = 0o700, fileMode = 0o600 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tq-key-')));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const file = join(home, 'anthropic.env');
  writeFileSync(file, content, { mode: fileMode });
  chmodSync(file, fileMode);
  chmodSync(home, dirMode);
  return {
    root,
    file,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('the key file is read only under owner, mode, location and format rules', () => {
  const ok = keyDir('TALKQTE_LAB_ANTHROPIC_KEY=sk-ant-api03-fictional\n');
  try {
    // The temporary directory itself is a forbidden root, so allow it here.
    assert.equal(
      readAnthropicKeyFile({ file: ok.file, forbiddenRoots: [] }),
      'sk-ant-api03-fictional',
    );
    assert.throws(() => readAnthropicKeyFile({ file: ok.file }), {
      category: 'credentials',
    });
  } finally {
    ok.cleanup();
  }
  const usr = keyDir('TALKQTE_LAB_ANTHROPIC_KEY=sk-ant-usr-fictional\n');
  try {
    assert.equal(
      readAnthropicKeyFile({ file: usr.file, forbiddenRoots: [] }),
      'sk-ant-usr-fictional',
    );
  } finally {
    usr.cleanup();
  }
  for (const [content, opts] of [
    ['TALKQTE_LAB_ANTHROPIC_KEY=sk-ant-admin01-fictional\n', {}],
    ['TALKQTE_LAB_ANTHROPIC_KEY=sk-ant-oat01-fictional\n', {}],
    ['ANTHROPIC_API_KEY=sk-ant-api03-fictional\n', {}],
    ['TALKQTE_LAB_ANTHROPIC_KEY=a\nTALKQTE_LAB_ANTHROPIC_KEY=b\n', {}],
    ['TALKQTE_LAB_ANTHROPIC_KEY=sk-ant-api03-fictional\n', { fileMode: 0o644 }],
    ['TALKQTE_LAB_ANTHROPIC_KEY=sk-ant-api03-fictional\n', { dirMode: 0o755 }],
  ]) {
    const k = keyDir(content, opts);
    try {
      assert.throws(
        () => readAnthropicKeyFile({ file: k.file, forbiddenRoots: [] }),
        (error) =>
          error.category === 'credentials' &&
          !error.message.includes('fictional'),
      );
    } finally {
      chmodSync(join(k.root, 'home'), 0o700);
      k.cleanup();
    }
  }
  const s = keyDir('TALKQTE_LAB_ANTHROPIC_KEY=sk-ant-api03-fictional\n');
  try {
    const link = join(s.root, 'home', 'linked.env');
    symlinkSync(s.file, link);
    assert.throws(() =>
      readAnthropicKeyFile({ file: link, forbiddenRoots: [] }),
    );
  } finally {
    s.cleanup();
  }
});

// A loopback stand-in for the Messages API: the worker process talks to it
// with a dummy key; nothing leaves the machine.
async function fakeApi(replies) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const reply = replies[Math.min(requests.length, replies.length - 1)];
    requests.push({ authorization: req.headers.authorization, body });
    if (reply.hold) return; // never answers; the caller must abort
    if (reply.partial) {
      // Starts the reply (message_start reports output_tokens 1), then
      // stalls before message_delta, as a request cut off by a deadline.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse().split('\n\n')[0] + '\n\n');
      return;
    }
    if (reply.status) {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"x","message":"x"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(reply));
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
const open = (api, extra = {}) =>
  openAnthropicLab({
    model: 'claude-opus-5-5',
    effort: 'low',
    maxCalls: 5,
    deadlineMs: 5000,
    environment: { PATH: process.env.PATH },
    offline: { baseUrl: api.baseUrl, key: KEY },
    ...extra,
  });
const request = (extra = {}) => ({ role: 'cue-evaluator', input, ...extra });

test('the per-run worker answers through the loopback stand-in and keeps content-free receipts', async () => {
  const api = await fakeApi([{}]);
  const session = await open(api);
  try {
    const result = await session.request(request());
    assert.deepEqual(result.value, decision);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].authorization, `Bearer ${KEY}`);
    const [r] = session.receipts;
    assert.equal(r.outcome, 'decision');
    for (const k of ['messageStartMs', 'firstTextMs', 'settledMs'])
      assert.ok(Number.isSafeInteger(r[k]), k);
    assert.deepEqual(r.usage, { input_tokens: 900, output_tokens: 40 });
    assert.equal(r.costMicroUsd, 900 * 4 + 40 * 20);
    assert.equal(JSON.stringify(session.receipts).includes('fictional'), false);
    assert.equal(JSON.stringify(session.receipts).includes(KEY), false);
  } finally {
    await session.close();
    await api.close();
  }
});

test('a refusal ends only that request; the next request is answered', async () => {
  const api = await fakeApi([
    { stopReason: 'refusal', stopDetails: { category: 'cyber' }, text: '' },
    {},
  ]);
  const session = await open(api);
  try {
    await assert.rejects(session.request(request()), { category: 'refusal' });
    assert.deepEqual((await session.request(request())).value, decision);
    assert.equal(session.receipts[0].refusalCategory, 'cyber');
  } finally {
    await session.close();
    await api.close();
  }
});

test('a scoped abort retires only that request and the worker stays usable', async () => {
  const api = await fakeApi([{ hold: true }, {}]);
  const session = await open(api);
  try {
    const controller = new AbortController();
    const pending = session.request(request({ signal: controller.signal }));
    for (let n = 0; n < 100 && api.requests.length < 1; n++)
      await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await assert.rejects(pending, { category: 'cancelled' });
    assert.deepEqual((await session.request(request())).value, decision);
  } finally {
    await session.close();
    await api.close();
  }
});

// Stop only the exact worker created by this test process, never an app or CLI.
for (const mode of [
  'deadline',
  'scoped-abort',
  'root-abort',
  'close',
  'unconfirmed',
]) {
  test(
    'parent bounds a stopped API worker during ' + mode,
    { skip: process.platform === 'win32' },
    async () => {
      const api = await fakeApi([{ hold: true }]);
      const root = new AbortController();
      const session = await open(api, {
        deadlineMs: mode === 'deadline' ? 50 : 5000,
        signal: root.signal,
      });
      const pids = execFileSync('pgrep', ['-P', String(process.pid)], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .map(Number);
      assert.equal(pids.length, 1);
      const pid = pids[0];
      let timer, killMock;
      try {
        process.kill(pid, 'SIGSTOP'); // The worker's own event-loop timer cannot run.
        const controller = new AbortController();
        const pending = session.request(request({ signal: controller.signal }));
        const rejected = assert.rejects(pending, {
          category:
            mode === 'deadline'
              ? 'deadline'
              : mode === 'unconfirmed'
                ? 'cleanup'
                : 'cancelled',
        });
        if (mode === 'scoped-abort' || mode === 'unconfirmed')
          controller.abort();
        if (mode === 'root-abort') root.abort();
        if (mode === 'unconfirmed') {
          const kill = process.kill.bind(process);
          killMock = mock.method(process, 'kill', (target, signal) => {
            if (target === -pid && signal === 0)
              throw Object.assign(new Error('fictional unconfirmed group'), {
                code: 'EPERM',
              });
            return kill(target, signal);
          });
        }
        const closing = mode === 'close' ? session.close() : null;
        const completed = (async () => {
          await rejected;
          if (mode === 'unconfirmed')
            await assert.rejects(session.close(), { category: 'cleanup' });
          else await (closing ?? session.close());
        })();
        await Promise.race([
          completed,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    'parent worker cleanup did not settle within bound',
                  ),
                ),
              4000,
            );
          }),
        ]);
        if (killMock) {
          killMock.mock.restore();
          killMock = null;
        }
        assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
        assert.equal(api.requests.length, 0);
        assert.equal(session.calls, 1);
        const worst = worstCaseMicroUsd('claude-opus-5-5', input);
        assert.equal(session.spentMicroUsd, worst);
        assert.equal(session.receipts[0].costMicroUsd, worst);
        assert.equal(
          session.receipts[0].abortReason,
          mode === 'deadline' ? 'deadline' : 'cancelled',
        );
        assert.equal(
          session.receipts[0].workerRetirement,
          mode === 'unconfirmed' ? 'unconfirmed' : 'confirmed',
        );
        await assert.rejects(session.request(request()), {
          category: 'terminal',
        });
      } finally {
        clearTimeout(timer);
        killMock?.mock.restore();
        try {
          process.kill(pid, 'SIGCONT');
        } catch {}
        await session.close().catch(() => {});
        await api.close();
      }
    },
  );
}

test('the spend cap is enforced before dispatch and ends the run as a usage limit', async () => {
  // The first reply's usage leaves the Opus run about $0.01 under its $1 cap.
  const api = await fakeApi([{ inputTokens: 247_500 }, {}]);
  const session = await open(api);
  try {
    await session.request(request());
    assert.equal(session.spentMicroUsd, 247_500 * 4 + 40 * 20);
    // The next call's worst case cannot fit: refused unsent, run ends.
    await assert.rejects(session.request(request()), {
      category: 'usage-limit',
    });
    assert.equal(api.requests.length, 1);
    // Later requests still report the spend cap, not a generic stop.
    await assert.rejects(session.request(request()), {
      category: 'usage-limit',
    });
  } finally {
    await session.close();
    await api.close();
  }
});

test('a request cut off after message_start is charged its full worst case', async () => {
  const api = await fakeApi([{ partial: true }, {}]);
  const session = await open(api);
  try {
    const controller = new AbortController();
    const pending = session.request(request({ signal: controller.signal }));
    for (let n = 0; n < 200 && api.requests.length < 1; n++)
      await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await assert.rejects(pending, { category: 'cancelled' });
    const worst = worstCaseMicroUsd('claude-opus-5-5', input);
    // Not the one output token message_start reported.
    assert.equal(session.receipts[0].costMicroUsd, worst);
    assert.equal(session.spentMicroUsd, worst);
    assert.deepEqual((await session.request(request())).value, decision);
    assert.equal(session.spentMicroUsd, worst + 900 * 4 + 40 * 20);
  } finally {
    await session.close();
    await api.close();
  }
});

test('a worker that dies mid-request is charged the worst case and ends the run', async () => {
  const api = await fakeApi([{ hold: true }]);
  const session = await open(api);
  try {
    const pending = session.request(request());
    for (let n = 0; n < 200 && api.requests.length < 1; n++)
      await new Promise((r) => setTimeout(r, 10));
    const pids = execFileSync('pgrep', ['-P', String(process.pid)], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .map(Number);
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    await assert.rejects(pending, { category: 'process' });
    const worst = worstCaseMicroUsd('claude-opus-5-5', input);
    assert.equal(session.spentMicroUsd, worst);
    assert.deepEqual(
      [session.receipts[0].outcome, session.receipts[0].costMicroUsd],
      ['process', worst],
    );
  } finally {
    await session.close().catch(() => {});
    await api.close();
  }
});

test('a decision that brings spend to the cap returns, then the run ends as a usage limit', async () => {
  // 250,000 input tokens at $4/M: exactly $1.00 with the 40 output tokens.
  const api = await fakeApi([{ inputTokens: 249_800 }, {}]);
  const session = await open(api);
  try {
    assert.deepEqual((await session.request(request())).value, decision);
    assert.ok(session.spentMicroUsd >= 1_000_000);
    await assert.rejects(session.request(request()), {
      category: 'usage-limit',
    });
    assert.equal(api.requests.length, 1);
  } finally {
    await session.close();
    await api.close();
  }
});

test('a reply that reaches max_tokens is a charged, request-scoped output limit', async () => {
  const api = await fakeApi([{ stopReason: 'max_tokens', text: '' }, {}]);
  const session = await open(api);
  try {
    await assert.rejects(session.request(request()), {
      category: 'output-limit',
    });
    const worst = worstCaseMicroUsd('claude-opus-5-5', input);
    assert.deepEqual(
      [session.receipts[0].outcome, session.receipts[0].costMicroUsd],
      ['output-limit', worst],
    );
    // The run continues.
    assert.deepEqual((await session.request(request())).value, decision);
  } finally {
    await session.close();
    await api.close();
  }
});

test('a usage limit from the API ends the session; there is no retry', async () => {
  const api = await fakeApi([{ status: 429 }, {}]);
  const session = await open(api);
  try {
    await assert.rejects(session.request(request()), {
      category: 'usage-limit',
    });
    await assert.rejects(session.request(request()), { category: 'terminal' });
    assert.equal(api.requests.length, 1);
  } finally {
    await session.close();
    await api.close();
  }
});

test('the session refuses ambient ANTHROPIC_* settings, other models, other efforts and other roles', async () => {
  const api = await fakeApi([{}]);
  try {
    await assert.rejects(
      open(api, { environment: { PATH: '/bin', ANTHROPIC_PROFILE: 'x' } }),
      { category: 'ambient-credentials' },
    );
    await assert.rejects(open(api, { model: 'claude-opus-4-1' }), {
      category: 'configuration',
    });
    await assert.rejects(open(api, { effort: 'medium' }), {
      category: 'configuration',
    });
    const session = await open(api);
    try {
      await assert.rejects(session.request({ role: 'cast', input }), {
        category: 'invalid-request',
      });
    } finally {
      await session.close();
    }
  } finally {
    await api.close();
  }
});

test('the API session refuses TLS or code-loading Node settings, even empty', async () => {
  const api = await fakeApi([{}]);
  try {
    for (const name of [
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_EXTRA_CA_CERTS',
      'NODE_OPTIONS',
      'NODE_USE_ENV_PROXY',
    ])
      await assert.rejects(
        open(api, { environment: { PATH: process.env.PATH, [name]: '' } }),
        { category: 'environment' },
      );
    assert.equal(api.requests.length, 0);
  } finally {
    await api.close();
  }
});

test("the API session checks this process's own environment even when a clean one is passed", async (t) => {
  const api = await fakeApi([{}]);
  // Presence is refused even when certificate validation stays enabled.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
  t.after(() => delete process.env.NODE_TLS_REJECT_UNAUTHORIZED);
  let session;
  try {
    await assert.rejects(
      async () => {
        session = await open(api);
      },
      { category: 'environment' },
    );
    assert.equal(api.requests.length, 0);
  } finally {
    await session?.close();
    await api.close();
  }
});

test('the provider wrapper runs the API route only as api execution at effort low', async () => {
  const base = {
    provider: 'anthropic-api',
    model: 'claude-opus-5-5',
    effort: 'low',
    maxCalls: 2,
    deadlineMs: 30000,
    environment: {},
  };
  await assert.rejects(
    openLabProvider({ ...base, execution: 'subscription' }),
    {
      category: 'configuration',
    },
  );
  await assert.rejects(
    openLabProvider({ ...base, effort: 'medium', execution: 'api' }),
    {
      category: 'configuration',
    },
  );
  await assert.rejects(
    openLabProvider({
      ...base,
      provider: 'codex',
      model: 'gpt-6.1-sol',
      execution: 'api',
    }),
    { category: 'configuration' },
  );
  // Offline stand-in: the wrapper declares the API budget and the spend cap.
  const p = await openLabProvider({
    ...base,
    execution: 'offline-stand-in',
    openers: {
      'anthropic-api': async () => ({
        request: async () => ({ value: decision, elapsedMs: 1 }),
        close: async () => {},
      }),
    },
  });
  assert.equal(p.metadata.budgetUnit, 'api-requests');
  assert.equal(p.metadata.actualProviderRequestBound, true);
  assert.equal(p.metadata.spendCapMicroUsd, 1_000_000);
  await p.close();
});
