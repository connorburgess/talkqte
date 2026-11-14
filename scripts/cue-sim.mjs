// Timing simulation: replays a fictional conversation line by line on a
// virtual clock and asks an evaluator, with only the lines heard so far,
// whether to show a cue, stay quiet, or clear the one on screen. It then
// scores when cues appeared against the conversation's labels.
//
//   node scripts/cue-sim.mjs                         (dry run, all conversations)
//   node scripts/cue-sim.mjs --coverage              (what the fictional sets cover)
//   node scripts/cue-sim.mjs --evaluator fake --run --out <dir>
//   node scripts/cue-sim.mjs --conversations standup-flaky-test --run --out <dir> \
//     --max-calls 14 --included-usage-confirmed
//
// The clock is virtual, so an offline run takes milliseconds. A hosted run
// is one explicit invocation with a call cap and stops at the first failure.
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPrompt, systemPromptFor } from './cue-lab.mjs';
import { CUE_BUDGET_MS, callCap } from './cue-lab-batch.mjs';
import {
  claudeEvaluator,
  fakeEvaluator,
  rulesEvaluator,
} from './cue-evaluators.mjs';
import {
  createRunLog,
  latencySummary,
  outputDirectory,
  parseFlags,
  stamp,
} from './cue-lab-output.mjs';
import { SETS, loadRulesOutcomes, loadSet } from './cue-lab-sets.mjs';
import { isMain } from './is-main.mjs';

/** How long an unread cue stays, as the engine's CUE_MS. */
export const CUE_LIFETIME_MS = 18_000;
/** The evaluator sees this many recent lines, as the engine's bridge does. */
export const CONTEXT_LINES = 6;
export const DEFAULTS = {
  // Evaluate only on a new line, and never sooner than this after the last
  // evaluation started.
  minGapMs: 2_000,
  // Stands in for local transcription: a line reaches the evaluator this
  // long after it was said (measured median 3.13 s; see docs/budgets.md).
  transcriptDelayMs: 3_000,
  // 'app': what the app's bridge sends today (one speaker label, no name).
  // 'named': speaker names and the listener's name, to see what they add.
  input: 'app',
  // false: a decision overtaken by newer speech is dropped, as in the app.
  applyStale: false,
};
const RULES_CUE = 'Phrase-rule cue (wording not recorded)';

export const LIMITATIONS = [
  'Fictional conversations only. Nothing here is evidence about real meetings.',
  "The labels (where a cue would help, until when, and what should stay quiet) are the lab lane's own and await the owner's review. Matching them is not usefulness, participation or comprehension.",
  'The clock is simulated. A model decision is placed on it using the measured time of one isolated request including CLI start-up; the app would add its own overhead and draw time.',
  'The transcription delay is one fixed number, not a measurement of this conversation.',
  'Only the lifecycle below is simulated: one cue at a time, an 18-second life from its newest cited line, and decisions overtaken by newer speech dropped. Cooldown, focus, hold, dismissal and note reminders are not.',
];

export async function loadConversations() {
  const file = JSON.parse(
    await readFile(
      new URL('./fixtures/cue-sim-conversations.json', import.meta.url),
      'utf8',
    ),
  );
  return file.conversations;
}

/** A case from one of the three sets as a timed conversation: lines two
 * seconds apart, as the engine's replay spaces them, with the fixture's cue
 * on screen after its source line. Only the case's final outcome is
 * labelled, so only the last line (or, for show, the case) carries a label. */
export function conversationFromCase(testCase, set, gapMs = 2_000) {
  const expected = testCase.expected.action;
  const last = testCase.events.length - 1;
  return {
    id: testCase.id,
    context: `set:${set}`,
    title: testCase.id,
    setting: `A case from the ${set} set.`,
    listener: testCase.userName ?? null,
    participants: [],
    seedCue: testCase.existingCue && {
      text: testCase.existingCue.text,
      sourceIds: testCase.existingCue.sourceIds,
    },
    lines: testCase.events.map((event, index) => ({
      id: event.id,
      atMs: 1_000 + index * gapMs,
      speaker: event.speaker ?? 'Speaker',
      text: event.text,
      ...(expected === 'show'
        ? index === 0
          ? { expect: 'show' }
          : {}
        : index === last
          ? {
              expect: expected,
              ...(expected === 'quiet' ? {} : { of: 'seed' }),
            }
          : {}),
    })),
  };
}

