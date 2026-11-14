// Offline tests for the batch runner. Every "CLI" here is a fake function;
// no process, model, account or network is used.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MODEL,
  SYSTEM_PROMPT,
  buildPrompt,
  inheritedCredentialNames,
  runLab,
  systemPromptFor,
  validateDecision,
} from './cue-lab.mjs';
import {
  claudeEvaluator,
  fakeEvaluator,
  rulesEvaluator,
} from './cue-evaluators.mjs';
import {
  CUE_BUDGET_MS,
  MAX_CALLS_CEILING,
  callCap,
  main,
  runBatch,
  summarize,
} from './cue-lab-batch.mjs';
import { outputDirectory, percentile } from './cue-lab-output.mjs';
import {
  SETS,
  loadRulesOutcomes,
  loadSet,
  selectCases,
} from './cue-lab-sets.mjs';

const subscription = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
};
const quiet = (sourceIds = ['e1']) => ({
  action: 'quiet',
  cue: null,
  sourceIds,
  reason: 'Fictional reply.',
  observedUse: 'not_observed',
});
const reply = (decision, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: JSON.stringify(decision),
  modelUsage: { [MODEL]: {} },
  usage: { input_tokens: 3, output_tokens: 40 },
  duration_ms: 900,
  duration_api_ms: 700,
  session_id: 'fictional-session-id',
  ...extra,
});

/** A stand-in for the CLI: answers the two checks, then one reply per case. */
function fakeCli(replies) {
  const calls = [];
  const models = [];
  return {
    calls,
    models,
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (args.includes('--version')) return '2.1.318 (Claude Code)';
      if (args.includes('auth')) return JSON.stringify(subscription);
      models.push(options.input);
      const next = replies[models.length - 1];
      return JSON.stringify(typeof next === 'function' ? next() : next);
    },
  };
}
const clean = { HOME: '/fictional-home', PATH: '/fictional-bin' };
const out = () => mkdtempSync(join(tmpdir(), 'talkqte-lab-test-'));

