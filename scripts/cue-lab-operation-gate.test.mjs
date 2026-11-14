import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLabOperationGate } from './cue-lab-operation-gate.mjs';

const req = (role = 'cast') => ({
  role,
  instructions: 'Fictional only.',
  input: {},
  schema: {},
});
const stopped = (category) => (error) =>
  error.category === category && !error.message.includes('private');
function setup({
  request = async () => ({ value: {} }),
  maxCalls = 4,
  close = async () => {},
} = {}) {
  const terminals = [];
  const gate = createLabOperationGate({
    provider: { request, close },
    maxCalls,
    onTerminal: (code) => terminals.push(code),
  });
  const call = (role = 'cast', options = {}) =>
    gate.run(() => gate.request(req(role)), { role, ...options });
  return { gate, call, terminals };
}

test('one dispatch per lease; global attempted-dispatch cap spans roles and cannot reset', async () => {
  const { gate, call } = setup({ maxCalls: 2 });
  await call('cast');
  await call('cue-evaluator');
  assert.equal(gate.dispatchesUsed, 2);
  await assert.rejects(call('judge'), stopped('dispatch-limit'));
  await assert.rejects(call('listener'), stopped('dispatch-limit'));
  assert.equal(gate.dispatchesUsed, 2);
  await gate.close();
});

test('one pending evaluator waits behind participant and owns priority through Rust settlement', async () => {
  let releaseCast, releaseAck;
  const order = [];
  const { gate } = setup({
    request: async ({ role }) => {
      order.push(role);
      if (role === 'cast')
        await new Promise((resolve) => {
          releaseCast = resolve;
        });
      return { value: { role } };
    },
  });
  const cast = gate.run(() => gate.request(req()), { role: 'cast' });
  await delay(0);
  const evaluator = gate.run(
    async () => {
      const result = await gate.request(req('cue-evaluator'));
      await new Promise((resolve) => {
        releaseAck = resolve;
      });
      return result;
    },
    { role: 'cue-evaluator' },
  );
  let idle = false;
  const waiting = gate.waitIdle().then(() => {
    idle = true;
  });
  assert.equal(gate.dispatchesUsed, 1);
  releaseCast();
  await cast;
  await delay(0);
  assert.deepEqual(order, ['cast', 'cue-evaluator']);
  assert.equal(idle, false);
  assert.equal(gate.dispatchesUsed, 2);
  releaseAck();
  await evaluator;
  await waiting;
  assert.equal(idle, true);
  await gate.close();
});

test('semantic/settlement failure is terminal before any next role admission', async () => {
  let cleaned = false;
  const { gate, call, terminals } = setup({
    close: async () => {
      cleaned = true;
    },
  });
  await assert.rejects(
    gate.run(
      async () => {
        await gate.request(req('cue-evaluator'));
        throw Object.assign(new Error('private bad source'), {
          category: 'invalid-reply',
        });
      },
      { role: 'cue-evaluator' },
    ),
    stopped('invalid-reply'),
  );
  assert.equal(cleaned, true);
  assert.deepEqual(terminals, ['invalid-reply']);
  await assert.rejects(call(), stopped('invalid-reply'));
  assert.equal(gate.dispatchesUsed, 1);
  await gate.close();
});

test('queued evaluator deadline includes admission and cancels the active provider before release', async () => {
  let cleaned = false;
  const { gate } = setup({
    request: ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              cleaned = true;
              reject(new Error('private'));
            }, 20);
          },
          { once: true },
        ),
      ),
  });
  const cast = gate.run(() => gate.request(req()), { role: 'cast' });
  const rejectedCast = assert.rejects(cast, stopped('deadline'));
  await delay(0);
  const queued = gate.run(() => gate.request(req('cue-evaluator')), {
    role: 'cue-evaluator',
    deadlineMs: 10,
  });
  const rejectedQueued = assert.rejects(queued, stopped('deadline'));
  await rejectedCast;
  await rejectedQueued;
  assert.equal(cleaned, true);
  assert.equal(gate.dispatchesUsed, 1);
  await gate.close();
});

test('close and cancellation hold ownership until active provider settlement and cleanup', async () => {
  let release,
    closed = false;
  const { gate, call } = setup({
    request: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    close: async () => {
      closed = true;
    },
  });
  const pending = call();
  const rejected = assert.rejects(pending, stopped('closed'));
  await delay(0);
  const closing = gate.close();
  await delay(0);
  assert.equal(closed, false);
  release({ value: {} });
  await rejected;
  await closing;
  assert.equal(closed, true);
});

test('missing lease, nested admission, second provider dispatch and wrong role fail closed', async () => {
  for (const variant of ['missing', 'nested', 'second', 'wrong']) {
    const { gate } = setup();
    let pending;
    if (variant === 'missing') pending = gate.request(req());
    else
      pending = gate.run(
        async () => {
          if (variant === 'nested')
            return gate.run(() => gate.request(req()), { role: 'cast' });
          if (variant === 'wrong') return gate.request(req('judge'));
          await gate.request(req());
          return gate.request(req());
        },
        { role: 'cast' },
      );
    await assert.rejects(pending, stopped('protocol'));
    assert.equal(gate.dispatchesUsed, variant === 'second' ? 1 : 0);
    await gate.close();
  }
});

test('provider failure cannot be swallowed by a task or leak raw text', async () => {
  const { gate, call } = setup({
    request: async () => {
      throw new Error('private provider details');
    },
  });
  await assert.rejects(
    gate.run(
      async () => {
        try {
          await gate.request(req());
        } catch {}
        return { value: {} };
      },
      { role: 'cast' },
    ),
    stopped('provider'),
  );
  await assert.rejects(call('listener'), stopped('provider'));
  await gate.close();
});