/** The phrase rules inside the simulation. Their record holds one final
 * outcome per case, so they stay quiet until the last line and then give
 * that outcome at once: the rules decide as a line arrives. */
export function finalOutcomeEvaluator(rules) {
  return {
    ...rules,
    async decide(testCase) {
      if (!testCase.finalLine)
        return {
          decision: {
            action: 'quiet',
            cue: null,
            sourceIds: null,
            reason: null,
            observedUse: null,
          },
          elapsedMs: 0,
          latency: 'none',
        };
      return { ...(await rules.decide(testCase)), elapsedMs: 0 };
    },
  };
}

/** Replays one conversation. Returns its timeline and its lines with the
 * time each reached the evaluator. Throws whatever the evaluator throws. */
export async function simulate(
  conversation,
  evaluator,
  {
    minGapMs = DEFAULTS.minGapMs,
    transcriptDelayMs = DEFAULTS.transcriptDelayMs,
    input = DEFAULTS.input,
    applyStale = DEFAULTS.applyStale,
    maxCalls = Infinity,
    calls = { count: 0 },
    log,
  } = {},
) {
  const lines = conversation.lines.map((line) => ({
    ...line,
    arrivesAtMs: line.atMs + transcriptDelayMs,
  }));
  const byId = new Map(lines.map((line) => [line.id, line]));
  const timeline = [];
  const emit = (type, atMs, data) => {
    const event = { type, atMs, ...data };
    timeline.push(event);
    log?.write(`sim-${type}`, { conversation: conversation.id, atMs, ...data });
  };
  const heard = [];
  let next = 0;
  let cue = null;
  let cueCount = 0;
  let pending = null;
  let waiting = false;
  let wakeAt = null;
  let lastStart = -Infinity;
  let capped = false;

  const show = (atMs, text, sourceIds, triggerLineId, origin) => {
    const newest = Math.max(...sourceIds.map((id) => byId.get(id).arrivesAtMs));
    cue = {
      cueId: `${conversation.id}:cue-${++cueCount}`,
      text,
      sourceIds,
      triggerLineId,
      origin,
      shownAtMs: atMs,
      // An unread cue's life starts at its newest cited line.
      expiresAtMs: newest + CUE_LIFETIME_MS,
    };
    emit('cue-shown', atMs, cue);
  };
  const clear = (atMs, why, lineId = null) => {
    emit('cue-cleared', atMs, {
      cueId: cue.cueId,
      why,
      lineId,
      visibleMs: atMs - cue.shownAtMs,
    });
    cue = null;
  };

  const start = async (atMs) => {
    const newest = heard.at(-1);
    waiting = false;
    wakeAt = null;
    if (calls.count >= maxCalls) {
      capped = true;
      emit('evaluation-skipped', atMs, { lineId: newest.id, why: 'call-cap' });
      return;
    }
    const recent = heard.slice(-CONTEXT_LINES);
    // The cue's own lines stay in view even when older than the window.
    const cited = (cue?.sourceIds ?? [])
      .map((id) => byId.get(id))
      .filter((line) => !recent.includes(line));
    const testCase = {
      id: conversation.id,
      finalLine: newest === lines.at(-1),
      events: [...cited, ...recent].map((line) => ({
        id: line.id,
        speaker: input === 'named' ? line.speaker : 'Speaker',
        text: line.text,
      })),
      existingCue: cue && { text: cue.text, sourceIds: cue.sourceIds },
      ...(input === 'named' && conversation.listener
        ? { userName: conversation.listener }
        : {}),
    };
    calls.count++;
    lastStart = atMs;
    emit('evaluation-start', atMs, {
      lineId: newest.id,
      call: calls.count,
      existingCueId: cue?.cueId ?? null,
      input: buildPrompt(testCase),
    });
    const result = await evaluator.decide(testCase);
    pending = {
      lineId: newest.id,
      startedAtMs: atMs,
      landsAtMs: atMs + result.elapsedMs,
      cueId: cue?.cueId ?? null,
      superseded: false,
      result,
    };
  };

  const land = (atMs) => {
    const { lineId, startedAtMs, cueId, superseded, result } = pending;
    pending = null;
    const { decision } = result;
    const sourceIds = decision.sourceIds ?? [lineId];
    let outcome = 'applied';
    if (superseded && !applyStale) outcome = 'superseded';
    else if ((cue?.cueId ?? null) !== cueId) outcome = 'cue-changed';
    else if (decision.action === 'show') {
      const newest = Math.max(
        ...sourceIds.map((id) => byId.get(id).arrivesAtMs),
      );
      if (atMs - newest > CUE_LIFETIME_MS) outcome = 'too-late';
    } else if (decision.action !== 'quiet' && !cue) outcome = 'no-cue';
    emit('decision', atMs, {
      lineId,
      startedAtMs,
      latencyMs: result.elapsedMs,
      latency: result.latency,
      overtaken: superseded,
      outcome,
      action: decision.action,
      cue: decision.cue,
      sourceIds: decision.sourceIds,
      reason: decision.reason,
      observedUse: decision.observedUse,
      usage: result.usage ?? null,
      provider: result.provider ?? null,
    });
    if (outcome !== 'applied') return;
    if (decision.action === 'show')
      show(atMs, decision.cue ?? RULES_CUE, sourceIds, lineId, 'evaluator');
    else if (decision.action !== 'quiet') clear(atMs, decision.action, lineId);
  };

  for (;;) {
    // At the same instant: speech first, then a landing decision, then expiry.
    const due = [
      next < lines.length && [lines[next].arrivesAtMs, 0, 'line'],
      pending && [pending.landsAtMs, 1, 'land'],
      cue && [cue.expiresAtMs, 2, 'expire'],
      wakeAt !== null && !pending && [wakeAt, 3, 'wake'],
    ]
      .filter(Boolean)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])[0];
    if (!due) break;
    const [atMs, , kind] = due;
    if (kind === 'line') {
      const line = lines[next++];
      heard.push(line);
      emit('line', atMs, { lineId: line.id, spokenAtMs: line.atMs });
      const seed = conversation.seedCue;
      if (seed && !cueCount && seed.sourceIds.at(-1) === line.id) {
        // The fixture's cue is given, not decided: no evaluation here.
        show(atMs, seed.text, seed.sourceIds, line.id, 'fixture');
      } else if (capped) {
        emit('evaluation-skipped', atMs, { lineId: line.id, why: 'call-cap' });
      } else if (pending) {
        // New speech overtakes the request in flight; one catch-up follows.
        pending.superseded = true;
        waiting = true;
        emit('evaluation-skipped', atMs, { lineId: line.id, why: 'busy' });
      } else if (atMs - lastStart < minGapMs) {
        waiting = true;
        wakeAt = lastStart + minGapMs;
        emit('evaluation-skipped', atMs, { lineId: line.id, why: 'min-gap' });
      } else await start(atMs);
    } else if (kind === 'land') {
      land(atMs);
      if (waiting && !capped) {
        if (atMs - lastStart >= minGapMs) await start(atMs);
        else wakeAt = lastStart + minGapMs;
      }
    } else if (kind === 'expire') clear(atMs, 'expired');
    else await start(atMs);
  }
  return { lines, timeline, capped };
}

