import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openLabProvider } from './cue-lab-provider.mjs';

const schema = {
  type: 'object',
  properties: { quiet: { type: 'boolean' } },
  required: ['quiet'],
  additionalProperties: false,
};
const reply = {
  value: { quiet: true },
  elapsedMs: 2,
  usage: { input_tokens: 4, secret: 'discard' },
};
const req = (extra = {}) => ({
  role: 'cast',
  instructions: 'Use fictional speech only.',
  input: { fictional: true },
  schema,
  ...extra,
});
const config = (provider, extra = {}) => ({
  provider,
  model: provider === 'codex' ? 'gpt-6.1-sol' : 'claude-haiku-5-5',
  effort: 'medium',
  maxCalls: 2,
  deadlineMs: 100,
  execution: 'offline-stand-in',
  environment: {},
  openers: {
    [provider]: async () => ({
      request: async () => reply,
      close: async () => {},
    }),
  },
  ...extra,
});
const rejects = (promise, category, calls) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.category, category);
    if (calls !== undefined) assert.equal(error.calls, calls);
    assert.ok(!error.message.includes('sensitive'));
    return true;
  });

for (const provider of ['claude-code', 'codex']) {
  test(`${provider} is explicitly selected, pinned and normalized without fallback`, async () => {
    let opened = 0,
      other = 0,
      closed = 0;
    const session = await openLabProvider(
      config(provider, {
        openers: {
          [provider]: async (options) => {
            opened++;
            assert.equal(options.provider, provider);
            return {
              request: async () => reply,
              close: async () => {
                closed++;
              },
            };
          },
          [provider === 'codex' ? 'claude-code' : 'codex']: async () => {
            other++;
            throw new Error();
          },
        },
      }),
    );
    assert.equal(opened, 1);
    assert.equal(other, 0);
    assert.equal(session.metadata.provider, provider);
    assert.equal(session.metadata.budgetUnit, 'runner-dispatch-attempts');
    assert.equal(session.metadata.actualProviderRequestBound, false);
    assert.throws(() => {
      session.metadata.provider = 'other';
    }, TypeError);
    assert.deepEqual(await session.request(req()), {
      ...reply,
      usage: { input_tokens: 4 },
    });
    await session.close();
    await session.close();
    assert.equal(closed, 1);
    await rejects(session.request(req()), 'terminal', 1);
  });
}

test('missing selection, model, effort, bounds or available selected provider fails without opening another', async () => {
  for (const extra of [
    { provider: undefined },
    { model: undefined },
    { effort: undefined },
    { model: 'automatic' },
    { maxCalls: 0 },
    { deadlineMs: 0 },
    { execution: 'subscription' },
  ])
    await rejects(openLabProvider(config('codex', extra)), 'configuration');
  let other = 0;
  await rejects(
    openLabProvider(
      config('codex', {
        openers: {
          'claude-code': async () => {
            other++;
          },
        },
      }),
    ),
    'provider-unavailable',
  );
  assert.equal(other, 0);
  await rejects(
    openLabProvider(
      config('codex', {
        openers: {
          codex: async () => {
            throw new Error('sensitive account');
          },
        },
      }),
    ),
    'provider',
  );
  await rejects(
    openLabProvider(
      config('claude-code', { environment: { OPENAI_API_KEY: 'sensitive' } }),
    ),
    'ambient-credentials',
  );
});

test('one immutable session cap spans roles and failed state cannot be reset', async () => {
  const session = await openLabProvider(config('codex'));
  await session.request(req({ role: 'generator' }));
  await session.request(req({ role: 'cue-evaluator' }));
  await rejects(session.request(req({ role: 'judge' })), 'call-cap', 2);
  await rejects(session.request(req()), 'terminal', 2);
  await session.close();
  const next = await openLabProvider(config('claude-code'));
  assert.equal(next.calls, 0);
  assert.equal(next.metadata.provider, 'claude-code');
  await next.close();
});

test('invalid input/schema consumes no dispatch and schema/provider failures remain terminal and safe', async () => {
  const invalid = await openLabProvider(config('codex'));
  await rejects(
    invalid.request(req({ input: { value: NaN } })),
    'invalid-request',
    0,
  );
  await invalid.close();
  const session = await openLabProvider(
    config('codex', {
      openers: {
        codex: async () => ({
          request: async () => ({ ...reply, value: { wrong: true } }),
          close: async () => {},
        }),
      },
    }),
  );
  await rejects(session.request(req()), 'schema', 1);
  await rejects(session.request(req()), 'terminal', 1);
  await session.close();
});

test('concurrent dispatch cancels owner; close retains ownership until settlement and discards late result', async () => {
  let release,
    cleaned = false,
    aborted = false;
  const session = await openLabProvider(
    config('codex', {
      openers: {
        codex: async () => ({
          request: ({ signal }) =>
            new Promise((resolve) => {
              release = resolve;
              signal.addEventListener('abort', () => {
                aborted = true;
              });
            }),
          close: async () => {
            cleaned = true;
          },
        }),
      },
    }),
  );
  const pending = session.request(req());
  await delay(0);
  const rejected = rejects(pending, 'cancelled', 1);
  await rejects(session.request(req()), 'concurrent-request', 1);
  const closing = session.close();
  assert.equal(aborted, true);
  assert.equal(cleaned, false);
  release(reply);
  await rejected;
  await closing;
  assert.equal(cleaned, true);
});

test('hard deadline cancels a runner, counts its attempted dispatch and cannot accept late success', async () => {
  const session = await openLabProvider(
    config('claude-code', {
      deadlineMs: 10,
      openers: {
        'claude-code': async () => ({
          request: ({ signal }) =>
            new Promise((resolve) =>
              signal.addEventListener('abort', () => resolve(reply), {
                once: true,
              }),
            ),
          close: async () => {},
        }),
      },
    }),
  );
  await rejects(session.request(req()), 'deadline', 1);
  await rejects(session.request(req()), 'terminal', 1);
  await session.close();
});
