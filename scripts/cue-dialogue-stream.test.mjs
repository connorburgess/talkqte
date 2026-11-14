import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { briefsFile, loadFixtureBriefs } from './cue-dialogue-briefs.mjs';
import {
  CAST_PROMPT,
  listenerPrompt,
  fakeAgents,
} from './cue-dialogue-agents.mjs';
import {
  SCHEMA,
  openStream,
  nextLines,
  judgeStream,
  replayStream,
} from './cue-dialogue-stream.mjs';

const briefs = await loadFixtureBriefs();
const brief = briefs[0];
const folder = await mkdtemp(join(tmpdir(), 'talkqte-stream-'));
after(() => rm(folder, { recursive: true, force: true }));
const frozen = briefsFile(briefs, { source: 'fixture' });
const file = join(folder, 'briefs.json');
await writeFile(file, frozen.text);
const scenario = { file, sha256: frozen.sha256, id: brief.id, branch: 'A' };
const stopped = (category) => (error) => {
  assert.equal(error.category, category);
  return true;
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// A stand-in orchestrator gate shared with evaluator tasks too. It counts
// admitted runner dispatch attempts, not hidden provider HTTP requests.
function sharedGate(max = 300) {
  let active = false;
  let attempts = 0;
  return {
    get attempts() {
      return attempts;
    },
    async run(task, { signal } = {}) {
      if (active) throw Object.assign(new Error('busy'), { category: 'busy' });
      if (signal?.aborted)
        throw Object.assign(new Error('cancelled'), { category: 'cancelled' });
      if (attempts >= max)
        throw Object.assign(new Error('cap'), { category: 'call-cap' });
      active = true;
      attempts++;
      try {
        return await task();
      } finally {
        active = false;
      }
    },
  };
}
function cast(next = brief.people[0].name, speaker = brief.people[0].name) {
  return { value: { speaker, text: 'The rollout is ready for review.', next } };
}
function request(s = scenario) {
  return {
    schema: SCHEMA,
    scenario: structuredClone(s),
    transcript: [],
    cues: [],
    nowMs: 0,
    budgetMs: 6000,
    callsLeft: 30,
    state: null,
  };
}
function acknowledged(req, reply, cues = req.cues) {
  const transcript = structuredClone(req.transcript);
  if (reply.lines.length) {
    const line = reply.lines[0];
    const startMs = req.nowMs + line.pauseBeforeMs;
    transcript.push({
      lineId: line.lineId,
      speaker: line.speaker,
      text: line.text,
      startMs,
      durationMs: 1000,
    });
  }
  return {
    ...structuredClone(req),
    transcript,
    state: reply.state,
    nowMs: transcript.at(-1)
      ? transcript.at(-1).startMs + transcript.at(-1).durationMs
      : req.nowMs,
    callsLeft: req.callsLeft - reply.calls,
    cues,
  };
}
async function setup(options = {}) {
  const records = [];
  const calls = [];
  const run = options.run ?? (async () => cast());
  const session = await openStream({
    scenario,
    maxCalls: 30,
    briefSource: 'fixture',
    gate: sharedGate(),
    log: (r) => records.push(r),
    ...options,
    run: async (...args) => {
      calls.push(args);
      return run(...args);
    },
  });
  return { session, records, calls };
}
const cue = (extra = {}) => ({
  cueId: 'card-1',
  atMs: 1500,
  text: 'Who owns the release checklist?',
  source: 'runtime',
  decider: 'model',
  ...extra,
});

test('a hashed scenario produces one line and requires completed exact playback acknowledgement', async () => {
  const { session, calls } = await setup();
  let req = request();
  const first = await nextLines(req, { session });
  assert.equal(first.lines.length, 1);
  assert.equal(first.lines[0].lineId, 'l1');
  assert.equal(first.calls, 1);
  assert.equal(first.nextRole, 'cast');
  req = acknowledged(req, first);
  const second = await session.nextLines(req);
  assert.equal(second.lines[0].lineId, 'l2');
  assert.equal(calls[1][1].input.includes('l1'), true);
  assert.equal(session.calls, 2);
  await session.close();
});

test('invalid binding, hash and brief id are refused before runner or gate', async () => {
  let calls = 0;
  for (const binding of [
    { ...scenario, sha256: '0'.repeat(64) },
    { ...scenario, id: 'absent' },
    { ...scenario, file: 'relative.json' },
    { ...scenario, branch: 'C' },
  ]) {
    await assert.rejects(
      openStream({
        scenario: binding,
        maxCalls: 10,
        run: () => {
          calls++;
        },
        gate: sharedGate(),
        briefSource: 'fixture',
      }),
    );
  }
  assert.equal(calls, 0);
});

for (const [name, edit] of [
  [
    'missing acknowledgement',
    (r) => {
      r.transcript = [];
    },
  ],
  [
    'changed text',
    (r) => {
      r.transcript[0].text = 'Changed.';
    },
  ],
  [
    'changed speaker',
    (r) => {
      r.transcript[0].speaker = brief.focus.name;
    },
  ],
  [
    'in-progress speech',
    (r) => {
      r.nowMs--;
    },
  ],
  [
    'queued speech',
    (r) => {
      r.transcript[0].startMs += 5000;
    },
  ],
  [
    'duplicate acknowledgement',
    (r) => {
      r.transcript.push(r.transcript[0]);
    },
  ],
  [
    'revised old state',
    (r) => {
      r.state.revision--;
    },
  ],
  [
    'reset state',
    (r) => {
      r.state = null;
    },
  ],
])
  test(`${name} refuses before a second dispatch and makes session terminal`, async () => {
    const { session, calls } = await setup();
    const original = request();
    const first = await session.nextLines(original);
    const req = acknowledged(original, first);
    edit(req);
    await assert.rejects(session.nextLines(req), stopped('invalid-request'));
    await assert.rejects(
      session.nextLines(acknowledged(original, first)),
      stopped('invalid-request'),
    );
    assert.equal(calls.length, 1);
    await session.close();
  });

for (const [name, edit] of [
  [
    'unknown speaker',
    (r) =>
      r.transcript.push({
        lineId: 'x',
        speaker: 'Unknown',
        text: 'Hello',
        startMs: 0,
        durationMs: 1,
      }),
  ],
  [
    'negative time',
    (r) => {
      r.nowMs = -1;
    },
  ],
  [
    'nonfinite budget',
    (r) => {
      r.budgetMs = Infinity;
    },
  ],
  [
    'extra field',
    (r) => {
      r.private = 'data';
    },
  ],
  [
    'wrong branch',
    (r) => {
      r.scenario.branch = 'B';
    },
  ],
  [
    'future cue',
    (r) => {
      r.cues = [cue()];
    },
  ],
  [
    'oversized cue',
    (r) => {
      r.cues = [cue({ atMs: 0, text: 'x'.repeat(401) })];
    },
  ],
])
  test(`${name} is rejected without calls`, async () => {
    const { session, calls } = await setup();
    const req = request();
    edit(req);
    await assert.rejects(session.nextLines(req), stopped('invalid-request'));
    assert.equal(calls.length, 0);
  });

test('listener silence advances once to cast, with no repeated listener or busy loop', async () => {
  const { session, calls } = await setup({
    settings: { interjectEvery: 1 },
    run: async (role) =>
      role === 'listener'
        ? { value: { speak: false, text: null, card: 'none' } }
        : cast(),
  });
  let req = request();
  const first = await session.nextLines(req);
  assert.equal(first.nextRole, 'listener');
  req = acknowledged(req, first);
  const silent = await session.nextLines(req);
  assert.deepEqual(silent.lines, []);
  assert.equal(silent.nextRole, 'cast');
  assert.equal(silent.end, false);
  req = acknowledged(req, silent);
  await session.nextLines(req);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['cast', 'listener', 'cast'],
  );
  await session.close();
});