const normal = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Scores one replay against the conversation's labels. */
export function score(conversation, { lines, timeline }) {
  const index = new Map(lines.map((line, i) => [line.id, i]));
  const line = (id) => lines[index.get(id)];
  const events = (type) => timeline.filter((event) => event.type === type);
  const shown = events('cue-shown');
  const cleared = new Map(events('cue-cleared').map((e) => [e.cueId, e]));
  const decisions = events('decision');

  // Each labelled moment where a cue would help, and until when.
  const opportunities = lines
    .filter((item) => item.expect === 'show')
    .map((item) => ({
      lineId: item.id,
      about: item.about ?? null,
      saidAtMs: item.atMs,
      // Past this the moment has gone: the line that answers it or moves on
      // has been said, or the cue would be older than the app allows.
      closesAtMs: item.until
        ? line(item.until).atMs
        : item.arrivesAtMs + CUE_LIFETIME_MS,
      until: item.until ?? null,
      cueId: null,
      outcome: 'missed',
      visibleAtMs: null,
      afterSaidMs: null,
    }));
  const seeded = shown.find((event) => event.origin === 'fixture');
  let unexpected = 0;
  let duplicates = 0;
  const texts = new Set(seeded ? [normal(seeded.text)] : []);
  for (const event of shown.filter((e) => e.origin === 'evaluator')) {
    const at = index.get(event.triggerLineId);
    const trigger = line(event.triggerLineId);
    const open = opportunities.findLast(
      (o) =>
        index.get(o.lineId) <= at &&
        (!o.until || at < index.get(o.until)) &&
        trigger.arrivesAtMs < o.closesAtMs,
    );
    const repeat = texts.has(normal(event.text));
    texts.add(normal(event.text));
    const second = Boolean(open?.cueId);
    if (!open) unexpected++;
    else if (!second) {
      open.cueId = event.cueId;
      open.visibleAtMs = event.atMs;
      open.afterSaidMs = event.atMs - open.saidAtMs;
      open.outcome = event.atMs < open.closesAtMs ? 'in-time' : 'late';
    }
    // The same words again, or a second cue for a moment already cued.
    if (second || repeat) duplicates++;
  }

  // Lines labelled as answering or removing the basis of a cue.
  const endings = lines
    .filter((item) => item.expect === 'resolved' || item.expect === 'withdraw')
    .map((item) => {
      const cueId =
        item.of === 'seed'
          ? seeded?.cueId
          : opportunities.find((o) => o.lineId === item.of)?.cueId;
      const cue = shown.find((event) => event.cueId === cueId);
      const end = cue && cleared.get(cue.cueId);
      // Nothing to clear if the cue was never shown or had already gone.
      if (!cue || cue.atMs > item.arrivesAtMs || (end && end.atMs < item.atMs))
        return { lineId: item.id, expect: item.expect, outcome: 'no-cue' };
      const byEvaluator = end && ['resolved', 'withdraw'].includes(end.why);
      return {
        lineId: item.id,
        expect: item.expect,
        outcome: !byEvaluator
          ? 'lingered'
          : end.why === item.expect
            ? 'as-labelled'
            : 'cleared-otherwise',
        // How long the cue stayed after the line that ended its use.
        lingerMs: (end?.atMs ?? cue.expiresAtMs) - item.atMs,
      };
    });

  // A flip: the evaluator showed a cue and then took it back, at a line
  // that is not labelled as a reason to withdraw it.
  const flips = shown.filter((event) => {
    const end = cleared.get(event.cueId);
    return (
      event.origin === 'evaluator' &&
      end?.why === 'withdraw' &&
      line(end.lineId).expect !== 'withdraw'
    );
  }).length;

  // A cue for a labelled moment may arrive a line or two later. Showing it
  // on a quiet line while that moment is still open is not a broken quiet.
  const catchingUp = (item, decision) =>
    decision.action === 'show' &&
    opportunities.some(
      (o) =>
        index.get(o.lineId) < index.get(item.id) &&
        (!o.until || index.get(item.id) < index.get(o.until)) &&
        item.arrivesAtMs < o.closesAtMs &&
        (!o.cueId ||
          shown.find((e) => e.cueId === o.cueId).triggerLineId === item.id),
    );
  const quietLines = lines.filter((item) => item.expect === 'quiet');
  const quietDecisions = quietLines
    .map((item) => [item, decisions.find((d) => d.lineId === item.id)])
    .filter(([item, decision]) => decision && !catchingUp(item, decision))
    .map(([, decision]) => decision);
  const count = (list, test) => list.filter(test).length;
  return {
    lines: lines.length,
    evaluations: {
      started: events('evaluation-start').length,
      applied: count(decisions, (d) => d.outcome === 'applied'),
      overtaken: count(decisions, (d) => d.outcome === 'superseded'),
      cueChanged: count(decisions, (d) => d.outcome === 'cue-changed'),
      tooLate: count(decisions, (d) => d.outcome === 'too-late'),
      noCue: count(decisions, (d) => d.outcome === 'no-cue'),
      skippedBusy: count(events('evaluation-skipped'), (e) => e.why === 'busy'),
      skippedGap: count(
        events('evaluation-skipped'),
        (e) => e.why === 'min-gap',
      ),
      skippedCap: count(
        events('evaluation-skipped'),
        (e) => e.why === 'call-cap',
      ),
    },
    opportunities: {
      labelled: opportunities.length,
      inTime: count(opportunities, (o) => o.outcome === 'in-time'),
      late: count(opportunities, (o) => o.outcome === 'late'),
      missed: count(opportunities, (o) => o.outcome === 'missed'),
      detail: opportunities,
    },
    cuesShown: count(shown, (e) => e.origin === 'evaluator'),
    unexpectedShows: unexpected,
    duplicates,
    flips,
    quiet: {
      labelled: quietLines.length,
      evaluated: quietDecisions.length,
      kept: count(quietDecisions, (d) => d.action === 'quiet'),
    },
    endings: {
      labelled: endings.length,
      asLabelled: count(endings, (e) => e.outcome === 'as-labelled'),
      clearedOtherwise: count(
        endings,
        (e) => e.outcome === 'cleared-otherwise',
      ),
      lingered: count(endings, (e) => e.outcome === 'lingered'),
      noCue: count(endings, (e) => e.outcome === 'no-cue'),
      detail: endings,
    },
    // Request time of every completed evaluation, applied or not.
    decisionMs: decisions
      .filter((d) => d.latency !== 'none')
      .map((d) => d.latencyMs),
    // From the moment the triggering line was said to the cue on screen.
    afterSaidMs: opportunities
      .filter((o) => o.afterSaidMs !== null)
      .map((o) => o.afterSaidMs),
  };
}