test('the rules record is the engine replay tests, case for case', async () => {
  const engine = readFileSync(
    new URL('../src-tauri/src/engine.rs', import.meta.url),
    'utf8',
  );
  const record = JSON.parse(
    readFileSync(
      new URL('./fixtures/cue-rules-recorded.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(Object.keys(record.sets), Object.keys(SETS));
  for (const [name, { test: fn, array, actions }] of Object.entries(
    record.sets,
  )) {
    const start = engine.indexOf(`fn ${fn}(`);
    assert.ok(start > 0, `${fn} exists in engine.rs`);
    const from = engine.indexOf(`let ${array} = [`, start);
    const body = engine.slice(from, engine.indexOf('];', from));
    const recorded = Object.fromEntries(
      [...body.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    assert.deepEqual(actions, recorded, `${name} matches ${fn}`);
    // And it covers exactly the cases of its set, in the set's order.
    const { cases } = await loadSet(name);
    assert.deepEqual(
      Object.keys(actions),
      cases.map(({ id }) => id),
      name,
    );
  }
});

test('the first set is still sent exactly what the recorded trials sent', async () => {
  const { cases } = await loadSet('cue-lab');
  for (const item of cases) {
    assert.equal(
      buildPrompt(item),
      JSON.stringify({ events: item.events, existingCue: item.existingCue }),
    );
    assert.equal(systemPromptFor(item), SYSTEM_PROMPT);
  }
});

test('labels, case IDs, categories and rule types never reach the evaluator', async () => {
  for (const name of Object.keys(SETS)) {
    const { cases } = await loadSet(name);
    for (const item of cases) {
      const input = JSON.parse(buildPrompt(item));
      assert.deepEqual(
        Object.keys(input).sort(),
        item.userName
          ? ['events', 'existingCue', 'userName']
          : ['events', 'existingCue'],
        item.id,
      );
      if (input.existingCue)
        assert.deepEqual(Object.keys(input.existingCue), ['text', 'sourceIds']);
      assert.ok(!buildPrompt(item).includes(item.expected.reason ?? '\u0000'));
      // The listener's name is explained only where a name is sent.
      assert.equal(
        systemPromptFor(item).includes('userName is'),
        Boolean(item.userName),
      );
    }
  }
});

test('without --run nothing is opened, and the plan says what would leave the device', async () => {
  const lines = [];
  let created = 0;
  const result = await main(['--set', 'held-out'], {
    print: (line) => lines.push(line),
    environment: clean,
    evaluators: {
      claude: () => {
        created++;
        return {
          ...claudeEvaluator({ environment: clean }),
          open: () => assert.fail('a dry run opened the evaluator'),
          decide: () => assert.fail('a dry run asked for a decision'),
        };
      },
    },
  });
  assert.equal(result, null);
  assert.equal(created, 1);
  const text = lines.join('\n');
  assert.match(text, /Dry run\. No process was started and nothing was sent/);
  assert.match(text, /23 model requests/);
  assert.match(text, /off this device to Anthropic/);
  assert.match(text, /No API key is used or accepted/);
  assert.match(text, /--max-calls 23 --included-usage-confirmed/);
  const { cases } = await loadSet('held-out');
  for (const item of cases) assert.ok(text.includes(buildPrompt(item)));
});

test('a hosted run refuses before any process without confirmation, a cap, or room under it', async () => {
  for (const [args, message] of [
    [['--run'], /--included-usage-confirmed/],
    [['--run', '--included-usage-confirmed'], /call cap/],
    [
      ['--run', '--included-usage-confirmed', '--max-calls', '5'],
      /needs 11 model requests and the cap is 5/,
    ],
    [['--run', '--included-usage-confirmed', '--max-calls', '0'], /whole/],
    [['--run', '--included-usage-confirmed', '--max-calls', '1e2'], /whole/],
    [
      [
        '--run',
        '--included-usage-confirmed',
        '--max-calls',
        String(MAX_CALLS_CEILING + 1),
      ],
      /whole/,
    ],
    // A cap that fits still needs somewhere outside the repository to write.
    [
      ['--run', '--included-usage-confirmed', '--max-calls', '11'],
      /Say where to write/,
    ],
    [['--run', '--all'], /Unknown or incomplete argument/],
    [['--run', '--file', '/private/transcript'], /Unknown or incomplete/],
  ]) {
    const cli = fakeCli([]);
    await assert.rejects(
      main(['--set', 'cue-lab', ...args], {
        print: () => {},
        environment: clean,
        evaluators: {
          claude: () => claudeEvaluator({ environment: clean, run: cli.run }),
        },
      }),
      message,
    );
    assert.equal(cli.calls.length, 0, args.join(' '));
  }
  assert.equal(callCap('100'), 100);
});

test('inherited API keys, tokens, gateways and provider switches stop a hosted run before any process', async () => {
  const { cases } = await loadSet('cue-lab');
  for (const [key, value] of [
    ['ANTHROPIC_API_KEY', 'fictional-secret-value'],
    ['ANTHROPIC_AUTH_TOKEN', 'fictional-secret-value'],
    ['ANTHROPIC_BASE_URL', 'https://example.invalid'],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'fictional-secret-value'],
    ['CLAUDE_CODE_USE_BEDROCK', '1'],
    ['ANTHROPIC_FOUNDRY_API_KEY', 'fictional-secret-value'],
    ['ANTHROPIC_VERTEX_PROJECT_ID', 'fictional-project'],
    ['ANTHROPIC_UNIX_SOCKET', '/fictional/socket'],
    ['CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'fictional-secret-value'],
    ['CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', '3'],
    ['CLAUDE_CONFIG_DIR', '/fictional-config'],
    ['CLAUDE_CODE_SKIP_BEDROCK_AUTH', '1'],
    ['CLOUD_ML_REGION', 'fictional-region'],
    ['HTTPS_PROXY', 'http://example.invalid:8080'],
    ['https_proxy', 'http://example.invalid:8080'],
    ['ALL_PROXY', 'http://example.invalid:8080'],
  ]) {
    const environment = { ...clean, [key]: value };
    assert.deepEqual(inheritedCredentialNames(environment), [key]);
    const cli = fakeCli([reply(quiet())]);
    const results = await runBatch({
      set: { name: 'cue-lab', file: 'fictional' },
      cases: cases.slice(0, 1),
      rules: {},
      evaluator: claudeEvaluator({ environment, run: cli.run }),
      maxCalls: 1,
    });
    assert.equal(cli.calls.length, 0, key);
    assert.equal(results.cases.length, 0);
    assert.ok(results.stopped.reason.includes(key), key);
    assert.ok(!results.stopped.reason.includes(value), 'names only');
    // The single-case command refuses the same way.
    const single = fakeCli([reply(quiet())]);
    await assert.rejects(
      runLab(cases[0], { environment, run: single.run }),
      (error) =>
        error.message.includes(key) &&
        /No process was started/.test(error.message),
    );
    assert.equal(single.calls.length, 0, key);
  }
  // Ordinary variables and an empty one are not refused.
  assert.deepEqual(
    inheritedCredentialNames({
      ...clean,
      ANTHROPIC_API_KEY: '',
      EDITOR: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
    }),
    [],
  );
});

test('a batch checks the sign-in once, asks once per case, and records every comparison', async () => {
  const set = await loadSet('held-out');
  const cases = selectCases(set.cases, [
    'deferral-next-month',
    'plain-idiom',
    'asked-of-the-user',
  ]);
  const rules = await loadRulesOutcomes('held-out');
  const cli = fakeCli([
    reply({ ...quiet(['e1', 'e2']), action: 'withdraw' }),
    reply(quiet()),
    reply({ ...quiet(), action: 'show', cue: 'Who can tell?' }),
  ]);
  const events = [];
  const results = await runBatch({
    set,
    cases,
    rules,
    evaluator: claudeEvaluator({ environment: clean, run: cli.run }),
    maxCalls: 3,
    log: { write: (type, data) => events.push({ type, ...data }) },
  });
  assert.equal(cli.calls.length, 2 + 3, 'two checks, then one per case');
  assert.deepEqual(
    cli.models,
    cases.map((item) => buildPrompt(item)),
  );
  // No retry, API or fallback switch is ever passed.
  for (const { args } of cli.calls)
    for (const flag of ['--bare', '--fallback-model', '--continue'])
      assert.ok(!args.includes(flag));
  assert.equal(results.stopped, null);
  assert.equal(results.fictional, true);
  assert.equal(results.evaluator.model, MODEL);
  assert.equal(results.evaluator.cliVersion, '2.1.318');
  assert.deepEqual(
    results.cases.map((r) => [
      r.caseId,
      r.action,
      r.expectedAction,
      r.matchesLabel,
      r.rulesAction,
      r.matchesRules,
      r.rulesMatchesLabel,
    ]),
    [
      [
        'deferral-next-month',
        'withdraw',
        'withdraw',
        true,
        'withdraw',
        true,
        true,
      ],
      ['asked-of-the-user', 'quiet', 'show', false, 'show', false, true],
      ['plain-idiom', 'show', 'quiet', false, 'quiet', false, true],
    ],
  );
  const [first] = results.cases;
  assert.deepEqual(first.sourceIds, ['e1', 'e2']);
  assert.equal(first.latency, 'measured');
  assert.ok(first.latencyMs >= 0);
  assert.deepEqual(first.usage, { input_tokens: 3, output_tokens: 40 });
  assert.deepEqual(first.provider, { durationMs: 900, durationApiMs: 700 });
  assert.deepEqual(results.summary.label, { matches: 1, of: 3 });
  assert.equal(results.summary.quietLabelled, 1);
  assert.equal(results.summary.actedWhenLabelledQuiet, 1);
  assert.deepEqual(results.summary.neededAction, { matches: 1, of: 2 });
  assert.deepEqual(results.summary.agreesWithRules, { matches: 1, of: 3 });
  assert.deepEqual(results.summary.usage, {
    input_tokens: 9,
    output_tokens: 120,
  });
  // The log has the exact input of every request and every decision, and
  // nothing from the CLI's own output such as its session ID.
  assert.deepEqual(
    events.filter((e) => e.type === 'request').map((e) => e.input),
    cli.models,
  );
  assert.equal(events.filter((e) => e.type === 'decision').length, 3);
  assert.equal(events.at(-1).type, 'run-end');
  assert.ok(!JSON.stringify([events, results]).includes('fictional-session'));
});

test('the first limit, error, wrong model or malformed reply ends the batch with no retry', async () => {
  const set = await loadSet('cue-lab');
  for (const bad of [
    reply(quiet(), {
      is_error: true,
      subtype: 'error_during_execution',
      result: 'fictional sensitive provider details',
    }),
    reply(quiet(), { modelUsage: { 'different-model': {} } }),
    reply({ ...quiet(), sourceIds: ['invented'] }),
    () => {
      throw new Error('fictional sensitive provider details');
    },
  ]) {
    const cli = fakeCli([reply(quiet()), bad, reply(quiet()), reply(quiet())]);
    const results = await runBatch({
      set,
      cases: set.cases.slice(0, 4),
      rules: {},
      evaluator: claudeEvaluator({ environment: clean, run: cli.run }),
      maxCalls: 4,
    });
    assert.equal(cli.models.length, 2, 'stopped at the failing request');
    assert.equal(results.cases.length, 1);
    assert.equal(results.summary.completed, 1);
    assert.equal(results.stopped.afterCalls, 1);
    assert.ok(results.stopped.reason.length > 0);
  }
});

test('the cap holds even if more cases are passed than it allows', async () => {
  const set = await loadSet('cue-lab');
  const cli = fakeCli(set.cases.map(() => reply(quiet())));
  const results = await runBatch({
    set,
    cases: set.cases,
    rules: {},
    evaluator: claudeEvaluator({ environment: clean, run: cli.run }),
    maxCalls: 2,
  });
  assert.equal(cli.models.length, 2);
  assert.equal(results.cases.length, 2);
  assert.match(results.stopped.reason, /call cap/);
});

test('a run writes a dated results file and an event log outside the repository', async () => {
  const directory = out();
  const lines = [];
  const results = await main(
    [
      '--set',
      'independent',
      '--evaluator',
      'fake',
      '--run',
      '--out',
      directory,
    ],
    {
      print: (line) => lines.push(line),
      environment: clean,
      now: () => new Date('2026-11-14T09:30:05Z'),
    },
  );
  const name = 'cue-lab-batch-independent-fake-20261114-093005';
  assert.deepEqual(readdirSync(directory).sort(), [
    `${name}.json`,
    `${name}.log.jsonl`,
  ]);
  const written = JSON.parse(readFileSync(join(directory, `${name}.json`)));
  assert.deepEqual(written, JSON.parse(JSON.stringify(results)));
  assert.equal(written.cases.length, 34);
  assert.equal(written.createdAt, '2026-11-14T09:30:05.000Z');
  assert.ok(
    written.limitations.some((line) => /Fictional cases only/.test(line)),
  );
  const log = readFileSync(join(directory, `${name}.log.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    log.map((event) => event.seq),
    log.map((_, index) => index + 1),
  );
  assert.equal(log[0].type, 'run-start');
  assert.equal(log.filter((event) => event.type === 'decision').length, 34);
  assert.match(lines.join('\n'), /not evidence of usefulness/);
});

test('results cannot be written inside the checkout, to a relative path, or nowhere', () => {
  const repository = new URL('..', import.meta.url).pathname;
  assert.throws(() => outputDirectory(undefined, {}), /Say where to write/);
  assert.throws(() => outputDirectory('lab-output', {}), /absolute/);
  assert.throws(() => outputDirectory(repository, {}), /inside the repository/);
  assert.throws(
    () => outputDirectory(join(repository, 'docs', 'new', 'folder'), {}),
    /inside the repository/,
  );
  assert.throws(
    () => outputDirectory(undefined, { TALKQTE_LAB_OUTPUT: repository }),
    /inside the repository/,
  );
  const base = realpathSync.native(out());
  const directory = join(base, 'new', 'folder');
  assert.equal(outputDirectory(directory, {}), directory);
  assert.equal(
    outputDirectory(undefined, { TALKQTE_LAB_OUTPUT: directory }),
    directory,
  );
  // A link into the checkout is judged by where it leads.
  const root = join(base, 'Checkout');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  symlinkSync(join(root, 'scripts'), join(base, 'link'));
  assert.throws(
    () => outputDirectory(join(base, 'link', 'results'), {}, root),
    /inside the repository/,
  );
  // "link/.." names a folder beside the link. The resolved place is what
  // gets created and returned, so nothing appears inside the checkout.
  assert.equal(
    outputDirectory(join(base, 'link', '..', 'results'), {}, root),
    join(base, 'results'),
  );
  assert.ok(!existsSync(join(root, 'results')), 'nothing was created');
  // On a volume that ignores letter case, another spelling is the same place.
  if (existsSync(join(base, 'CHECKOUT')))
    assert.throws(
      () => outputDirectory(join(base, 'CHECKOUT', 'results'), {}, root),
      /inside the repository/,
    );
  assert.ok(!existsSync(join(root, 'results')), 'nothing was created');
});

test('the fake evaluator is repeatable and always returns a decision the lab accepts', async () => {
  for (const name of Object.keys(SETS)) {
    const { cases } = await loadSet(name);
    for (const item of cases) {
      const first = await fakeEvaluator().decide(item);
      const second = await fakeEvaluator().decide(item);
      assert.deepEqual(first, second, item.id);
      validateDecision(first.decision, item);
      assert.equal(first.latency, 'simulated');
      assert.ok(first.elapsedMs >= 1_200 && first.elapsedMs < 5_800);
    }
  }
  const fixed = await fakeEvaluator({ latencyMs: 250 }).decide(
    (await loadSet('cue-lab')).cases[0],
  );
  assert.equal(fixed.elapsedMs, 250);
});

test('recorded rule outcomes compare with labels and never pose as a model', async () => {
  const set = await loadSet('cue-lab');
  const results = await runBatch({
    set,
    cases: set.cases,
    rules: {},
    evaluator: rulesEvaluator(await loadRulesOutcomes('cue-lab')),
  });
  // docs/cue-intelligence.md: 9 of 11 from each fixture's own cue.
  assert.deepEqual(results.summary.label, { matches: 9, of: 11 });
  assert.equal(results.summary.latency, null);
  assert.equal(results.evaluator.model, null);
  assert.ok(results.cases.every((r) => r.rulesAction === null));
});

test('a single-case report compares only the labelled judgments', async () => {
  const { cases } = await loadSet('held-out');
  const item = cases.find(({ id }) => id === 'plain-idiom');
  const cli = fakeCli([reply(quiet())]);
  const report = await runLab(item, { environment: clean, run: cli.run });
  assert.equal(report.matchesExpectedLabels, true);
});

test('summaries count quiet separately and use nearest-rank percentiles', () => {
  const record = (expectedAction, action, latencyMs) => ({
    expectedAction,
    action,
    matchesLabel: expectedAction === action,
    rulesAction: 'quiet',
    matchesRules: action === 'quiet',
    rulesMatchesLabel: expectedAction === 'quiet',
    latency: 'measured',
    latencyMs,
    usage: null,
  });
  const summary = summarize(
    [
      record('quiet', 'quiet', 1_000),
      record('quiet', 'show', 2_000),
      record('show', 'show', 6_000),
      record('withdraw', 'quiet', 3_000),
    ],
    5,
  );
  assert.equal(summary.selected, 5);
  assert.equal(summary.completed, 4);
  assert.deepEqual(summary.label, { matches: 2, of: 4 });
  assert.equal(summary.quietLabelled, 2);
  assert.equal(summary.quietKept, 1);
  assert.deepEqual(summary.neededAction, { matches: 1, of: 2 });
  assert.deepEqual(summary.byExpectedAction.withdraw, { matches: 0, of: 1 });
  assert.deepEqual(summary.latency, {
    count: 4,
    minMs: 1_000,
    medianMs: 2_000,
    p95Ms: 6_000,
    maxMs: 6_000,
    overBudget: 1,
    budgetMs: CUE_BUDGET_MS,
  });
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5, 1, 3], 0.5), 3);
});

test('an adapter that does not say it is on-device is held to the confirmation and the cap', async () => {
  const set = await loadSet('cue-lab');
  // A new adapter that forgot to declare `hosted` at all.
  let opened = 0;
  const { hosted: _omitted, ...undeclared } = {
    ...fakeEvaluator(),
    id: 'undeclared',
    open: async () => {
      opened++;
      return { model: 'fictional' };
    },
  };
  for (const args of [
    ['--run', '--out', out()],
    ['--run', '--out', out(), '--included-usage-confirmed'],
  ])
    await assert.rejects(
      main(['--set', 'cue-lab', '--evaluator', 'undeclared', ...args], {
        print: () => {},
        environment: clean,
        evaluators: { undeclared: () => undeclared },
      }),
      /--included-usage-confirmed|call cap/,
    );
  // Called directly, without the command line's checks, it still refuses.
  for (const maxCalls of [undefined, Infinity, 0, 1.5, MAX_CALLS_CEILING + 1])
    await assert.rejects(
      runBatch({
        set,
        cases: set.cases,
        rules: {},
        evaluator: undeclared,
        maxCalls,
      }),
      /needs a call cap/,
    );
  assert.equal(opened, 0);
  // An explicit on-device evaluator needs neither.
  const results = await runBatch({
    set,
    cases: set.cases,
    rules: {},
    evaluator: fakeEvaluator(),
  });
  assert.equal(results.cases.length, 11);
});

test('the dry run prints what the adapter says it would send, and a command that keeps the selection', async () => {
  const lines = [];
  await main(
    ['--set', 'held-out', '--cases', 'plain-idiom,asked-of-the-user'],
    {
      print: (line) => lines.push(line),
      environment: clean,
    },
  );
  const text = lines.join('\n');
  assert.match(
    text,
    /--set held-out --cases plain-idiom,asked-of-the-user --run .* --max-calls 2 --included-usage-confirmed/,
  );
  assert.match(
    text,
    /2 CLI checks \(version and sign-in\) that send no case text/,
  );
  // The plan is the adapter's own description of each request.
  const { cases } = await loadSet('held-out');
  const adapter = claudeEvaluator({ environment: clean });
  for (const id of ['plain-idiom', 'asked-of-the-user']) {
    const request = adapter.request(cases.find((item) => item.id === id));
    assert.ok(text.includes(request.input));
    assert.ok(text.includes(request.systemPrompt));
  }
  // Recorded rule outcomes read nothing, and say so.
  const rules = [];
  await main(['--set', 'cue-lab', '--evaluator', 'rules'], {
    print: (line) => rules.push(line),
    environment: clean,
  });
  assert.match(rules.join('\n'), /the recorded outcome for this case is read/);
  assert.doesNotMatch(rules.join('\n'), /System prompt/);
});