test('listener sees fresh on-screen card, spends a glance once, and does not see private cast facts', async () => {
  const views = [];
  const { session } = await setup({
    settings: { interjectEvery: 1, glances: 1 },
    run: async (role, built) => {
      const view = JSON.parse(built.input);
      views.push([role, view]);
      return role === 'listener'
        ? {
            value: {
              speak: false,
              text: null,
              card: view.card ? 'ignored' : 'none',
            },
          }
        : cast();
    },
  });
  let req = request();
  req = acknowledged(req, await session.nextLines(req), [cue()]);
  const reply = await session.nextLines(req);
  assert.deepEqual(reply.read, {
    cueId: 'card-1',
    state: 'read-ignored',
    atMs: 1500,
  });
  const view = views[1][1];
  assert.equal(view.card, cue().text);
  for (const person of brief.people)
    for (const fact of person.privately)
      assert.ok(!JSON.stringify(view).includes(fact));
  req = acknowledged(req, reply);
  req = acknowledged(req, await session.nextLines(req));
  await session.nextLines(req);
  assert.equal(views.at(-1)[1].card, null);
  await session.close();
});

for (const [label, cards, glances] of [
  ['cleared', [cue({ clearedAtMs: 1500 })], 3],
  ['glances exhausted', [cue()], 0],
  ['no card', [], 3],
])
  test(`${label} cannot affect listener`, async () => {
    let listener;
    const { session } = await setup({
      settings: { interjectEvery: 1, glances },
      run: async (role, built) => {
        if (role !== 'listener') return cast();
        listener = JSON.parse(built.input);
        return { value: { speak: false, text: null, card: 'none' } };
      },
    });
    let req = request();
    req = acknowledged(req, await session.nextLines(req), cards);
    await session.nextLines(req);
    assert.equal(listener.card, null);
    await session.close();
  });