/** Adds up the scores of several conversations. */
export function total(scores) {
  const sum = (pick) => scores.reduce((value, s) => value + pick(s), 0);
  const group = (name, keys) =>
    Object.fromEntries(keys.map((key) => [key, sum((s) => s[name][key])]));
  const decisionMs = scores.flatMap((s) => s.decisionMs);
  const afterSaidMs = scores.flatMap((s) => s.afterSaidMs);
  return {
    conversations: scores.length,
    lines: sum((s) => s.lines),
    evaluations: group('evaluations', Object.keys(scores[0].evaluations)),
    opportunities: group('opportunities', [
      'labelled',
      'inTime',
      'late',
      'missed',
    ]),
    cuesShown: sum((s) => s.cuesShown),
    unexpectedShows: sum((s) => s.unexpectedShows),
    duplicates: sum((s) => s.duplicates),
    flips: sum((s) => s.flips),
    quiet: group('quiet', ['labelled', 'evaluated', 'kept']),
    endings: group('endings', [
      'labelled',
      'asLabelled',
      'clearedOtherwise',
      'lingered',
      'noCue',
    ]),
    decisionLatency: latencySummary(decisionMs, CUE_BUDGET_MS),
    // The budget is measured from the end of the triggering line.
    triggerToCue: latencySummary(afterSaidMs, CUE_BUDGET_MS),
  };
}

