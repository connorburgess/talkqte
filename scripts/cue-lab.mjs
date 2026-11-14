import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './is-main.mjs';

// The cue decision contract: prompt texts, CLI arguments and settings, the
// child environment, the credential pattern, models and efforts. The app
// reads the same file, so the lab keeps no copy of any of it.
export const CONTRACT = JSON.parse(
  readFileSync(
    new URL('./fixtures/cue-decision.json', import.meta.url),
    'utf8',
  ),
);
/** The models a run may ask for, by the name given to --model. Anything
 * else is refused, so a typing mistake cannot reach another model. */
export const MODELS = CONTRACT.models;
export const MODEL = MODELS[CONTRACT.defaultModel];

export function modelFor(name = CONTRACT.defaultModel) {
  if (!Object.hasOwn(MODELS, name))
    throw new Error(
      `Unknown model. Choose one of: ${Object.keys(MODELS).join(', ')}.`,
    );
  return MODELS[name];
}
const MIN_VERSION = CONTRACT.minCliVersion;
const TIMEOUT_MS = CONTRACT.cli.timeoutMs;
const MAX_OUTPUT_BYTES = CONTRACT.cli.maxOutputBytes;
const BASE_ARGS = CONTRACT.cli.baseArgs;
/** The prompt the recorded trials used. It must not change by a byte. */
export const SYSTEM_PROMPT = CONTRACT.prompts.full;
// The same task with the smallest reply the app needs: the decision, the
// cue and its sources, and no explanation. Writing less is quicker.
export const COMPACT_PROMPT = CONTRACT.prompts.compact;

/** The effort settings a run may ask the CLI for. */
export const EFFORTS = CONTRACT.efforts;

// Added only for a case that supplies a name, so every other case is sent
// exactly the prompt the recorded trials used.
const NAME_NOTE = CONTRACT.prompts.nameNote;

/** A cue is read in a glance during a conversation: the most words a cue
 * may have under the glance rule, and the sentence that asks for it. */
export const GLANCE_WORDS = CONTRACT.glanceWords;
const GLANCE_RULE = CONTRACT.prompts.glanceRule;

// Added only when a request lists earlier cues.
const HISTORY_NOTE = CONTRACT.prompts.historyNote;

/** `glance` adds the length rule. Without it the prompt is exactly the one
 * the recorded trials used. */
export function systemPromptFor(
  testCase,
  { glance = false, compact = false } = {},
) {
  return (
    (compact ? COMPACT_PROMPT : SYSTEM_PROMPT) +
    (glance ? GLANCE_RULE : '') +
    (testCase.userName ? NAME_NOTE : '') +
    (testCase.earlierCues?.length ? HISTORY_NOTE : '')
  );
}

/** The effort and reply a run asked for with --effort and --reply. */
export function replyOptions(flags) {
  const effort = flags['--effort'] ?? 'medium';
  if (!EFFORTS.includes(effort))
    throw new Error(`--effort is one of: ${EFFORTS.join(', ')}.`);
  const reply = flags['--reply'] ?? 'full';
  if (!['full', 'compact'].includes(reply))
    throw new Error('--reply is full or compact.');
  return { effort, compact: reply === 'compact' };
}

const CREDENTIAL = new RegExp(
  CONTRACT.credentialPattern.source,
  CONTRACT.credentialPattern.flags,
);

/** Names, never values, of inherited settings that could route a request
 * to an API key, another provider, a gateway, a proxy or another sign-in
 * instead of the subscription. */
export function inheritedCredentialNames(source) {
  return Object.keys(source)
    .filter((key) => source[key] && CREDENTIAL.test(key))
    .sort();
}

export function subscriptionEnvironment(source) {
  // Allowlist ordinary process context; never inherit keys, auth overrides,
  // gateways, Node injection, provider switches, or automatic retry settings.
  const allowed = CONTRACT.childEnvironment.allow;
  const env = Object.fromEntries(
    allowed
      .filter((key) => typeof source[key] === 'string')
      .map((key) => [key, source[key]]),
  );
  return { ...env, ...CONTRACT.childEnvironment.set };
}

/** Sorts a failed request into a kind, from the exit and the wording of
 * the CLI's own output. Only the kind is kept: the text is never stored,
 * logged or shown, because it can hold account details. */
