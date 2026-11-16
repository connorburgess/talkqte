// Direct Anthropic API cue decisions for the development lab: request shape,
// streamed call, outcome classification, pricing and credential checks.
// Pure logic; the per-run worker (cue-lab-anthropic-worker.mjs) is the only
// place a key and an SDK client exist. Tests drive this module with a fake
// fetch, never the network.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { COMPACT_PROMPT, CONTRACT } from './cue-lab.mjs';

export const ANTHROPIC_PROVIDER = 'anthropic-api';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_EFFORT = 'low';
// Shared by adaptive thinking (Opus, Haiku) and the reply; a reply that
// reaches it is a request-scoped non-decision.
export const ANTHROPIC_MAX_TOKENS = 2048;
export const ANTHROPIC_MAX_TEXT_BYTES = 4096;
export const ANTHROPIC_KEY_NAME = 'TALKQTE_LAB_ANTHROPIC_KEY';

// Exactly the models and thinking settings API-BENCH-01 measured at effort
// low. Omitting `thinking` runs adaptive thinking. Opus 5.5 cannot turn
// thinking off; Sonnet 5.5 turns it off with between_tools.
export const ANTHROPIC_MODELS = Object.freeze({
  'claude-opus-5-5': Object.freeze({ thinking: null }),
  'claude-sonnet-5-5': Object.freeze({ thinking: { type: 'between_tools' } }),
  'claude-haiku-5-5': Object.freeze({ thinking: null }),
});

// $ per million tokens: input, 5-minute cache write, cache read, output.
// From the published pricing page, read 2026-11-16 (Haiku 5.5 rate for
// prompts up to 100,000 tokens). Held in micro-dollars to stay integral.
const PRICE = Object.freeze({
  'claude-opus-5-5': { in: 4, cw: 5, cr: 0.2, out: 20 },
  'claude-sonnet-5-5': { in: 2, cw: 2.5, cr: 0.1, out: 10 },
  'claude-haiku-5-5': { in: 0.1, cw: 0.125, cr: 0.01, out: 0.5 },
});
// Per-run spend caps in micro-dollars; reaching one ends the run.
export const ANTHROPIC_SPEND_CAP_MICRO_USD = Object.freeze({
  'claude-opus-5-5': 1_000_000,
  'claude-sonnet-5-5': 250_000,
  'claude-haiku-5-5': 250_000,
});

// A fixed schema: no per-request enum and no length or item constraints the
// API does not support. The broker's per-request schema and validateDecision
// still check lengths, at most four sources and membership client-side.
export const ANTHROPIC_DECISION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['show', 'quiet', 'resolved', 'withdraw'] },
    cue: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    sourceIds: { type: 'array', minItems: 1, items: { type: 'string' } },
  },
  required: ['action', 'cue', 'sourceIds'],
  additionalProperties: false,
});

/**
 * The byte-stable system prompt: the compact evaluator prompt with the
 * glance rule and both field notes always included. userName and earlierCues
 * travel only in the user message, so the system block never changes.
 */
export function anthropicSystemPrompt() {
  const p = CONTRACT.prompts;
  return COMPACT_PROMPT + p.glanceRule + p.nameNote + p.historyNote;
}

export function isAnthropicModel(model) {
  return Object.hasOwn(ANTHROPIC_MODELS, model);
}

export function buildAnthropicParams(model, input) {
  if (!isAnthropicModel(model)) throw new Error('unsupported model');
  const params = {
    model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: anthropicSystemPrompt(),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: JSON.stringify(input) }],
    output_config: {
      effort: ANTHROPIC_EFFORT,
      format: { type: 'json_schema', schema: ANTHROPIC_DECISION_SCHEMA },
    },
    stream: true,
  };
  const { thinking } = ANTHROPIC_MODELS[model];
  if (thinking) params.thinking = { ...thinking };
  return params;
}

export function costMicroUsd(model, usage = {}) {
  const p = PRICE[model];
  return Math.ceil(
    (usage.input_tokens ?? 0) * p.in +
      (usage.cache_creation_input_tokens ?? 0) * p.cw +
      (usage.cache_read_input_tokens ?? 0) * p.cr +
      (usage.output_tokens ?? 0) * p.out,
  );
}

// Worst case for one call before it is sent: about two bytes per token for
// the prompt and input plus 1,500 tokens for the structured-output prompt,
// at the higher of input and cache-write price, plus the full output bound.
export function worstCaseMicroUsd(model, input) {
  const p = PRICE[model];
  const bytes = Buffer.byteLength(
    anthropicSystemPrompt() +
      JSON.stringify(input) +
      JSON.stringify(ANTHROPIC_DECISION_SCHEMA),
  );
  const tokens = Math.ceil(bytes / 2) + 1500;
  return Math.ceil(
    tokens * Math.max(p.in, p.cw) + ANTHROPIC_MAX_TOKENS * p.out,
  );
}

/**
 * One streamed request. Returns a content-free outcome plus the reply text,
 * which only ever goes back to the caller for client-side validation.
 * Never throws for an API outcome; errors carry a class name and HTTP status
 * only, never a message body.
 */