/** The most evaluations a replay can start: every decision instant. */
export async function maxEvaluations(conversation, options) {
  const instant = {
    async decide() {
      return {
        decision: {
          action: 'quiet',
          cue: null,
          sourceIds: null,
          reason: null,
          observedUse: null,
        },
        elapsedMs: 0,
        latency: 'none',
      };
    },
  };
  const { timeline } = await simulate(conversation, instant, {
    ...options,
    maxCalls: Infinity,
    calls: { count: 0 },
    log: undefined,
  });
  return timeline.filter((event) => event.type === 'evaluation-start').length;
}

/** Runs the conversations in order. Stops at the cap or the first failure. */
export async function runSimulation({
  source,
  conversations,
  evaluator,
  options = {},
  maxCalls,
  log = createRunLog(null),
  now = () => new Date(),
}) {
  const settings = { ...DEFAULTS, ...options };
  const calls = { count: 0 };
  const replays = [];
  let stopped = null;
  let facts = null;
  log.write('run-start', {
    kind: 'simulation',
    source,
    evaluator: evaluator.id,
    evaluatorLabel: evaluator.label,
    hosted: evaluator.hosted,
    destination: evaluator.destination ?? null,
    conversationIds: conversations.map(({ id }) => id),
    settings,
    maxCalls: maxCalls ?? null,
    systemPrompts: [
      ...new Set(
        conversations.map((c) =>
          systemPromptFor({
            userName: settings.input === 'named' ? c.listener : null,
          }),
        ),
      ),
    ],
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  });
  try {
    facts = await evaluator.open();
    log.write('evaluator-ready', facts);
    for (const conversation of conversations) {
      log.write('conversation-start', { conversation: conversation.id });
      const replay = await simulate(conversation, evaluator, {
        ...settings,
        maxCalls: maxCalls ?? Infinity,
        calls,
        log,
      });
      const metrics = score(conversation, replay);
      log.write('conversation-end', { conversation: conversation.id, metrics });
      replays.push({
        id: conversation.id,
        context: conversation.context,
        title: conversation.title,
        setting: conversation.setting,
        listener: conversation.listener ?? null,
        participants: conversation.participants,
        lines: replay.lines,
        timeline: replay.timeline,
        metrics,
      });
      if (replay.capped) {
        stopped = {
          afterCalls: calls.count,
          reason: 'The call cap was reached.',
        };
        break;
      }
    }
  } catch (error) {
    // The adapters' messages never contain provider output or credentials.
    stopped = { afterCalls: calls.count, reason: error.message };
  } finally {
    await evaluator.close();
  }
  if (stopped) log.write('stopped', stopped);
  const results = {
    schema: 'talkqte-cue-sim/1',
    fictional: true,
    simulated: true,
    createdAt: now().toISOString(),
    source,
    evaluator: {
      id: evaluator.id,
      label: evaluator.label,
      kind: evaluator.kind,
      hosted: evaluator.hosted,
      ...facts,
    },
    settings,
    maxCalls: maxCalls ?? null,
    calls: calls.count,
    stopped,
    totals: replays.length
      ? {
          ...total(replays.map((r) => r.metrics)),
          // The rules record holds no delay, so there is no time to report.
          ...(evaluator.kind === 'rules' ? { triggerToCue: null } : {}),
        }
      : null,
    conversations: replays,
    limitations: LIMITATIONS,
  };
  log.write('run-end', { stopped, calls: calls.count, totals: results.totals });
  return results;
}

