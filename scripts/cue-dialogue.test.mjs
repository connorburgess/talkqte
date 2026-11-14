import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeEvaluator, fakeEvaluator } from './cue-evaluators.mjs';
import { createRunLog } from './cue-lab-output.mjs';
import { DEFAULTS as SIM_DEFAULTS } from './cue-sim.mjs';
import {
  briefProblems,
  briefsFile,
  loadFixtureBriefs,
} from './cue-dialogue-briefs.mjs';
import {
  CAST_PROMPT,
  GENERATOR_PROMPT,
  JUDGE_PROMPT,
  ROLE_MODELS,
  claudeAgents,
  fakeAgents,
  fakeGenerator,
} from './cue-dialogue-agents.mjs';
import {
  DEFAULT_PLAN,
  DEFAULTS,
  PLACEBO_CUES,
  createBudget,
  main,
  random,
  recordedSource,
  runDialogue,
  runScenario,
  savedRun,
  worstCaseCalls,
} from './cue-dialogue.mjs';

const briefs = await loadFixtureBriefs();
const byId = (id) => briefs.find((brief) => brief.id === id);

/** A run of the fakes over the chosen hand-written briefs, recording every
 * request each role made. */
async function rehearse({
  ids = ['release-handoff'],
  chosen: given,
  latencyMs = 1_500,
  agents,
  settings = {},
  maxCalls = 300,
  seed = 'test',
  cueSource = null,
  replay = null,
} = {}) {
  const chosen = given ?? ids.map(byId);
  const requests = [];
  const results = await runDialogue({
    agents: agents ?? fakeAgents(chosen),
    evaluator: fakeEvaluator({ latencyMs }),
    plan: { ...DEFAULT_PLAN, scenarios: chosen.length },
    settings,
    seed,
    maxCalls,
    cueSource,
    replay,
    onRequest: (request) => requests.push(request),
  });
  return { results, requests };
}

const branch = (results, scenario, name) =>
  results.branches.find((b) => b.scenario === scenario && b.branch === name);
const said = (b) => b.lines.map(({ speaker, text }) => `${speaker}: ${text}`);

test('the hand-written briefs pass the same checks a generated one must', () => {
  assert.equal(briefs.length, 3);
  for (const brief of briefs)
    assert.deepEqual(briefProblems(brief, { source: 'fixture' }), []);
});

test('branches share the prefix up to the fork, then differ only by what the listener was given', async () => {
  const { results, requests } = await rehearse({
    settings: { branches: ['A', 'B', 'C'] },
  });
  const [summary] = results.scenarios;
  assert.equal(summary.forked, true);
  const a = branch(results, 'release-handoff', 'A');
  const b = branch(results, 'release-handoff', 'B');
  const c = branch(results, 'release-handoff', 'C');
  const shared = summary.prefix.turns;
  assert.ok(shared > 0);
  for (const other of [b, c])
    assert.deepEqual(said(other).slice(0, shared), said(a).slice(0, shared));
  // A's card changed what the listener said at the fork; B and C did not.
  assert.match(a.lines[shared].text, /rollback runbook/);
  assert.notDeepEqual(said(a), said(b));
  assert.deepEqual(said(b), said(c));
  assert.equal(a.listenerReads[0].state, 'read-used');
  assert.equal(c.listenerReads[0].state, 'read-ignored');
  assert.equal(c.listenerReads[0].origin, 'placebo');
  assert.deepEqual(b.listenerReads, []);
  // The prefix was asked once, not once per branch.
  const prefixCalls = requests.filter(
    (r) => r.role !== 'judge' && r.branch === 'shared',
  ).length;
  assert.equal(prefixCalls, summary.prefix.steps.length);
  assert.equal(
    requests.filter((r) => r.role === 'cast').length,
    [a, b, c].reduce(
      (sum, x) => sum + x.lines.filter((l) => l.speaker !== 'Noor').length,
      0,
    ) -
      2 * a.lines.slice(0, shared).filter((l) => l.speaker !== 'Noor').length,
  );
  // The criterion tied to A's card is the one that differs.
  assert.deepEqual(summary.differs, ['runbook-owned']);
});

