// Offline tests for the timing simulation. The clock is virtual and every
// evaluator here is a script or the deterministic fake: no process, model,
// account or network is used.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MODEL } from './cue-lab.mjs';
import {
  claudeEvaluator,
  fakeEvaluator,
  rulesEvaluator,
} from './cue-evaluators.mjs';
import {
  CONTEXT_LINES,
  CUE_LIFETIME_MS,
  conversationFromCase,
  coverage,
  finalOutcomeEvaluator,
  loadConversations,
  main,
  maxEvaluations,
  runSimulation,
  score,
  simulate,
} from './cue-sim.mjs';
import { loadRulesOutcomes, loadSet } from './cue-lab-sets.mjs';

const line = (id, atMs, text, label = {}) => ({
  id,
  atMs,
  speaker: 'Maya',
  text,
  ...label,
});
const talk = (lines, extra = {}) => ({
  id: 'fictional',
  context: 'test',
  title: 'Fictional',
  setting: 'Fictional.',
  listener: 'Robin',
  participants: [],
  lines,
  ...extra,
});
const decide = (action, cue = null) => ({
  action,
  cue,
  sourceIds: null,
  reason: 'Scripted.',
  observedUse: 'not_observed',
});
/** Answers by the newest line's ID; anything unlisted is quiet in 1 s. */
function scripted(script) {
  const seen = [];
  return {
    seen,
    id: 'scripted',
    label: 'Scripted',
    kind: 'fake',
    hosted: false,
    async open() {
      return { model: null };
    },
    async decide(testCase) {
      seen.push(testCase);
      const [action, elapsedMs = 1_000, cue = null] =
        script[testCase.events.at(-1).id] ?? [];
      return {
        decision: decide(action ?? 'quiet', cue),
        elapsedMs,
        latency: 'simulated',
      };
    },
    async close() {},
  };
}
const noDelay = { transcriptDelayMs: 0, minGapMs: 0 };
const types = (timeline) => timeline.map((e) => `${e.atMs} ${e.type}`);

test('a cue appears one decision after its line and is scored against the moment it was for', async () => {
  const conversation = talk([
    line('l1', 1_000, 'Someone needs to book the room.', {
      expect: 'show',
      until: 'l3',
    }),
    line('l2', 9_000, 'Mm.', { expect: 'quiet' }),
    line('l3', 15_000, 'I will book it.', { expect: 'resolved', of: 'l1' }),
  ]);
  const replay = await simulate(
    conversation,
    scripted({
      l1: ['show', 4_000, 'Who will book the room?'],
      l3: ['resolved'],
    }),
    { transcriptDelayMs: 3_000, minGapMs: 2_000 },
  );
  assert.deepEqual(types(replay.timeline), [
    '4000 line',
    '4000 evaluation-start',
    '8000 decision',
    '8000 cue-shown',
    '12000 line',
    '12000 evaluation-start',
    '13000 decision',
    '18000 line',
    '18000 evaluation-start',
    '19000 decision',
    '19000 cue-cleared',
  ]);
  const metrics = score(conversation, replay);
  assert.deepEqual(
    [
      metrics.opportunities.inTime,
      metrics.opportunities.late,
      metrics.opportunities.missed,
    ],
    [1, 0, 0],
  );
  // Said at 1 s, transcribed at 4 s, decided at 8 s: 7 s after it was said.
  assert.deepEqual(metrics.afterSaidMs, [7_000]);
  assert.deepEqual(metrics.decisionMs, [4_000, 1_000, 1_000]);
  assert.deepEqual(
    [metrics.quiet.labelled, metrics.quiet.evaluated, metrics.quiet.kept],
    [1, 1, 1],
  );
  assert.equal(metrics.endings.asLabelled, 1);
  // The answer was said at 15 s; the cue stayed until 19 s.
  assert.equal(metrics.endings.detail[0].lingerMs, 4_000);
  assert.equal(metrics.unexpectedShows + metrics.flips + metrics.duplicates, 0);
});