export function classifyFailure({ code, killed = false, text = '' }) {
  if (code === 'ENOENT') return 'not-installed';
  if (killed || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return 'time-or-output-limit';
  const words = text.toLowerCase();
  if (
    /usage limit|rate limit|limit reached|hit your limit|quota|too many requests|\b429\b|out of (?:extra )?usage|credit balance/.test(
      words,
    )
  )
    return 'usage-limit';
  if (
    /not logged in|please log in|\/login|unauthori[sz]ed|authenticat|invalid api key|credential|oauth|\b401\b|\b403\b|forbidden/.test(
      words,
    )
  )
    return 'auth';
  if (
    /overloaded|timed out|timeout|network|econn|enotfound|socket|temporar|unavailable|connection|\b5\d\d\b/.test(
      words,
    )
  )
    return 'transient';
  return 'other';
}

const KINDS = {
  'usage-limit': 'a usage or rate limit',
  auth: 'sign-in or authorization',
  transient: 'a network or service problem',
  'time-or-output-limit': "the lab's own time or output limit",
  'not-installed': 'the CLI is not installed',
  other: 'not recognized',
};

/** An error that carries the kind of failure and the exit code, never the
 * CLI's words. */
function failure(message, category, exitCode = null) {
  return Object.assign(
    new Error(
      `${message} Kind of failure: ${KINDS[category]}${exitCode === null ? '' : ` (exit code ${exitCode})`}.`,
    ),
    { category, exitCode },
  );
}

export function execute(
  command,
  args,
  { cwd, env, input = '', timeoutMs = TIMEOUT_MS },
) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        env,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        if (error) {
          // Never echo raw provider stderr, auth output, or account details:
          // the output is read here once, to sort the failure, and dropped.
          const category = classifyFailure({
            code: error.code,
            killed: error.killed,
            text: `${stdout}\n${stderr}`,
          });
          const message =
            category === 'not-installed'
              ? 'Claude Code is not installed. Install it and sign in through its official subscription flow.'
              : category === 'time-or-output-limit'
                ? 'Claude Code exceeded the time or output limit; the lab did not retry.'
                : 'Claude Code failed; check your subscription access in the official CLI. The lab did not retry or request an API fallback.';
          reject(
            failure(
              message,
              category,
              Number.isInteger(error.code) ? error.code : null,
            ),
          );
        } else resolve(stdout);
      },
    );
    child.stdin.on('error', () => {}); // Early child exit is reported by execFile.
    child.stdin.end(input);
  });
}

function parseObject(text, message) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value;
  } catch {
    /* Rejected below without exposing provider output. */
  }
  throw new Error(message);
}

export function assertSubscription(status) {
  if (
    status.loggedIn !== true ||
    status.authMethod !== CONTRACT.subscription.authMethod ||
    status.apiProvider !== CONTRACT.subscription.apiProvider ||
    !CONTRACT.subscription.subscriptionTypes.includes(status.subscriptionType)
  ) {
    throw new Error(
      "A verified Claude subscription login is required. No model request was sent; use Claude Code's official sign-in flow.",
    );
  }
}

/** Exactly what one request carries. The dry run prints this and the run
 * sends it, so the two cannot differ. */
export function requestFor(testCase, options) {
  return {
    systemPrompt: systemPromptFor(testCase, options),
    input: buildPrompt(testCase),
    // Which reply the prompt asked for, so the reply is checked against it.
    compact: Boolean(options?.compact),
  };
}

export function buildPrompt(testCase) {
  // Keep the expected labels, case IDs, categories and the rules' own cue
  // type out of the model's input.
  const cue = testCase.existingCue ?? null;
  return JSON.stringify({
    // Only these fields of a line, whatever else a fixture may add later.
    events: testCase.events.map((event) => ({
      id: event.id,
      ...(event.speaker === undefined ? {} : { speaker: event.speaker }),
      text: event.text,
    })),
    existingCue: cue && { text: cue.text, sourceIds: cue.sourceIds },
    ...(testCase.userName ? { userName: testCase.userName } : {}),
    // What this session has already shown, as words and how each ended.
    ...(testCase.earlierCues?.length
      ? {
          earlierCues: testCase.earlierCues.map(({ text, state }) => ({
            text,
            state,
          })),
        }
      : {}),
  });
}

export function validateDecision(value, testCase, { compact = false } = {}) {
  // A compact reply has the three fields the app acts on. It is checked
  // as strictly, then given the two it left out as "not said".
  if (compact) {
    const three = ['action', 'cue', 'sourceIds'];
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== three.length ||
      !three.every((key) => Object.hasOwn(value, key))
    )
      throw new Error(
        'Invalid or unsupported cue decision; nothing will be shown to a meeting participant.',
      );
    const checked = validateDecision(
      { ...value, reason: 'Not asked for.', observedUse: 'not_observed' },
      testCase,
    );
    return { ...checked, reason: null, observedUse: null };
  }
  const fields = ['action', 'cue', 'sourceIds', 'reason', 'observedUse'];
  const existingCue = Boolean(testCase.existingCue);
  const valid =
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key)) &&
    ['show', 'quiet', 'resolved', 'withdraw'].includes(value.action) &&
    ['not_observed', 'possible', 'unknown'].includes(value.observedUse) &&
    typeof value.reason === 'string' &&
    value.reason.trim().length > 0 &&
    value.reason.length <= 300 &&
    Array.isArray(value.sourceIds) &&
    value.sourceIds.length > 0 &&
    value.sourceIds.length <= 4 &&
    new Set(value.sourceIds).size === value.sourceIds.length &&
    value.sourceIds.every((id) =>
      testCase.events.some((event) => event.id === id),
    ) &&
    (value.action === 'show'
      ? !existingCue &&
        typeof value.cue === 'string' &&
        value.cue.trim().length > 0 &&
        value.cue.length <= 240
      : value.cue === null) &&
    (!['resolved', 'withdraw'].includes(value.action) || existingCue) &&
    (existingCue || value.observedUse === 'not_observed');
  if (!valid)
    throw new Error(
      'Invalid or unsupported cue decision; nothing will be shown to a meeting participant.',
    );
  return value;
}