const words = (text) => text.split(/\s+/).filter(Boolean).length;
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];

/** What the bundled fictional material covers, for deciding what to add. */
export async function coverage() {
  const rows = [];
  for (const name of Object.keys(SETS)) {
    const { cases } = await loadSet(name);
    const lengths = cases.map((item) => item.events.length);
    const wordCounts = cases.flatMap((item) =>
      item.events.map((event) => words(event.text)),
    );
    const actions = {};
    for (const item of cases)
      actions[item.expected.action] = (actions[item.expected.action] ?? 0) + 1;
    rows.push({
      name,
      kind: 'case set',
      items: cases.length,
      lines: lengths.reduce((a, b) => a + b, 0),
      linesPerItem: `${Math.min(...lengths)}-${Math.max(...lengths)}`,
      medianWords: median(wordCounts),
      timed: false,
      named: cases.filter((item) => item.events.some((e) => e.speaker)).length,
      labels: actions,
    });
  }
  const conversations = await loadConversations();
  const byContext = {};
  for (const item of conversations) (byContext[item.context] ??= []).push(item);
  for (const [context, items] of Object.entries(byContext)) {
    const lengths = items.map((item) => item.lines.length);
    const labels = {};
    for (const item of items)
      for (const line of item.lines)
        labels[line.expect] = (labels[line.expect] ?? 0) + 1;
    rows.push({
      name: context,
      kind: 'timed conversations',
      items: items.length,
      lines: lengths.reduce((a, b) => a + b, 0),
      linesPerItem: `${Math.min(...lengths)}-${Math.max(...lengths)}`,
      medianWords: median(
        items.flatMap((item) => item.lines.map((l) => words(l.text))),
      ),
      timed: true,
      named: items.length,
      labels,
      seconds: items.map((item) => Math.round(item.lines.at(-1).atMs / 1000)),
    });
  }
  return rows;
}

function describeCoverage(rows, print) {
  print('What the bundled fictional material covers. Nothing was started.\n');
  for (const row of rows)
    print(
      `${row.kind.padEnd(20)} ${row.name.padEnd(14)} ${String(row.items).padStart(3)} items, ${String(row.lines).padStart(3)} lines (${row.linesPerItem} each), median ${row.medianWords} words a line, ${row.timed ? `timed, ${Math.min(...row.seconds)}-${Math.max(...row.seconds)} s` : 'no times'}, labels ${Object.entries(
        row.labels,
      )
        .map(([action, n]) => `${action} ${n}`)
        .join(', ')}`,
    );
}