test('branch B rejects cues and never supplies cue identity or text to listener', async () => {
  const binding = { ...scenario, branch: 'B' };
  const fakes = fakeAgents(briefs);
  const { session, calls } = await setup({
    scenario: binding,
    settings: { interjectEvery: 1 },
    run: async (role, built) => fakes[role].reply(JSON.parse(built.input)),
  });
  let req = request(binding);
  req = acknowledged(req, await session.nextLines(req));
  await session.nextLines(req);
  const listener = calls[1][1].input;
  assert.equal(JSON.parse(listener).card, null);
  assert.ok(!listener.includes('cueId'));
  await session.close();
  const other = await setup({ scenario: binding });
  const invalid = request(binding);
  invalid.cues = [cue({ atMs: 0 })];
  await assert.rejects(
    other.session.nextLines(invalid),
    stopped('invalid-request'),
  );
  assert.equal(other.calls.length, 0);
});

test('normal end requires final heard line before exactly one blind judge', async () => {
  const { session, calls } = await setup({
    run: async (role, built) => {
      if (role !== 'judge') return cast('end');
      const view = JSON.parse(built.input);
      assert.deepEqual(Object.keys(view).sort(), ['criteria', 'transcript']);
      assert.ok(!JSON.stringify(view).includes(brief.focus.goal));
      return {
        value: {
          verdicts: view.criteria.map((c) => ({
            criterion: c.id,
            met: 'unclear',
            lineIds: ['l1'],
            reason: 'The transcript does not settle it.',
          })),
        },
      };
    },
  });
  let req = request();
  const end = await session.nextLines(req);
  assert.equal(end.end, true);
  req = acknowledged(req, end);
  const judged = await judgeStream(req, { session });
  assert.equal(judged.verdicts.length, brief.criteria.length);
  assert.equal(judged.calls, 1);
  await assert.rejects(
    session.judgeStream({ ...req, state: judged.state }),
    stopped('ended'),
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['cast', 'judge'],
  );
  await session.close();
});

test('judge before normal end or before final playback refuses with no judge call', async () => {
  for (const done of [false, true]) {
    const { session, calls } = await setup({
      run: async () => cast(done ? 'end' : brief.people[0].name),
    });
    const req = request();
    const reply = await session.nextLines(req);
    await assert.rejects(
      session.judgeStream({ ...req, state: reply.state }),
      stopped('invalid-request'),
    );
    assert.equal(calls.length, 1);
  }
});

test('session cap includes judge and caller cannot reset or widen a narrowed cap', async () => {
  const { session, calls } = await setup({
    maxCalls: 1,
    run: async () => cast('end'),
  });
  let req = request();
  req = acknowledged(req, await session.nextLines(req));
  req.callsLeft = 300;
  await assert.rejects(session.judgeStream(req), stopped('call-cap'));
  assert.equal(calls.length, 1);
  const other = await setup();
  req = request();
  req.callsLeft = 1;
  req = acknowledged(req, await other.session.nextLines(req));
  req.callsLeft = 300;
  await assert.rejects(other.session.nextLines(req), stopped('call-cap'));
  assert.equal(other.calls.length, 1);
});

