// Test preload only. A real API worker runs unchanged; only its SDK constructor
// is replaced. No socket, fetch, key file or provider is used by this fake.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
assert.equal(typeof process.send, 'function');
globalThis.fetch = () => {
  throw new Error('network forbidden in paired fixture');
};
let current;
let partial = '';
const observeInput = (chunk) => {
  partial += chunk;
  for (let end; (end = partial.indexOf('\n')) !== -1;) {
    const frame = JSON.parse(partial.slice(0, end));
    partial = partial.slice(end + 1);
    if (frame.type === 'request') current = frame;
  }
};
// Observe only once the actual worker attaches its reader. Starting stdin in
// this preload would consume init before the worker module has loaded.
const on = process.stdin.on.bind(process.stdin);
let observing = false;
process.stdin.on = (event, listener) => {
  if (event === 'data' && !observing) {
    observing = true;
    on('data', observeInput);
  }
  return on(event, listener);
};
class FictionalSdk {
  constructor(config) {
    assert.equal(config.apiKey, 'sk-ant-api-offline-paired');
    assert.equal(config.baseURL, 'http://127.0.0.1:1');
    process.send({ type: 'sdk-constructed' });
  }
  messages = {
    create: async (params, { signal }) => {
      assert.ok(current?.id);
      const input = JSON.parse(params.messages[0].content);
      assert.deepEqual(input, current.input);
      const id = current.id;
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const command = (frame) => {
        if (frame.type === 'release' && frame.id === id) release();
      };
      process.on('message', command);
      const aborted = () => process.send({ type: 'sdk-aborted', id });
      signal.addEventListener('abort', aborted, { once: true });
      process.send({ type: 'sdk-request', id, input });
      await held;
      process.off('message', command);
      signal.removeEventListener('abort', aborted);
      // Deliberately produces a valid show after release, even after abort.
      // The real request core/adapter/broker must suppress the retired outcome.
      const value = {
        action: 'show',
        cue: 'Should we check the opening time?',
        sourceIds: [
          input.events.at(-1).id,
          ...(input.priorNotes ?? []).map((n) => n.id),
        ],
      };
      process.send({ type: 'sdk-released', id, afterAbort: signal.aborted });
      return (async function* () {
        yield {
          type: 'message_start',
          message: {
            model: params.model,
            usage: { input_tokens: 20, output_tokens: 1 },
          },
        };
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: JSON.stringify(value) },
        };
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 10 },
        };
        yield { type: 'message_stop' };
      })();
    },
  };
}
mock.module('@anthropic-ai/sdk', { defaultExport: FictionalSdk });
process.send({ type: 'sdk-installed' });