test('a cue that arrives after the listener has spoken has no influence', async () => {
  // Greta asks Malik by name; Malik answers half a second later, and the
  // cue for the question needs the transcript delay plus a decision.
  const { results, requests } = await rehearse({ ids: ['renewal-seat-count'] });
  const [summary] = results.scenarios;
  assert.equal(summary.forked, false);
  const a = branch(results, 'renewal-seat-count', 'A');
  const b = branch(results, 'renewal-seat-count', 'B');
  assert.deepEqual(said(a), said(b));
  const shown = a.timeline.find((e) => e.type === 'cue-shown');
  assert.match(shown.text, /Malik, when could/);
  const answer = a.lines.find((line) => line.speaker === 'Malik');
  assert.ok(shown.atMs > answer.startMs);
  assert.deepEqual(
    a.listenerReads.map(({ state, why }) => [state, why]),
    [['never-offered', 'shown after the listener’s last turn']],
  );
  const listened = requests.filter((r) => r.role === 'listener');
  assert.ok(listened.length > 0);
  assert.ok(listened.every((r) => JSON.parse(r.input).card === null));
  // One conversation, so the judge reads it once.
  assert.equal(requests.filter((r) => r.role === 'judge').length, 1);
});

test('the evaluator is never asked about speech that has not been said yet', async () => {
  // Short lines arrive less than the minimum gap apart, so a rerun at a
  // listener decision would otherwise start an evaluation that a later
  // line overtakes in the finished branch.
  const quick = structuredClone(byId('release-handoff'));
  quick.offline.castTurns = [
    ['Elena', 'Okay, let us start.', 'Tomas'],
    ['Tomas', 'Tests pass.', 'Elena'],
    ['Elena', 'Someone needs to own the rollback runbook.', 'Ines'],
    ['Ines', 'Not me.', 'Tomas'],
    ['Tomas', 'Nor me.', 'Ines'],
    ['Ines', 'Demo is Wednesday.', 'Elena'],
    ['Elena', 'Okay then.', 'Tomas'],
    ['Tomas', 'Fine.', 'Elena'],
    ['Elena', 'Anything else?', 'end'],
  ].map(([speaker, text, next]) => ({ speaker, text, next }));
  for (const latencyMs of [300, 1_500, 2_500]) {
    const { results, requests } = await rehearse({
      chosen: [quick],
      latencyMs,
      settings: { interjectEvery: 1 },
    });
    const a = branch(results, 'release-handoff', 'A');
    const asked = requests
      .filter((r) => r.role === 'evaluator')
      .map((r) => r.input);
    const final = a.timeline
      .filter((e) => e.type === 'evaluation-start')
      .map((e) => e.input);
    // Every request made is one the finished branch really makes.
    for (const input of asked) assert.ok(final.includes(input), input);
    assert.equal(new Set(asked).size, asked.length);
    assert.ok(asked.length <= a.lines.length);
  }
});

test('a card counts only if it is on screen when the listener’s turn starts', async () => {
  // In release-handoff the listener's first open check is at 20,875 ms.
  const at = async (shownAtMs) =>
    (
      await rehearse({
        cueSource: () =>
          recordedSource([
            {
              type: 'cue-shown',
              atMs: shownAtMs,
              cueId: 'app-1',
              text: 'Who owns the runbook?',
            },
            { type: 'cue-cleared', atMs: shownAtMs + 5_000, cueId: 'app-1' },
          ]),
      })
    ).results;
  const onTime = await at(20_875);
  assert.equal(onTime.scenarios[0].fork.atMs, 20_875);
  const late = await at(20_876);
  // Gone before the next chance, at 34,000 ms: never offered.
  assert.equal(late.scenarios[0].forked, false);
  assert.deepEqual(
    branch(late, 'release-handoff', 'A').listenerReads.map(({ state, why }) => [
      state,
      why,
    ]),
    [['never-offered', 'cleared before the listener’s next turn']],
  );
});

test('no glances left means the card is seen by nobody and the branches stay one', async () => {
  const { results } = await rehearse({ settings: { glances: 0 } });
  assert.equal(results.scenarios[0].forked, false);
  const reads = branch(results, 'release-handoff', 'A').listenerReads;
  assert.ok(reads.some((read) => read.state === 'glances-spent'));
});

test('a run whose worst case exceeds the cap is refused before any call', async () => {
  let calls = 0;
  const agents = fakeAgents([byId('release-handoff')]);
  for (const agent of Object.values(agents)) {
    const reply = agent.reply;
    agent.reply = (...args) => {
      calls++;
      return reply(...args);
    };
  }
  const worst = worstCaseCalls({
    scenarios: 1,
    generated: true,
    settings: DEFAULTS,
  });
  await assert.rejects(
    rehearse({ agents, maxCalls: worst - 1 }),
    /more than the cap/,
  );
  await assert.rejects(rehearse({ agents, maxCalls: null }), /--max-calls/);
  assert.equal(calls, 0);
});