test('a decision overtaken by newer speech is dropped and one catch-up follows with the latest lines', async () => {
  const conversation = talk([
    line('l1', 1_000, 'Someone needs to book the room.', { expect: 'show' }),
    line('l2', 2_000, 'And the projector.'),
    line('l3', 3_000, 'And lunch.'),
  ]);
  const evaluator = scripted({
    l1: ['show', 5_000, 'Who will book the room?'],
    l3: ['show', 1_000, 'Who will book the room and lunch?'],
  });
  const replay = await simulate(conversation, evaluator, noDelay);
  assert.deepEqual(types(replay.timeline), [
    '1000 line',
    '1000 evaluation-start',
    '2000 line',
    '2000 evaluation-skipped',
    '3000 line',
    '3000 evaluation-skipped',
    '6000 decision',
    '6000 evaluation-start',
    '7000 decision',
    '7000 cue-shown',
    `${3_000 + CUE_LIFETIME_MS} cue-cleared`,
  ]);
  const [first, second] = replay.timeline.filter((e) => e.type === 'decision');
  assert.equal(first.outcome, 'superseded');
  assert.equal(second.outcome, 'applied');
  // Never two requests at once, and the catch-up saw all three lines.
  assert.equal(evaluator.seen.length, 2);
  assert.deepEqual(
    evaluator.seen[1].events.map((e) => e.id),
    ['l1', 'l2', 'l3'],
  );
  const metrics = score(conversation, replay);
  assert.equal(metrics.evaluations.overtaken, 1);
  assert.equal(metrics.evaluations.skippedBusy, 2);
  assert.equal(metrics.opportunities.inTime, 1);
});

test('applying an overtaken decision anyway shows the cue late, after its moment has passed', async () => {
  const conversation = talk([
    line('l1', 1_000, 'Someone needs to book the room.', {
      expect: 'show',
      until: 'l2',
    }),
    line('l2', 3_000, 'I will book it.', { expect: 'resolved', of: 'l1' }),
  ]);
  const script = { l1: ['show', 5_000, 'Who will book the room?'] };
  const dropped = score(
    conversation,
    await simulate(conversation, scripted(script), noDelay),
  );
  assert.equal(dropped.opportunities.missed, 1);
  assert.equal(dropped.cuesShown, 0);
  const applied = score(
    conversation,
    await simulate(conversation, scripted(script), {
      ...noDelay,
      applyStale: true,
    }),
  );
  assert.deepEqual(
    [applied.opportunities.late, applied.opportunities.missed],
    [1, 0],
  );
});

test('lines closer than the minimum gap share one later evaluation, and the dry-run bound holds', async () => {
  const conversation = talk(
    [0, 400, 800, 1_200, 1_600, 9_000].map((atMs, i) =>
      line(`l${i + 1}`, atMs, `Fictional line ${i + 1}.`),
    ),
  );
  const options = { transcriptDelayMs: 0, minGapMs: 2_000 };
  const evaluator = scripted({});
  const replay = await simulate(conversation, evaluator, {
    ...options,
    // Faster than the gap, so only the gap limits the count.
  });
  const starts = replay.timeline.filter((e) => e.type === 'evaluation-start');
  assert.deepEqual(
    starts.map((e) => [e.atMs, e.lineId]),
    [
      [0, 'l1'],
      [2_000, 'l5'],
      [9_000, 'l6'],
    ],
  );
  assert.equal(await maxEvaluations(conversation, options), 3);
  // A slower evaluator can only make fewer.
  const slow = await simulate(
    conversation,
    scripted({ l1: ['quiet', 8_000] }),
    options,
  );
  assert.ok(
    slow.timeline.filter((e) => e.type === 'evaluation-start').length <= 3,
  );
});

