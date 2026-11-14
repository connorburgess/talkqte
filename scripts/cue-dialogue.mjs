// Dialogue lab: generated, branching conversations in which a simulated
// listener responds to the cues it actually saw in time. A generator writes
// a brief; the cast and the listener speak turn by turn; the lab's own cue
// evaluator watches the transcript under cue-sim's timing model; and at the
// first listener turn where a cue could change what the listener is given,
// the conversation forks into branches: A with the evaluator's cues, B with
// none, and optionally C with an irrelevant placebo card. A judge that is
// never told which branch it reads checks each against the brief's
// pre-registered criteria.
//
//   node scripts/cue-dialogue.mjs                       (dry run: nothing sent)
//   node scripts/cue-dialogue.mjs --run --agents fake --max-calls 200 --out <dir>
//   node scripts/cue-dialogue.mjs --replay <results.json> --run --agents fake \
//     --max-calls 200 --out <dir>
//
// The clock is simulated. A simulated listener changing course is not a
// user outcome; see docs/cue-dialogue.md.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { EFFORTS, modelFor } from './cue-lab.mjs';
import {
  claudeEvaluator,
  createEvaluator,
  isHosted as evaluatorHosted,
} from './cue-evaluators.mjs';
import {
  createRunLog,
  outputDirectory,
  parseFlags,
  percentile,
  stamp,
} from './cue-lab-output.mjs';
import {
  CUE_LIFETIME_MS,
  DEFAULTS as SIM_DEFAULTS,
  simulate,
} from './cue-sim.mjs';
import {
  DOMAINS,
  allNames,
  briefProblems,
  briefsFile,
  castView,
  judgeView,
  listenerView,
  loadFixtureBriefs,
} from './cue-dialogue-briefs.mjs';
import {
  PLANNED,
  REQUESTS,
  ROLE_EFFORTS,
  ROLE_MODELS,
  VALIDATE,
  claudeAgents,
  fakeAgents,
  isHosted,
} from './cue-dialogue-agents.mjs';
import { isMain } from './is-main.mjs';

export const SCHEMA = 'talkqte-cue-dialogue/1';
export const MAX_CALLS_CEILING = 300;
export const BRANCHES = {
  A: 'the cue evaluator’s cues',
  B: 'no assistance',
  C: 'an irrelevant placebo card at the time of A’s first card',
};
export const DEFAULTS = {
  // Turns in one branch, the cast's and the listener's together.
  maxTurns: 14,
  // After this many turns by others in a row, the listener may speak up.
  interjectEvery: 3,
  // Cards the listener will read in one conversation.
  glances: 3,
  // Spoken duration until a line is voiced.
  wordsPerMinute: 160,
  minTurnMs: 700,
  // Silence between turns; the listener decides at the start of a turn.
  turnGapMs: 500,
  // When the first turn starts.
  firstTurnMs: 1_000,
  branches: ['A', 'B'],
};
/** The settings that shape a conversation's turns; a replay must match. */
export const TURN_SETTINGS = [
  'maxTurns',
  'interjectEvery',
  'glances',
  'wordsPerMinute',
  'minTurnMs',
  'turnGapMs',
  'firstTurnMs',
];
/** Neutral cards for the placebo branch, unrelated to any brief. */
export const PLACEBO_CUES = [
  'The team offsite agenda is in the shared folder.',
  'Parking validation is at the front desk.',
  'Lunch orders for the office close at noon.',
  'The second-floor printer is working again.',
];
export const DEFAULT_PLAN = {
  scenarios: 2,
  domains: DOMAINS,
  open: 2,
  settled: 1,
  decoys: 1,
};
export const LIMITATIONS = [
  'Simulated people, not users. A simulated listener changing course says nothing about whether a real person would, or whether it helps them.',
  'One run per branch: a difference between branches can be sampling variation in the participants’ replies. Repeat runs before reading anything into it.',
  'The clock is simulated. Turn durations are estimated from word counts until voiced; the evaluator’s delay is its measured request time (or a made-up one for the fake), plus cue-sim’s fixed transcription delay.',
  'The judge reads transcripts only and is not told the branch, but a listener line can still give a branch away; such lines are flagged.',
  'The briefs, moments and criteria are written by a model (or, offline, by hand) and have not been reviewed by people.',
  'This informs which cue types and moments to test with people; it proves nothing about real usefulness.',
];

