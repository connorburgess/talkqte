// Runs one evaluator over one bundled fictional set and compares its
// decisions with the set's labels and with the phrase rules' recorded
// outcomes. Without --run it only lists what a run would send.
//
//   node scripts/cue-lab-batch.mjs --set held-out
//   node scripts/cue-lab-batch.mjs --set held-out --evaluator fake --run --out <dir>
//   node scripts/cue-lab-batch.mjs --set held-out --run --out <dir> \
//     --max-calls 23 --included-usage-confirmed
//
// There is no schedule, retry, or all-sets switch. A hosted run is one
// explicit invocation with a call cap, and stops at the first failure.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVALUATORS, createEvaluator, isHosted } from './cue-evaluators.mjs';
import {
  createRunLog,
  latencySummary,
  outputDirectory,
  parseFlags,
  stamp,
} from './cue-lab-output.mjs';
import {
  SETS,
  loadRulesOutcomes,
  loadSet,
  selectCases,
} from './cue-lab-sets.mjs';
import { isMain } from './is-main.mjs';

/** The trigger-to-visible-cue target in docs/budgets.md. */
export const CUE_BUDGET_MS = 5_000;
/** No single invocation may ask for more model requests than this. */
export const MAX_CALLS_CEILING = 100;

export const LIMITATIONS = [
  'Fictional cases only. Nothing here is evidence about real meetings.',
  "Agreement with a label means the evaluator chose the action the case's author expected, not that a cue would have helped anyone. The labels are the lanes' own and await the owner's review.",
  'Agreement with the phrase rules compares final actions only; the rules record no sources, wording or delay.',
  'Latency is the wall time of one isolated request including CLI start-up, not the time to a visible cue in a live session.',
  'Token counters are what the CLI reported; they are not a billing receipt or the remaining allowance.',
];

/** Parses --max-calls: a whole number from 1 to the ceiling. */
export function callCap(value) {
  const cap = Number(value);
  if (!/^\d+$/.test(value ?? '') || cap < 1 || cap > MAX_CALLS_CEILING)
    throw new Error(
      `--max-calls must be a whole number from 1 to ${MAX_CALLS_CEILING}.`,
    );
  return cap;
}

/** What a run over these cases would send: one request per case, as the
 * evaluator itself describes it. */
export function planBatch(cases, evaluator) {
  return cases.map((testCase) => ({
    caseId: testCase.id,
    ...evaluator.request(testCase),
  }));
}

/** A hosted run without a usable cap is refused, wherever it is started. */
export function requireCap(evaluator, maxCalls) {
  if (!isHosted(evaluator)) return;
  if (
    !Number.isInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > MAX_CALLS_CEILING
  )
    throw new Error(
      `A hosted run needs a call cap from 1 to ${MAX_CALLS_CEILING}. Nothing was started.`,
    );
}

const tally = (records, test) => ({
  matches: records.filter(test).length,
  of: records.length,
});

export function summarize(records, selected) {
  const quiet = records.filter((r) => r.expectedAction === 'quiet');
  const active = records.filter((r) => r.expectedAction !== 'quiet');
  const withRules = records.filter((r) => r.rulesAction !== null);
  const usage = {};
  for (const record of records)
    for (const [key, value] of Object.entries(record.usage ?? {}))
      usage[key] = (usage[key] ?? 0) + value;
  return {
    selected,
    completed: records.length,
    label: tally(records, (r) => r.matchesLabel),
    byExpectedAction: Object.fromEntries(
      ['show', 'quiet', 'resolved', 'withdraw'].map((action) => [
        action,
        tally(
          records.filter((r) => r.expectedAction === action),
          (r) => r.matchesLabel,
        ),
      ]),
    ),
    // A companion that never did anything would match every quiet label.
    quietLabelled: quiet.length,
    quietKept: quiet.filter((r) => r.action === 'quiet').length,
    actedWhenLabelledQuiet: quiet.filter((r) => r.action !== 'quiet').length,
    neededAction: tally(active, (r) => r.matchesLabel),
    agreesWithRules: tally(withRules, (r) => r.matchesRules),
    rulesMatchLabel: tally(withRules, (r) => r.rulesMatchesLabel),
    latency: latencySummary(
      records
        .filter((r) => r.latency === 'measured' || r.latency === 'simulated')
        .map((r) => r.latencyMs),
      CUE_BUDGET_MS,
    ),
    usage,
  };
}

/** Evaluates the cases in order, one at a time. Stops at the cap or the
 * first failure; whatever completed is returned with the reason. */
