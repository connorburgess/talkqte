import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  MODEL,
  assertSubscription,
  buildPrompt,
  execute,
  loadCases,
  main,
  runLab,
  subscriptionEnvironment,
  validateDecision,
} from './cue-lab.mjs';

const cases = await loadCases();
const answered = cases.find(({ id }) => id === 'already-answered');
const decision = {
  action: 'quiet',
  cue: null,
  sourceIds: ['e2'],
  reason: 'The later statement assigns the checklist to Maya.',
  observedUse: 'not_observed',
};
const subscription = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
};
const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: JSON.stringify(decision),
  modelUsage: { [MODEL]: {} },
};

function fakeRunner({
  auth = subscription,
  result = success,
  version = '2.1.318 (Claude Code)',
} = {}) {
  const calls = [];
  return {
    calls,
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (args.includes('--version')) return version;
      if (args.includes('auth')) return JSON.stringify(auth);
      return JSON.stringify(result);
    },
  };
}

test('the lab does not inherit API credentials, gateways, tools or billing switches', () => {
  const env = subscriptionEnvironment({
    HOME: '/fictional-home',
    PATH: '/fictional-bin',
    LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: 'fictional-key',
    ANTHROPIC_AUTH_TOKEN: 'fictional-token',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'fictional-override',
    NODE_OPTIONS: '--require injected.cjs',
    HTTPS_PROXY: 'https://example.invalid',
    CLAUDE_CODE_RETRY_WATCHDOG: '1',
    CLAUDE_CONFIG_DIR: '/fictional-config',
    CURSOR_API_KEY: 'fictional-key',
  });
  assert.equal(env.HOME, '/fictional-home');
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'NODE_OPTIONS',
    'HTTPS_PROXY',
    'CLAUDE_CODE_RETRY_WATCHDOG',
    'CLAUDE_CONFIG_DIR',
    'CURSOR_API_KEY',
  ]) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.CLAUDE_CODE_DISABLE_FAST_MODE, '1');
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '0');
});

test('API, unauthenticated, unknown and routed accounts cannot start inference', async () => {
  for (const auth of [
    { ...subscription, authMethod: 'api_key' },
    { ...subscription, loggedIn: false },
    { ...subscription, apiProvider: 'bedrock' },
    { ...subscription, subscriptionType: null },
  ]) {
    assert.throws(() => assertSubscription(auth), /subscription login/);
    const fake = fakeRunner({ auth });
    await assert.rejects(
      runLab(answered, { run: fake.run }),
      /No model request/,
    );
    assert.equal(fake.calls.length, 2);
  }
});

test('older CLI versions stop before authentication or inference', async () => {
  const fake = fakeRunner({ version: '2.1.200 (Claude Code)' });
  await assert.rejects(runLab(answered, { run: fake.run }), /2.1.318/);
  assert.equal(fake.calls.length, 1);
});

test('check mode returns no account identity and never requests a model', async () => {
  const fake = fakeRunner({
    auth: { ...subscription, email: 'fictional@example.invalid' },
  });
  const result = await runLab(null, { checkOnly: true, run: fake.run });
  assert.deepEqual(result, {
    version: '2.1.318',
    authentication: 'subscription',
    inferenceRun: false,
    paidExtraUsage: 'not_verified',
  });
  assert.equal(fake.calls.length, 2);
  await assert.rejects(access(fake.calls[0].options.cwd));
});

test('expected labels and fixture IDs are not disclosed to the evaluator', () => {
  const input = JSON.parse(buildPrompt(answered));
  assert.deepEqual(Object.keys(input).sort(), ['events', 'existingCue']);
  assert.equal(input.expected, undefined);
  assert.equal(input.id, undefined);
});