test('an unread cue expires after 18 seconds, and a decision about an expired cue is not applied', async () => {
  const conversation = talk([
    line('l1', 0, 'Someone needs to book the room.', { expect: 'show' }),
    line('l2', 17_500, 'I will book it.'),
  ]);
  const replay = await simulate(
    conversation,
    scripted({
      l1: ['show', 1_000, 'Who will book the room?'],
      l2: ['resolved', 2_000],
    }),
    noDelay,
  );
  const expiry = replay.timeline.find((e) => e.type === 'cue-cleared');
  assert.equal(expiry.atMs, CUE_LIFETIME_MS);
  assert.equal(expiry.why, 'expired');
  assert.equal(replay.timeline.at(-1).outcome, 'cue-changed');
  // A cue whose newest source is already older than a cue may live is refused.
  const late = await simulate(
    talk([line('l1', 0, 'Someone needs to book the room.')]),
    scripted({ l1: ['show', CUE_LIFETIME_MS + 1, 'Who will book the room?'] }),
    noDelay,
  );
  assert.equal(late.timeline.at(-1).outcome, 'too-late');
  assert.ok(!late.timeline.some((e) => e.type === 'cue-shown'));
});

test('a request holds the newest six lines plus the cue, and only what the app would send', async () => {
  const lines = Array.from({ length: 9 }, (_, i) =>
    line(`l${i + 1}`, i * 3_000, `Fictional line ${i + 1}.`, {
      expect: 'quiet',
      about: 'A label that must not be sent.',
      note: 'Nor this note.',
    }),
  );
  const conversation = talk(lines);
  const evaluator = scripted({ l1: ['show', 500, 'A fictional cue?'] });
  // A long-lived cue is not what this test is about: its lines must stay
  // in the request while it is on screen, even when older than the window.
  const replay = await simulate(conversation, evaluator, noDelay);
  const withCue = evaluator.seen[5];
  assert.deepEqual(
    withCue.events.map((e) => e.id),
    ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'],
  );
  assert.deepEqual(withCue.existingCue, {
    text: 'A fictional cue?',
    sourceIds: ['l1'],
  });
  const last = evaluator.seen.at(-1);
  assert.equal(last.events.length, CONTEXT_LINES);
  assert.equal(last.existingCue, null);
  for (const start of replay.timeline.filter(
    (e) => e.type === 'evaluation-start',
  )) {
    const input = JSON.parse(start.input);
    assert.deepEqual(Object.keys(input), ['events', 'existingCue']);
    assert.ok(!start.input.includes('must not be sent'));
    assert.ok(!start.input.includes('Nor this note'));
    for (const event of input.events) {
      assert.deepEqual(Object.keys(event), ['id', 'speaker', 'text']);
      assert.equal(event.speaker, 'Speaker');
    }
  }
  const named = scripted({});
  await simulate(conversation, named, { ...noDelay, input: 'named' });
  assert.equal(named.seen[0].events[0].speaker, 'Maya');
  assert.equal(named.seen[0].userName, 'Robin');
});

test('unexpected cues, a cue taken back, and a repeated cue are each counted', async () => {
  const conversation = talk([
    line('l1', 0, 'The weather was lovely.', { expect: 'quiet' }),
    line('l2', 10_000, 'Still lovely.', { expect: 'quiet' }),
    line('l3', 20_000, 'Someone needs to book the room.', { expect: 'show' }),
    line('l4', 30_000, 'Yes, someone really should.', { expect: 'quiet' }),
    line('l5', 60_000, 'Lovely.', { expect: 'quiet' }),
  ]);
  const replay = await simulate(
    conversation,
    scripted({
      l1: ['show', 1_000, 'What about the weather?'],
      l2: ['withdraw', 1_000],
      l3: ['show', 1_000, 'Who will book the room?'],
      l5: ['show', 1_000, 'Who will book the room?'],
    }),
    noDelay,
  );
  const metrics = score(conversation, replay);
  assert.equal(metrics.cuesShown, 3);
  assert.equal(metrics.unexpectedShows, 2, 'the weather cue and the repeat');
  assert.equal(metrics.flips, 1, 'shown at l1, withdrawn at l2');
  assert.equal(metrics.duplicates, 1, 'the same words shown again at l5');
  assert.equal(metrics.opportunities.inTime, 1);
  // l1 and l5 showed, l2 withdrew: only l4 was left quiet.
  assert.deepEqual(
    [metrics.quiet.labelled, metrics.quiet.evaluated, metrics.quiet.kept],
    [4, 4, 1],
  );
});