export async function runBatch({
  set,
  cases,
  rules,
  evaluator,
  maxCalls,
  log = createRunLog(null),
  now = () => new Date(),
}) {
  requireCap(evaluator, maxCalls);
  const hosted = isHosted(evaluator);
  const plan = planBatch(cases, evaluator);
  const records = [];
  let stopped = null;
  let facts = null;
  log.write('run-start', {
    kind: 'batch',
    set: set.name,
    setFile: set.file,
    evaluator: evaluator.id,
    evaluatorLabel: evaluator.label,
    hosted,
    destination: evaluator.destination ?? null,
    caseIds: cases.map(({ id }) => id),
    maxCalls: maxCalls ?? null,
    systemPrompts: [
      ...new Set(plan.map((request) => request.systemPrompt).filter(Boolean)),
    ],
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  });
  try {
    facts = await evaluator.open();
    log.write('evaluator-ready', facts);
    for (const [index, testCase] of cases.entries()) {
      if (maxCalls !== undefined && index >= maxCalls) {
        stopped = { afterCalls: index, reason: 'The call cap was reached.' };
        break;
      }
      log.write('request', {
        index,
        caseId: testCase.id,
        input: plan[index].input,
      });
      const result = await evaluator.decide(testCase);
      const { decision } = result;
      const rulesAction =
        evaluator.kind === 'rules' ? null : (rules[testCase.id] ?? null);
      const expected = testCase.expected;
      const record = {
        caseId: testCase.id,
        category: testCase.category ?? null,
        expectedAction: expected.action,
        action: decision.action,
        matchesLabel: decision.action === expected.action,
        cue: decision.cue,
        sourceIds: decision.sourceIds,
        reason: decision.reason,
        observedUse: decision.observedUse,
        // Only the first set labels observed use.
        expectedObservedUse: expected.observedUse ?? null,
        latencyMs: result.elapsedMs,
        latency: result.latency,
        rulesAction,
        matchesRules:
          rulesAction === null ? null : decision.action === rulesAction,
        rulesMatchesLabel:
          rulesAction === null ? null : rulesAction === expected.action,
        usage: result.usage ?? null,
        provider: result.provider ?? null,
      };
      records.push(record);
      log.write('decision', { index, ...record });
    }
  } catch (error) {
    // The adapters' messages never contain provider output or credentials.
    stopped = {
      afterCalls: records.length,
      reason: error.message,
      category: error.category ?? null,
      exitCode: error.exitCode ?? null,
    };
    log.write('stopped', stopped);
  } finally {
    await evaluator.close();
  }
  const results = {
    schema: 'talkqte-cue-lab-batch/1',
    fictional: true,
    createdAt: now().toISOString(),
    set: set.name,
    setFile: set.file,
    evaluator: {
      id: evaluator.id,
      label: evaluator.label,
      kind: evaluator.kind,
      hosted,
      ...facts,
    },
    maxCalls: maxCalls ?? null,
    stopped,
    summary: summarize(records, cases.length),
    cases: records,
    limitations: LIMITATIONS,
  };
  log.write('run-end', { stopped, summary: results.summary });
  return results;
}

function describePlan(set, cases, evaluator, plan, selection, print) {
  print('Dry run. No process was started and nothing was sent.');
  print(
    `Set: ${set.name} (${set.file}), ${cases.length} of ${set.cases.length} cases.`,
  );
  print(`Evaluator: ${evaluator.label}.`);
  if (isHosted(evaluator)) {
    print(
      `A run would make ${plan.length} model requests, one per case, one at a time, with no retry. Before them it makes 2 CLI checks (version and sign-in) that send no case text.`,
    );
    print(
      `A run sends the fictional case text listed below off this device to ${evaluator.destination}. That is hosted inference and uses the subscription's shared allowance. No API key is used or accepted.`,
    );
  } else {
    print(
      `A run would evaluate ${plan.length} cases on this device. No model, account or network is used.`,
    );
  }
  for (const prompt of new Set(plan.map((request) => request.systemPrompt))) {
    if (!prompt) continue;
    const count = plan.filter((r) => r.systemPrompt === prompt).length;
    print(`\nSystem prompt for ${count} of the requests:\n${prompt}`);
  }
  print('\nInput for each request (labels and case IDs are not sent):');
  for (const [index, request] of plan.entries())
    print(
      `[${index + 1}] ${request.caseId}\n    ${request.input ?? '(nothing: the recorded outcome for this case is read)'}`,
    );
  const chosen = `--set ${set.name}${selection ? ` --cases ${selection}` : ''}`;
  if (!isHosted(evaluator))
    print(
      `\nTo run it:\n  npm run lab:batch -- ${chosen} --evaluator ${evaluator.id} --run --out <directory outside the repository>`,
    );
  else if (plan.length > MAX_CALLS_CEILING)
    print(
      `\nThis selection needs ${plan.length} requests, more than the ${MAX_CALLS_CEILING} one invocation allows. Split it with --cases.`,
    );
  else
    print(
      `\nTo run it, after checking that paid extra usage is off and with the owner's go-ahead for this run:\n  npm run lab:batch -- ${chosen} --run --out <directory outside the repository> --max-calls ${plan.length} --included-usage-confirmed`,
    );
}

