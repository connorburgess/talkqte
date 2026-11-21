import { SELECTED_CONTEXT } from './cue-selected-context.mjs';
// Per-run worker for the lab's direct Anthropic API route. It is the only
// process that holds the key: the first stdin line carries it, never argv,
// environment, logs or evidence. Then it answers one request at a time.
// stdout carries only fixed-shape JSON lines; nothing is ever logged.
import Anthropic from '@anthropic-ai/sdk';
import {
  runAnthropicRequest,
  ANTHROPIC_BASE_URL,
} from './cue-lab-anthropic-core.mjs';

const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
let client = null;
let active = null;
let contextPolicy = 'fresh-only';
let buffer = '';

function handle(frame) {
  if (frame?.type === 'init' && client === null) {
    if (
      !['fresh-only', SELECTED_CONTEXT].includes(
        frame.contextPolicy ?? 'fresh-only',
      )
    )
      process.exit(3);
    contextPolicy = frame.contextPolicy ?? 'fresh-only';
    const key = frame.key;
    // A loopback endpoint exists only for the offline stand-in tests.
    const baseURL =
      typeof frame.offlineBaseUrl === 'string' &&
      /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(frame.offlineBaseUrl)
        ? frame.offlineBaseUrl
        : ANTHROPIC_BASE_URL;
    client = new Anthropic({
      apiKey: key,
      authToken: null,
      baseURL,
      maxRetries: 0,
      timeout: 10000,
      logLevel: 'off',
    });
    write({ type: 'ready' });
    return;
  }
  if (frame?.type === 'request' && client && !active) {
    const controller = new AbortController();
    active = { id: frame.id, controller };
    runAnthropicRequest({
      client,
      contextPolicy,
      model: frame.model,
      input: frame.input,
      budgetMs: frame.budgetMs,
      signal: controller.signal,
    }).then(
      ({ result, text }) => {
        active = null;
        write({ type: 'result', id: frame.id, result, text });
      },
      () => {
        active = null;
        write({
          type: 'result',
          id: frame.id,
          result: { outcome: 'provider' },
        });
      },
    );
    return;
  }
  // An abort can race a request that has just finished; it is then ignored.
  if (frame?.type === 'abort' && Number.isSafeInteger(frame.id)) {
    if (active?.id === frame.id) active.controller.abort();
    return;
  }
  process.exit(3);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (buffer.length > 256 * 1024) process.exit(3);
  for (let end; (end = buffer.indexOf('\n')) !== -1;) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      process.exit(3);
    }
    handle(frame);
  }
});
process.stdin.on('end', () => {
  active?.controller.abort();
  setTimeout(() => process.exit(0), 50);
});