async function preflight(options, run) {
  const version = (await run('claude', ['--version'], options)).match(
    /^(\d+)\.(\d+)\.(\d+)/,
  );
  if (!version)
    throw new Error('Could not verify the installed Claude Code version.');
  const parts = version.slice(1, 4).map(Number);
  const difference =
    parts.map((part, i) => part - MIN_VERSION[i]).find((part) => part !== 0) ??
    0;
  if (difference < 0)
    throw new Error(
      'This lab requires Claude Code 2.1.318 or newer for its isolation flags.',
    );
  const status = parseObject(
    await run(
      CONTRACT.cli.command,
      [...BASE_ARGS, ...CONTRACT.cli.authStatusArgs],
      options,
    ),
    'Could not verify Claude Code subscription authentication. No inference was attempted.',
  );
  assertSubscription(status);
  return { version: version[0], authentication: 'subscription' };
}

// Timing counters the CLI reports about its own request. Session IDs,
// account details and everything else in its output are left out.
function providerCounters(result) {
  const counters = {};
  for (const [name, key] of [
    ['durationMs', 'duration_ms'],
    ['durationApiMs', 'duration_api_ms'],
    ['numTurns', 'num_turns'],
  ])
    if (Number.isFinite(result[key]) && result[key] >= 0)
      counters[name] = result[key];
  return counters;
}

/** One isolated, subscription-only request: the contract's arguments with
 * this request's model, effort, settings and system prompt in their marked
 * places, the input on stdin, no retry. The reply must report exactly the
 * requested model, and `reply` must accept the parsed JSON it returned (it
 * throws otherwise). The CLI's own output is read here to sort a failure
 * and dropped; only the kind of failure is kept. */
async function isolatedRequest(
  options,
  run,
  {
    model,
    effort,
    systemPrompt,
    input,
    reply,
    task = 'the evaluation',
    acceptedAs = 'an evaluation',
    expected = 'decision JSON',
  },
) {
  // Shapes only; each caller keeps its own list of what it may ask for.
  if (!/^claude-[a-z0-9-]+$/.test(model ?? ''))
    throw new Error('The request names no usable model; nothing was sent.');
  if (!['low', 'medium', 'high'].includes(effort))
    throw new Error('The request names no usable effort; nothing was sent.');
  // The argument list comes from the contract, with this request's model,
  // effort, settings and system prompt put in its marked places.
  const settings = JSON.stringify(CONTRACT.cli.settings).replaceAll(
    '{model}',
    model,
  );
  const fill = {
    '{model}': model,
    '{effort}': effort,
    '{settings}': settings,
    '{systemPrompt}': systemPrompt,
  };
  const args = [
    ...BASE_ARGS,
    ...CONTRACT.cli.evaluateArgs.map((arg) => fill[arg] ?? arg),
  ];
  const start = performance.now();
  const raw = await run('claude', args, { ...options, input });
  const elapsedMs = Math.round(performance.now() - start);
  const result = parseObject(
    raw,
    'Claude returned an unreadable result; the lab did not retry.',
  );
  if (
    result.type !== 'result' ||
    result.subtype !== 'success' ||
    result.is_error !== false
  ) {
    throw failure(
      `Claude did not complete ${task}; the lab did not retry or request a fallback.`,
      classifyFailure({
        text: `${result.subtype ?? ''}\n${typeof result.result === 'string' ? result.result : ''}`,
      }),
    );
  }
  const models = Object.keys(result.modelUsage ?? {});
  if (models.length !== 1 || models[0] !== model) {
    throw new Error(
      `The result did not verify the requested model (${model}); it was not accepted as ${acceptedAs}.`,
    );
  }
  const value = reply(
    parseObject(
      result.result,
      `Claude did not return the expected ${expected}; the lab did not retry.`,
    ),
  );
  const usage = Object.fromEntries(
    [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ]
      .filter(
        (key) =>
          Number.isSafeInteger(result.usage?.[key]) && result.usage[key] >= 0,
      )
      .map((key) => [key, result.usage[key]]),
  );
  return { value, elapsedMs, usage, provider: providerCounters(result) };
}

