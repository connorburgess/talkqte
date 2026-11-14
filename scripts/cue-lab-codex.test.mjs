import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createServer } from 'node:http';
import {
  CODEX_SUPPORT,
  assertInspectedCodexVersion,
  openCodexLab,
  parseCodexEvents,
  runBoundedCodexProcess,
  validateCodexSchema,
  codexExecArgs,
  codexFeatureDisables,
  createCodexEventReader,
} from './cue-lab-codex.mjs';

const schema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['show', 'quiet'] },
    cue: { type: ['string', 'null'], maxLength: 80 },
  },
  required: ['action', 'cue'],
  additionalProperties: false,
};
const value = { action: 'quiet', cue: null };
const events = (result = value) =>
  [
    { type: 'thread.started', thread_id: 'fictional' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(result) },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 4, output_tokens: 2, account: 'must-not-return' },
    },
  ]
    .map((x) => JSON.stringify(x))
    .join('\n');
const options = (extra = {}) => ({
  model: 'gpt-6.1-sol',
  effort: 'medium',
  deadlineMs: 100,
  maxCalls: 2,
  environment: {},
  run: async () => ({ stdout: events() }),
  ...extra,
});
const request = (extra = {}) => ({
  role: 'cue-evaluator',
  instructions: 'Use the fictional transcript only.',
  input: { fictional: true, transcript: [] },
  schema,
  ...extra,
});
const rejects = (promise, category, calls) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.category, category);
    if (calls !== undefined) assert.equal(error.calls, calls);
    assert.match(error.message, /^Codex lab stopped:/);
    assert.ok(!error.message.includes('private-account'));
    return true;
  });

test('real Codex execution fails closed: a CLI-attempt cap cannot bound provider requests', async () => {
  // Regression from an unauthenticated local fake-provider probe, not a
  // transcript or authenticated provider response. No tools advertised; an
  // unsupported fabricated toolcall still caused a second model request.
  const requests = [
    { tools: null, tool_choice: 'auto' },
    { tools: null, tool_choice: 'auto' },
  ];
  assert.equal(requests.length, 2);
  assert.equal(CODEX_SUPPORT.inspectedVersion, '0.163.0');
  assert.equal(CODEX_SUPPORT.actualProviderRequestBound, false);
  await rejects(
    openCodexLab(options({ run: undefined })),
    'provider-unavailable',
    0,
  );
});

test('explicit model/effort/bounds and absent ambient credentials are required before dispatch', async () => {
  for (const extra of [
    { model: undefined },
    { model: 'other' },
    { effort: undefined },
    { effort: 'automatic' },
    { maxCalls: 0 },
    { maxCalls: 101 },
    { deadlineMs: 0 },
    { deadlineMs: 60001 },
  ])
    await rejects(openCodexLab(options(extra)), 'configuration');
  for (const key of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_BASE_URL',
    'HTTPS_PROXY',
    'NODE_OPTIONS',
    'CODEX_HOME',
  ])
    await rejects(
      openCodexLab(options({ environment: { [key]: 'private-account' } })),
      'ambient-credentials',
    );
});

test('the offline run pins provider/model/effort and returns only schema-valid output and safe counters', async () => {
  const seen = [];
  const session = await openCodexLab(
    options({
      run: async (r) => {
        seen.push(r);
        return { stdout: events() };
      },
    }),
  );
  try {
    const result = await session.request(request());
    assert.deepEqual(result.value, value);
    assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 2 });
    assert.ok(result.elapsedMs >= 0);
    assert.equal(seen[0].model, 'gpt-6.1-sol');
    assert.equal(seen[0].effort, 'medium');
    assert.equal(session.metadata.execution, 'offline-stand-in');
    assert.equal(session.metadata.budgetUnit, 'runner-dispatch-attempts');
    assert.equal(session.metadata.actualProviderRequestBound, false);
    assert.throws(() => {
      session.metadata.model = 'other';
    }, TypeError);
  } finally {
    await session.close();
  }
});

test('strict schema rejects unsupported keywords, extra output, wrong types and unbounded malformed constraints', () => {
  for (const bad of [
    { $ref: '#/x' },
    {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    },
    { type: 'array' },
    { type: 'string', maxLength: -1 },
    { type: 'number', minimum: 3, maximum: 2 },
  ])
    assert.throws(() => validateCodexSchema(bad), /schema/);
  for (const bad of [
    { action: 'quiet', cue: null, extra: true },
    { action: 'other', cue: null },
    { action: 'show', cue: 42 },
    { action: 'show' },
    null,
  ])
    assert.throws(() => validateCodexSchema(schema, bad), /schema/);
  validateCodexSchema(schema, value);
});