function describeTotals(results, print) {
  for (const replay of results.conversations) {
    const m = replay.metrics;
    print(
      `${replay.id}: ${m.evaluations.started} evaluations, ${m.cuesShown} cues shown; of ${m.opportunities.labelled} labelled moments ${m.opportunities.inTime} in time, ${m.opportunities.late} late, ${m.opportunities.missed} missed; ${m.unexpectedShows} unexpected, ${m.flips} flips, ${m.duplicates} duplicates; quiet kept ${m.quiet.kept} of ${m.quiet.evaluated} evaluated quiet lines`,
    );
  }
  const t = results.totals;
  if (!t) return;
  print(
    `\n${t.conversations} conversations, ${t.lines} lines, ${results.calls} evaluations (${t.evaluations.overtaken} overtaken by newer speech and dropped).`,
  );
  print(
    `Labelled moments: ${t.opportunities.labelled}; cue in time ${t.opportunities.inTime}, late ${t.opportunities.late}, missed ${t.opportunities.missed}. Unexpected cues ${t.unexpectedShows}, flips ${t.flips}, duplicates ${t.duplicates}.`,
  );
  print(
    `Quiet lines: ${t.quiet.labelled} labelled, ${t.quiet.evaluated} evaluated, ${t.quiet.kept} kept quiet. Endings: ${t.endings.asLabelled} cleared as labelled, ${t.endings.clearedOtherwise} cleared otherwise, ${t.endings.lingered} lingered, ${t.endings.noCue} had no cue to clear.`,
  );
  if (t.decisionLatency)
    print(
      `Decision time: median ${t.decisionLatency.medianMs} ms, 95th percentile ${t.decisionLatency.p95Ms} ms.`,
    );
  if (t.triggerToCue)
    print(
      `Line said to cue on screen: median ${t.triggerToCue.medianMs} ms, 95th percentile ${t.triggerToCue.p95Ms} ms; ${t.triggerToCue.overBudget} of ${t.triggerToCue.count} over the ${CUE_BUDGET_MS} ms budget.`,
    );
  if (results.stopped)
    print(
      `Stopped after ${results.stopped.afterCalls} evaluations: ${results.stopped.reason}`,
    );
  print(
    'Simulated timing on fictional conversations; matching the labels is not evidence of usefulness.',
  );
}

const wholeNumber = (flag, value, fallback) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value))
    throw new Error(`${flag} must be a whole number of milliseconds.`);
  return Number(value);
};