test('one selected case uses isolated subscription CLI and returns source-checked labels', async () => {
  const fake = fakeRunner();
  const result = await runLab(answered, { run: fake.run });
  assert.equal(fake.calls.length, 3);
  const call = fake.calls[2];
  assert.equal(call.command, 'claude');
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.equal(call.args[call.args.indexOf('--model') + 1], MODEL);
  const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
  assert.equal(settings.switchModelsOnFlag, false);
  assert.deepEqual(settings.availableModels, [MODEL]);
  assert.equal(settings.fallbackModel, undefined);
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.fastMode, false);
  for (const flag of [
    '--safe-mode',
    '--restricted',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--disable-slash-commands',
  ])
    assert.ok(call.args.includes(flag));
  for (const flag of [
    '--bare',
    '--fallback-model',
    '--dangerously-skip-permissions',
    '--continue',
  ])
    assert.ok(!call.args.includes(flag));
  assert.equal(call.options.input, buildPrompt(answered));
  assert.ok(!call.args.includes(call.options.input));
  assert.equal(result.matchesExpectedLabels, true);
  assert.equal(result.decision.action, 'quiet');
  await assert.rejects(access(call.options.cwd));
});

test('invalid shape, invented sources and incompatible lifecycle decisions are rejected', () => {
  for (const invalid of [
    { ...decision, sourceIds: ['invented'] },
    { ...decision, sourceIds: ['e2', 'e2'] },
    { ...decision, sourceIds: [] },
    { ...decision, cue: 'Should we ask?' },
    { ...decision, observedUse: 'possible' },
    { ...decision, action: 'resolved' },
    { ...decision, action: 'withdraw' },
    { ...decision, reason: 'x'.repeat(301) },
    { ...decision, confidence: 1 },
  ])
    assert.throws(() => validateDecision(invalid, answered), /Invalid/);
  const existing = cases.find(({ id }) => id === 'visible-cue-resolved');
  assert.throws(
    () =>
      validateDecision(
        { ...decision, action: 'show', cue: 'Replacement' },
        existing,
      ),
    /Invalid/,
  );
  assert.equal(
    validateDecision({ ...decision, action: 'resolved' }, existing).action,
    'resolved',
  );
});

test('usage limits, wrong models and malformed replies fail without retry', async () => {
  for (const result of [
    {
      ...success,
      is_error: true,
      subtype: 'error_during_execution',
      result: 'fictional sensitive provider details',
    },
    { ...success, modelUsage: { 'different-model': {} } },
    {
      ...success,
      modelUsage: { [MODEL]: {}, 'different-model': {} },
    },
    { ...success, result: 'not json' },
    {
      ...success,
      result: JSON.stringify({ ...decision, sourceIds: ['invented'] }),
    },
  ]) {
    const fake = fakeRunner({ result });
    await assert.rejects(runLab(answered, { run: fake.run }), (error) => {
      assert.ok(!error.message.includes('sensitive provider details'));
      return true;
    });
    assert.equal(fake.calls.length, 3);
    await assert.rejects(access(fake.calls[0].options.cwd));
  }
});

test('invocation cannot accept arbitrary files, all-cases runs or unconfirmed billing', async () => {
  for (const args of [
    ['--run', '--case', 'already-answered'],
    ['--run', '--all', '--included-usage-confirmed'],
    ['--run', '--case', '/private/transcript', '--included-usage-confirmed'],
  ])
    await assert.rejects(main(args));
});

test('a hung subprocess is terminated within the local deadline', async () => {
  await assert.rejects(
    execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: tmpdir(),
      env: subscriptionEnvironment(process.env),
      timeoutMs: 40,
    }),
    /exceeded the time or output limit/,
  );
});

test('fixtures exercise suppression, resolution, uncertain use and context reminders', () => {
  assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
  assert.ok(cases.some(({ expected }) => expected.action === 'withdraw'));
  assert.ok(cases.some(({ expected }) => expected.observedUse === 'unknown'));
  assert.ok(cases.some(({ id }) => id === 'context-reminder'));
  for (const fixture of cases) {
    const ids = new Set(fixture.events.map(({ id }) => id));
    assert.equal(ids.size, fixture.events.length);
    assert.ok(
      fixture.events.every(
        ({ text }) => typeof text === 'string' && text.length > 0,
      ),
    );
    assert.ok(
      fixture.existingCue === null ||
        fixture.existingCue.sourceIds.every((id) => ids.has(id)),
    );
  }
});