export async function runAnthropicRequest({
  client,
  model,
  input,
  budgetMs,
  signal,
}) {
  const params = buildAnthropicParams(model, input);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const r = {
    outcome: null,
    status: null,
    errorClass: null,
    messageStartMs: null,
    firstTextMs: null,
    messageStopMs: null,
    settledMs: null,
    stopReason: null,
    refusalCategory: null,
    modelEcho: null,
    usage: {},
  };
  let text = '';
  let stream = null;
  const timer = setTimeout(() => {
    controller.abort();
    stream?.controller?.abort();
  }, budgetMs);
  try {
    if (signal?.aborted) controller.abort();
    stream = await client.messages.create(params, {
      signal: controller.signal,
      timeout: Math.max(1, budgetMs - 250),
      maxRetries: 0,
    });
    for await (const ev of stream) {
      if (ev.type === 'message_start') {
        r.messageStartMs ??= ms();
        r.modelEcho = ev.message?.model ?? null;
        Object.assign(r.usage, pickUsage(ev.message?.usage));
      } else if (
        ev.type === 'content_block_delta' &&
        ev.delta?.type === 'text_delta'
      ) {
        r.firstTextMs ??= ms();
        text += ev.delta.text;
        if (Buffer.byteLength(text) > ANTHROPIC_MAX_TEXT_BYTES) {
          r.outcome = 'output-limit';
          stream.controller.abort();
          break;
        }
      } else if (ev.type === 'message_delta') {
        r.stopReason = ev.delta?.stop_reason ?? r.stopReason;
        if (ev.delta?.stop_reason === 'refusal')
          r.refusalCategory = fixedLabel(ev.delta?.stop_details?.category);
        Object.assign(r.usage, pickUsage(ev.usage));
      } else if (ev.type === 'message_stop') {
        r.messageStopMs = ms();
      }
    }
    if (!r.outcome) {
      if (controller.signal.aborted) r.outcome = 'cancelled';
      else if (r.modelEcho !== model) r.outcome = 'configuration-mismatch';
      else if (r.stopReason === 'refusal') r.outcome = 'refusal';
      else if (r.stopReason === 'max_tokens') r.outcome = 'output-limit';
      else if (r.stopReason !== 'end_turn' || r.messageStopMs === null)
        r.outcome = 'protocol';
      else r.outcome = 'decision';
    }
  } catch (error) {
    r.outcome = controller.signal.aborted ? 'cancelled' : 'provider';
    r.errorClass = String(error?.constructor?.name ?? 'Error').slice(0, 40);
    r.status = Number.isSafeInteger(error?.status) ? error.status : null;
    if (r.status === 401 || r.status === 403) r.outcome = 'auth';
    else if (r.status === 429) r.outcome = 'usage-limit';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    r.settledMs = ms();
  }
  return { result: r, text: r.outcome === 'decision' ? text : null };
}

const USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
];
function pickUsage(usage) {
  return Object.fromEntries(
    USAGE_KEYS.filter((k) => Number.isSafeInteger(usage?.[k])).map((k) => [
      k,
      usage[k],
    ]),
  );
}
const fixedLabel = (value) =>
  typeof value === 'string' && /^[a-z_]{1,40}$/.test(value)
    ? value
    : 'unspecified';

// ---------- credentials ----------

/** Names of any ANTHROPIC_* setting, including one set to an empty string. */
export function anthropicEnvironmentNames(environment) {
  return Object.keys(environment ?? {}).filter(
    (key) => environment[key] !== undefined && /^ANTHROPIC_/i.test(key),
  );
}

export const ANTHROPIC_KEY_DIR = join(
  process.env.HOME ?? '/nonexistent',
  '.config',
  'talkqte-lab',
);
export const ANTHROPIC_KEY_FILE = join(ANTHROPIC_KEY_DIR, 'anthropic.env');

class KeyRefused extends Error {
  constructor(reason) {
    super(`Lab API key refused: ${reason}.`);
    this.category = 'credentials';
  }
}

function insideRepository(path) {
  for (let p = path; ; p = dirname(p)) {
    if (existsSync(join(p, '.git'))) return true;
    if (dirname(p) === p) return false;
  }
}

/**
 * Reads the owner's key file under strict ownership, mode and location
 * checks. Every failure is fixed text; the key value never appears.
 */
export function readAnthropicKeyFile({
  file = ANTHROPIC_KEY_FILE,
  forbiddenRoots = [tmpdir(), '/tmp', '/private/tmp'],
} = {}) {
  const uid = process.getuid?.();
  const dir = dirname(file);
  let d, f;
  try {
    d = lstatSync(dir);
    f = lstatSync(file);
  } catch {
    throw new KeyRefused('missing');
  }
  if (!d.isDirectory() || d.isSymbolicLink() || d.uid !== uid)
    throw new KeyRefused('directory');
  if ((d.mode & 0o777) !== 0o700) throw new KeyRefused('directory mode');
  if (!f.isFile() || f.isSymbolicLink() || f.uid !== uid)
    throw new KeyRefused('file');
  if ((f.mode & 0o777) !== 0o600) throw new KeyRefused('file mode');
  if (f.size === 0 || f.size > 4096) throw new KeyRefused('size');
  const real = realpathSync(file);
  const roots = forbiddenRoots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  if (roots.some((r) => real === r || real.startsWith(r + '/')))
    throw new KeyRefused('location');
  if (insideRepository(dirname(real))) throw new KeyRefused('location');
  const lines = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length !== 1) throw new KeyRefused('format');
  const m = lines[0].match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
  if (!m || m[1] !== ANTHROPIC_KEY_NAME) throw new KeyRefused('format');
  let value = m[2].trim();
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
  // Console API keys only: classic sk-ant-api… and account-linked
  // sk-ant-usr-…. Admin, OAuth and every other sk-ant- credential refused.
  if (
    !(value.startsWith('sk-ant-api') || value.startsWith('sk-ant-usr-')) ||
    value.startsWith('sk-ant-admin') ||
    /\s/.test(value) ||
    value.length > 512
  )
    throw new KeyRefused('kind');
  return value;
}
