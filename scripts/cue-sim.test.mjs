// Offline tests for the timing simulation. The clock is virtual and every
// evaluator here is a script or the deterministic fake: no process, model,
// account or network is used.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  GLANCE_WORDS,
  MODEL,
  SYSTEM_PROMPT,
  buildPrompt,
  classifyFailure,
  execute,
  subscriptionEnvironment,
  systemPromptFor,
} from './cue-lab.mjs';
import {
  EVALUATORS,
  claudeEvaluator,
  fakeEvaluator,
  rulesEvaluator,
} from './cue-evaluators.mjs';
import {
  CONTEXT_LINES,
  CUE_LIFETIME_MS,
  HISTORY_CUES,
  budgetTable,
  conversationFromCase,
  coverage,
  isBackchannel,
  finalOutcomeEvaluator,
  labelsEvaluator,
  loadConversations,
  main,
  maxEvaluations,
  resumingEvaluator,
  reusableDecisions,
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
    request: (testCase) => ({
      systemPrompt: null,
      input: buildPrompt(testCase),
    }),
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
// The simulation as it was before acknowledgements, cue history and the
// listener's name: the tests of the clock and the scoring use it so that
// each of those three is tested on its own, further down.
const plain = {
  ignoreBackchannels: false,
  cueHistory: false,
  listenerName: false,
};
const noDelay = { transcriptDelayMs: 0, minGapMs: 0, ...plain };
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
    { transcriptDelayMs: 3_000, minGapMs: 2_000, ...plain },
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
  await simulate(conversation, named, {
    ...noDelay,
    input: 'named',
    listenerName: true,
  });
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
      /could need 10 model requests and the cap is 5/,
    ],
    [
      ['--run', '--included-usage-confirmed', '--max-calls', '10'],
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
          ...EVALUATORS,
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
  // One line is a bare acknowledgement and starts no request.
  assert.match(text, /paper-reading-group: 11 lines over 69 s, at most 10/);
  assert.match(text, /off this device to Anthropic/);
  assert.match(text, /--max-calls 10 --included-usage-confirmed/);
  // Every line is listed as a request would carry it: one speaker label,
  // no speaker names, no labels.
  const [conversation] = (await loadConversations()).filter(
    (c) => c.id === 'paper-reading-group',
  );
  for (const item of conversation.lines) {
    assert.ok(text.includes(`  ${item.id}  Speaker: ${item.text}`), item.id);
    if (item.about) assert.ok(!text.includes(item.about), item.id);
  }
  assert.ok(!text.includes('Sofia'));
  assert.match(text, /A cue the evaluator wrote .* is therefore sent back/);
  // The listener's name is sent, and both prompts a run can use are
  // printed: with and without the sentence about earlier cues.
  assert.match(text, /userName "Dev"/);
  assert.equal(text.match(/System prompt:/g).length, 2);
  assert.equal(text.match(/userName is the listener's own name/g).length, 2);
  assert.equal(text.match(/earlierCues lists cues already shown/g).length, 1);
  assert.match(text, /up to 4 cues already shown with how each ended/);
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
        // And in words short enough to read on a card at a glance.
        assert.ok(
          item.cue?.split(/\s+/).length <= GLANCE_WORDS,
          `${where} has a cue of at most ${GLANCE_WORDS} words`,
        );
        if (item.until) assert.ok(order.get(item.until) > i, where);
      } else if (item.expect === 'resolved' || item.expect === 'withdraw') {
        const of = c.lines[order.get(item.of)];
        assert.equal(of?.expect, 'show', `${where} ends a labelled moment`);
        // The moment must say where it closes, or it would stay open.
        assert.ok(of.until, `${where}: ${item.of} names the line that ends it`);
        assert.ok(order.get(of.until) <= i, where);
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

test('replaying the labels at a fixed delay shows which labelled moments a slower evaluator loses', async () => {
  const conversations = await loadConversations();
  const at = async (latencyMs, options = {}) =>
    (
      await runSimulation({
        source: 'conversations',
        conversations,
        evaluator: labelsEvaluator(conversations, { latencyMs }),
        options,
      })
    ).totals;
  const instant = await at(0, { transcriptDelayMs: 0 });
  const typical = await at(4_000);
  const slow = await at(8_000);
  for (const totals of [instant, typical, slow]) {
    // It only ever acts where a label says to.
    assert.equal(totals.unexpectedShows, 0);
    assert.equal(totals.flips, 0);
    assert.equal(totals.duplicates, 0);
    assert.equal(totals.quiet.kept, totals.quiet.evaluated);
    assert.equal(totals.opportunities.labelled, 30);
  }
  // With no delay at all, the only misses are moments that open while an
  // earlier cue still holds the single slot.
  assert.ok(instant.opportunities.inTime >= 27);
  assert.equal(instant.opportunities.late, 0);
  assert.ok(typical.opportunities.inTime < instant.opportunities.inTime);
  assert.ok(slow.opportunities.inTime < typical.opportunities.inTime);
  assert.ok(typical.triggerToCue.medianMs >= 3_000 + 4_000);
  assert.ok(slow.evaluations.overtaken > typical.evaluations.overtaken);
});

test('the labels evaluator cannot cue a moment that has left the six-line window', async () => {
  const lines = [
    line('l1', 0, 'Someone needs to book the room.', {
      expect: 'show',
      about: 'The room has no one booking it.',
    }),
    ...Array.from({ length: 7 }, (_, i) =>
      line(`l${i + 2}`, 1_000 + i * 1_000, 'Mm.', { expect: 'quiet' }),
    ),
  ];
  const conversation = talk(lines);
  // The first request is still in flight when the next six lines arrive.
  const replay = await simulate(
    conversation,
    labelsEvaluator([conversation], { latencyMs: 6_500 }),
    noDelay,
  );
  const decisions = replay.timeline.filter((e) => e.type === 'decision');
  assert.deepEqual(
    decisions.map((d) => [d.lineId, d.action, d.outcome]),
    [
      ['l1', 'show', 'superseded'],
      ['l7', 'quiet', 'superseded'],
      ['l8', 'quiet', 'applied'],
    ],
  );
  assert.equal(score(conversation, replay).opportunities.missed, 1);
});

test('the dry run prints the prompts and command a run would really use', async () => {
  const dry = async (args) => {
    const lines = [];
    await main(args, {
      print: (text) => lines.push(text),
      environment: {},
      evaluators: {
        ...EVALUATORS,
        claude: () => claudeEvaluator({ environment: {} }),
      },
    });
    return lines.join('\n');
  };
  // Named input: speaker names and the listener's name are sent, and the
  // settings are carried into the suggested command.
  const named = await dry([
    '--conversations',
    'recruiter-intake',
    '--input',
    'named',
    '--min-gap-ms',
    '3000',
    '--transcript-delay-ms',
    '1000',
    '--apply-stale',
  ]);
  assert.match(named, /userName "Kai"/);
  assert.match(named, /  l1 {2}Paula: Thanks for making time/);
  assert.match(named, /userName is the listener's own name/);
  assert.match(
    named,
    /--conversations recruiter-intake --input named --min-gap-ms 3000 --transcript-delay-ms 1000 --apply-stale --run .* --max-calls \d+ --included-usage-confirmed/,
  );
  // A set: each case's own cue is listed. Cases with and without a
  // session name, each with and without earlier cues, make four prompts.
  const set = await dry(['--set', 'held-out', '--input', 'named']);
  assert.match(set, /cue on screen from e1: Who will book the hall\?/);
  assert.equal(set.match(/System prompt:/g).length, 4);
  // Each of the three additions can be switched off, and the command a
  // dry run suggests keeps the switch.
  const bare = await dry([
    '--conversations',
    'paper-reading-group',
    '--overtake-backchannels',
    '--no-cue-history',
    '--no-listener-name',
  ]);
  assert.match(bare, /at most 11 evaluations/);
  assert.equal(bare.match(/System prompt:/g).length, 1);
  assert.ok(!bare.includes('userName'));
  assert.match(
    bare,
    /--overtake-backchannels --no-cue-history --no-listener-name --run/,
  );
  // More than one invocation allows: no command that would be refused.
  const all = await dry([]);
  assert.match(all, /could need 163 requests, more than the 100/);
  assert.ok(!all.includes('--included-usage-confirmed'));
});

test('an adapter that does not say it is on-device cannot simulate without a confirmation and a cap', async () => {
  const [conversation] = await loadConversations();
  let opened = 0;
  const { hosted: _omitted, ...undeclared } = {
    ...fakeEvaluator({ latencyMs: 100 }),
    id: 'undeclared',
    open: async () => {
      opened++;
      return { model: 'fictional' };
    },
  };
  await assert.rejects(
    main(
      [
        '--conversations',
        conversation.id,
        '--evaluator',
        'undeclared',
        '--run',
      ],
      {
        print: () => {},
        environment: {},
        evaluators: { undeclared: () => undeclared },
      },
    ),
    /--included-usage-confirmed/,
  );
  for (const maxCalls of [undefined, Infinity, 0, 101])
    await assert.rejects(
      runSimulation({
        source: 'conversations',
        conversations: [conversation],
        evaluator: undeclared,
        maxCalls,
      }),
      /needs a call cap/,
    );
  assert.equal(opened, 0);
});

test('a cue shown after its moment closed is late, not missed, and a labelled withdrawal is not a flip', async () => {
  // The answer is said two seconds after the question, but with a
  // three-second transcription delay the evaluator has not heard it yet.
  const late = talk([
    line('l1', 0, 'Robin, can you book the room?', {
      expect: 'show',
      until: 'l2',
    }),
    line('l2', 2_000, 'Yes, I will.', { expect: 'resolved', of: 'l1' }),
  ]);
  const replay = await simulate(
    late,
    scripted({ l1: ['show', 500, 'Maya asked you to book the room.'] }),
    { transcriptDelayMs: 3_000, minGapMs: 0, ...plain },
  );
  const scored = score(late, replay);
  assert.deepEqual(
    [
      scored.opportunities.late,
      scored.opportunities.missed,
      scored.unexpectedShows,
    ],
    [1, 0, 0],
  );

  // The line labelled withdraw and a quiet line arrive while one request
  // is in flight; the catch-up withdraws with the quiet line as newest.
  const moved = talk([
    line('l1', 0, 'Someone needs to book the room.', {
      expect: 'show',
      until: 'l3',
    }),
    line('l2', 5_000, 'Mm.', { expect: 'quiet' }),
    line('l3', 5_500, 'Moving on to the budget.', {
      expect: 'withdraw',
      of: 'l1',
    }),
    line('l4', 6_000, 'Right.', { expect: 'quiet' }),
  ]);
  const metrics = score(
    moved,
    await simulate(
      moved,
      scripted({
        l1: ['show', 500, 'Who will book the room?'],
        l2: ['quiet', 2_000],
        l4: ['withdraw', 500],
      }),
      noDelay,
    ),
  );
  assert.equal(metrics.flips, 0);
  assert.equal(metrics.endings.asLabelled, 1);
  assert.equal(metrics.quiet.kept, metrics.quiet.evaluated);
});

test("a case whose cue is given never asks about that cue's own line", async () => {
  const set = await loadSet('cue-lab');
  for (const item of set.cases.filter((c) => c.existingCue)) {
    const conversation = conversationFromCase(item, 'cue-lab');
    const bound = await maxEvaluations(conversation, {});
    // An evaluator that would show at once still cannot exceed the bound.
    const eager = scripted(
      Object.fromEntries(conversation.lines.map((l) => [l.id, ['quiet', 0]])),
    );
    const replay = await simulate(conversation, eager, {});
    assert.equal(eager.seen.length, bound, item.id);
    assert.ok(
      !replay.timeline.some(
        (e) =>
          e.type === 'evaluation-start' &&
          e.lineId === item.existingCue.sourceIds.at(-1),
      ),
      item.id,
    );
  }
});

test('a stopped run can be resumed without asking again for the decisions it already has', async () => {
  const [conversation] = await loadConversations();
  // A "model" whose requests are measured, and which fails on its fifth.
  const measured = (failAt) => {
    let asked = 0;
    return {
      ...fakeEvaluator({ latencyMs: 300 }),
      id: 'measured',
      get asked() {
        return asked;
      },
      async decide(testCase) {
        if (++asked === failAt)
          throw Object.assign(new Error('Claude Code failed.'), {
            category: 'usage-limit',
            exitCode: 1,
          });
        const result = await fakeEvaluator({ latencyMs: 300 }).decide(testCase);
        return { ...result, latency: 'measured' };
      },
    };
  };
  const events = [];
  const first = await runSimulation({
    source: 'conversations',
    conversations: [conversation],
    evaluator: measured(5),
    log: { write: (type, data) => events.push({ type, ...data }) },
  });
  // The stop is recorded with its kind and exit code, not the CLI's words.
  assert.deepEqual(
    [first.stopped.afterCalls, first.stopped.category, first.stopped.exitCode],
    [5, 'usage-limit', 1],
  );
  const logText = events.map((event) => JSON.stringify(event)).join('\n');

  const again = measured(0);
  const reusable = reusableDecisions(logText, again);
  assert.equal(reusable.size, 4);
  const resumed = await runSimulation({
    source: 'conversations',
    conversations: [conversation],
    evaluator: resumingEvaluator(again, reusable),
  });
  assert.equal(resumed.stopped, null);
  assert.equal(resumed.reused, 4);
  const decisions = resumed.conversations[0].timeline.filter(
    (e) => e.type === 'decision',
  );
  // The first four are the earlier answers, in order and not asked again;
  // only the rest were requests, and only those are counted.
  assert.deepEqual(
    decisions.slice(0, 5).map((d) => d.reused),
    [true, true, true, true, false],
  );
  assert.equal(again.asked, decisions.length - 4);
  assert.equal(resumed.calls, again.asked);
  const earlier = events.filter((e) => e.type === 'sim-decision');
  assert.deepEqual(
    decisions.slice(0, 4).map((d) => [d.lineId, d.action, d.latencyMs, d.atMs]),
    earlier.map((d) => [d.lineId, d.action, d.latencyMs, d.atMs]),
  );

  // The cap counts new requests only.
  const capped = measured(0);
  const tight = await runSimulation({
    source: 'conversations',
    conversations: [conversation],
    evaluator: { ...resumingEvaluator(capped, reusable), hosted: true },
    maxCalls: 2,
  });
  assert.equal(capped.asked, 2);
  assert.equal(tight.reused, 4);
  assert.match(tight.stopped.reason, /call cap/);

  // Nothing is reused under another prompt, or from another evaluator.
  const reworded = {
    ...measured(0),
    request: (testCase) => ({
      systemPrompt: 'A different prompt.',
      input: buildPrompt(testCase),
    }),
  };
  const none = resumingEvaluator(
    reworded,
    reusableDecisions(logText, reworded),
  );
  assert.equal(
    (
      await runSimulation({
        source: 'conversations',
        conversations: [conversation],
        evaluator: none,
      })
    ).reused,
    0,
  );
  assert.throws(
    () => reusableDecisions(logText, fakeEvaluator()),
    /not from a simulation with this evaluator/,
  );
});

test('a failed request is sorted into a kind without keeping what the CLI said', async () => {
  for (const [text, kind] of [
    [
      'Claude usage limit reached. Your limit will reset at 3pm.',
      'usage-limit',
    ],
    ['API Error: 429 too many requests', 'usage-limit'],
    ['Invalid API key · Please run /login', 'auth'],
    ['OAuth token has expired', 'auth'],
    ['API Error: 529 Overloaded', 'transient'],
    ['fetch failed: ECONNRESET', 'transient'],
    ['something nobody expected', 'other'],
    ['', 'other'],
  ])
    assert.equal(classifyFailure({ code: 1, text }), kind, text);
  assert.equal(classifyFailure({ code: 'ENOENT' }), 'not-installed');
  assert.equal(
    classifyFailure({ code: null, killed: true }),
    'time-or-output-limit',
  );

  // A real child process that prints account-like text and exits 3.
  const secret = 'fictional-account@example.invalid hit your limit';
  await assert.rejects(
    execute(
      process.execPath,
      ['-e', `console.error(${JSON.stringify(secret)}); process.exit(3)`],
      { cwd: tmpdir(), env: subscriptionEnvironment(process.env) },
    ),
    (error) => {
      assert.equal(error.category, 'usage-limit');
      assert.equal(error.exitCode, 3);
      assert.match(error.message, /a usage or rate limit \(exit code 3\)/);
      assert.ok(!error.message.includes('fictional-account'));
      assert.ok(!JSON.stringify(error).includes('fictional-account'));
      return true;
    },
  );
});

test('the simulation asks for cues that can be read at a glance, and counts the ones that cannot', async () => {
  const plain = { events: [], existingCue: null };
  assert.equal(systemPromptFor(plain), SYSTEM_PROMPT);
  const glance = systemPromptFor(plain, { glance: true });
  assert.ok(glance.startsWith(SYSTEM_PROMPT));
  assert.match(glance, new RegExp(`at most ${GLANCE_WORDS} words`));
  // The dry run prints the prompt a run would use; the recorded one on request.
  const dry = async (args) => {
    const lines = [];
    await main(['--conversations', 'paper-reading-group', ...args], {
      print: (text) => lines.push(text),
      environment: {},
    });
    return lines.join('\n');
  };
  assert.match(await dry([]), /read at a glance/);
  const recorded = await dry(['--prompt', 'recorded']);
  assert.ok(!recorded.includes('read at a glance'));
  assert.match(recorded, /--prompt recorded --run/);
  await assert.rejects(dry(['--prompt', 'long']), /recorded or glance/);

  // Two cues: one a glance, one not.
  const conversation = talk([
    line('l1', 0, 'Someone needs to book the room.', { expect: 'show' }),
    line('l2', 30_000, 'Someone needs to order lunch.', { expect: 'show' }),
  ]);
  const long =
    'Who will own booking the larger meeting room that the workshop needs before the visitors arrive on Thursday?';
  const metrics = score(
    conversation,
    await simulate(
      conversation,
      scripted({
        l1: ['show', 500, long],
        l2: ['show', 500, 'Who will order lunch?'],
      }),
      noDelay,
    ),
  );
  assert.deepEqual(metrics.cueWords, [long.split(' ').length, 4]);
  assert.equal(metrics.cuesOverGlance, 1);
});

test('a bare acknowledgement neither starts an evaluation nor throws away a decision in flight', async () => {
  for (const [text, previous, expected] of [
    ['Mm.', '', true],
    ['Yeah.', '', true],
    ['Mm-hm, right.', '', true],
    ['Ha. Yeah.', '', true],
    ['Ah, okay.', '', true],
    // Not acknowledgements: a turn with content, a question, a topic
    // change, more than three words, and an answer to a question.
    ['Yeah, I will do it.', '', false],
    ['Right?', '', false],
    ['Okay, next item.', '', false],
    ['Sure, someday.', '', false],
    ['Oh. Good point.', '', false],
    ['Yeah yeah yeah yeah.', '', false],
    ['Yeah.', 'Are we done?', false],
    ['Okay.', 'Can you take the draft?', false],
  ])
    assert.equal(isBackchannel(text, previous), expected, text);

  const conversation = talk([
    line('l1', 0, 'Someone needs to book the room.', {
      expect: 'show',
      until: 'l5',
    }),
    line('l2', 1_500, 'Mm.', { expect: 'quiet' }),
    line('l3', 2_000, 'Yeah.', { expect: 'quiet' }),
    line('l4', 9_000, 'And lunch needs ordering too.', { expect: 'quiet' }),
    line('l5', 30_000, 'Moving on to the budget.', { expect: 'quiet' }),
  ]);
  const script = { l1: ['show', 4_000, 'Who will book the room?'] };
  const options = { transcriptDelayMs: 0, minGapMs: 0, ...plain };

  // As the app is today: the two acknowledgements overtake the decision.
  const before = scripted(script);
  const old = await simulate(conversation, before, options);
  assert.equal(
    old.timeline.find((e) => e.type === 'decision').outcome,
    'superseded',
  );
  assert.equal(score(conversation, old).opportunities.missed, 1);

  // With acknowledgements set aside, the same decision lands and is shown.
  const after = scripted(script);
  const kept = await simulate(conversation, after, {
    ...options,
    ignoreBackchannels: true,
  });
  assert.deepEqual(
    kept.timeline
      .filter((e) => e.type === 'evaluation-skipped')
      .map((e) => [e.lineId, e.why]),
    [
      ['l2', 'backchannel'],
      ['l3', 'backchannel'],
    ],
  );
  assert.equal(
    kept.timeline.find((e) => e.type === 'decision').outcome,
    'applied',
  );
  const scored = score(conversation, kept);
  assert.equal(scored.opportunities.inTime, 1);
  assert.equal(scored.evaluations.skippedBackchannel, 2);
  // Fewer requests, and the acknowledgements are still in later ones.
  assert.equal(after.seen.length, before.seen.length - 1);
  assert.deepEqual(
    after.seen[1].events.map((e) => e.id),
    ['l1', 'l2', 'l3', 'l4'],
  );

  // A real new turn still overtakes a decision in flight.
  const turn = talk([
    line('l1', 0, 'Someone needs to book the room.'),
    line('l2', 1_500, 'Actually, I booked it this morning.'),
  ]);
  const overtaken = await simulate(turn, scripted(script), {
    ...options,
    ignoreBackchannels: true,
  });
  assert.equal(
    overtaken.timeline.find((e) => e.type === 'decision').outcome,
    'superseded',
  );
});

test('each request lists the cues already shown and how each ended, and says so in the prompt', async () => {
  const conversation = talk([
    line('l1', 0, 'Someone needs to book the room.'),
    line('l2', 5_000, 'Moving on to the budget.'),
    line('l3', 10_000, 'Lunch needs ordering too.'),
    line('l4', 20_000, 'I ordered lunch.'),
    line('l5', 25_000, 'Good.'),
    line('l6', 80_000, 'That is everything.'),
  ]);
  const evaluator = scripted({
    l1: ['show', 500, 'Who will book the room?'],
    l2: ['withdraw', 500],
    l3: ['show', 500, 'Who will order lunch?'],
    l4: ['resolved', 500],
    l5: ['show', 500, 'Anything else to order?'],
  });
  const options = { transcriptDelayMs: 0, minGapMs: 0, ...plain };
  await simulate(conversation, evaluator, { ...options, cueHistory: true });
  assert.deepEqual(
    evaluator.seen.map((testCase) => testCase.earlierCues ?? []),
    [
      [],
      [],
      [{ text: 'Who will book the room?', state: 'withdrawn' }],
      [{ text: 'Who will book the room?', state: 'withdrawn' }],
      [
        { text: 'Who will book the room?', state: 'withdrawn' },
        { text: 'Who will order lunch?', state: 'resolved' },
      ],
      [
        { text: 'Who will book the room?', state: 'withdrawn' },
        { text: 'Who will order lunch?', state: 'resolved' },
        { text: 'Anything else to order?', state: 'expired' },
      ],
    ],
  );
  // What is sent: the same request shape with one more field, only once
  // there is something to list, and one more sentence in the prompt.
  const first = buildPrompt(evaluator.seen[0]);
  const third = buildPrompt(evaluator.seen[2]);
  assert.deepEqual(Object.keys(JSON.parse(first)), ['events', 'existingCue']);
  assert.deepEqual(Object.keys(JSON.parse(third)), [
    'events',
    'existingCue',
    'earlierCues',
  ]);
  assert.deepEqual(JSON.parse(third).earlierCues, [
    { text: 'Who will book the room?', state: 'withdrawn' },
  ]);
  assert.equal(systemPromptFor(evaluator.seen[0]), SYSTEM_PROMPT);
  assert.match(
    systemPromptFor(evaluator.seen[2]),
    /Do not show a cue that repeats or rewords one of them/,
  );

  // Never more than the last few, and none at all when switched off.
  const many = talk(
    Array.from({ length: 14 }, (_, i) =>
      line(`l${i + 1}`, i * 30_000, `Fictional line ${i + 1}.`),
    ),
  );
  const chatty = scripted(
    Object.fromEntries(
      many.lines.map((item, i) => [item.id, ['show', 500, `Cue ${i + 1}?`]]),
    ),
  );
  await simulate(many, chatty, { ...options, cueHistory: true });
  assert.equal(chatty.seen.at(-1).earlierCues.length, HISTORY_CUES);
  assert.equal(chatty.seen.at(-1).earlierCues.at(-1).text, 'Cue 13?');
  const silent = scripted({ l1: ['show', 500, 'Who will book the room?'] });
  await simulate(conversation, silent, options);
  assert.ok(silent.seen.every((testCase) => !('earlierCues' in testCase)));
});

test("the listener's name is sent as the session name, with one speaker label kept", async () => {
  const conversation = talk([line('l1', 0, 'Robin, is that endpoint ready?')]);
  const options = { transcriptDelayMs: 0, minGapMs: 0, ...plain };
  const named = scripted({});
  await simulate(conversation, named, { ...options, listenerName: true });
  assert.equal(named.seen[0].userName, 'Robin');
  assert.equal(named.seen[0].events[0].speaker, 'Speaker');
  assert.match(
    systemPromptFor(named.seen[0]),
    /userName is the listener's own name/,
  );
  assert.equal(JSON.parse(buildPrompt(named.seen[0])).userName, 'Robin');
  // A conversation with no listener sends no name.
  const nobody = scripted({});
  await simulate({ ...conversation, listener: null }, nobody, {
    ...options,
    listenerName: true,
  });
  assert.ok(!('userName' in nobody.seen[0]));
  // With the name, the labels evaluator's "asked you" moments are the same
  // as before: only what the evaluator is told changes, not the scoring.
  const without = scripted({});
  await simulate(conversation, without, options);
  assert.ok(!('userName' in without.seen[0]));
});

test('the budget estimate shows what transcript delay and decision time each allow', async () => {
  const rows = await budgetTable();
  assert.deepEqual(
    [...new Set(rows.map((row) => row.transcriptDelayMs))],
    [0, 1_000, 2_000, 3_000],
  );
  for (const row of rows) {
    assert.equal(row.moments, 30);
    assert.ok(row.withinBudget <= row.shown);
    assert.ok(row.inTime <= row.moments);
    // Nothing can be inside the budget when the two together exceed it.
    if (row.transcriptDelayMs + row.decisionMs > 5_000)
      assert.equal(row.withinBudget, 0, JSON.stringify(row));
  }
  const at = (delay, decision) =>
    rows.find(
      (row) => row.transcriptDelayMs === delay && row.decisionMs === decision,
    );
  // Today's two numbers put no cue inside the budget; halving both does.
  assert.equal(at(3_000, 4_000).withinBudget, 0);
  assert.ok(at(1_000, 2_000).withinBudget > 20);
  assert.ok(at(3_000, 1_000).withinBudget > at(3_000, 2_000).withinBudget - 30);
  assert.ok(at(0, 500).inTime >= at(3_000, 4_000).inTime);
});