test('a cue that arrives a line late for an open moment does not count as breaking a quiet', async () => {
  const conversation = talk([
    line('l1', 0, 'Someone needs to book the room.', { expect: 'show' }),
    line('l2', 1_000, 'Mm.', { expect: 'quiet' }),
    line('l3', 9_000, 'Lovely weather.', { expect: 'quiet' }),
  ]);
  const replay = await simulate(
    conversation,
    scripted({
      l1: ['quiet', 3_000],
      l2: ['show', 1_000, 'Who will book the room?'],
    }),
    noDelay,
  );
  const metrics = score(conversation, replay);
  assert.equal(metrics.opportunities.inTime, 1);
  assert.equal(metrics.unexpectedShows, 0);
  assert.deepEqual([metrics.quiet.evaluated, metrics.quiet.kept], [1, 1]);
});

test('a cue left on screen after the line that answered it is reported as lingering', async () => {
  const conversation = talk([
    line('l1', 0, 'Someone needs to book the room.', { expect: 'show' }),
    line('l2', 5_000, 'I will book it.', { expect: 'resolved', of: 'l1' }),
    line('l3', 9_000, 'Now, the budget.', { expect: 'withdraw', of: 'l1' }),
  ]);
  const replay = await simulate(
    conversation,
    scripted({
      l1: ['show', 1_000, 'Who will book the room?'],
      l3: ['withdraw'],
    }),
    noDelay,
  );
  const { endings } = score(conversation, replay);
  // l2 was labelled as the answer; the evaluator cleared the cue at l3 instead.
  assert.deepEqual(
    endings.detail.map((e) => [e.lineId, e.outcome, e.lingerMs]),
    [
      ['l2', 'cleared-otherwise', 5_000],
      ['l3', 'as-labelled', 1_000],
    ],
  );
  const never = score(
    conversation,
    await simulate(
      conversation,
      scripted({ l1: ['show', 1_000, 'Who will book the room?'] }),
      noDelay,
    ),
  );
  assert.equal(never.endings.lingered, 2);
  assert.equal(never.endings.detail[0].lingerMs, CUE_LIFETIME_MS - 5_000);
});

test('a simulation stops at the call cap and at the first evaluator failure, keeping what completed', async () => {
  const conversations = (await loadConversations()).slice(0, 2);
  const capped = await runSimulation({
    source: 'conversations',
    conversations,
    evaluator: fakeEvaluator({ latencyMs: 100 }),
    maxCalls: 5,
  });
  assert.equal(capped.calls, 5);
  assert.match(capped.stopped.reason, /call cap/);
  assert.equal(capped.conversations.length, 1);

  let asked = 0;
  const failing = {
    ...fakeEvaluator({ latencyMs: 100 }),
    async decide() {
      if (++asked === 3)
        throw new Error('Claude did not complete the evaluation.');
      return { decision: decide('quiet'), elapsedMs: 100, latency: 'measured' };
    },
  };
  const events = [];
  const failed = await runSimulation({
    source: 'conversations',
    conversations,
    evaluator: failing,
    maxCalls: 50,
    log: { write: (type, data) => events.push({ type, ...data }) },
  });
  assert.equal(asked, 3, 'no retry and nothing after the failure');
  assert.equal(
    failed.stopped.reason,
    'Claude did not complete the evaluation.',
  );
  assert.equal(failed.conversations.length, 0);
  // The log still holds every line and decision up to the failure.
  assert.equal(events.filter((e) => e.type === 'sim-decision').length, 2);
  assert.equal(events.at(-1).type, 'run-end');
});