function describeResults(results, print) {
  for (const record of results.cases)
    print(
      `${record.matchesLabel ? 'match   ' : 'differs '} ${record.caseId}: ${record.action} (label ${record.expectedAction}${record.rulesAction ? `, rules ${record.rulesAction}` : ''})${record.latencyMs === null ? '' : ` ${record.latencyMs} ms ${record.latency}`}`,
    );
  const s = results.summary;
  print(
    `\n${s.completed} of ${s.selected} cases evaluated. Label matches: ${s.label.matches} of ${s.label.of}.`,
  );
  print(
    `Labelled quiet: ${s.quietLabelled}, kept quiet: ${s.quietKept}. Cases needing an action: ${s.neededAction.matches} of ${s.neededAction.of} matched.`,
  );
  if (s.agreesWithRules.of)
    print(
      `Same action as the phrase rules: ${s.agreesWithRules.matches} of ${s.agreesWithRules.of} (the rules match the label on ${s.rulesMatchLabel.matches}).`,
    );
  if (s.latency)
    print(
      `Latency (${results.cases[0].latency}): median ${s.latency.medianMs} ms, 95th percentile ${s.latency.p95Ms} ms, maximum ${s.latency.maxMs} ms; ${s.latency.overBudget} over the ${CUE_BUDGET_MS} ms budget.`,
    );
  if (results.stopped)
    print(
      `Stopped after ${results.stopped.afterCalls} cases: ${results.stopped.reason}`,
    );
  print('Fictional cases; label agreement is not evidence of usefulness.');
}

export async function main(
  args,
  {
    print = console.log,
    environment = process.env,
    evaluators = EVALUATORS,
    now = () => new Date(),
  } = {},
) {
  const flags = parseFlags(args, {
    values: [
      '--set',
      '--cases',
      '--evaluator',
      '--out',
      '--max-calls',
      '--prompt',
    ],
    switches: ['--run', '--included-usage-confirmed'],
  });
  const setName = flags['--set'];
  if (!setName)
    throw new Error(
      `Choose a set with --set: ${Object.keys(SETS).join(', ')}. Without --run nothing is started or sent.`,
    );
  const set = await loadSet(setName);
  const cases = selectCases(set.cases, flags['--cases']?.split(','));
  const rules = await loadRulesOutcomes(set.name);
  // The batch keeps the recorded trials' prompt unless asked otherwise, so
  // its results stay comparable with them.
  const prompt = flags['--prompt'] ?? 'recorded';
  if (!['recorded', 'glance'].includes(prompt))
    throw new Error('--prompt is recorded or glance.');
  const evaluator = createEvaluator(
    flags['--evaluator'] ?? 'claude',
    { environment, rules, glance: prompt === 'glance' },
    evaluators,
  );
  if (!flags['--run']) {
    describePlan(
      set,
      cases,
      evaluator,
      planBatch(cases, evaluator),
      flags['--cases'],
      print,
    );
    return null;
  }
  let maxCalls;
  // Anything not explicitly on-device needs the acknowledgement and a cap.
  if (isHosted(evaluator)) {
    // Every check that can refuse does so before any process is started.
    if (!flags['--included-usage-confirmed'])
      throw new Error(
        'A hosted run needs --included-usage-confirmed, after checking in the Claude account that paid extra usage is off. Nothing was started.',
      );
    if (flags['--max-calls'] === undefined)
      throw new Error(
        'A hosted run needs a call cap: --max-calls <number>. Nothing was started.',
      );
    maxCalls = callCap(flags['--max-calls']);
    if (cases.length > maxCalls)
      throw new Error(
        `This run needs ${cases.length} model requests and the cap is ${maxCalls}. Choose fewer cases with --cases or raise the cap. Nothing was started.`,
      );
  }
  const directory = outputDirectory(flags['--out'], environment);
  const base = join(
    directory,
    `cue-lab-batch-${set.name}-${evaluator.id}-${stamp(now())}`,
  );
  const log = createRunLog(`${base}.log.jsonl`, now);
  const results = await runBatch({
    set,
    cases,
    rules,
    evaluator,
    maxCalls,
    log,
    now,
  });
  writeFileSync(`${base}.json`, `${JSON.stringify(results, null, 2)}\n`);
  describeResults(results, print);
  print(`Results: ${base}.json\nEvent log: ${base}.log.jsonl`);
  if (results.stopped) process.exitCode = 1;
  return results;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