// FNV-1a, then a small PRNG, so a seed always gives the same choices.
function hash(text) {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    value = Math.imul(value ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return value;
}
export function random(seed) {
  let state = hash(String(seed)) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(items, next) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
const sha = (text) => createHash('sha256').update(text).digest('hex');
const requestKey = ({ systemPrompt, input }) =>
  sha(`${systemPrompt ?? ''}\n${input ?? ''}`).slice(0, 24);
const words = (text) => text.split(/\s+/).filter(Boolean).length;

/** Every agent, evaluator and generator call goes through one budget. It
 * refuses the call that would pass the cap, before it is made. */
export function createBudget(maxCalls) {
  return {
    maxCalls,
    count: 0,
    byRole: { generator: 0, cast: 0, listener: 0, evaluator: 0, judge: 0 },
    take(role) {
      if (this.count >= this.maxCalls)
        throw Object.assign(
          new Error(
            `The call cap of ${this.maxCalls} was reached before a ${role} call; the run stopped there.`,
          ),
          { category: 'call-cap' },
        );
      this.count++;
      this.byRole[role]++;
      return this.count;
    },
  };
}

/** The most calls a run can make, worked out before it starts. Per branch,
 * every turn costs one call, plus one open check per `interjectEvery`
 * turns by others; the evaluator asks at most once per line of branch A;
 * the judge reads each branch once. A shared prefix makes the real number
 * smaller. */
export function worstCaseCalls({ scenarios, generated, settings }) {
  const { maxTurns, interjectEvery, branches } = settings;
  const participants = maxTurns + Math.floor(maxTurns / interjectEvery);
  const perScenario =
    (generated ? 1 : 0) +
    branches.length * participants +
    maxTurns +
    branches.length;
  return scenarios * perScenario;
}

/** Calls one agent with its view, after taking a call from the budget.
 * Logs the exact request and reply; a failure or an unusable reply ends
 * the run (no retry). */
async function ask(context, agent, view, where) {
  const call = context.budget.take(agent.role);
  const request = agent.request(view);
  context.logPrompt(request.systemPrompt);
  context.log.write('request', {
    role: agent.role,
    call,
    ...where,
    systemPrompt: sha(request.systemPrompt).slice(0, 24),
    input: request.input,
  });
  context.onRequest?.({ role: agent.role, call, ...where, ...request });
  const result = await agent.reply(view, request);
  context.log.write('reply', {
    role: agent.role,
    call,
    ...where,
    elapsedMs: result.elapsedMs,
    latency: result.latency,
    usage: result.usage ?? null,
    value: result.value,
  });
  context.latencies.push({
    role: agent.role,
    elapsedMs: result.elapsedMs,
    latency: result.latency,
  });
  return VALIDATE[agent.role](result.value, view);
}

/** The lab's evaluator, asked through the budget, remembering each answer
 * by its exact request so the shared prefix is asked once. */
function countedEvaluator(evaluator, context, scenario) {
  const memo = new Map();
  return {
    ...evaluator,
    async decide(testCase) {
      const request = evaluator.request(testCase);
      const key = requestKey(request);
      if (memo.has(key)) return memo.get(key);
      const call = context.budget.take('evaluator');
      context.logPrompt(request.systemPrompt);
      context.log.write('request', {
        role: 'evaluator',
        call,
        scenario,
        systemPrompt: request.systemPrompt
          ? sha(request.systemPrompt).slice(0, 24)
          : null,
        input: request.input,
      });
      context.onRequest?.({ role: 'evaluator', call, scenario, ...request });
      const result = await evaluator.decide(testCase);
      context.log.write('reply', {
        role: 'evaluator',
        call,
        scenario,
        elapsedMs: result.elapsedMs,
        latency: result.latency,
        usage: result.usage ?? null,
        value: result.decision,
      });
      context.latencies.push({
        role: 'evaluator',
        elapsedMs: result.elapsedMs,
        latency: result.latency,
      });
      memo.set(key, result);
      return result;
    },
  };
}

// A cue source says which cards existed by a moment of the conversation:
//
//   cuesAt(lines, atMs)  every card shown at or before atMs, as
//                        { cueId, text, shownAtMs, clearedAtMs, origin },
//                        clearedAtMs null while it is still up at atMs
//   timeline             what to record for the branch (cue-sim events)
//
// The timing model asks the evaluator. A recorded source replays the cue
// events of a real app run instead, so the same listener can react to what
// the desktop app actually showed.

/** Cards from the lab's evaluator under cue-sim's timing model. At each
 * listener decision the simulation is rerun over the lines so far and
 * stopped before any evaluation that would start after that moment: such
 * an evaluation could only guess at speech not yet said, so asking it
 * would spend a call on a request that may never really be made. Events up
 * to the moment depend only on lines already said, so they are exact, and
 * every answer is remembered by its request, never asked twice. When a
 * branch is over, `cuesAt(lines, Infinity)` simulates it whole: nothing is
 * left to guess, and its starts include every one asked before, so the
 * evaluator is asked at most once per start of that one simulation. */
export function timingModelSource(evaluator, conversation, simSettings) {
  const beyond = Symbol('beyond the decision');
  const source = {
    kind: 'timing-model',
    timeline: [],
    async cuesAt(lines, atMs) {
      const events = [];
      let startedAt = -Infinity;
      // simulate logs each event as it happens, an evaluation's start just
      // before it asks; the timeline is rebuilt from that.
      const log = {
        write(type, { conversation: _, ...event }) {
          if (type === 'sim-evaluation-start') startedAt = event.atMs;
          events.push({ type: type.replace(/^sim-/, ''), ...event });
        },
      };
      const bounded = {
        ...evaluator,
        async decide(testCase) {
          if (startedAt > atMs) throw beyond;
          return evaluator.decide(testCase);
        },
      };
      try {
        await simulate(
          {
            ...conversation,
            lines: lines.map(({ id, atMs: endMs, speaker, text }) => ({
              id,
              atMs: endMs,
              speaker,
              text,
            })),
          },
          bounded,
          { ...simSettings, maxCalls: Infinity, calls: { count: 0 }, log },
        );
      } catch (error) {
        if (error !== beyond) throw error;
      }
      // Per-simulation counters mean nothing here; the run log has calls.
      source.timeline = events
        .filter((event) => event.atMs <= atMs)
        .map(({ call, reused, ...event }) => event);
      return cardsFrom(source.timeline, atMs);
    },
  };
  return source;
}

function cardsFrom(timeline, atMs) {
  const cards = [];
  for (const event of timeline) {
    if (event.atMs > atMs) continue;
    if (event.type === 'cue-shown')
      cards.push({
        cueId: event.cueId,
        text: event.text,
        shownAtMs: event.atMs,
        clearedAtMs: null,
        origin: event.origin,
        sourceIds: event.sourceIds ?? [],
      });
    else if (event.type === 'cue-cleared') {
      const card = cards.find((c) => c.cueId === event.cueId);
      if (card) card.clearedAtMs = event.atMs;
    }
  }
  return cards;
}

/** Cue events recorded from a real app run, already put on the
 * conversation's clock: [{ type: 'cue-shown', atMs, cueId, text } |
 * { type: 'cue-cleared', atMs, cueId }]. The lines play no part: the app
 * decided. */
export function recordedSource(events) {
  // In the shape the recorder's stage reads: sources (line ids, where the
  // log can name them) and when the card goes.
  const timeline = events.map((event) =>
    event.type === 'cue-shown'
      ? {
          ...event,
          origin: 'app',
          sourceIds: event.sourceIds ?? [],
          expiresAtMs:
            events.find(
              (other) =>
                other.type === 'cue-cleared' && other.cueId === event.cueId,
            )?.atMs ?? event.atMs + CUE_LIFETIME_MS,
        }
      : { ...event, origin: 'app' },
  );
  return {
    kind: 'recorded',
    timeline,
    async cuesAt(lines, atMs) {
      return cardsFrom(timeline, atMs);
    },
  };
}

export function placeboSource(text, shownAtMs, scenario) {
  const cueId = `${scenario}:placebo`;
  const timeline = [
    {
      type: 'cue-shown',
      atMs: shownAtMs,
      cueId,
      text,
      // It cites nothing: it is about nothing in the conversation.
      sourceIds: [],
      expiresAtMs: shownAtMs + CUE_LIFETIME_MS,
      origin: 'placebo',
    },
    {
      type: 'cue-cleared',
      atMs: shownAtMs + CUE_LIFETIME_MS,
      cueId,
      why: 'expired',
    },
  ];
  return {
    kind: 'placebo',
    timeline,
    async cuesAt(lines, atMs) {
      return cardsFrom(timeline, atMs);
    },
  };
}

export const noSource = () => ({
  kind: 'none',
  timeline: [],
  async cuesAt() {
    return [];
  },
});

/** What the listener hears: lines said while it was distracted are only
 * known to have been said. */
function heardBy(brief, lines) {
  const windows = brief.focus.distracted;
  return lines.map((line) =>
    line.speaker !== brief.focus.name &&
    windows.some((w) => line.startMs < w.toMs && line.atMs > w.fromMs)
      ? { id: line.id, speaker: line.speaker, missed: true }
      : { id: line.id, speaker: line.speaker, text: line.text },
  );
}

function newState(name, source, settings) {
  return {
    name,
    source,
    lines: [],
    steps: [],
    glancesLeft: settings.glances,
    earlierCards: [],
    reads: [],
    turnOf: null,
    castStreak: 0,
    clockMs: settings.firstTurnMs - settings.turnGapMs,
    ended: null,
  };
}

const clone = (state, name, source) => ({
  ...structuredClone({ ...state, source: null }),
  name,
  source,
});

function addLine(state, settings, speaker, text, by) {
  const startMs = state.clockMs + settings.turnGapMs;
  const durationMs = Math.max(
    settings.minTurnMs,
    Math.round((words(text) / settings.wordsPerMinute) * 60_000),
  );
  const line = {
    id: `t${state.lines.length + 1}`,
    speaker,
    text,
    startMs,
    durationMs,
    atMs: startMs + durationMs,
    by,
  };
  state.lines.push(line);
  state.clockMs = line.atMs;
  return line;
}

/** The card this branch offers the listener now, if any: one on screen at
 * the moment the listener's turn would start, not read before, and only
 * while glances remain. Returns what to record either way. */
async function cardFor(state, atMs) {
  const cards = await state.source.cuesAt(state.lines, atMs);
  const up = cards.filter(
    (card) =>
      card.shownAtMs <= atMs &&
      (card.clearedAtMs === null || card.clearedAtMs > atMs) &&
      !state.reads.some((read) => read.cueId === card.cueId),
  );
  const card = up.at(-1) ?? null;
  if (!card) return { card: null };
  if (state.glancesLeft <= 0) return { card: null, unread: card };
  return { card };
}

/** Runs one branch (or the shared prefix, `trunk`) until it ends. In the
 * trunk, the first listener decision at which branch A would hand the
 * listener a card returns { fork } instead, before anything is asked. */
async function runBranch(state, context, { trunk = false, script = [] } = {}) {
  const { brief, settings, agents } = context;
  const listener = brief.focus.name;
  const where = { scenario: brief.id, branch: trunk ? 'shared' : state.name };
  const nextStep = (kind) => {
    if (!trunk || !script.length) return null;
    const step = script.shift();
    if (step.kind !== kind)
      throw new Error(
        'The saved prefix does not match these settings: it was made with a different turn order. Nothing more was asked.',
      );
    return step;
  };
  for (;;) {
    if (state.lines.length >= settings.maxTurns) {
      state.ended = 'turn-limit';
      return {};
    }
    const atMs = state.clockMs + settings.turnGapMs;
    const mode =
      state.turnOf === listener
        ? 'floor'
        : state.castStreak >= settings.interjectEvery
          ? 'open'
          : null;
    if (mode) {
      const offer = await cardFor(state, atMs);
      if (trunk && offer.card)
        return { fork: { atMs, mode, card: offer.card } };
      if (offer.unread)
        state.reads.push({
          cueId: offer.unread.cueId,
          text: offer.unread.text,
          atMs,
          turn: state.lines.length + 1,
          state: 'glances-spent',
        });
      const view = {
        ...listenerView(brief),
        mode,
        transcript: heardBy(brief, state.lines),
        card: offer.card?.text ?? null,
        earlierCards: state.earlierCards,
      };
      const saved = nextStep('listener');
      const reply = saved
        ? VALIDATE.listener(saved.reply, view)
        : await ask(context, agents.listener, view, where);
      state.steps.push({ kind: 'listener', mode, atMs, reply });
      if (offer.card) {
        state.glancesLeft--;
        state.earlierCards.push(offer.card.text);
        state.reads.push({
          cueId: offer.card.cueId,
          text: offer.card.text,
          atMs,
          turn: state.lines.length + 1,
          origin: offer.card.origin,
          state: reply.card === 'used' ? 'read-used' : 'read-ignored',
          spoke: reply.speak,
        });
      }
      state.castStreak = 0;
      if (reply.speak) {
        addLine(state, settings, listener, reply.text, 'listener');
        state.turnOf = null;
        continue;
      }
    }
    const view = {
      ...castView(brief),
      transcript: state.lines.map(({ id, speaker, text }) => ({
        id,
        speaker,
        text,
      })),
      turnOf: state.turnOf === listener ? null : state.turnOf,
      turnsLeft: settings.maxTurns - state.lines.length,
    };
    const saved = nextStep('cast');
    const reply = saved
      ? VALIDATE.cast(saved.reply, view)
      : await ask(context, agents.cast, view, where);
    if (view.turnOf && reply.speaker !== view.turnOf)
      throw Object.assign(
        new Error(
          `The cast spoke as ${reply.speaker} when it had chosen ${view.turnOf}; the run stopped and did not retry.`,
        ),
        { category: 'invalid-reply' },
      );
    state.steps.push({ kind: 'cast', reply });
    addLine(state, settings, reply.speaker, reply.text, 'cast');
    state.castStreak++;
    state.turnOf = reply.next;
    if (reply.next === 'end') {
      state.ended = 'cast-ended';
      return {};
    }
  }
}

/** After a branch ends: every card that was shown but never offered to the
 * listener, and why. */
async function finishReads(state, settings) {
  const end = state.clockMs + settings.turnGapMs;
  // The whole branch, now that no more speech can come; this also leaves
  // the full cue timeline for the recording.
  const cards = await state.source.cuesAt(state.lines, Infinity);
  const listenerDecisions = state.steps
    .filter((step) => step.kind === 'listener')
    .map((step) => step.atMs);
  for (const card of cards)
    if (!state.reads.some((read) => read.cueId === card.cueId))
      state.reads.push({
        cueId: card.cueId,
        text: card.text,
        atMs: card.shownAtMs,
        origin: card.origin,
        state: 'never-offered',
        why:
          card.shownAtMs > end ||
          !listenerDecisions.some((at) => at >= card.shownAtMs)
            ? 'shown after the listener’s last turn'
            : 'cleared before the listener’s next turn',
      });
  state.reads.sort((a, b) => a.atMs - b.atMs);
}

const LEAK = /\b(?:card|cue|my screen|on screen|it says here|my notes say)\b/i;

/** One scenario: the shared prefix, the fork, each branch, and the judge.
 * Throws whatever an agent throws. */
export async function runScenario(brief, context, { prefix = null } = {}) {
  const { settings, rng } = context;
  const scenario = brief.id;
  const conversation = {
    id: scenario,
    listener: brief.focus.name,
    lines: [],
  };
  const evaluator = countedEvaluator(context.evaluator, context, scenario);
  const sourceA = () =>
    context.cueSource?.(brief) ??
    timingModelSource(evaluator, conversation, context.simSettings);
  const scoped = { ...context, brief };
  context.log.write('scenario-start', {
    scenario,
    source: prefix ? 'saved-prefix' : 'brief',
  });

  // The shared prefix runs with A's cards in view, to find the fork.
  const trunk = newState('shared', sourceA(), settings);
  const script = prefix ? structuredClone(prefix.steps) : [];
  const { fork } = await runBranch(trunk, scoped, { trunk: true, script });
  const savedPrefixUsed = prefix ? prefix.steps.length - script.length : 0;
  const prefixSteps = structuredClone(trunk.steps);
  let states;
  if (!fork) {
    await finishReads(trunk, settings);
    states = [trunk];
    context.log.write('no-fork', {
      scenario,
      reason:
        'No card reached the listener before one of their turns, so every branch is the same conversation.',
    });
  } else {
    context.log.write('fork', {
      scenario,
      atMs: fork.atMs,
      mode: fork.mode,
      turn: trunk.lines.length + 1,
      card: fork.card.text,
    });
    const placebo = PLACEBO_CUES[Math.floor(rng() * PLACEBO_CUES.length)];
    const sources = {
      A: () => trunk.source,
      B: noSource,
      C: () => placeboSource(placebo, fork.card.shownAtMs, scenario),
    };
    states = settings.branches.map((name) =>
      clone(trunk, name, sources[name]()),
    );
    for (const state of states) {
      await runBranch(state, scoped);
      await finishReads(state, settings);
      context.log.write('branch-end', {
        scenario,
        branch: state.name,
        turns: state.lines.length,
        ended: state.ended,
        reads: state.reads,
      });
    }
  }

  // The judge reads each distinct transcript once, in a shuffled order,
  // under a name that says nothing about its branch.
  const judged = new Map();
  for (const state of shuffle(states, rng)) {
    const transcriptId = `transcript-${Math.floor(rng() * 0xffffff)
      .toString(16)
      .padStart(6, '0')}`;
    const view = {
      ...judgeView(brief),
      transcript: state.lines.map(({ id, speaker, text }) => ({
        id,
        speaker,
        text,
      })),
    };
    const reply = await ask(context, context.agents.judge, view, {
      scenario,
      transcript: transcriptId,
    });
    judged.set(state.name, { transcriptId, verdicts: reply.verdicts });
    context.log.write('judged', {
      scenario,
      transcript: transcriptId,
      branch: state.name,
      verdicts: reply.verdicts,
    });
  }

  const branches = (
    fork ? states : settings.branches.map((name) => ({ ...trunk, name }))
  ).map((state) => {
    const judge = judged.get(fork ? state.name : 'shared');
    return {
      id: `${scenario}-${state.name.toLowerCase()}`,
      scenario,
      branch: state.name,
      assistance: BRANCHES[state.name],
      context: brief.domain,
      title: brief.title,
      setting: brief.setting,
      listener: brief.focus.name,
      // With the generator's casting, so voices and portraits never
      // guess from a name.
      participants: [brief.focus, ...brief.people].map(
        ({ name, role, casting }) => ({ name, role, casting }),
      ),
      lines: state.lines.map(({ by, ...line }) => ({
        ...line,
        arrivesAtMs: line.atMs + context.simSettings.transcriptDelayMs,
      })),
      timeline: fork || state.name === 'A' ? state.source.timeline : [],
      prefixTurns: fork ? trunk.lines.length : state.lines.length,
      ended: state.ended,
      listenerReads: fork ? state.reads : state.name === 'A' ? state.reads : [],
      mentionsCard: state.lines.some(
        (line) => line.speaker === brief.focus.name && LEAK.test(line.text),
      ),
      judge,
    };
  });
  const verdict = (branch, id) =>
    branch.judge.verdicts.find((v) => v.criterion === id)?.met ?? null;
  const comparison = brief.criteria.map(({ id, moment }) => ({
    criterion: id,
    moment,
    ...Object.fromEntries(branches.map((b) => [b.branch, verdict(b, id)])),
  }));
  const summary = {
    id: scenario,
    domain: brief.domain,
    title: brief.title,
    forked: Boolean(fork),
    fork: fork
      ? {
          atMs: fork.atMs,
          mode: fork.mode,
          turn: trunk.lines.length + 1,
          card: fork.card.text,
        }
      : null,
    prefix: {
      steps: prefixSteps,
      // So a replay can tell that the saved opening is the one this run had.
      sha256: sha(JSON.stringify(prefixSteps)),
      turns: trunk.lines.length,
      savedStepsUsed: savedPrefixUsed,
      savedStepsDropped: prefix ? script.length : 0,
    },
    comparison,
    differs: comparison
      .filter(
        (row) => row.A !== undefined && row.B !== undefined && row.A !== row.B,
      )
      .map((row) => row.criterion),
  };
  context.log.write('scenario-end', { scenario, summary });
  return { summary, branches };
}

/** How the run would play in real time, from the measured call times:
 * an other's turn can be generated while the line before it plays; a
 * listener decision needs the card state at its own moment, so its call
 * time is a pause unless it is generated ahead. */
export function realtime(latencies, branches) {
  const measured = latencies.filter((l) => l.latency === 'measured');
  if (!measured.length)
    return {
      measured: false,
      note: 'No call time was measured (offline fakes), so real-time play cannot be judged from this run.',
    };
  const of = (role) =>
    measured.filter((l) => l.role === role).map((l) => l.elapsedMs);
  const lines = branches.flatMap((b) => b.lines);
  const cast = of('cast');
  const durations = lines.map((line) => line.durationMs);
  return {
    measured: true,
    castMedianMs: percentile(cast, 0.5),
    castP95Ms: percentile(cast, 0.95),
    lineMedianMs: percentile(durations, 0.5),
    castFitsUnderPreviousLine:
      cast.length && percentile(cast, 0.95) <= percentile(durations, 0.5),
    listenerPauseMedianMs: percentile(of('listener'), 0.5),
    listenerPauseP95Ms: percentile(of('listener'), 0.95),
    evaluatorMedianMs: percentile(of('evaluator'), 0.5),
  };
}

function checkModels(models) {
  for (const [role, name] of Object.entries(models))
    if (role !== 'evaluator' && !Object.hasOwn(ROLE_MODELS, name))
      throw new Error(
        `Unknown ${role} model. Choose one of: ${Object.keys(ROLE_MODELS).join(', ')}.`,
      );
  modelFor(models.evaluator);
  const distinct = [models.participants, models.evaluator, models.judge];
  if (new Set(distinct).size !== 3)
    throw new Error(
      'The participants, the cue evaluator and the judge must each use a different model, so no model grades its own kind of output.',
    );
  return models;
}

/** One run: freeze the briefs (generated, or from a saved run), then each
 * scenario in turn. Stops at the first failure or at the cap and returns
 * everything that completed. */
export async function runDialogue({
  agents,
  evaluator,
  plan = DEFAULT_PLAN,
  settings: given = {},
  simSettings: simGiven = {},
  seed = 'dialogue',
  maxCalls,
  replay = null,
  cueSource = null,
  log = createRunLog(null),
  onBriefs = () => null,
  onRequest,
  now = () => new Date(),
}) {
  const settings = { ...DEFAULTS, ...given };
  const simSettings = { ...SIM_DEFAULTS, ...simGiven };
  if (!settings.branches.includes('A') || !settings.branches.includes('B'))
    throw new Error('A run needs branches A and B; C is optional.');
  // A saved prefix fits only the settings that shaped its turns.
  for (const key of TURN_SETTINGS)
    if (replay && replay.settings?.[key] !== settings[key])
      throw new Error(
        `A replay must use the saved run's ${key} (${replay.settings?.[key]}), or its prefix would not fit. Nothing was started.`,
      );
  const generated = !replay;
  const scenarios = replay ? replay.briefs.length : plan.scenarios;
  const worstCase = worstCaseCalls({ scenarios, generated, settings });
  if (
    !Number.isInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > MAX_CALLS_CEILING
  )
    throw new Error(
      `Every run needs --max-calls, a whole number from 1 to ${MAX_CALLS_CEILING}. Nothing was started.`,
    );
  if (worstCase > maxCalls)
    throw new Error(
      `This run could make up to ${worstCase} calls, more than the cap of ${maxCalls}. Raise the cap, or ask for fewer scenarios or turns. Nothing was started.`,
    );
  const budget = createBudget(maxCalls);
  const rng = random(seed);
  const prompts = new Set();
  const context = {
    agents,
    evaluator,
    settings,
    simSettings: { ...simSettings, input: 'app', listenerName: true },
    budget,
    rng,
    log,
    latencies: [],
    cueSource,
    onRequest,
    logPrompt(prompt) {
      if (!prompt) return;
      const key = sha(prompt).slice(0, 24);
      if (prompts.has(key)) return;
      prompts.add(key);
      log.write('system-prompt', { key, text: prompt });
    },
  };
  const describe = (agent) => ({
    id: agent.id,
    label: agent.label,
    kind: agent.kind,
    model: agent.model ?? null,
    effort: agent.effort ?? null,
    hosted: isHosted(agent),
    destination: agent.destination ?? null,
  });
  const roster = {
    ...Object.fromEntries(
      Object.entries(agents).map(([role, agent]) => [role, describe(agent)]),
    ),
    evaluator: {
      id: evaluator.id,
      label: evaluator.label,
      kind: evaluator.kind,
      model: evaluator.model ?? null,
      hosted: evaluatorHosted(evaluator),
      destination: evaluator.destination ?? null,
    },
  };
  log.write('run-start', {
    kind: 'dialogue',
    seed,
    plan: generated ? plan : null,
    replayOf: replay?.of ?? null,
    settings,
    simSettings: context.simSettings,
    agents: roster,
    maxCalls,
    worstCaseCalls: worstCase,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  });

  const briefs = [];
  const rejected = [];
  const scenarioResults = [];
  let stopped = null;
  let brief = null;
  const opened = [];
  try {
    for (const agent of [...new Set(Object.values(agents)), evaluator]) {
      opened.push(agent);
      log.write('agent-ready', { id: agent.id, ...(await agent.open()) });
    }
    if (replay) {
      // A saved brief is checked again, as it is, before it is used.
      for (const saved of replay.briefs) {
        const problems = briefProblems(saved, { source: replay.briefSource });
        if (problems.length)
          throw new Error(
            `Saved brief ${saved.id} is not usable: ${problems.join(' ')}`,
          );
        briefs.push(saved);
      }
    } else {
      const domains = shuffle(plan.domains, rng);
      for (let index = 0; index < plan.scenarios; index++) {
        const request = {
          domain: domains[index % domains.length],
          variation: Math.floor(rng() * 1e9),
          open: plan.open,
          settled: plan.settled,
          decoys: plan.decoys,
          people: '3 to 5 including the focus person',
        };
        const value = await ask(context, agents.generator, request, {
          scenario: `plan-${index + 1}`,
        });
        // A model's brief must follow the plan and may not carry an offline
        // block; only the fake's hand-written briefs are exempt.
        const problems = briefProblems(value, {
          plan: agents.generator.followsPlan === false ? null : request,
          source: agents.generator.briefSource ?? 'generated',
        });
        if (problems.length) {
          rejected.push({ index: index + 1, request, problems, brief: value });
          log.write('brief-rejected', { index: index + 1, problems });
        } else if (briefs.some((b) => b.id === value.id)) {
          rejected.push({
            index: index + 1,
            request,
            problems: ['Its id repeats an earlier brief in this run.'],
            brief: value,
          });
          log.write('brief-rejected', {
            index: index + 1,
            problems: ['repeated id'],
          });
        } else briefs.push(value);
      }
    }
    // Frozen before any conversation starts.
    brief = onBriefs(briefs) ?? null;
    log.write('briefs-frozen', {
      ids: briefs.map(({ id }) => id),
      file: brief?.file ?? null,
      sha256: brief?.sha256 ?? null,
    });
    for (const item of briefs)
      scenarioResults.push(
        await runScenario(item, context, {
          prefix: replay?.prefixes?.[item.id] ?? null,
        }),
      );
  } catch (error) {
    // Agents' messages never contain provider output or credentials.
    stopped = {
      afterCalls: budget.count,
      reason: error.message,
      category: error.category ?? null,
      exitCode: error.exitCode ?? null,
    };
    log.write('stopped', stopped);
  } finally {
    for (const agent of opened) await agent.close();
  }
  const branches = scenarioResults.flatMap((r) => r.branches);
  const results = {
    schema: SCHEMA,
    fictional: true,
    simulated: true,
    generated: generated && agents.generator.kind === 'model',
    createdAt: now().toISOString(),
    seed,
    plan: generated ? plan : null,
    replayOf: replay?.of ?? null,
    settings,
    simSettings: context.simSettings,
    agents: roster,
    maxCalls,
    worstCaseCalls: worstCase,
    calls: { total: budget.count, byRole: budget.byRole },
    stopped,
    brief,
    briefs,
    rejectedBriefs: rejected,
    scenarios: scenarioResults.map((r) => r.summary),
    branches,
    realtime: realtime(context.latencies, branches),
    limitations: LIMITATIONS,
  };
  log.write('run-end', { stopped, calls: results.calls });
  return results;
}

/** A saved run as a control: its frozen briefs and each scenario's shared
 * prefix, to replay with another evaluator, effort or policy. The settings
 * that shape turns must match, or the saved prefix would not fit. */
export function savedRun(results, briefsText, file) {
  if (results.schema !== SCHEMA || results.fictional !== true)
    throw new Error('That is not a dialogue lab results file.');
  if (!results.brief || sha(briefsText) !== results.brief.sha256)
    throw new Error(
      'The saved briefs file does not match the hash in the results file, so the run cannot be replayed.',
    );
  const { briefs } = JSON.parse(briefsText);
  for (const scenario of results.scenarios)
    if (
      !scenario.prefix?.sha256 ||
      sha(JSON.stringify(scenario.prefix.steps)) !== scenario.prefix.sha256
    )
      throw new Error(
        `The saved opening of ${scenario.id} does not match its hash, so the run cannot be replayed.`,
      );
  return {
    of: { file, sha256: results.brief.sha256, seed: results.seed },
    // Hand-written briefs carry the fakes' offline block; generated ones
    // never may.
    briefSource:
      results.agents?.generator?.kind === 'model' ? 'generated' : 'fixture',
    settings: results.settings,
    briefs,
    prefixes: Object.fromEntries(
      results.scenarios.map((s) => [s.id, s.prefix]),
    ),
  };
}

/** What can and cannot be concluded from one scenario, in plain words. */
export function reviewText(results, summary) {
  const branches = results.branches.filter((b) => b.scenario === summary.id);
  const fake = Object.values(results.agents).some((a) => a.kind !== 'model');
  const out = [];
  out.push(`# Dialogue lab review: ${summary.title} (${summary.id})`, '');
  out.push(
    `Fictional and simulated. Run ${results.createdAt}, seed \`${results.seed}\`. Agents: ${Object.entries(
      results.agents,
    )
      .map(([role, a]) => `${role} ${a.kind === 'model' ? a.model : 'fake'}`)
      .join(', ')}.`,
    '',
    '**A simulated listener changing course is not a user outcome.** At most this suggests which cue types and moments are worth testing with people.',
    '',
  );
  if (!summary.forked)
    out.push(
      '## Fork',
      '',
      'No card reached the listener before any of their turns, so the branches are one conversation. Nothing about cue influence can be concluded from this scenario.',
      '',
    );
  else
    out.push(
      '## Fork',
      '',
      `The branches share ${summary.prefix.turns} turns. At ${(summary.fork.atMs / 1000).toFixed(1)} s, turn ${summary.fork.turn} (${summary.fork.mode === 'floor' ? 'the listener had the floor' : 'the listener could speak up'}), branch A had the card "${summary.fork.card}".`,
      '',
    );
  out.push('## Cards and the listener', '');
  for (const branch of branches) {
    out.push(
      `- **${branch.branch}** (${branch.assistance}): ${branch.lines.length} turns, ended by ${branch.ended}.`,
    );
    for (const read of branch.listenerReads)
      out.push(
        `  - "${read.text}": ${read.state}${read.why ? `, ${read.why}` : ''}${read.state.startsWith('read') ? ` at turn ${read.turn}` : ''}.`,
      );
    if (branch.mentionsCard)
      out.push(
        '  - The listener mentions a card or screen; the judge may be able to tell this branch apart.',
      );
  }
  out.push('', '## Criteria', '');
  const names = branches.map((b) => b.branch);
  out.push(
    `| Criterion | Moment | ${names.join(' | ')} |`,
    `| --- | --- | ${names.map(() => '---').join(' | ')} |`,
  );
  for (const row of summary.comparison)
    out.push(
      `| ${row.criterion} | ${row.moment} | ${names.map((n) => row[n] ?? '–').join(' | ')} |`,
    );
  out.push('', '## What this can and cannot show', '');
  if (fake)
    out.push(
      '- Some agents were deterministic fakes. Their behavior is fixed by code, so these outcomes test the engine only and say nothing about cues.',
    );
  if (summary.forked && summary.differs.length)
    out.push(
      `- In this one run, ${summary.differs.join(', ')} differed between A and B. With one run per branch this may be sampling variation; it needs repeats before it means anything, and even then it is about a simulated listener.`,
    );
  else if (summary.forked)
    out.push(
      '- No criterion differed between A and B in this run: the card made no judged difference here.',
    );
  out.push(
    '- The judge did not know which branch it read. The criteria were fixed before the conversation began.',
    '- Nothing here shows that a real person would notice, read or act on a card, or that it would help them.',
  );
  return `${out.join('\n')}\n`;
}

function agentsFor(name, briefs, { models, efforts, environment, run } = {}) {
  if (name === 'fake') return fakeAgents(briefs);
  if (name === 'claude')
    return claudeAgents({
      models: {
        generator: models.generator,
        cast: models.participants,
        listener: models.participants,
        judge: models.judge,
      },
      efforts,
      environment,
      run,
    });
  throw new Error('Unknown --agents. Choose claude or fake.');
}

const whole = (flag, value, fallback, min = 1, max = 1_000) => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < min || number > max)
    throw new Error(`${flag} must be a whole number from ${min} to ${max}.`);
  return number;
};