test('the cap stops a scenario at the call that would pass it, whatever the role', async () => {
  const brief = byId('release-handoff');
  const budget = createBudget(9);
  const context = {
    agents: fakeAgents([brief]),
    evaluator: fakeEvaluator({ latencyMs: 1_500 }),
    settings: DEFAULTS,
    simSettings: { ...SIM_DEFAULTS, input: 'app', listenerName: true },
    budget,
    rng: random('cap'),
    log: createRunLog(null),
    latencies: [],
    logPrompt() {},
  };
  await assert.rejects(runScenario(brief, context), (error) => {
    assert.equal(error.category, 'call-cap');
    return true;
  });
  assert.equal(budget.count, 9);
  assert.equal(
    Object.values(budget.byRole).reduce((sum, n) => sum + n, 0),
    9,
  );
  assert.ok(budget.byRole.evaluator > 0 && budget.byRole.cast > 0);
});

test('the first failure stops the run, with its kind, and nothing is retried', async () => {
  const agents = fakeAgents([byId('release-handoff')]);
  let listenerCalls = 0;
  let after = 0;
  agents.listener.reply = async () => {
    listenerCalls++;
    throw Object.assign(
      new Error('Claude Code failed. Kind of failure: a usage or rate limit.'),
      {
        category: 'usage-limit',
        exitCode: 1,
      },
    );
  };
  for (const role of ['cast', 'judge']) {
    const reply = agents[role].reply;
    agents[role].reply = (...args) => {
      if (listenerCalls) after++;
      return reply(...args);
    };
  }
  const { results } = await rehearse({ agents });
  assert.equal(listenerCalls, 1);
  assert.equal(after, 0);
  assert.equal(results.stopped.category, 'usage-limit');
  assert.equal(results.stopped.exitCode, 1);
  assert.equal(results.scenarios.length, 0);
  // The frozen brief survives the stop.
  assert.equal(results.briefs.length, 1);
});

test('an unusable reply stops the run instead of being repaired', async () => {
  const agents = fakeAgents([byId('release-handoff')]);
  agents.cast.reply = async () => ({
    value: { speaker: 'Noor', text: 'Speaking as the listener.', next: 'end' },
    elapsedMs: 0,
    latency: 'simulated',
  });
  const { results } = await rehearse({ agents });
  assert.equal(results.stopped.category, 'invalid-reply');
  assert.equal(results.calls.byRole.cast, 1);
});

test('the judge is never told which branch it reads', async () => {
  const orders = new Set();
  for (const seed of ['one', 'two', 'three', 'four', 'five', 'six']) {
    const { results, requests } = await rehearse({
      seed,
      settings: { branches: ['A', 'B', 'C'] },
    });
    const judged = requests.filter((r) => r.role === 'judge');
    assert.equal(judged.length, 3);
    for (const request of judged) {
      const view = JSON.parse(request.input);
      assert.deepEqual(Object.keys(view).sort(), [
        'criteria',
        'meeting',
        'people',
        'transcript',
      ]);
      assert.match(request.transcript, /^transcript-[0-9a-f]{6}$/);
      assert.equal(request.branch, undefined);
      assert.doesNotMatch(
        request.input,
        /"(?:branch|assistance|origin|card|cue|listenerReads|timeline)"|placebo/i,
      );
      // Card text, unless it was also spoken (the fake can quote a line).
      const spoken = new Set(
        results.branches.flatMap((b) => b.lines.map((line) => line.text)),
      );
      for (const event of results.branches.flatMap((b) => b.timeline))
        if (event.type === 'cue-shown' && !spoken.has(event.text))
          assert.ok(!request.input.includes(event.text), event.text);
      for (const text of PLACEBO_CUES) assert.ok(!request.input.includes(text));
      for (const line of view.transcript)
        assert.deepEqual(Object.keys(line).sort(), ['id', 'speaker', 'text']);
    }
    const order = judged.map(
      (r) =>
        results.branches.find((b) => b.judge.transcriptId === r.transcript)
          .branch,
    );
    orders.add(order.join(''));
  }
  // Shuffled: the seeds do not all read the branches in one order.
  assert.ok(orders.size > 1);
});