test('a hosted simulation is refused before any process without confirmation, a cap, or room under it', async () => {
  for (const [args, message] of [
    [['--run'], /--included-usage-confirmed/],
    [['--run', '--included-usage-confirmed'], /call cap/],
    [
      ['--run', '--included-usage-confirmed', '--max-calls', '5'],
      /could need 11 model requests and the cap is 5/,
    ],
    [
      ['--run', '--included-usage-confirmed', '--max-calls', '11'],
      /Say where to write/,
    ],
    [['--evaluator', 'rules'], /no recorded outcomes for the timed/],
    [['--set', 'cue-lab'], /not both/],
    [['--input', 'everything'], /app or named/],
    [['--min-gap-ms', 'fast'], /whole number/],
  ]) {
    let ran = 0;
    await assert.rejects(
      main(['--conversations', 'paper-reading-group', ...args], {
        print: () => {},
        environment: { HOME: '/fictional-home' },
        evaluators: {
          claude: () =>
            claudeEvaluator({
              environment: { HOME: '/fictional-home' },
              run: async () => {
                ran++;
                return '';
              },
            }),
        },
      }),
      message,
    );
    assert.equal(ran, 0, args.join(' '));
  }
});

test('the dry run starts nothing and says how many requests could leave the device', async () => {
  const lines = [];
  const result = await main(['--conversations', 'paper-reading-group'], {
    print: (text) => lines.push(text),
    environment: {},
    evaluators: {
      claude: () => ({
        ...claudeEvaluator({ environment: {} }),
        open: () => assert.fail('a dry run opened the evaluator'),
        decide: () => assert.fail('a dry run asked for a decision'),
      }),
    },
  });
  assert.equal(result, null);
  const text = lines.join('\n');
  assert.match(text, /Dry run\. No process was started and nothing was sent/);
  assert.match(text, /paper-reading-group: 11 lines over 69 s, at most 11/);
  assert.match(text, /off this device to Anthropic/);
  assert.match(text, /--max-calls 11 --included-usage-confirmed/);
});