export async function main(
  args,
  {
    print = console.log,
    environment = process.env,
    evaluators = {
      claude: () => claudeEvaluator({ environment }),
      fake: () => fakeEvaluator(),
    },
    now = () => new Date(),
  } = {},
) {
  const flags = parseFlags(args, {
    values: [
      '--conversations',
      '--set',
      '--evaluator',
      '--out',
      '--max-calls',
      '--min-gap-ms',
      '--transcript-delay-ms',
      '--input',
    ],
    switches: [
      '--run',
      '--included-usage-confirmed',
      '--apply-stale',
      '--coverage',
    ],
  });
  if (flags['--coverage']) {
    describeCoverage(await coverage(), print);
    return null;
  }
  const options = {
    minGapMs: wholeNumber(
      '--min-gap-ms',
      flags['--min-gap-ms'],
      DEFAULTS.minGapMs,
    ),
    transcriptDelayMs: wholeNumber(
      '--transcript-delay-ms',
      flags['--transcript-delay-ms'],
      DEFAULTS.transcriptDelayMs,
    ),
    input: flags['--input'] ?? DEFAULTS.input,
    applyStale: Boolean(flags['--apply-stale']),
  };
  if (!['app', 'named'].includes(options.input))
    throw new Error('--input is app or named.');
  if (flags['--set'] && flags['--conversations'])
    throw new Error('Choose --set or --conversations, not both.');
  const name = flags['--evaluator'] ?? 'claude';
  let source;
  let conversations;
  let evaluator;
  if (flags['--set']) {
    const set = await loadSet(flags['--set']);
    source = `set:${set.name}`;
    conversations = set.cases.map((item) =>
      conversationFromCase(item, set.name),
    );
    if (name === 'rules')
      evaluator = finalOutcomeEvaluator(
        rulesEvaluator(await loadRulesOutcomes(set.name)),
      );
  } else {
    source = 'conversations';
    const all = await loadConversations();
    const ids = flags['--conversations']?.split(',');
    const unknown = (ids ?? []).filter((id) => !all.some((c) => c.id === id));
    if (unknown.length)
      throw new Error(`Unknown fictional conversation: ${unknown.join(', ')}.`);
    conversations = ids ? all.filter((c) => ids.includes(c.id)) : all;
    if (name === 'rules')
      throw new Error(
        'The phrase rules have no recorded outcomes for the timed conversations: they run in Rust and have not been replayed on these. Use --set with one of the three case sets, or another evaluator.',
      );
  }
  if (!evaluator) {
    if (!Object.hasOwn(evaluators, name))
      throw new Error(
        `Unknown evaluator. Choose one of: ${[...Object.keys(evaluators), 'rules'].join(', ')}.`,
      );
    evaluator = evaluators[name]();
  }
  const most = [];
  for (const conversation of conversations)
    most.push(await maxEvaluations(conversation, options));
  const mostTotal = most.reduce((a, b) => a + b, 0);

  if (!flags['--run']) {
    print('Dry run. No process was started and nothing was sent.');
    print(`Evaluator: ${evaluator.label}.`);
    print(
      `Settings: evaluate on a new line, at least ${options.minGapMs} ms apart; a line reaches the evaluator ${options.transcriptDelayMs} ms after it is said; input "${options.input}"; each request holds the newest ${CONTEXT_LINES} lines and the cue on screen.`,
    );
    for (const [i, conversation] of conversations.entries())
      print(
        `  ${conversation.id}: ${conversation.lines.length} lines over ${Math.round(conversation.lines.at(-1).atMs / 1000)} s, at most ${most[i]} evaluations`,
      );
    print(
      `At most ${mostTotal} evaluations in all. A slow evaluator makes fewer, because lines arriving while a request is in flight share one catch-up.`,
    );
    if (evaluator.hosted) {
      print(
        `A run sends the lines of these fictional conversations, a few at a time as they are "heard", off this device to ${evaluator.destination}. That is hosted inference and uses the subscription's shared allowance. No API key is used or accepted. Before the first request it makes 2 local CLI checks that send no text.`,
      );
      print(
        `System prompt:\n${systemPromptFor({ userName: options.input === 'named' ? 'x' : null })}`,
      );
      print(
        `To run it, after checking that paid extra usage is off and with the owner's go-ahead for this run:\n  npm run lab:sim -- ${flags['--set'] ? `--set ${flags['--set']}` : `--conversations ${conversations.map((c) => c.id).join(',')}`} --run --out <directory outside the repository> --max-calls ${mostTotal} --included-usage-confirmed`,
      );
    } else
      print(
        'A run evaluates on this device. No model, account or network is used.',
      );
    return null;
  }
  let maxCalls;
  if (evaluator.hosted) {
    if (!flags['--included-usage-confirmed'])
      throw new Error(
        'A hosted run needs --included-usage-confirmed, after checking in the Claude account that paid extra usage is off. Nothing was started.',
      );
    if (flags['--max-calls'] === undefined)
      throw new Error(
        'A hosted run needs a call cap: --max-calls <number>. Nothing was started.',
      );
    maxCalls = callCap(flags['--max-calls']);
    if (mostTotal > maxCalls)
      throw new Error(
        `This run could need ${mostTotal} model requests and the cap is ${maxCalls}. Choose fewer conversations or raise the cap. Nothing was started.`,
      );
  }
  const directory = outputDirectory(flags['--out'], environment);
  const base = join(
    directory,
    `cue-sim-${source.replace(':', '-')}-${evaluator.id}-${stamp(now())}`,
  );
  const log = createRunLog(`${base}.log.jsonl`, now);
  const results = await runSimulation({
    source,
    conversations,
    evaluator,
    options,
    maxCalls,
    log,
    now,
  });
  writeFileSync(`${base}.json`, `${JSON.stringify(results, null, 2)}\n`);
  describeTotals(results, print);
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