test('moments, criteria and the plan never reach the participants or the evaluator', async () => {
  const { requests } = await rehearse({
    ids: ['release-handoff', 'renewal-seat-count', 'interview-debrief'],
    settings: { branches: ['A', 'B', 'C'] },
  });
  const secrets = briefs.flatMap((brief) => [
    ...brief.moments.flatMap((m) => [m.id, m.description]),
    // Not the offline patterns: they are spoken words the fakes look for.
    ...brief.criteria.flatMap((c) => [c.id, c.text]),
  ]);
  for (const request of requests.filter((r) =>
    ['cast', 'listener', 'evaluator'].includes(r.role),
  )) {
    const text = `${request.systemPrompt ?? ''}\n${request.input}`;
    for (const secret of secrets) assert.ok(!text.includes(secret), secret);
    assert.doesNotMatch(text, /"offline"|castTurns|withCard|"pattern"/);
  }
  for (const request of requests.filter((r) => r.role === 'evaluator')) {
    const input = JSON.parse(request.input);
    // As the app's transcript: one speaker label, nobody's private facts.
    assert.ok(input.events.every((event) => event.speaker === 'Speaker'));
    for (const brief of briefs)
      for (const fact of brief.people.flatMap((p) => p.privately))
        assert.ok(!request.input.includes(fact));
  }
  for (const request of requests.filter((r) => r.role === 'listener')) {
    const brief = briefs.find((b) => request.input.includes(b.focus.goal));
    for (const fact of brief.people.flatMap((p) => [p.goal, ...p.privately]))
      assert.ok(!request.input.includes(fact));
  }
  for (const request of requests.filter((r) => r.role === 'cast')) {
    for (const brief of briefs)
      for (const fact of [brief.focus.goal, ...brief.focus.knows])
        assert.ok(!request.input.includes(fact));
    assert.doesNotMatch(request.input, /offsite|Parking|Lunch orders|printer/);
  }
  for (const request of requests.filter((r) => r.role === 'generator')) {
    const plan = JSON.parse(request.input);
    assert.deepEqual(Object.keys(plan).sort(), [
      'decoys',
      'domain',
      'open',
      'people',
      'settled',
      'variation',
    ]);
  }
});

test('the generator is never told what the lab tests', () => {
  assert.doesNotMatch(
    GENERATOR_PROMPT,
    /\bcues?\b|card|TalkQTE|assist|help|hypothes|listener|test/i,
  );
});

test('lines the listener missed while distracted reach it only as missed', async () => {
  const { requests } = await rehearse({ ids: ['renewal-seat-count'] });
  const window = byId('renewal-seat-count').focus.distracted[0];
  const view = JSON.parse(requests.find((r) => r.role === 'listener').input);
  const missed = view.transcript.filter((line) => line.missed);
  assert.ok(missed.length > 0);
  assert.ok(missed.every((line) => !('text' in line)));
  assert.ok(window.toMs > window.fromMs);
});

test('a generated brief that fails a check is logged and left out, unchanged', async () => {
  const good = structuredClone(byId('release-handoff'));
  delete good.offline;
  for (const c of good.criteria) delete c.offline;
  const plan = { open: 2, settled: 0, decoys: 1 };
  const real = structuredClone(good);
  real.id = 'real-names';
  real.people[0].privately = ['You used to work at Google.'];
  const unjudgeable = structuredClone(good);
  unjudgeable.id = 'unjudgeable';
  unjudgeable.criteria[0].text = 'Noor feels confident about the runbook.';
  const extra = { ...structuredClone(good), id: 'extra', script: [] };
  const generator = fakeGenerator([real, unjudgeable, extra, good]);
  generator.followsPlan = true;
  generator.briefSource = 'generated';
  const agents = { ...fakeAgents([byId('release-handoff')]), generator };
  const results = await runDialogue({
    agents,
    evaluator: fakeEvaluator({ latencyMs: 1_500 }),
    plan: { ...DEFAULT_PLAN, ...plan, domains: ['software'], scenarios: 4 },
    maxCalls: 300,
  });
  assert.equal(results.rejectedBriefs.length, 3);
  assert.match(results.rejectedBriefs[0].problems.join(' '), /Google/);
  assert.match(
    results.rejectedBriefs[1].problems.join(' '),
    /thoughts, feelings/,
  );
  assert.match(
    results.rejectedBriefs[2].problems.join(' '),
    /exactly the fields/,
  );
  // Kept as the generator wrote it, not repaired.
  assert.deepEqual(results.rejectedBriefs[0].brief, real);
  assert.deepEqual(
    results.scenarios.map((s) => s.id),
    ['release-handoff'],
  );
  // No retry: four plans, four generator calls.
  assert.equal(results.calls.byRole.generator, 4);
});

test('a model brief must follow the plan and carry no offline block', () => {
  const brief = byId('release-handoff');
  assert.match(briefProblems(brief).join(' '), /exactly the fields/);
  const clean = structuredClone(brief);
  delete clean.offline;
  for (const c of clean.criteria) delete c.offline;
  assert.deepEqual(briefProblems(clean), []);
  const problems = briefProblems(clean, {
    plan: { domain: 'hiring', open: 1, settled: 1, decoys: 0 },
  });
  assert.match(problems.join(' '), /domain must be hiring/);
  assert.match(problems.join(' '), /1 open moments; got 2/);
  assert.match(problems.join(' '), /1 settled/);
  assert.match(problems.join(' '), /0 decoys/);
});