test('external gate cap covers evaluator and participant dispatch attempts', async () => {
  const gate = sharedGate(1);
  await gate.run(async () => ({ action: 'quiet' }));
  const { session, calls } = await setup({ gate });
  await assert.rejects(session.nextLines(request()), stopped('call-cap'));
  assert.equal(calls.length, 0);
  assert.equal(session.calls, 0);
  assert.equal(gate.attempts, 1);
});

test('first provider failure spends its attempt, stops and never leaks text or retries', async () => {
  const { session, calls } = await setup({
    run: async () => {
      throw Object.assign(new Error('private fictional-account@example.com'), {
        category: 'auth',
        stdout: 'private account',
      });
    },
  });
  await assert.rejects(session.nextLines(request()), (e) => {
    assert.equal(e.category, 'auth');
    assert.equal(e.calls, 1);
    assert.ok(!e.message.includes('fictional-account'));
    assert.ok(!JSON.stringify(e).includes('private'));
    return true;
  });
  await assert.rejects(session.nextLines(request()), stopped('auth'));
  assert.equal(calls.length, 1);
  assert.equal(session.calls, 1);
});

test('invalid model reply and wrong chosen speaker stop without repair', async () => {
  for (const value of [
    { speaker: brief.focus.name, text: 'Hello', next: 'end' },
    { speak: false, text: null, card: 'none' },
  ]) {
    const { session, calls } = await setup({ run: async () => ({ value }) });
    await assert.rejects(
      session.nextLines(request()),
      stopped('invalid-reply'),
    );
    assert.equal(calls.length, 1);
  }
});