async function evaluate(
  testCase,
  access,
  options,
  run,
  request = requestFor(testCase),
  model = MODEL,
  effort = 'medium',
) {
  const {
    value: decision,
    elapsedMs,
    usage,
    provider,
  } = await isolatedRequest(options, run, {
    model,
    effort,
    systemPrompt: request.systemPrompt,
    input: request.input,
    reply: (value) =>
      validateDecision(value, testCase, { compact: request.compact }),
  });
  const expected = testCase.expected ?? {};
  return {
    caseId: testCase.id,
    model,
    ...access,
    elapsedMs,
    usage,
    provider,
    decision,
    expected: testCase.expected,
    // Only the two labelled judgments; a set's written reason is not one.
    matchesExpectedLabels: ['action', 'observedUse']
      .filter((key) => Object.hasOwn(expected, key))
      .every((key) => decision[key] === expected[key]),
    limitation:
      'One fictional judgment, not evidence of usefulness or live meeting latency. Token cost estimates are not a billing receipt.',
  };
}

/** The lab's isolation, for any caller: refuses a shell that carries API,
 * provider or proxy settings before any process starts, checks the CLI
 * version and subscription sign-in once, then sends isolated requests one
 * at a time with `request({ model, effort, systemPrompt, input, reply })`.
 * `close` removes the temporary directory; call it even after a failure. */
export async function openIsolatedCli({
  environment = process.env,
  run = execute,
} = {}) {
  // Refuse rather than quietly drop them: an inherited key, token or gateway
  // means this shell is set up for something other than the subscription.
  const names = inheritedCredentialNames(environment);
  if (names.length)
    throw new Error(
      `This shell carries API, provider or proxy settings (${names.join(', ')}). No process was started. Run the lab from a shell without them; it uses the subscription sign-in only.`,
    );
  const cwd = await mkdtemp(join(tmpdir(), 'talkqte-cue-lab-'));
  const options = { cwd, env: subscriptionEnvironment(environment) };
  const close = () => rm(cwd, { recursive: true, force: true });
  try {
    const access = await preflight(options, run);
    return {
      access,
      options,
      request: (params) => isolatedRequest(options, run, params),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Checks the CLI version and subscription sign-in once, then evaluates any
 * number of cases, one request at a time. `close` removes the temporary
 * directory; call it even after a failure. */
export async function openLab({
  environment = process.env,
  run = execute,
  model = MODEL,
  effort = 'medium',
} = {}) {
  const cli = await openIsolatedCli({ environment, run });
  return {
    access: cli.access,
    // `request` is what the adapter said this case carries; it is sent
    // as given.
    evaluate: (testCase, request) =>
      evaluate(testCase, cli.access, cli.options, run, request, model, effort),
    close: cli.close,
  };
}

export async function runLab(
  testCase,
  { checkOnly = false, environment = process.env, run = execute } = {},
) {
  const lab = await openLab({ environment, run });
  try {
    if (checkOnly)
      return {
        ...lab.access,
        inferenceRun: false,
        paidExtraUsage: 'not_verified',
      };
    return await lab.evaluate(testCase);
  } finally {
    await lab.close();
  }
}

export async function loadCases() {
  return JSON.parse(
    await readFile(new URL('./fixtures/cue-lab.json', import.meta.url), 'utf8'),
  );
}

export async function main(args) {
  const cases = await loadCases();
  if (args.length === 0) {
    console.log('Fictional cue lab. No Claude process or inference started.');
    console.log(cases.map(({ id }) => `  ${id}`).join('\n'));
    console.log('Check subscription login: npm run lab:claude -- --check');
    console.log(
      'After verifying paid extra usage is off: npm run lab:claude -- --run --case already-answered --included-usage-confirmed',
    );
    return;
  }
  if (args.length === 1 && args[0] === '--check') {
    console.log(
      JSON.stringify(await runLab(null, { checkOnly: true }), null, 2),
    );
    return;
  }
  // Deliberately one selected bundled case per invocation. No arbitrary input,
  // background loop, all-cases switch, or account/billing changes.
  if (
    args.length !== 4 ||
    args[0] !== '--run' ||
    args[1] !== '--case' ||
    args[3] !== '--included-usage-confirmed'
  ) {
    throw new Error(
      'Use --check, or --run --case <listed-id> --included-usage-confirmed after checking that paid extra usage is off.',
    );
  }
  const testCase = cases.find(({ id }) => id === args[2]);
  if (!testCase)
    throw new Error(
      'Unknown fictional case. Run without arguments to list the bundled cases.',
    );
  console.log(JSON.stringify(await runLab(testCase), null, 2));
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