test('the listener can take its cards from a real app run’s cue log instead', async () => {
  const shownAt = 20_000;
  const { results, requests } = await rehearse({
    cueSource: () =>
      recordedSource([
        {
          type: 'cue-shown',
          atMs: shownAt,
          cueId: 'app-1',
          text: 'Who owns the runbook?',
        },
        { type: 'cue-cleared', atMs: shownAt + 18_000, cueId: 'app-1' },
      ]),
  });
  const [summary] = results.scenarios;
  assert.equal(summary.fork.card, 'Who owns the runbook?');
  assert.ok(summary.fork.atMs >= shownAt);
  // The app decided, so the lab's evaluator was never asked.
  assert.equal(requests.filter((r) => r.role === 'evaluator').length, 0);
  assert.equal(
    branch(results, 'release-handoff', 'A').listenerReads[0].origin,
    'app',
  );
});

test('a saved run replays its frozen brief and prefix without asking for them again', async () => {
  const first = await rehearse();
  const { text, sha256 } = briefsFile(first.results.briefs, { seed: 'test' });
  first.results.brief = { file: 'run.briefs.json', sha256 };
  const replay = savedRun(first.results, text, 'run.json');
  const again = await rehearse({ replay });
  const [summary] = again.results.scenarios;
  assert.equal(again.results.calls.byRole.generator, 0);
  assert.equal(
    summary.prefix.savedStepsUsed,
    first.results.scenarios[0].prefix.steps.length,
  );
  assert.equal(
    again.requests.filter(
      (r) => r.branch === 'shared' && r.role !== 'evaluator',
    ).length,
    0,
  );
  assert.deepEqual(
    said(branch(again.results, 'release-handoff', 'B')).slice(
      0,
      summary.prefix.turns,
    ),
    said(branch(first.results, 'release-handoff', 'B')).slice(
      0,
      summary.prefix.turns,
    ),
  );
  assert.throws(
    () => savedRun(first.results, `${text} `, 'run.json'),
    /does not match the hash/,
  );
});

test('a replay with an evaluator that cues earlier forks earlier and drops the rest of the prefix', async () => {
  const first = await rehearse({ latencyMs: 60_000 });
  const { text, sha256 } = briefsFile(first.results.briefs, {});
  first.results.brief = { file: 'run.briefs.json', sha256 };
  const replay = savedRun(first.results, text, 'run.json');
  const again = await rehearse({ replay, latencyMs: 1_500 });
  const [summary] = again.results.scenarios;
  assert.equal(summary.forked, true);
  assert.ok(summary.prefix.savedStepsDropped > 0);
});

test('every branch is a conversation the recorder can play', async () => {
  const { results } = await rehearse({
    ids: ['release-handoff', 'renewal-seat-count', 'interview-debrief'],
    settings: { branches: ['A', 'B', 'C'] },
  });
  assert.equal(results.schema, 'talkqte-cue-dialogue/1');
  assert.equal(results.fictional, true);
  assert.equal(results.branches.length, 9);
  for (const b of results.branches) {
    const names = b.participants.map(({ name }) => name);
    assert.ok(names.includes(b.listener));
    assert.equal(new Set(b.lines.map(({ id }) => id)).size, b.lines.length);
    b.lines.forEach((line, i) => {
      assert.ok(names.includes(line.speaker));
      assert.equal(line.atMs, line.startMs + line.durationMs);
      if (i) assert.ok(line.startMs > b.lines[i - 1].atMs);
      assert.equal(
        line.arrivesAtMs,
        line.atMs + SIM_DEFAULTS.transcriptDelayMs,
      );
    });
  }
});

test('the planned models must differ by role, and a model run is not available yet', async () => {
  const print = () => {};
  await assert.rejects(
    main(['--judge-model', 'opus-5.5'], { print }),
    /different model/,
  );
  await assert.rejects(
    main(['--participant-model', 'opus-5.5'], { print }),
    /different model/,
  );
  await assert.rejects(
    main(['--evaluator-model', 'gpt'], { print }),
    /Unknown model/,
  );
  await assert.rejects(
    main(
      ['--run', '--agents', 'claude', '--max-calls', '200', '--out', tmpdir()],
      { print },
    ),
    /--included-usage-confirmed/,
  );
  await assert.rejects(
    main(['--judge-effort', 'max'], { print }),
    /--judge-effort is one of/,
  );
});

