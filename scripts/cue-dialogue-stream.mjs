// Provider-independent, manual dialogue generation. No provider is constructed
// here. The caller supplies a bounded runner and a run-wide gate shared with
// evaluator operations; playback and actual app cues belong to the orchestrator.
import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  allNames,
  castView,
  listenerView,
  validateBrief,
} from './cue-dialogue-briefs.mjs';
import { REQUESTS, VALIDATE } from './cue-dialogue-agents.mjs';

export const SCHEMA = 'talkqte-dialogue-next/1';
const STATE_SCHEMA = 'talkqte-dialogue-state/1';
const MAX_BYTES = 1_048_576;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 400) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const time = (v) =>
  Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const integer = (v, min, max) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const exact = (v, keys) =>
  object(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const digest = (v) => createHash('sha256').update(v).digest('hex');

/** Order-independent JSON comparison for continuity and recorded replay. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function refused(category) {
  return Object.assign(
    new Error(`Dialogue stream stopped (${category}); nothing was retried.`),
    { category },
  );
}
function requireThat(ok, category = 'invalid-request') {
  if (!ok) throw refused(category);
}
function scenarioValid(s) {
  return (
    exact(s, ['file', 'sha256', 'id', 'branch']) &&
    text(s.file, 4096) &&
    isAbsolute(s.file) &&
    /^[a-f0-9]{64}$/.test(s.sha256) &&
    text(s.id, 100) &&
    ['A', 'B'].includes(s.branch)
  );
}
const categories = new Set([
  'auth',
  'usage-limit',
  'transient',
  'time-or-output-limit',
  'not-installed',
  'invalid-reply',
  'invalid-request',
  'call-cap',
  'cancelled',
  'closed',
  'busy',
  'ended',
  'replay-mismatch',
  'other',
]);
// Never forward an injected runner's message, output or arbitrary properties.
function safeFailure(error, calls) {
  return Object.assign(
    refused(categories.has(error?.category) ? error.category : 'other'),
    {
      calls,
      exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : null,
    },
  );
}

/** Strict output shape for an injected CLI adapter. Semantic checks run too. */
export function replySchema(role, view) {
  const shortText = { type: 'string', minLength: 1, maxLength: 400 };
  const record = (properties) => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  if (role === 'cast')
    return record({
      speaker: { enum: view.people.map((p) => p.name), type: 'string' },
      text: shortText,
      next: {
        type: 'string',
        enum: [...view.people.map((p) => p.name), view.focus.name, 'end'],
      },
    });
  if (role === 'listener')
    return record({
      speak: { type: 'boolean' },
      text: { anyOf: [shortText, { type: 'null' }] },
      card: { type: 'string', enum: ['none', 'used', 'ignored'] },
    });
  return record({
    verdicts: {
      type: 'array',
      minItems: view.criteria.length,
      maxItems: view.criteria.length,
      items: record({
        criterion: { type: 'string', enum: view.criteria.map((c) => c.id) },
        met: { type: 'string', enum: ['yes', 'no', 'unclear'] },
        lineIds: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string', enum: view.transcript.map((l) => l.id) },
        },
        reason: { type: 'string', minLength: 1, maxLength: 300 },
      }),
    },
  });
}

/** Open one frozen scenario/branch. gate.run(task,{role,signal}) must enforce
 * the shared evaluator+participant attempted-call cap and operation ownership.
 * run(role,{instructions,input,schema},{signal,deadlineMs}) must settle after
 * cancellation or its hard deadline, after provider cleanup. No automatic retry.
 * Only run/session cancellation uses signal; speech supersession is not abort. */