export async function main(
  args,
  {
    environment = process.env,
    print = console.log,
    // What starts the Claude Code CLI; tests pass a stand-in.
    run,
  } = {},
) {
  const flags = parseFlags(args, {
    values: [
      '--agents',
      '--scenarios',
      '--domains',
      '--open',
      '--settled',
      '--decoys',
      '--seed',
      '--branches',
      '--max-turns',
      '--interject-every',
      '--glances',
      '--max-calls',
      '--out',
      '--replay',
      '--latency-ms',
      '--participant-model',
      '--evaluator-model',
      '--judge-model',
      '--generator-model',
      '--generator-effort',
      '--participant-effort',
      '--evaluator-effort',
      '--judge-effort',
    ],
    switches: ['--run', '--included-usage-confirmed'],
  });
  const fixtures = await loadFixtureBriefs();
  const domains = flags['--domains']?.split(',') ?? DOMAINS;
  if (!domains.length || !domains.every((d) => DOMAINS.includes(d)))
    throw new Error(
      `--domains takes a comma-separated list of ${DOMAINS.join(', ')}.`,
    );
  const plan = {
    scenarios: whole(
      '--scenarios',
      flags['--scenarios'],
      DEFAULT_PLAN.scenarios,
      1,
      10,
    ),
    domains,
    open: whole('--open', flags['--open'], DEFAULT_PLAN.open, 0, 4),
    settled: whole('--settled', flags['--settled'], DEFAULT_PLAN.settled, 0, 3),
    decoys: whole('--decoys', flags['--decoys'], DEFAULT_PLAN.decoys, 0, 3),
  };
  const branches = (flags['--branches'] ?? 'AB').split('');
  if (!['AB', 'ABC'].includes(branches.join('')))
    throw new Error('--branches is AB or ABC.');
  const settings = {
    ...DEFAULTS,
    branches,
    maxTurns: whole(
      '--max-turns',
      flags['--max-turns'],
      DEFAULTS.maxTurns,
      2,
      40,
    ),
    interjectEvery: whole(
      '--interject-every',
      flags['--interject-every'],
      DEFAULTS.interjectEvery,
      1,
      10,
    ),
    glances: whole('--glances', flags['--glances'], DEFAULTS.glances, 0, 10),
  };
  const models = checkModels({
    generator: flags['--generator-model'] ?? PLANNED.generator.model,
    participants: flags['--participant-model'] ?? PLANNED.cast.model,
    evaluator: flags['--evaluator-model'] ?? PLANNED.evaluator.model,
    judge: flags['--judge-model'] ?? PLANNED.judge.model,
  });
  const effortFlag = (flag, fallback, allowed) => {
    const effort = flags[flag] ?? fallback;
    if (!allowed.includes(effort))
      throw new Error(`${flag} is one of: ${allowed.join(', ')}.`);
    return effort;
  };
  const participantEffort = effortFlag(
    '--participant-effort',
    PLANNED.cast.effort,
    ROLE_EFFORTS,
  );
  const efforts = {
    generator: effortFlag(
      '--generator-effort',
      PLANNED.generator.effort,
      ROLE_EFFORTS,
    ),
    cast: participantEffort,
    listener: participantEffort,
    judge: effortFlag('--judge-effort', PLANNED.judge.effort, ROLE_EFFORTS),
    evaluator: effortFlag(
      '--evaluator-effort',
      PLANNED.evaluator.effort,
      EFFORTS,
    ),
  };
  const seed = flags['--seed'] ?? stamp();
  const latencyMs =
    flags['--latency-ms'] === undefined
      ? undefined
      : whole('--latency-ms', flags['--latency-ms'], 0, 0, 120_000);
  let replay = null;
  if (flags['--replay']) {
    const file = flags['--replay'];
    const results = JSON.parse(readFileSync(file, 'utf8'));
    const briefsPath = join(dirname(file), basename(results.brief?.file ?? ''));
    replay = savedRun(
      results,
      readFileSync(briefsPath, 'utf8'),
      basename(file),
    );
  }
  const scenarios = replay ? replay.briefs.length : plan.scenarios;

  if (!flags['--run']) {
    const worst = worstCaseCalls({ scenarios, generated: !replay, settings });
    print('Dialogue lab dry run. Nothing is started, sent or written.');
    print(`Seed: ${seed}`);
    print(
      replay
        ? `Replay of ${replay.of.file}: ${scenarios} saved briefs and prefixes; no generator calls.`
        : `Plan: ${plan.scenarios} generated scenarios from ${plan.domains.join(', ')}; each brief asked for ${plan.open} open moments, ${plan.settled} settled and ${plan.decoys} decoys.`,
    );
    print(
      `Branches: ${branches.map((b) => `${b} (${BRANCHES[b]})`).join('; ')}.`,
    );
    print(
      `Models for a run: generator ${models.generator} (${efforts.generator} effort), participants ${models.participants} (${efforts.cast}), cue evaluator ${models.evaluator} (${efforts.evaluator}) through the lab's own adapter, judge ${models.judge} (${efforts.judge}). A model run sends every request below to Anthropic through the Claude Code subscription sign-in, and needs the owner's go-ahead and --included-usage-confirmed.`,
    );
    if (worst > MAX_CALLS_CEILING) {
      print(
        `This run could make up to ${worst} calls, more than any run may (${MAX_CALLS_CEILING}), so it would be refused. Ask for fewer scenarios or turns, or a less frequent chance to speak up.`,
      );
      return null;
    }
    print(
      `At most ${worst} calls in all (participants, evaluator, judge${replay ? '' : ' and generator'}); a run needs --max-calls of at least that, up to ${MAX_CALLS_CEILING}.`,
    );
    print(
      '\nRehearsal with the offline fakes and the hand-written briefs. Each request is what that role would be sent; with models, the replies and so the later requests differ.\n',
    );
    const rehearsal = await runDialogue({
      agents: agentsFor('fake', fixtures),
      evaluator: createEvaluator('fake', { latencyMs }),
      plan: { ...plan, scenarios: Math.min(scenarios, fixtures.length) },
      settings,
      seed,
      maxCalls: MAX_CALLS_CEILING,
      replay,
      onRequest: ({
        role,
        call,
        scenario,
        branch,
        transcript,
        systemPrompt,
        input,
      }) => {
        print(
          `--- call ${call}: ${role}, ${scenario}${branch ? `, ${branch}` : ''}${transcript ? `, ${transcript}` : ''}`,
        );
        print(
          `system prompt sha ${systemPrompt ? sha(systemPrompt).slice(0, 12) : 'none'}`,
        );
        print(input);
      },
    });
    print('\nSystem prompts:');
    const shown = new Set();
    const example = fixtures[0].focus.name;
    for (const [role, prompt] of [
      ['generator', REQUESTS.generator({}).systemPrompt],
      ['cast', REQUESTS.cast({}).systemPrompt],
      [
        `listener (${example}; each brief's own name)`,
        REQUESTS.listener({ you: { name: example } }).systemPrompt,
      ],
      ['judge', REQUESTS.judge({}).systemPrompt],
    ])
      if (!shown.has(prompt)) {
        shown.add(prompt);
        print(`\n[${role}] sha ${sha(prompt).slice(0, 12)}\n${prompt}`);
      }
    print(
      `\nThe rehearsal made ${rehearsal.calls.total} fake calls: ${JSON.stringify(rehearsal.calls.byRole)}.`,
    );
    return rehearsal;
  }

  const mode = flags['--agents'] ?? 'claude';
  if (mode === 'claude' && !flags['--included-usage-confirmed'])
    throw new Error(
      'A model run needs --included-usage-confirmed, after checking in the Claude account that paid extra usage is off, and the owner’s go-ahead for this run. Nothing was started.',
    );
  const agents = agentsFor(mode, replay?.briefs ?? fixtures, {
    models,
    efforts,
    environment,
    run,
  });
  const maxCalls = whole(
    '--max-calls',
    flags['--max-calls'],
    undefined,
    1,
    MAX_CALLS_CEILING,
  );
  if (maxCalls === undefined)
    throw new Error('Every run needs --max-calls. Nothing was started.');
  const directory = outputDirectory(flags['--out'], environment);
  const name = `cue-dialogue-${stamp()}`;
  const log = createRunLog(join(directory, `${name}.log.jsonl`));
  const results = await runDialogue({
    agents,
    evaluator:
      mode === 'claude'
        ? claudeEvaluator({
            environment,
            ...(run ? { run } : {}),
            model: modelFor(models.evaluator),
            effort: efforts.evaluator,
          })
        : createEvaluator('fake', { latencyMs }),
    plan: {
      ...plan,
      // The fakes have only the hand-written briefs to hand out.
      scenarios:
        mode === 'fake'
          ? Math.min(scenarios, (replay?.briefs ?? fixtures).length)
          : scenarios,
    },
    settings,
    seed,
    maxCalls,
    replay,
    log,
    onBriefs(briefs) {
      const file = `${name}.briefs.json`;
      const { text, sha256 } = briefsFile(briefs, {
        seed,
        createdAt: new Date().toISOString(),
      });
      writeFileSync(join(directory, file), text);
      return { file, sha256 };
    },
  });
  for (const summary of results.scenarios) {
    const file = `${name}-${summary.id}.review.md`;
    writeFileSync(join(directory, file), reviewText(results, summary));
    summary.review = file;
  }
  writeFileSync(
    join(directory, `${name}.json`),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  print(
    `Wrote ${name}.json, its briefs, log and ${results.scenarios.length} reviews to ${directory}.`,
  );
  print(
    `Calls: ${results.calls.total} of at most ${results.worstCaseCalls} (cap ${maxCalls}).`,
  );
  if (results.stopped) {
    print(`Stopped: ${results.stopped.reason}`);
    process.exitCode = 1;
  }
  return results;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