test('request validation consumes no dispatch, failure is terminal, and source mutation cannot alter in-flight schema', async () => {
  let dispatches = 0;
  const session = await openCodexLab(
    options({
      run: async () => {
        dispatches++;
        return { stdout: events() };
      },
    }),
  );
  await rejects(
    session.request(request({ schema: { $ref: 'private-account' } })),
    'invalid-request',
    0,
  );
  await rejects(session.request(request()), 'terminal', 0);
  assert.equal(dispatches, 0);
  await session.close();
  let release;
  const pendingSession = await openCodexLab(
    options({
      run: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
  );
  const ownSchema = structuredClone(schema);
  const pending = pendingSession.request(request({ schema: ownSchema }));
  await delay(0);
  ownSchema.properties.action.enum = ['other'];
  release({ stdout: events() });
  assert.deepEqual((await pending).value, value);
  await pendingSession.close();
});

test('cap is cumulative across roles, counts failed/aborted attempts, and cannot reset after close', async () => {
  const session = await openCodexLab(options({ maxCalls: 2 }));
  await session.request(request({ role: 'cast' }));
  await session.request(request({ role: 'judge' }));
  await rejects(session.request(request()), 'call-cap', 2);
  assert.equal(session.calls, 2);
  await session.close();
  await session.close();
  await rejects(session.request(request()), 'terminal', 2);
  const failing = await openCodexLab(
    options({
      run: async () => {
        throw new Error('private-account secret');
      },
    }),
  );
  await rejects(failing.request(request()), 'provider', 1);
  await rejects(failing.request(request()), 'terminal', 1);
  await failing.close();
});

test('a concurrent role fails and cancels the active operation without a second dispatch', async () => {
  let count = 0;
  const session = await openCodexLab(
    options({
      run: (_r, { signal }) =>
        new Promise((_resolve, reject) => {
          count++;
          signal.addEventListener(
            'abort',
            () => reject(new Error('private-account')),
            { once: true },
          );
        }),
    }),
  );
  const first = session.request(request());
  await delay(0);
  const firstRejected = rejects(first, 'cancelled', 1);
  await rejects(
    session.request(request({ role: 'listener' })),
    'concurrent-request',
    1,
  );
  await firstRejected;
  assert.equal(count, 1);
  await session.close();
});

test('abort before dispatch spends no call, abort during request discards a late reply and waits for settlement', async () => {
  const before = new AbortController();
  before.abort();
  const first = await openCodexLab(options());
  await rejects(
    first.request(request({ signal: before.signal })),
    'cancelled',
    0,
  );
  await first.close();
  let release;
  const controller = new AbortController();
  const session = await openCodexLab(
    options({
      run: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
  );
  const pending = session.request(request({ signal: controller.signal }));
  await delay(0);
  controller.abort();
  let closed = false;
  const closing = session.close().then(() => {
    closed = true;
  });
  await delay(0);
  assert.equal(closed, false);
  const rejected = rejects(pending, 'cancelled', 1);
  release({ stdout: events() });
  await rejected;
  await closing;
  assert.equal(closed, true);
});

test('deadline aborts the runner, counts the attempted operation and preserves terminal state', async () => {
  let aborted = false;
  const session = await openCodexLab(
    options({
      deadlineMs: 15,
      run: (_r, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('private-account'));
            },
            { once: true },
          );
        }),
    }),
  );
  await rejects(session.request(request()), 'deadline', 1);
  assert.equal(aborted, true);
  await rejects(session.request(request()), 'terminal', 1);
  await session.close();
});

test('tools, unrecognized events, extra turns, oversized output and malformed envelopes are rejected', () => {
  for (const itemType of [
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'web_search',
    'image_generation',
    'tool_call',
  ]) {
    const bad = [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { type: itemType, command: 'private-account' },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n');
    assert.throws(() => parseCodexEvents(bad), /unexpected-event/);
  }
  for (const bad of [
    '',
    'not JSON',
    events() + '\n' + JSON.stringify({ type: 'turn.started' }),
    events().replace('turn.completed', 'turn.failed'),
  ])
    assert.throws(() => parseCodexEvents(bad));
  assert.throws(
    () => parseCodexEvents('x'.repeat(256 * 1024 + 1)),
    /output-limit/,
  );
  assert.throws(
    () =>
      parseCodexEvents(
        events(value) +
          '\n' +
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: '{}' },
          }),
      ),
    /unexpected-event/,
  );
});