test('abort before dispatch spends no attempt', async () => {
  const controller = new AbortController();
  const { session, calls } = await setup();
  controller.abort();
  await assert.rejects(
    session.nextLines(request(), { signal: controller.signal }),
    (e) => {
      assert.equal(e.category, 'cancelled');
      assert.equal(e.calls, 0);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('cancellation discards late reply and holds gate and close until cleanup', async () => {
  const entered = deferred();
  const late = deferred();
  const gate = sharedGate();
  const controller = new AbortController();
  const { session } = await setup({
    gate,
    run: async (_role, _req, options) => {
      entered.resolve(options.signal);
      return late.promise;
    },
  });
  const result = session.nextLines(request(), { signal: controller.signal });
  const failure = assert.rejects(result, (e) => {
    assert.equal(e.category, 'cancelled');
    assert.equal(e.calls, 1);
    return true;
  });
  const childSignal = await entered.promise;
  controller.abort();
  assert.equal(childSignal.aborted, true);
  let closed = false;
  const close = session.close().then(() => {
    closed = true;
  });
  await assert.rejects(
    gate.run(async () => {}),
    stopped('busy'),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, false);
  late.resolve(cast());
  await failure;
  await close;
  assert.equal(session.calls, 1);
  await assert.rejects(session.nextLines(request()), stopped('cancelled'));
});

test('hard deadline aborts bounded runner and is terminal, soft budget only flags reply', async () => {
  const { session } = await setup({
    deadlineMs: 5,
    run: async (_role, _req, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(cast()), { once: true });
      }),
  });
  await assert.rejects(
    session.nextLines(request()),
    stopped('time-or-output-limit'),
  );
  assert.equal(session.calls, 1);
  const soft = await setup();
  const req = request();
  req.budgetMs = 0;
  const reply = await soft.session.nextLines(req);
  assert.equal(reply.overBudget, true);
  await soft.session.close();
});

test('concurrent operations refuse rather than queue and cannot overlap role runners', async () => {
  const entered = deferred();
  const late = deferred();
  const { session, calls } = await setup({
    run: async () => {
      entered.resolve();
      return late.promise;
    },
  });
  const first = session.nextLines(request());
  await entered.promise;
  await assert.rejects(session.nextLines(request()), stopped('busy'));
  assert.equal(calls.length, 1);
  late.resolve(cast());
  await first;
  await session.close();
});

test('closed session cannot be reopened by compatibility helper, close is idempotent', async () => {
  const { session, calls } = await setup();
  await session.close();
  await session.close();
  await assert.rejects(nextLines(request(), { session }), stopped('closed'));
  assert.throws(() => nextLines(request()), stopped('invalid-request'));
  assert.equal(calls.length, 0);
});

test('strict replay returns saved replies in canonical request order without provider access', async () => {
  const { session, records } = await setup();
  const req = request();
  const reply = await session.nextLines(req);
  await session.close();
  const saved = records.filter((r) => r.type === 'stream-reply');
  const replay = replayStream(saved);
  const reordered = Object.fromEntries(Object.entries(req).reverse());
  assert.deepEqual(await replay.nextLines(reordered), reply);
  await assert.rejects(replay.nextLines(req), stopped('replay-mismatch'));
  const mismatch = replayStream(saved);
  await assert.rejects(
    mismatch.nextLines({ ...req, budgetMs: 1 }),
    stopped('replay-mismatch'),
  );
  await assert.rejects(mismatch.nextLines(req), stopped('closed'));
});

test('prompts ask participants to avoid repetition/interruption and use private facts', () => {
  assert.match(
    listenerPrompt('Fictional'),
    /Do not repeat a point you already made/,
  );
  assert.match(
    listenerPrompt('Fictional'),
    /latest question was put to someone else/,
  );
  assert.match(
    CAST_PROMPT,
    /Use those private facts when the discussion makes them relevant/,
  );
});

test('dispatch log retains exact role inputs and validated reply, with only safe usage counters', async () => {
  const { session, records } = await setup({
    run: async () => ({
      ...cast(),
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        account: 'fictional-account@example.com',
        cache_read_input_tokens: -1,
      },
    }),
  });
  const reply = await session.nextLines(request());
  assert.deepEqual(reply.usage, { input_tokens: 12, output_tokens: 4 });
  const sent = records.find((r) => r.type === 'stream-role-request');
  assert.equal(sent.role, 'cast');
  assert.equal(sent.request.instructions, CAST_PROMPT);
  assert.deepEqual(
    JSON.parse(sent.request.input).people.map((p) => p.name),
    brief.people.map((p) => p.name),
  );
  assert.deepEqual(
    records.find((r) => r.type === 'stream-role-reply').value,
    cast().value,
  );
  assert.ok(!JSON.stringify(records).includes('fictional-account'));
  await session.close();
});

test('listener distraction masks missed content and role views exclude criteria and offline blocks', async () => {
  const masked = structuredClone(brief);
  masked.focus.distracted = [
    { fromMs: 0, toMs: 10_000, doing: 'Checking an unrelated list.' },
  ];
  const stored = briefsFile([masked], {});
  const path = join(folder, 'distracted.json');
  await writeFile(path, stored.text);
  const binding = { ...scenario, file: path, sha256: stored.sha256 };
  let heard;
  const { session, calls } = await setup({
    scenario: binding,
    settings: { interjectEvery: 1 },
    run: async (role, built) => {
      if (role === 'cast') return cast();
      heard = JSON.parse(built.input);
      return { value: { speak: false, text: null, card: 'none' } };
    },
  });
  let req = request(binding);
  req = acknowledged(req, await session.nextLines(req));
  await session.nextLines(req);
  assert.deepEqual(heard.transcript, [
    { id: 'l1', speaker: brief.people[0].name, missed: true },
  ]);
  for (const [, built] of calls) {
    assert.ok(!built.input.includes('offline'));
    for (const c of brief.criteria) assert.ok(!built.input.includes(c.text));
  }
  await session.close();
});

test('a named next cast speaker is enforced after playback, even for another known speaker', async () => {
  let count = 0;
  const { session } = await setup({
    run: async () => (++count === 1 ? cast(brief.people[1].name) : cast()),
  });
  let req = request();
  req = acknowledged(req, await session.nextLines(req));
  await assert.rejects(session.nextLines(req), stopped('invalid-reply'));
  assert.equal(session.calls, 2);
});

test('a mutated request cannot change dispatched view while awaiting the shared gate', async () => {
  const admitted = deferred();
  const entered = deferred();
  let built;
  const gate = {
    async run(task) {
      entered.resolve();
      await admitted.promise;
      return task();
    },
  };
  const { session } = await setup({
    gate,
    run: async (_role, request) => {
      built = request;
      return cast();
    },
  });
  const req = request();
  const result = session.nextLines(req);
  await entered.promise;
  req.transcript.push({
    lineId: 'forged',
    speaker: brief.focus.name,
    text: 'Forged private speech.',
    startMs: 0,
    durationMs: 1,
  });
  admitted.resolve();
  await result;
  assert.ok(!built.input.includes('Forged private speech'));
  await session.close();
});