export async function openStream({
  scenario,
  maxCalls,
  settings = {},
  run,
  gate,
  signal,
  deadlineMs = 60_000,
  briefSource = 'generated',
  log = () => {},
}) {
  requireThat(scenarioValid(scenario));
  requireThat(integer(maxCalls, 1, 300) && integer(deadlineMs, 1, 60_000));
  requireThat(
    typeof run === 'function' &&
      typeof gate?.run === 'function' &&
      typeof log === 'function',
  );
  requireThat(['generated', 'fixture'].includes(briefSource));
  requireThat(
    object(settings) &&
      Object.keys(settings).every((k) =>
        ['maxTurns', 'interjectEvery', 'glances', 'pauseBeforeMs'].includes(k),
      ),
  );
  const config = {
    maxTurns: 14,
    interjectEvery: 3,
    glances: 3,
    pauseBeforeMs: 500,
    ...settings,
  };
  requireThat(
    integer(config.maxTurns, 1, 100) &&
      integer(config.interjectEvery, 1, 100) &&
      integer(config.glances, 0, 100) &&
      integer(config.pauseBeforeMs, 0, 60_000),
  );
  if (signal?.aborted) throw refused('cancelled');
  const binding = structuredClone(scenario);
  const handle = await open(binding.file, 'r');
  let raw;
  try {
    const stat = await handle.stat();
    requireThat(stat.isFile() && stat.size <= MAX_BYTES);
    raw = await handle.readFile();
    requireThat(raw.length <= MAX_BYTES && digest(raw) === binding.sha256);
  } finally {
    await handle.close();
  }
  let file;
  try {
    file = JSON.parse(raw.toString('utf8'));
  } catch {
    throw refused('invalid-request');
  }
  requireThat(
    file?.schema === 'talkqte-cue-dialogue-briefs/1' &&
      file.fictional === true &&
      Array.isArray(file.briefs) &&
      file.briefs.length <= 100,
  );
  const matches = file.briefs.filter((b) => b.id === binding.id);
  requireThat(matches.length === 1);
  const brief = structuredClone(matches[0]);
  validateBrief(brief, { source: briefSource });
  if (signal?.aborted) throw refused('cancelled');
  const names = allNames(brief);
  const sessionId = randomUUID();
  const controller = new AbortController();
  let terminal = null;
  let active = null;
  let totalCalls = 0;
  let callerRemaining = maxCalls;
  let state = null;
  let revision = 0;
  let transcript = [];
  let pending = null;
  let now = 0;
  let turnOf = null;
  let streak = 0;
  let glances = config.glances;
  let ended = false;
  let judged = false;
  const seen = new Set();
  const earlierCards = [];
  const cueHistory = new Map();
  const cancel = () => {
    terminal ??= 'cancelled';
    controller.abort();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const detach = () => signal?.removeEventListener('abort', cancel);
  const nextRole = () =>
    ended
      ? 'end'
      : turnOf === brief.focus.name || streak >= config.interjectEvery
        ? 'listener'
        : 'cast';

  function check(request, operation) {
    requireThat(
      exact(request, [
        'schema',
        'scenario',
        'transcript',
        'cues',
        'nowMs',
        'budgetMs',
        'callsLeft',
        'state',
      ]),
    );
    requireThat(
      request.schema === SCHEMA &&
        canonical(request.scenario) === canonical(binding),
    );
    requireThat(canonical(request.state) === canonical(state));
    requireThat(
      time(request.nowMs) && request.nowMs >= now && time(request.budgetMs),
    );
    requireThat(integer(request.callsLeft, 0, 300));
    callerRemaining = Math.min(callerRemaining, request.callsLeft);
    requireThat(
      Array.isArray(request.transcript) &&
        request.transcript.length <= config.maxTurns,
    );
    let end = 0;
    const ids = new Set();
    for (const line of request.transcript) {
      requireThat(
        exact(line, ['lineId', 'speaker', 'text', 'startMs', 'durationMs']),
      );
      requireThat(
        text(line.lineId, 100) &&
          !ids.has(line.lineId) &&
          names.includes(line.speaker) &&
          text(line.text),
      );
      requireThat(
        time(line.startMs) &&
          time(line.durationMs) &&
          line.durationMs > 0 &&
          time(line.startMs + line.durationMs) &&
          line.startMs >= end &&
          line.startMs + line.durationMs <= request.nowMs,
      );
      ids.add(line.lineId);
      end = line.startMs + line.durationMs;
    }
    requireThat(
      request.transcript.length === transcript.length + (pending ? 1 : 0),
    );
    requireThat(
      canonical(request.transcript.slice(0, transcript.length)) ===
        canonical(transcript),
    );
    if (pending) {
      const last = request.transcript.at(-1);
      requireThat(
        last.lineId === pending.lineId &&
          last.speaker === pending.speaker &&
          last.text === pending.text &&
          last.startMs >= pending.notBeforeMs,
      );
    }
    requireThat(Array.isArray(request.cues) && request.cues.length <= 100);
    requireThat(binding.branch !== 'B' || request.cues.length === 0);
    requireThat(operation !== 'judge' || request.cues.length === 0);
    const cueIds = new Set();
    for (const cue of request.cues) {
      requireThat(
        object(cue) &&
          Object.keys(cue).every((k) =>
            [
              'cueId',
              'atMs',
              'clearedAtMs',
              'text',
              'source',
              'decider',
            ].includes(k),
          ),
      );
      requireThat(
        text(cue.cueId, 100) &&
          !cueIds.has(cue.cueId) &&
          text(cue.text) &&
          text(cue.source, 100) &&
          text(cue.decider, 100) &&
          time(cue.atMs) &&
          cue.atMs <= request.nowMs,
      );
      requireThat(
        cue.clearedAtMs == null ||
          (time(cue.clearedAtMs) &&
            cue.clearedAtMs >= cue.atMs &&
            cue.clearedAtMs <= request.nowMs),
      );
      const prior = cueHistory.get(cue.cueId);
      requireThat(
        !prior ||
          (prior.atMs === cue.atMs &&
            prior.text === cue.text &&
            prior.source === cue.source &&
            prior.decider === cue.decider &&
            (prior.clearedAtMs == null ||
              prior.clearedAtMs === cue.clearedAtMs)),
      );
      cueHistory.set(cue.cueId, structuredClone(cue));
      cueIds.add(cue.cueId);
    }
    transcript = request.transcript;
    pending = null;
    now = request.nowMs;
  }

  function viewFor(role, request) {
    const lines = transcript.map(({ lineId: id, speaker, text: words }) => ({
      id,
      speaker,
      text: words,
    }));
    if (role === 'judge')
      return {
        transcript: lines,
        criteria: brief.criteria.map(({ id, text: words }) => ({
          id,
          text: words,
        })),
      };
    if (role === 'cast')
      return {
        ...castView(brief),
        transcript: lines,
        turnOf,
        turnsLeft: config.maxTurns - transcript.length,
      };
    const eligible = request.cues
      .filter((c) => !seen.has(c.cueId) && c.clearedAtMs == null)
      .sort((a, b) => b.atMs - a.atMs);
    const card = glances > 0 ? eligible[0] : null;
    return {
      ...listenerView(brief),
      mode: turnOf === brief.focus.name ? 'floor' : 'open',
      transcript: transcript.map(
        ({ lineId: id, speaker, text: words, startMs, durationMs }) =>
          speaker !== brief.focus.name &&
          brief.focus.distracted.some(
            (w) => startMs < w.toMs && startMs + durationMs > w.fromMs,
          )
            ? { id, speaker, missed: true }
            : { id, speaker, text: words },
      ),
      card: card?.text ?? null,
      earlierCards: [...earlierCards],
    };
  }

  async function perform(operation, original, options = {}) {
    // A second caller is refused without cancelling the owned operation.
    if (active) throw safeFailure(refused('busy'), 0);
    if (terminal) throw safeFailure(refused(terminal), 0);
    if (judged || (operation === 'next' && ended))
      throw safeFailure(refused('ended'), 0);
    let consumed = 0;
    const started = performance.now();
    const requestSignal = options.signal;
    requestSignal?.addEventListener('abort', cancel, { once: true });
    if (requestSignal?.aborted) cancel();
    let release;
    active = new Promise((resolve) => {
      release = resolve;
    });
    try {
      if (terminal) throw refused(terminal);
      const request = structuredClone(original);
      requireThat(JSON.stringify(request).length <= MAX_BYTES);
      check(request, operation);
      requireThat(
        operation !== 'judge' || (ended && transcript.length > 0),
        'invalid-request',
      );
      log({
        type: 'stream-request',
        operation,
        request: structuredClone(request),
      });
      let role = operation === 'judge' ? 'judge' : nextRole();
      if (operation === 'next' && transcript.length >= config.maxTurns) {
        ended = true;
        role = 'end';
      }
      let value;
      let usage = null;
      let read = null;
      if (role !== 'end') {
        requireThat(totalCalls < maxCalls && callerRemaining > 0, 'call-cap');
        const view = viewFor(role, request);
        const built = REQUESTS[role](view);
        // The shared gate counts immediately before admitting task. A refusal
        // by that gate dispatches no role call and leaves consumed at zero.
        value = await gate.run(
          async () => {
            if (terminal || controller.signal.aborted)
              throw refused(terminal ?? 'cancelled');
            totalCalls++;
            callerRemaining--;
            consumed++;
            const timer = setTimeout(() => {
              terminal ??= 'time-or-output-limit';
              controller.abort();
            }, deadlineMs);
            try {
              const outgoing = {
                instructions: built.systemPrompt,
                input: built.input,
                schema: replySchema(role, view),
              };
              log({
                type: 'stream-role-request',
                role,
                dispatch: totalCalls,
                request: structuredClone(outgoing),
              });
              const result = await run(role, outgoing, {
                signal: controller.signal,
                deadlineMs,
              });
              if (terminal || controller.signal.aborted)
                throw refused(terminal ?? 'cancelled');
              requireThat(object(result), 'invalid-reply');
              usage =
                result.usage == null
                  ? null
                  : Object.fromEntries(
                      [
                        'input_tokens',
                        'output_tokens',
                        'cache_read_input_tokens',
                        'cache_creation_input_tokens',
                      ]
                        .filter(
                          (key) =>
                            Number.isSafeInteger(result.usage?.[key]) &&
                            result.usage[key] >= 0,
                        )
                        .map((key) => [key, result.usage[key]]),
                    );
              const checked = VALIDATE[role](result.value, view);
              if (role === 'cast' && view.turnOf)
                requireThat(checked.speaker === view.turnOf, 'invalid-reply');
              log({
                type: 'stream-role-reply',
                role,
                dispatch: totalCalls,
                value: structuredClone(checked),
                usage: structuredClone(usage),
              });
              return structuredClone(checked);
            } finally {
              clearTimeout(timer);
            }
          },
          { role, signal: controller.signal },
        );
        if (terminal || controller.signal.aborted)
          throw refused(terminal ?? 'cancelled');
        if (role === 'listener' && view.card !== null) {
          const card = request.cues
            .filter((c) => !seen.has(c.cueId) && c.clearedAtMs == null)
            .sort((a, b) => b.atMs - a.atMs)[0];
          seen.add(card.cueId);
          glances--;
          earlierCards.push(card.text);
          read = {
            cueId: card.cueId,
            state: value.card === 'used' ? 'read-used' : 'read-ignored',
            atMs: now,
          };
        }
      }
      const lines = [];
      if (role === 'cast') {
        lines.push({
          lineId: `l${transcript.length + 1}`,
          speaker: value.speaker,
          text: value.text,
          pauseBeforeMs: config.pauseBeforeMs,
        });
        streak++;
        turnOf = value.next === 'end' ? null : value.next;
        ended = value.next === 'end';
      } else if (role === 'listener') {
        if (value.speak)
          lines.push({
            lineId: `l${transcript.length + 1}`,
            speaker: brief.focus.name,
            text: value.text,
            pauseBeforeMs: config.pauseBeforeMs,
          });
        streak = 0;
        turnOf = null;
      } else if (role === 'judge') judged = true;
      if (lines.length) {
        pending = { ...lines[0], notBeforeMs: now + config.pauseBeforeMs };
        if (transcript.length + 1 >= config.maxTurns) ended = true;
      }
      state = {
        schema: STATE_SCHEMA,
        session: sessionId,
        revision: ++revision,
      };
      const elapsedMs = Math.ceil(performance.now() - started);
      const reply = {
        schema: SCHEMA,
        lines,
        end: ended,
        calls: consumed,
        elapsedMs,
        overBudget: elapsedMs > request.budgetMs,
        state: structuredClone(state),
        nextRole: nextRole(),
        ...(read ? { read } : {}),
        ...(operation === 'judge' ? { verdicts: value.verdicts } : {}),
        usage,
      };
      log({
        type: 'stream-reply',
        operation,
        request: structuredClone(request),
        reply: structuredClone(reply),
      });
      if (judged) detach();
      return reply;
    } catch (error) {
      terminal ??= categories.has(error?.category) ? error.category : 'other';
      controller.abort();
      detach();
      const safe = safeFailure(
        { category: terminal, exitCode: error?.exitCode },
        consumed,
      );
      log({
        type: 'stream-failure',
        operation,
        category: safe.category,
        calls: consumed,
        totalCalls,
      });
      throw safe;
    } finally {
      requestSignal?.removeEventListener('abort', cancel);
      release();
      active = null;
    }
  }
  return Object.freeze({
    nextLines: (request, options) => perform('next', request, options),
    judgeStream: (request, options) => perform('judge', request, options),
    async close() {
      terminal ??= 'closed';
      controller.abort();
      detach();
      if (active) await active;
    },
    get calls() {
      return totalCalls;
    },
  });
}

/** Compatibility helpers never construct or reopen a provider/session. */
export function nextLines(request, { session, signal } = {}) {
  requireThat(typeof session?.nextLines === 'function');
  return session.nextLines(request, { signal });
}
export function judgeStream(request, { session, signal } = {}) {
  requireThat(typeof session?.judgeStream === 'function');
  return session.judgeStream(request, { signal });
}

/** Replay only completed stream-reply log records; no provider, gate or file
 * opens. Exact canonical requests and operation order are required. */
export function replayStream(records) {
  requireThat(Array.isArray(records) && records.length <= 301);
  const saved = structuredClone(records);
  requireThat(
    saved.every(
      (r) =>
        r.type === 'stream-reply' &&
        ['next', 'judge'].includes(r.operation) &&
        r.reply?.schema === SCHEMA,
    ),
  );
  let index = 0;
  let terminal = false;
  const play = (operation, request, { signal } = {}) => {
    try {
      requireThat(
        !terminal && !signal?.aborted,
        signal?.aborted ? 'cancelled' : 'closed',
      );
      const record = saved[index];
      requireThat(
        record &&
          operation === record.operation &&
          canonical(request) === canonical(record.request),
        'replay-mismatch',
      );
      index++;
      return structuredClone(record.reply);
    } catch (error) {
      terminal = true;
      throw error;
    }
  };
  return Object.freeze({
    async nextLines(request, options) {
      return play('next', request, options);
    },
    async judgeStream(request, options) {
      return play('judge', request, options);
    },
    async close() {
      terminal = true;
    },
  });
}