test('bounded process executor enforces output ceiling and deadline without echoing subprocess text', async () => {
  await rejects(
    runBoundedCodexProcess(
      process.execPath,
      [
        '-e',
        "process.stdout.write('private-account'.repeat(10000));setInterval(()=>{},1000)",
      ],
      { env: {}, deadlineMs: 1000, maxOutputBytes: 1024 },
    ),
    'output-limit',
  );
  await rejects(
    runBoundedCodexProcess(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { env: {}, deadlineMs: 30 },
    ),
    'deadline',
  );
});

test('process cancellation retires the entire owned process group before returning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'talkqte-codex-tree-'));
  try {
    const pidFile = join(directory, 'grandchild.pid');
    const childFile = join(directory, 'child.mjs');
    await writeFile(
      childFile,
      `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(process.argv[2],String(child.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
    );
    const controller = new AbortController();
    const pending = runBoundedCodexProcess(
      process.execPath,
      [childFile, pidFile],
      { env: {}, signal: controller.signal, deadlineMs: 2000 },
    );
    let pid;
    for (let n = 0; n < 80; n++) {
      try {
        pid = Number(await readFile(pidFile, 'utf8'));
        break;
      } catch {
        await delay(5);
      }
    }
    assert.ok(pid > 0);
    const rejected = rejects(pending, 'cancelled');
    controller.abort();
    await rejected;
    let alive = true;
    for (let n = 0; n < 80; n++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await delay(5);
    }
    assert.equal(alive, false, 'owned grandchild must be gone');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('version and config mismatches never enable real execution', async () => {
  assertInspectedCodexVersion('codex-cli 0.163.0');
  for (const version of ['codex-cli 0.164.0', '0.163.0', 'unknown']) {
    assert.throws(
      () => assertInspectedCodexVersion(version),
      /unsupported-cli-version/,
    );
    await rejects(
      openCodexLab(options({ cliVersion: version })),
      'unsupported-cli-version',
    );
  }
  await rejects(
    openCodexLab(options({ run: undefined })),
    'provider-unavailable',
  );
});

test('feature drift and non-loopback audit endpoints fail closed', () => {
  assert.throws(
    () => codexFeatureDisables('shell_tool  stable  true'),
    /configuration-mismatch/,
  );
  assert.throws(
    () =>
      codexExecArgs({
        cwd: '/tmp/fictional',
        schemaFile: '/tmp/schema',
        model: CODEX_SUPPORT.model,
        effort: 'medium',
        offlineBaseUrl: 'https://example.com/v1',
      }),
    /configuration/,
  );
});

test('listener nullable anyOf schema and finite JSON input agree with stream contract', async () => {
  const nullable = {
    anyOf: [{ type: 'string', minLength: 1, maxLength: 400 }, { type: 'null' }],
  };
  validateCodexSchema(nullable, null);
  validateCodexSchema(nullable, 'Fictional reply.');
  assert.throws(() => validateCodexSchema(nullable, 3), /schema/);
  assert.throws(
    () => validateCodexSchema({ anyOf: [{ unsupported: true }] }),
    /schema/,
  );
  const session = await openCodexLab(options());
  await rejects(
    session.request(request({ input: { number: Infinity } })),
    'invalid-request',
    0,
  );
  await session.close();
});

test('streaming event rejection kills the process before accepting another event or result', async () => {
  const reader = createCodexEventReader();
  await rejects(
    runBoundedCodexProcess(
      process.execPath,
      [
        '-e',
        `process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'command_execution'}})+'\\n');setInterval(()=>{},1000)`,
      ],
      { env: {}, deadlineMs: 1000, onStdoutLine: reader.accept },
    ),
    'unexpected-event',
  );
  for (const item of [
    { type: 'error', message: 'unexpected failure' },
    { type: 'mcp_tool_call' },
  ]) {
    const guard = createCodexEventReader();
    assert.throws(
      () => guard.accept(JSON.stringify({ type: 'item.completed', item })),
      /unexpected-event/,
    );
  }
});

// Opt-in local integration check: talks only to an unauthenticated loopback
// server, with a fresh empty CODEX_HOME. CI does not need Codex or credentials.
// The intended subscription profile differs only in auth and provider endpoint;
// this cannot prove account-dependent runtime parity. Source review must also
// verify that auth does not re-enable the disabled feature gates.
test(
  'installed pinned CLI advertises no tools and rejects hostile tools without executing them',
  { skip: process.env.TALKQTE_CODEX_OFFLINE_PROBE !== '1', timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'talkqte-codex-audit-'));
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR', 'LANG']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    env.CODEX_HOME = join(directory, 'home');
    await mkdir(env.CODEX_HOME, { mode: 0o700 });
    // The fresh home has no auth file; none is read or copied.
    const sentinel = join(directory, 'forbidden-action');
    let server;
    try {
      const version = await runBoundedCodexProcess('codex', ['--version'], {
        env,
        deadlineMs: 5000,
      });
      assertInspectedCodexVersion(version.stdout.trim());
      const catalog = (
        await runBoundedCodexProcess('codex', ['features', 'list'], {
          env,
          deadlineMs: 5000,
        })
      ).stdout;
      const disables = codexFeatureDisables(catalog);
      for (const name of [
        'shell_tool',
        'apps',
        'plugins',
        'hooks',
        'image_generation',
        'multi_agent',
        'browser_use',
        'computer_use',
        'skill_search',
      ])
        assert.ok(disables.includes(name), `${name} must be disabled`);
      const schemaFile = join(directory, 'reply.schema.json');
      await writeFile(schemaFile, JSON.stringify(schema));
      const requests = [];
      let tool;
      server = createServer(async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(404).end();
          return;
        }
        let bytes = '';
        for await (const chunk of req) bytes += chunk;
        const body = JSON.parse(bytes);
        requests.push(body);
        if (requests.length !== 1) {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(
              '{"error":{"message":"offline stop","type":"invalid_request_error"}}',
            );
          return;
        }
        if (tool === null) {
          const item = {
            type: 'message',
            id: 'msg_offline',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(value),
                annotations: [],
              },
            ],
          };
          const events = [
            {
              type: 'response.created',
              response: {
                id: 'resp_offline',
                status: 'in_progress',
                output: [],
              },
            },
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...item, status: 'in_progress', content: [] },
            },
            {
              type: 'response.output_text.delta',
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: JSON.stringify(value),
            },
            { type: 'response.output_item.done', output_index: 0, item },
            {
              type: 'response.completed',
              response: {
                id: 'resp_offline',
                object: 'response',
                status: 'completed',
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ];
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            events
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(''),
          );
          return;
        }
        const item = {
          type: 'function_call',
          id: 'fc_offline',
          call_id: 'call_offline',
          name: tool,
          arguments: JSON.stringify({
            cmd: `touch ${sentinel}`,
            command: `touch ${sentinel}`,
            script: `touch ${sentinel}`,
            patch: `*** Begin Patch\n*** Add File: ${sentinel}\n+forbidden\n*** End Patch`,
          }),
        };
        const events = [
          {
            type: 'response.created',
            response: { id: 'resp_offline', status: 'in_progress', output: [] },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...item, arguments: '' },
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: 0,
            delta: item.arguments,
          },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id: 'resp_offline',
              object: 'response',
              status: 'completed',
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(''),
        );
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
      const args = codexExecArgs({
        cwd: directory,
        schemaFile,
        catalog,
        model: CODEX_SUPPORT.model,
        effort: 'medium',
        offlineBaseUrl: endpoint,
      });
      assert.ok(args.includes('forced_login_method="chatgpt"'));
      const live = codexExecArgs({
        cwd: directory,
        schemaFile,
        catalog,
        model: CODEX_SUPPORT.model,
        effort: 'medium',
      });
      assert.ok(live.includes('model_provider="lab_subscription"'));
      assert.ok(
        live.some(
          (arg) =>
            arg.includes('requires_openai_auth=true') &&
            arg.includes('request_max_retries=0') &&
            !arg.includes('base_url'),
        ),
      );
      for (tool of [
        'exec_command',
        'apply_patch',
        'mcp__fictional__write',
        'web.run',
        'image_gen',
        'spawn_agent',
      ]) {
        requests.length = 0;
        await rejects(
          runBoundedCodexProcess('codex', args, {
            cwd: directory,
            env,
            input:
              'Return a fictional quiet decision as JSON. Do not use tools.',
            deadlineMs: 5000,
          }),
          'process',
        );
        assert.ok(requests.length >= 1, `fake provider reached for ${tool}`);
        assert.ok(
          requests.length <= 2,
          'unexpected continuation or configured retry',
        );
        for (const body of requests) {
          assert.ok(
            !body.tools || body.tools.length === 0,
            'no model-facing tool must be advertised',
          );
          assert.equal(body.model, CODEX_SUPPORT.model);
          assert.equal(body.reasoning.effort, 'medium');
        }
        await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
      }
      tool = null;
      requests.length = 0;
      const result = await runBoundedCodexProcess('codex', args, {
        cwd: directory,
        env,
        input: 'Return a fictional quiet decision as JSON. Do not use tools.',
        deadlineMs: 5000,
      });
      let parsed;
      try {
        parsed = parseCodexEvents(result.stdout);
      } catch (error) {
        assert.fail(`offline fake-provider envelope: ${result.stdout}`);
      }
      assert.deepEqual(parsed.value, value);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].text.format.schema, schema);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