test('a run is repeatable and writes results and a full event log outside the repository', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'talkqte-sim-test-'));
  const run = () =>
    main(['--evaluator', 'fake', '--run', '--out', directory], {
      print: () => {},
      environment: {},
      now: () => new Date('2026-11-14T09:30:05Z'),
    });
  const first = await run();
  const second = await run();
  assert.deepEqual(first, second);
  assert.equal(first.fictional, true);
  assert.equal(first.simulated, true);
  assert.equal(first.stopped, null);
  assert.equal(first.conversations.length, 13);
  assert.equal(first.calls, first.totals.evaluations.started);
  const name = 'cue-sim-conversations-fake-20261114-093005';
  assert.deepEqual(readdirSync(directory).sort(), [
    `${name}.json`,
    `${name}.log.jsonl`,
  ]);
  const log = readFileSync(join(directory, `${name}.log.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((text) => JSON.parse(text));
  const lines = first.totals.lines;
  // Both runs appended: every line, request and decision is there twice.
  assert.equal(log.filter((e) => e.type === 'sim-line').length, lines * 2);
  assert.equal(
    log.filter((e) => e.type === 'sim-evaluation-start').length,
    first.calls * 2,
  );
  assert.equal(
    log.filter((e) => e.type === 'sim-decision').length,
    first.calls * 2,
  );
  assert.ok(
    log.filter((e) => e.type === 'sim-evaluation-start').every((e) => e.input),
  );
});

test('the three case sets replay as two-second conversations from each fixture cue', async () => {
  const set = await loadSet('cue-lab');
  const rules = finalOutcomeEvaluator(
    rulesEvaluator(await loadRulesOutcomes('cue-lab')),
  );
  const results = await runSimulation({
    source: 'set:cue-lab',
    conversations: set.cases.map((item) =>
      conversationFromCase(item, 'cue-lab'),
    ),
    evaluator: rules,
  });
  assert.equal(results.stopped, null);
  const by = Object.fromEntries(results.conversations.map((c) => [c.id, c]));
  // visible-cue-resolved: the fixture's cue is on screen after e1, and the
  // rules' recorded outcome clears it at e2 as labelled.
  const resolved = by['visible-cue-resolved'];
  assert.deepEqual(
    resolved.timeline
      .filter((e) => e.type.startsWith('cue-'))
      .map((e) => [e.type, e.origin ?? e.why]),
    [
      ['cue-shown', 'fixture'],
      ['cue-cleared', 'resolved'],
    ],
  );
  assert.equal(resolved.metrics.endings.asLabelled, 1);
  // context-corrected: labelled withdraw, the rules stay quiet, the cue stays.
  assert.equal(by['context-corrected'].metrics.endings.lingered, 1);
  // already-answered: the rules raise and clear a question within the case;
  // the record keeps only "resolved", which has no cue to act on here.
  assert.equal(by['already-answered'].metrics.evaluations.noCue, 1);
  // The rules record has no delay, so no trigger-to-cue time is reported.
  assert.equal(results.totals.triggerToCue, null);
  assert.equal(results.totals.decisionLatency, null);
});

test('the timed conversations cover software, AI and hiring work and are mostly quiet', async () => {
  const conversations = await loadConversations();
  assert.ok(conversations.length >= 12);
  const contexts = new Set(conversations.map((c) => c.context));
  for (const context of ['engineering', 'ai', 'interview', 'customer'])
    assert.ok(contexts.has(context), context);
  const ids = new Set();
  const labels = {};
  for (const c of conversations) {
    assert.match(c.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(!ids.has(c.id), `${c.id} is listed once`);
    ids.add(c.id);
    assert.ok(c.lines.length >= 10, `${c.id} is a real stretch of talk`);
    assert.ok(
      c.participants.some((p) => p.name === c.listener),
      c.id,
    );
    const names = new Set(c.participants.map((p) => p.name));
    const order = new Map(c.lines.map((item, i) => [item.id, i]));
    for (const [i, item] of c.lines.entries()) {
      const where = `${c.id} ${item.id}`;
      assert.equal(item.id, `l${i + 1}`, where);
      assert.ok(names.has(item.speaker), where);
      assert.ok(item.text.trim() === item.text && item.text.length > 0, where);
      if (i) assert.ok(item.atMs > c.lines[i - 1].atMs, `${where} is later`);
      labels[item.expect] = (labels[item.expect] ?? 0) + 1;
      if (item.expect === 'show') {
        assert.ok(
          item.about?.length > 10,
          `${where} says what the cue is about`,
        );
        if (item.until) assert.ok(order.get(item.until) > i, where);
      } else if (item.expect === 'resolved' || item.expect === 'withdraw') {
        const of = c.lines[order.get(item.of)];
        assert.equal(of?.expect, 'show', `${where} ends a labelled moment`);
        assert.ok(order.get(item.of) < i, where);
      } else if (item.expect === null) {
        assert.ok(item.note?.length > 10, `${where} says why it is unlabelled`);
      } else assert.equal(item.expect, 'quiet', where);
    }
  }
  for (const action of ['show', 'quiet', 'resolved', 'withdraw'])
    assert.ok(labels[action] > 0, `uses ${action}`);
  // Most of a meeting should raise nothing.
  const total = Object.values(labels).reduce((a, b) => a + b, 0);
  assert.ok(labels.quiet / total > 0.6);
  const rows = await coverage();
  assert.equal(rows.filter((row) => row.kind === 'case set').length, 3);
  assert.ok(rows.filter((row) => row.timed).length >= 5);
});

test('a hosted simulation checks the sign-in once and asks one request at a time', async () => {
  const calls = [];
  let inFlight = 0;
  const evaluator = claudeEvaluator({
    environment: { HOME: '/fictional-home', PATH: '/fictional-bin' },
    run: async (command, args, options) => {
      calls.push(args);
      if (args.includes('--version')) return '2.1.318 (Claude Code)';
      if (args.includes('auth'))
        return JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: 'max',
        });
      assert.equal(++inFlight, 1);
      const { events } = JSON.parse(options.input);
      inFlight--;
      return JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify({
          ...decide('quiet'),
          sourceIds: [events.at(-1).id],
        }),
        modelUsage: { [MODEL]: {} },
      });
    },
  });
  const [conversation] = await loadConversations();
  const results = await runSimulation({
    source: 'conversations',
    conversations: [conversation],
    evaluator,
    maxCalls: 20,
  });
  assert.equal(results.stopped, null);
  assert.equal(calls.length, 2 + results.calls);
  assert.equal(results.evaluator.model, MODEL);
  assert.ok(
    results.conversations[0].timeline
      .filter((e) => e.type === 'decision')
      .every((e) => e.latency === 'measured'),
  );
});
