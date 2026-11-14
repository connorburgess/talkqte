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
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GLANCE_WORDS } from './cue-lab.mjs';
import {
  CUE_BUDGET_MS,
  MAX_CALLS_CEILING,
  callCap,
  requireCap,
} from './cue-lab-batch.mjs';
import {
  CUE_LIFETIME_MS,
  EVALUATORS,
  createEvaluator,
  isHosted,
  labelsEvaluator,
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

export { CUE_LIFETIME_MS, labelsEvaluator };
/** The evaluator sees this many recent lines, as the engine's bridge does. */
export const CONTEXT_LINES = 6;
export const DEFAULTS = {
  // Evaluate only on a new line, and never sooner than this after the last
  // evaluation started.
  minGapMs: 2_000,
  // Stands in for local transcription: a line reaches the evaluator this
  // long after it was said (measured median 3.13 s; see docs/budgets.md).
  transcriptDelayMs: 3_000,
  // 'app': one speaker label for every line, as a live transcript has.
  // 'named': speaker names as well, to see what they add.
  input: 'app',
  // false: a decision overtaken by newer speech is dropped, as in the app.
  applyStale: false,
  // true: a bare acknowledgement ("Mm.", "Yeah.") neither starts an
  // evaluation nor overtakes one in flight. The app does not do this yet.
  ignoreBackchannels: true,
  // true: each request lists the cues this session already showed and how
  // each ended. The app's bridge does not send this yet.
  cueHistory: true,
  // true: the listener's name is sent where the conversation has one, as
  // the app's session name. The app's bridge leaves it out today.
  listenerName: true,
};
/** How many earlier cues a request lists. */
export const HISTORY_CUES = 4;

// Words that, alone, only tell a speaker they are being followed.
const ACKNOWLEDGEMENTS = new Set(
  'mm mhm mm-hm mm-hmm hmm hm uh-huh yeah yes yep yup right ok okay sure exactly totally true agreed cool nice great fine oh ah ha'.split(
    ' ',
  ),
);

/** A bare acknowledgement: one to three words, each of them one of a short
 * list, not a question, and not said in reply to a question. "Yeah." and
 * "Mm-hm, right." are; "Yeah, I'll do it", "Right?" and "Okay, next item"
 * are not, and neither is "Yeah." straight after "Are we done?", which is
 * an answer. Deliberately narrow: a line wrongly taken for one would delay
 * a decision about real speech. */
export function isBackchannel(text, previous = '') {
  if (text.includes('?') || previous.trim().endsWith('?')) return false;
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return (
    tokens.length >= 1 &&
    tokens.length <= 3 &&
    tokens.every((token) => ACKNOWLEDGEMENTS.has(token))
  );
}
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

/** What the evaluator is given for one decision: the lines in view, the
 * cue on screen, and (in named input only) the listener's name. */
function testCaseFor(
  conversation,
  lines,
  cue,
  { input, listenerName },
  finalLine = false,
  earlierCues = [],
) {
  return {
    id: conversation.id,
    finalLine,
    events: lines.map((line) => ({
      id: line.id,
      speaker: input === 'named' ? line.speaker : 'Speaker',
      text: line.text,
    })),
    existingCue: cue && { text: cue.text, sourceIds: cue.sourceIds },
    // The listener's own name, as the app's session name.
    ...(listenerName && conversation.listener
      ? { userName: conversation.listener }
      : {}),
    // Cues this session already showed, and how each ended.
    ...(earlierCues.length ? { earlierCues } : {}),
  };
}

/** The system prompts a run over these conversations would use, exactly
 * as the evaluator gives them for each one. */
function systemPrompts(conversations, evaluator, settings) {
  // A request that lists earlier cues carries one more sentence.
  const histories = settings.cueHistory
    ? [[], [{ text: 'An earlier cue.', state: 'expired' }]]
    : [[]];
  return [
    ...new Set(
      conversations
        .flatMap((c) =>
          histories.map(
            (earlier) =>
              evaluator.request(
                testCaseFor(
                  c,
                  c.lines.slice(0, 1),
                  null,
                  settings,
                  false,
                  earlier,
                ),
              ).systemPrompt,
          ),
        )
        .filter(Boolean),
    ),
  ];
}

// Names a request by everything it carries, so a decision is only ever
// reused for the same prompt and the same input.
const requestKey = ({ systemPrompt, input }) =>
  createHash('sha256')
    .update(`${systemPrompt ?? ''}\n${input ?? ''}`)
    .digest('hex')
    .slice(0, 24);

/** The completed decisions in an earlier run's event log, by the request
 * that produced each. Only logs of the same evaluator are accepted. */
export function reusableDecisions(logText, evaluator) {
  const events = logText
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const run = events.find((event) => event.type === 'run-start');
  if (run?.kind !== 'simulation' || run.evaluator !== evaluator.id)
    throw new Error(
      'That log is not from a simulation with this evaluator, so nothing in it can be reused.',
    );
  // Older logs name the run's prompts once; later ones name each request.
  const only = run.systemPrompts?.length === 1 ? run.systemPrompts[0] : null;
  const reusable = new Map();
  let open = null;
  for (const event of events) {
    if (event.type === 'sim-evaluation-start') open = event;
    else if (
      event.type === 'sim-decision' &&
      open &&
      open.conversation === event.conversation &&
      open.lineId === event.lineId
    ) {
      const key =
        open.request ??
        (only === null
          ? null
          : requestKey({ systemPrompt: only, input: open.input }));
      if (key && event.latency === 'measured')
        reusable.set(key, {
          decision: {
            action: event.action,
            cue: event.cue,
            sourceIds: event.sourceIds,
            reason: event.reason,
            observedUse: event.observedUse,
          },
          elapsedMs: event.latencyMs,
          latency: event.latency,
          usage: event.usage ?? undefined,
          provider: event.provider ?? undefined,
        });
      open = null;
    }
  }
  return reusable;
}

/** Answers from an earlier run where the request is identical, and asks
 * the evaluator only for the rest. A reused decision is not a new request. */
export function resumingEvaluator(evaluator, reusable) {
  return {
    ...evaluator,
    cached: (testCase) => reusable.get(requestKey(evaluator.request(testCase))),
    async decide(testCase) {
      const earlier = reusable.get(requestKey(evaluator.request(testCase)));
      return earlier
        ? { ...earlier, reused: true }
        : evaluator.decide(testCase);
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
    ignoreBackchannels = DEFAULTS.ignoreBackchannels,
    cueHistory = DEFAULTS.cueHistory,
    listenerName = DEFAULTS.listenerName,
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
  let seeded = false;
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
  // What this session has shown and how each cue ended, newest last.
  const earlier = [];
  const clear = (atMs, why, lineId = null) => {
    emit('cue-cleared', atMs, {
      cueId: cue.cueId,
      why,
      lineId,
      visibleMs: atMs - cue.shownAtMs,
    });
    // "withdraw" is the action; "withdrawn" is how the cue ended.
    earlier.push({
      text: cue.text,
      state: why === 'withdraw' ? 'withdrawn' : why,
    });
    cue = null;
  };

  const start = async (atMs) => {
    const newest = heard.at(-1);
    waiting = false;
    wakeAt = null;
    const recent = heard.slice(-CONTEXT_LINES);
    // The cue's own lines stay in view even when older than the window.
    const cited = (cue?.sourceIds ?? [])
      .map((id) => byId.get(id))
      .filter((line) => !recent.includes(line));
    const testCase = testCaseFor(
      conversation,
      [...cited, ...recent],
      cue,
      { input, listenerName },
      newest === lines.at(-1),
      cueHistory ? earlier.slice(-HISTORY_CUES) : [],
    );
    // A decision carried over from an earlier run is not a new request and
    // does not count against the cap.
    const reused = Boolean(evaluator.cached?.(testCase));
    if (!reused && calls.count >= maxCalls) {
      capped = true;
      emit('evaluation-skipped', atMs, { lineId: newest.id, why: 'call-cap' });
      return;
    }
    if (!reused) calls.count++;
    lastStart = atMs;
    // The adapter's own account of what this request carries.
    const request = evaluator.request(testCase);
    emit('evaluation-start', atMs, {
      lineId: newest.id,
      call: reused ? null : calls.count,
      reused,
      existingCueId: cue?.cueId ?? null,
      request: requestKey(request),
      input: request.input,
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
      reused: Boolean(result.reused),
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
      if (seed && !seeded && seed.sourceIds.at(-1) === line.id) {
        // The fixture's cue is given, not decided: no evaluation here.
        seeded = true;
        if (!cue) show(atMs, seed.text, seed.sourceIds, line.id, 'fixture');
      } else if (capped) {
        emit('evaluation-skipped', atMs, { lineId: line.id, why: 'call-cap' });
      } else if (
        ignoreBackchannels &&
        isBackchannel(line.text, heard.at(-2)?.text)
      ) {
        // An acknowledgement says nothing new: it starts no evaluation and
        // leaves a decision in flight alone. Later requests still hold it.
        emit('evaluation-skipped', atMs, {
          lineId: line.id,
          why: 'backchannel',
        });
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
        // A moment with an ending line is open until that line is the
        // newest heard; whether the cue then came in time is judged below
        // by the clock. One without is open while a cue could still live.
        (o.until
          ? at < index.get(o.until)
          : trigger.arrivesAtMs < o.closesAtMs),
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

  // A flip: the evaluator showed a cue and then took it back, with no line
  // heard by then that is labelled as a reason to withdraw that cue.
  const flips = shown.filter((event) => {
    const end = cleared.get(event.cueId);
    if (event.origin !== 'evaluator' || end?.why !== 'withdraw') return false;
    const moment = opportunities.find((o) => o.cueId === event.cueId)?.lineId;
    return !lines.some(
      (other) =>
        other.expect === 'withdraw' &&
        other.of === moment &&
        index.get(other.id) <= index.get(end.lineId),
    );
  }).length;

  // A decision can come a line or two after the line it is about. On a
  // quiet line, showing the cue for a moment that is still open, or clearing
  // a cue after the line labelled as ending it, is catching up, not a
  // broken quiet.
  const starts = new Map(
    events('evaluation-start').map((event) => [event.lineId, event]),
  );
  const catchingUp = (item, decision) => {
    const here = index.get(item.id);
    if (decision.action === 'show')
      return opportunities.some(
        (o) =>
          index.get(o.lineId) < here &&
          (o.until
            ? here < index.get(o.until)
            : item.arrivesAtMs < o.closesAtMs),
      );
    const cueId = starts.get(item.id)?.existingCueId;
    const moment =
      cueId === seeded?.cueId
        ? 'seed'
        : opportunities.find((o) => o.cueId === cueId)?.lineId;
    return lines.some(
      (other) =>
        other.expect === decision.action &&
        other.of === moment &&
        index.get(other.id) < here,
    );
  };
  const quietLines = lines.filter((item) => item.expect === 'quiet');
  const quietDecisions = quietLines
    .map((item) => [item, decisions.find((d) => d.lineId === item.id)])
    .filter(
      ([item, decision]) =>
        decision &&
        (decision.action === 'quiet' || !catchingUp(item, decision)),
    )
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
      skippedBackchannel: count(
        events('evaluation-skipped'),
        (e) => e.why === 'backchannel',
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
    // The glance test: how many words each cue on screen had, and how many
    // had more than a glance allows.
    cueWords: shown
      .filter((e) => e.origin === 'evaluator')
      .map((e) => e.text.trim().split(/\s+/).length),
    cuesOverGlance: count(
      shown,
      (e) =>
        e.origin === 'evaluator' &&
        e.text.trim().split(/\s+/).length > GLANCE_WORDS,
    ),
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
    cuesOverGlance: sum((s) => s.cuesOverGlance),
    longestCueWords: Math.max(0, ...scores.flatMap((s) => s.cueWords)),
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
    request: () => ({ systemPrompt: null, input: null }),
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
  requireCap(evaluator, maxCalls);
  const hosted = isHosted(evaluator);
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
    hosted,
    destination: evaluator.destination ?? null,
    conversationIds: conversations.map(({ id }) => id),
    settings,
    maxCalls: maxCalls ?? null,
    systemPrompts: systemPrompts(conversations, evaluator, settings),
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
    stopped = {
      afterCalls: calls.count,
      reason: error.message,
      category: error.category ?? null,
      exitCode: error.exitCode ?? null,
    };
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
      hosted,
      ...facts,
    },
    settings,
    maxCalls: maxCalls ?? null,
    calls: calls.count,
    stopped,
    // Decisions carried over from an earlier run instead of asked again.
    reused: replays.reduce(
      (sum, replay) =>
        sum +
        replay.timeline.filter((e) => e.type === 'decision' && e.reused).length,
      0,
    ),
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

/** What the budget allows, worked out offline: for each transcription
 * delay and decision time, how many of the labelled moments an evaluator
 * that agreed with every label would cue in time, and how many of those
 * cues would be on screen within the budget of the line being said. */
export async function budgetTable({
  delays = [0, 1_000, 2_000, 3_000],
  decisions = [500, 1_000, 2_000, 3_000, 4_000],
} = {}) {
  const conversations = await loadConversations();
  const rows = [];
  for (const transcriptDelayMs of delays)
    for (const decisionMs of decisions) {
      const results = await runSimulation({
        source: 'conversations',
        conversations,
        evaluator: labelsEvaluator(conversations, { latencyMs: decisionMs }),
        options: { transcriptDelayMs },
      });
      const after = results.conversations.flatMap((c) => c.metrics.afterSaidMs);
      rows.push({
        transcriptDelayMs,
        decisionMs,
        moments: results.totals.opportunities.labelled,
        inTime: results.totals.opportunities.inTime,
        shown: after.length,
        withinBudget: after.filter((ms) => ms <= CUE_BUDGET_MS).length,
        medianMs: results.totals.triggerToCue?.medianMs ?? null,
      });
    }
  return rows;
}

function describeBudget(rows, print) {
  print(
    `What the ${CUE_BUDGET_MS / 1000}-second budget allows, worked out offline. Nothing was started.\nAn evaluator that agreed with every label, over the ${rows[0].moments} labelled moments of the bundled conversations:\n`,
  );
  print('transcription  decision  cued in time  on screen within 5 s  median');
  for (const row of rows)
    print(
      `${`${row.transcriptDelayMs / 1000} s`.padEnd(14)} ${`${row.decisionMs / 1000} s`.padEnd(9)} ${String(row.inTime).padStart(4)} of ${row.moments}    ${String(row.withinBudget).padStart(4)} of ${String(row.shown).padEnd(13)} ${row.medianMs === null ? '' : `${(row.medianMs / 1000).toFixed(1)} s`}`,
    );
  print(
    "\nArithmetic on invented conversations and the lab lane's own labels, with assumed delays. It shows what a pair of delays cannot do; it does not show what a real evaluator would do.",
  );
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
    evaluators = EVALUATORS,
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
      '--latency-ms',
      '--input',
      '--prompt',
      '--resume',
    ],
    switches: [
      '--run',
      '--included-usage-confirmed',
      '--apply-stale',
      '--overtake-backchannels',
      '--no-cue-history',
      '--no-listener-name',
      '--budget',
      '--coverage',
    ],
  });
  if (flags['--budget']) {
    describeBudget(await budgetTable(), print);
    return null;
  }
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
    ignoreBackchannels: !flags['--overtake-backchannels'],
    cueHistory: !flags['--no-cue-history'],
    listenerName: !flags['--no-listener-name'],
  };
  if (!['app', 'named'].includes(options.input))
    throw new Error('--input is app or named.');
  // A cue here goes on a card, so the simulation asks for cues that can be
  // read at a glance unless told to use the recorded trials' prompt.
  const prompt = flags['--prompt'] ?? 'glance';
  if (!['recorded', 'glance'].includes(prompt))
    throw new Error('--prompt is recorded or glance.');
  options.prompt = prompt;
  if (flags['--set'] && flags['--conversations'])
    throw new Error('Choose --set or --conversations, not both.');
  const name = flags['--evaluator'] ?? 'claude';
  let source;
  let conversations;
  let rules = null;
  if (flags['--set']) {
    const set = await loadSet(flags['--set']);
    source = `set:${set.name}`;
    conversations = set.cases.map((item) =>
      conversationFromCase(item, set.name),
    );
    rules = await loadRulesOutcomes(set.name);
  } else {
    source = 'conversations';
    const all = await loadConversations();
    const ids = flags['--conversations']?.split(',');
    const unknown = (ids ?? []).filter((id) => !all.some((c) => c.id === id));
    if (unknown.length)
      throw new Error(`Unknown fictional conversation: ${unknown.join(', ')}.`);
    conversations = ids ? all.filter((c) => ids.includes(c.id)) : all;
  }
  const latencyMs =
    flags['--latency-ms'] === undefined
      ? undefined
      : wholeNumber('--latency-ms', flags['--latency-ms']);
  if (latencyMs !== undefined && !['labels', 'fake'].includes(name))
    throw new Error(
      '--latency-ms sets the made-up delay of the labels or fake evaluator only.',
    );
  let evaluator = createEvaluator(
    name,
    {
      environment,
      rules,
      conversations,
      latencyMs,
      glance: prompt === 'glance',
    },
    evaluators,
  );
  // The rules' record is one outcome per case, given at its last line.
  if (evaluator.kind === 'rules') evaluator = finalOutcomeEvaluator(evaluator);
  const hosted = isHosted(evaluator);
  // Decisions already made in an earlier run are not asked for again.
  let carried = 0;
  if (flags['--resume']) {
    const reusable = reusableDecisions(
      readFileSync(flags['--resume'], 'utf8'),
      evaluator,
    );
    carried = reusable.size;
    evaluator = resumingEvaluator(evaluator, reusable);
  }
  const most = [];
  for (const conversation of conversations)
    most.push(await maxEvaluations(conversation, options));
  const mostTotal = most.reduce((a, b) => a + b, 0);

  // The same selection and settings, for the command a dry run suggests.
  const chosen = [
    flags['--set']
      ? `--set ${flags['--set']}`
      : `--conversations ${conversations.map((c) => c.id).join(',')}`,
    ...['--input', '--min-gap-ms', '--transcript-delay-ms']
      .filter((flag) => flags[flag] !== undefined)
      .map((flag) => `${flag} ${flags[flag]}`),
    ...[
      '--apply-stale',
      '--overtake-backchannels',
      '--no-cue-history',
      '--no-listener-name',
    ].filter((flag) => flags[flag]),
    ...['--prompt', '--resume']
      .filter((flag) => flags[flag] !== undefined)
      .map((flag) => `${flag} ${flags[flag]}`),
  ].join(' ');

  if (!flags['--run']) {
    print('Dry run. No process was started and nothing was sent.');
    print(`Evaluator: ${evaluator.label}.`);
    print(
      `Settings: evaluate on a new line, at least ${options.minGapMs} ms apart; a line reaches the evaluator ${options.transcriptDelayMs} ms after it is said; input "${options.input}"; each request holds the newest ${CONTEXT_LINES} lines and the cue on screen${options.listenerName ? ", the listener's name where the conversation has one" : ''}${options.cueHistory ? `, and up to ${HISTORY_CUES} cues already shown with how each ended` : ''}. ${options.ignoreBackchannels ? 'A bare acknowledgement ("Mm.", "Yeah.") starts no evaluation and does not overtake one in flight.' : 'Every line, even a bare acknowledgement, can overtake a decision in flight.'}`,
    );
    print(
      hosted
        ? `\nA run sends the lines below, a few at a time as they are "heard", off this device to ${evaluator.destination}. That is hosted inference and uses the subscription's shared allowance. No API key is used or accepted. Before the first request it makes 2 CLI checks (version and sign-in) that send no conversation text.`
        : '\nA run evaluates on this device. No model, account or network is used. These are the lines an evaluator would be given:',
    );
    print(
      'Every line as a request would carry it (ID, speaker label, text). Labels and conversation IDs are not sent.',
    );
    for (const [i, conversation] of conversations.entries()) {
      print(
        `\n${conversation.id}: ${conversation.lines.length} lines over ${Math.round(conversation.lines.at(-1).atMs / 1000)} s, at most ${most[i]} evaluations${options.listenerName && conversation.listener ? `; userName "${conversation.listener}"` : ''}`,
      );
      const sent = testCaseFor(
        conversation,
        conversation.lines,
        conversation.seedCue,
        options,
      );
      for (const event of sent.events)
        print(`  ${event.id}  ${event.speaker}: ${event.text}`);
      if (sent.existingCue)
        print(
          `  cue on screen from ${sent.existingCue.sourceIds.join(', ')}: ${sent.existingCue.text}`,
        );
    }
    print(
      `\nEach request also carries the cue on screen at that moment: its text and the IDs of the lines it cites. A cue the evaluator wrote in an earlier reply is therefore sent back to it.`,
    );
    print(
      `At most ${mostTotal} evaluations in all. A slow evaluator makes fewer, because lines arriving while a request is in flight share one catch-up.`,
    );
    if (flags['--resume'])
      print(
        `${carried} completed decisions from the earlier run can be reused. One is reused only where the prompt and the request are identical to the earlier ones; those are not sent again and do not count against the cap.`,
      );
    for (const prompt of systemPrompts(conversations, evaluator, options))
      print(`\nSystem prompt:\n${prompt}`);
    if (!hosted)
      print(
        `\nTo run it:\n  npm run lab:sim -- ${chosen} --evaluator ${name}${latencyMs === undefined ? '' : ` --latency-ms ${latencyMs}`} --run --out <directory outside the repository>`,
      );
    else if (mostTotal > MAX_CALLS_CEILING)
      print(
        `\nThis selection could need ${mostTotal} requests, more than the ${MAX_CALLS_CEILING} one invocation allows. Split it: choose fewer conversations with --conversations.`,
      );
    else
      print(
        `\nTo run it, after checking that paid extra usage is off and with the owner's go-ahead for this run:\n  npm run lab:sim -- ${chosen} --run --out <directory outside the repository> --max-calls ${mostTotal} --included-usage-confirmed`,
      );
    return null;
  }
  let maxCalls;
  // Anything not explicitly on-device needs the acknowledgement and a cap.
  if (hosted) {
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