test('the dry run sends nothing and writes nothing, and shows every request', async () => {
  const printed = [];
  const results = await main(['--seed', 'dry'], {
    print: (text) => printed.push(text),
  });
  const output = printed.join('\n');
  assert.match(output, /Nothing is started, sent or written/);
  assert.match(output, /At most \d+ calls/);
  assert.equal(results.brief, null);
  assert.ok(Object.values(results.agents).every((a) => a.hosted === false));
  assert.equal(
    printed.filter((line) => line.startsWith('--- call ')).length,
    results.calls.total,
  );
});

test('a fake run writes its results, frozen briefs, log and reviews outside the repository', async () => {
  const out = mkdtempSync(join(tmpdir(), 'cue-dialogue-'));
  try {
    const results = await main(
      [
        '--run',
        '--agents',
        'fake',
        '--max-calls',
        '200',
        '--out',
        out,
        '--latency-ms',
        '1500',
      ],
      { print: () => {} },
    );
    const files = readdirSync(out);
    const briefsName = files.find((f) => f.endsWith('.briefs.json'));
    assert.equal(results.brief.file, briefsName);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(out, briefsName)))
        .digest('hex'),
      results.brief.sha256,
    );
    assert.ok(files.some((f) => f.endsWith('.log.jsonl')));
    const reviews = files.filter((f) => f.endsWith('.review.md'));
    assert.equal(reviews.length, results.scenarios.length);
    for (const review of reviews)
      assert.match(
        readFileSync(join(out, review), 'utf8'),
        /not a user outcome[\s\S]*deterministic fakes/,
      );
    const log = readFileSync(
      join(
        out,
        files.find((f) => f.endsWith('.log.jsonl')),
      ),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const types = log.map((event) => event.type);
    assert.ok(types.indexOf('briefs-frozen') < types.indexOf('scenario-start'));
    assert.equal(
      log.filter((event) => event.type === 'request').length,
      results.calls.total,
    );
    await assert.rejects(
      main(
        [
          '--run',
          '--agents',
          'fake',
          '--max-calls',
          '200',
          '--out',
          process.cwd(),
        ],
        {
          print: () => {},
        },
      ),
      /inside the repository/,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('every card in every timeline has what the recorder’s stage reads', async () => {
  const runs = [
    await rehearse({
      ids: ['release-handoff', 'interview-debrief'],
      settings: { branches: ['A', 'B', 'C'] },
    }),
    await rehearse({
      cueSource: () =>
        recordedSource([
          {
            type: 'cue-shown',
            atMs: 20_000,
            cueId: 'app-1',
            text: 'Who owns the runbook?',
          },
          { type: 'cue-cleared', atMs: 26_000, cueId: 'app-1' },
        ]),
    }),
  ];
  let cards = 0;
  for (const { results } of runs)
    for (const b of results.branches)
      for (const event of b.timeline.filter((e) => e.type === 'cue-shown')) {
        cards++;
        assert.ok(Array.isArray(event.sourceIds), b.id);
        assert.ok(Number.isFinite(event.expiresAtMs), b.id);
        assert.ok(event.expiresAtMs > event.atMs);
      }
  assert.ok(cards >= 3);
  const app = branch(runs[1].results, 'release-handoff', 'A').timeline.find(
    (e) => e.type === 'cue-shown',
  );
  assert.equal(app.expiresAtMs, 26_000);
});

test('each person is cast by the brief, and casting reaches no participant or judge', async () => {
  const { results, requests } = await rehearse({
    ids: ['release-handoff', 'renewal-seat-count'],
  });
  for (const b of results.branches)
    for (const person of b.participants)
      assert.deepEqual(Object.keys(person.casting).sort(), [
        'age',
        'portrait',
        'voice',
      ]);
  const portraits = briefs.flatMap((brief) =>
    [brief.focus, ...brief.people].map((p) => p.casting.portrait),
  );
  for (const request of requests.filter((r) => r.role !== 'generator'))
    for (const portrait of portraits)
      assert.ok(!request.input.includes(portrait));
  const bad = (change) => {
    const brief = structuredClone(byId('release-handoff'));
    change(brief);
    return briefProblems(brief, { source: 'fixture' }).join(' ');
  };
  assert.match(
    bad((b) => delete b.people[0].casting),
    /needs casting/,
  );
  assert.match(
    bad((b) => (b.focus.casting.voice = 'female')),
    /casting voice/,
  );
  assert.match(
    bad((b) => (b.people[1].casting.age = '20-60')),
    /casting age must be a range/,
  );
  assert.match(
    bad(
      (b) =>
        (b.people[2].casting.portrait =
          'Looks like a famous actor, short hair.'),
    ),
    /compare the person to anyone real/,
  );
  assert.match(
    bad(
      (b) =>
        (b.people[2].casting.portrait =
          'Short hair, a Google hoodie, home office.'),
    ),
    /real companies or products: Google/,
  );
});

test('measured call times, the evaluator’s included, feed the real-time summary', async () => {
  const evaluator = fakeEvaluator({ latencyMs: 1_500 });
  const decide = evaluator.decide;
  evaluator.decide = async (testCase) => ({
    ...(await decide(testCase)),
    latency: 'measured',
  });
  const results = await runDialogue({
    agents: fakeAgents([byId('release-handoff')]),
    evaluator,
    plan: { ...DEFAULT_PLAN, scenarios: 1 },
    maxCalls: 300,
  });
  assert.equal(results.realtime.measured, true);
  assert.equal(results.realtime.evaluatorMedianMs, 1_500);
});

test('the dry run says a run over the ceiling would be refused, and rehearses nothing', async () => {
  const printed = [];
  const result = await main(['--scenarios', '10'], {
    print: (t) => printed.push(t),
  });
  assert.equal(result, null);
  assert.match(printed.join('\n'), /would be refused/);
  assert.ok(!printed.some((line) => line.startsWith('--- call ')));
});

test('a replay with different turn settings is refused by the engine itself', async () => {
  const first = await rehearse();
  const { text, sha256 } = briefsFile(first.results.briefs, {});
  first.results.brief = { file: 'run.briefs.json', sha256 };
  const replay = savedRun(first.results, text, 'run.json');
  await assert.rejects(
    rehearse({ replay, settings: { interjectEvery: 2 } }),
    /must use the saved run's interjectEvery/,
  );
});

/** A stand-in for the Claude Code CLI: the version and sign-in checks, and
 * for each request a reply from the matching fake, reported as coming
 * from the model the request named. Records every call. */
function fakeCli(brief, { fail = null } = {}) {
  const fakes = fakeAgents([brief]);
  const generated = structuredClone(brief);
  delete generated.offline;
  for (const c of generated.criteria) delete c.offline;
  const evaluator = fakeEvaluator({ latencyMs: 1_500 });
  const calls = [];
  return {
    calls,
    async run(command, args, options) {
      calls.push({ args, input: options.input });
      if (args.includes('--version')) return '2.1.318 (Claude Code)';
      if (args.includes('auth'))
        return JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          apiProvider: 'firstParty',
          subscriptionType: 'max',
        });
      const at = (flag) => args[args.indexOf(flag) + 1];
      const model = at('--model');
      const prompt = at('--system-prompt');
      if (
        fail &&
        calls.filter((c) => c.args.includes('--print')).length === fail.at
      )
        return JSON.stringify({
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: fail.text,
        });
      const view = JSON.parse(options.input);
      let value;
      if (prompt === GENERATOR_PROMPT) value = generated;
      else if (prompt === CAST_PROMPT)
        value = (await fakes.cast.reply(view)).value;
      else if (prompt === JUDGE_PROMPT)
        value = (await fakes.judge.reply(view)).value;
      else if (prompt.startsWith('You are '))
        value = (await fakes.listener.reply(view)).value;
      else value = (await evaluator.decide(view)).decision;
      return JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify(value),
        modelUsage: { [model]: {} },
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  };
}

const roleModels = {
  generator: 'sonnet-5.5',
  cast: 'haiku-5.5',
  listener: 'haiku-5.5',
  judge: 'sonnet-5.5',
};
const roleEfforts = {
  generator: 'medium',
  cast: 'low',
  listener: 'low',
  judge: 'medium',
};
const cleanShell = { HOME: '/fictional-home', PATH: '/fictional-bin' };

async function modelRun(
  cli,
  { environment = cleanShell, maxCalls = 300 } = {},
) {
  return runDialogue({
    agents: claudeAgents({
      models: roleModels,
      efforts: roleEfforts,
      environment,
      run: cli.run,
    }),
    evaluator: claudeEvaluator({ environment, run: cli.run, effort: 'medium' }),
    plan: {
      ...DEFAULT_PLAN,
      domains: ['software'],
      open: 2,
      settled: 0,
      decoys: 1,
      scenarios: 1,
    },
    maxCalls,
  });
}

test('the model-backed agents send each role with its own model and effort through one isolated sign-in', async () => {
  const cli = fakeCli(byId('release-handoff'));
  const results = await modelRun(cli);
  assert.equal(results.stopped, null);
  assert.equal(results.generated, true);
  assert.equal(results.scenarios[0].forked, true);
  const prints = cli.calls.filter((c) => c.args.includes('--print'));
  assert.equal(prints.length, results.calls.total);
  const at = (c, flag) => c.args[c.args.indexOf(flag) + 1];
  for (const c of prints) {
    const prompt = at(c, '--system-prompt');
    const role =
      prompt === GENERATOR_PROMPT
        ? 'generator'
        : prompt === CAST_PROMPT
          ? 'cast'
          : prompt === JUDGE_PROMPT
            ? 'judge'
            : prompt.startsWith('You are ')
              ? 'listener'
              : 'evaluator';
    if (role === 'evaluator') {
      assert.equal(at(c, '--model'), 'claude-opus-5-5');
      continue;
    }
    assert.equal(at(c, '--model'), ROLE_MODELS[roleModels[role]], role);
    assert.equal(at(c, '--effort'), roleEfforts[role], role);
    // The same isolation flags as the cue lab.
    for (const flag of [
      '--safe-mode',
      '--restricted',
      '--no-session-persistence',
      '--strict-mcp-config',
    ])
      assert.ok(c.args.includes(flag), flag);
  }
  // One version and sign-in check for the four agents, one for the evaluator.
  assert.equal(cli.calls.filter((c) => c.args.includes('--version')).length, 2);
  assert.equal(results.realtime.measured, true);
  assert.ok(
    Object.values(results.agents).every((a) => a.kind === 'model' && a.hosted),
  );
});

test('a model run refuses an inherited API key before any process, and stops at the first CLI failure without retry', async () => {
  const keyed = fakeCli(byId('release-handoff'));
  const refused = await modelRun(keyed, {
    environment: { ...cleanShell, ANTHROPIC_API_KEY: 'fictional' },
  });
  assert.match(refused.stopped.reason, /No process was started/);
  assert.equal(keyed.calls.length, 0);

  const limited = fakeCli(byId('release-handoff'), {
    fail: { at: 3, text: 'You have hit your limit.' },
  });
  const stopped = await modelRun(limited);
  assert.equal(stopped.stopped.category, 'usage-limit');
  assert.equal(
    limited.calls.filter((c) => c.args.includes('--print')).length,
    3,
  );
  assert.equal(stopped.calls.total, 3);
});

test('a saved opening that does not match its hash is refused', async () => {
  const first = await rehearse();
  const { text, sha256 } = briefsFile(first.results.briefs, {});
  first.results.brief = { file: 'run.briefs.json', sha256 };
  assert.ok(savedRun(first.results, text, 'run.json'));
  const edited = structuredClone(first.results);
  edited.scenarios[0].prefix.steps[0].reply.text = 'An edited line.';
  assert.throws(
    () => savedRun(edited, text, 'run.json'),
    /saved opening of release-handoff does not match/,
  );
});

test('only --run with --max-calls and --included-usage-confirmed starts the CLI; no flags is a dry run', async () => {
  const started = [];
  const spy = async (command, args) => {
    started.push(args);
    throw new Error('The test CLI must not start.');
  };
  const out = mkdtempSync(join(tmpdir(), 'cue-dialogue-'));
  const quiet = { print: () => {}, run: spy, environment: cleanShell };
  try {
    // No flags: the dry run, with the fakes only.
    const dry = await main([], quiet);
    assert.ok(Object.values(dry.agents).every((a) => a.kind === 'fake'));
    assert.equal(dry.brief, null);
    // Without --run, even with the other two flags: still the dry run.
    const alsoDry = await main(
      ['--max-calls', '110', '--included-usage-confirmed', '--out', out],
      quiet,
    );
    assert.ok(Object.values(alsoDry.agents).every((a) => a.kind === 'fake'));
    // --run without the cap or the acknowledgement: refused, nothing started.
    await assert.rejects(
      main(['--run', '--included-usage-confirmed', '--out', out], quiet),
      /--max-calls/,
    );
    await assert.rejects(
      main(['--run', '--max-calls', '110', '--out', out], quiet),
      /--included-usage-confirmed/,
    );
    assert.deepEqual(started, []);
    assert.deepEqual(readdirSync(out), []);
    // All three: the run starts the CLI (the stand-in refuses at once).
    const results = await main(
      [
        '--run',
        '--max-calls',
        '110',
        '--included-usage-confirmed',
        '--out',
        out,
      ],
      quiet,
    );
    assert.ok(started.length > 0);
    assert.deepEqual(started[0], ['--version']);
    assert.ok(results.stopped);
  } finally {
    rmSync(out, { recursive: true, force: true });
    process.exitCode = 0;
  }
});
