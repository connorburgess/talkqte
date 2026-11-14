// One adapter boundary for whatever decides about a cue. The batch runner
// and the timing simulation only use this shape, so another provider (a
// different CLI, a local model) is one more function here:
//
//   id, label          what made the decisions, for the results file
//   kind               'model' | 'fake' | 'rules'
//   hosted             true when case text leaves the device
//   destination        where it goes, in plain words (hosted only)
//   open()             one-time checks; returns facts for the results file
//   request(testCase)  { systemPrompt, input }: exactly what deciding this
//                      case reads or sends; null where there is nothing.
//                      The dry run prints it and the log records it.
//   decide(testCase)   { decision, elapsedMs, latency, usage?, provider? }
//   close()
//
// `hosted` must be exactly false for an evaluator to run without the usage
// acknowledgement and a call cap: anything else is treated as hosted.
//
// `latency` says what elapsedMs is: 'measured' wall time of a real request,
// 'simulated' for the fake, or 'none' for recorded rule outcomes.
import {
  MODEL,
  buildPrompt,
  openLab,
  requestFor,
  validateDecision,
} from './cue-lab.mjs';

/** Claude Code through the subscription sign-in. Hosted inference. */
export function claudeEvaluator({
  environment = process.env,
  run,
  glance = false,
  // The full model ID; one of the lab's allowed models.
  model = MODEL,
} = {}) {
  let lab;
  const request = (testCase) => requestFor(testCase, { glance });
  return {
    // The first model keeps the plain name its earlier results and logs
    // carry; any other model is named, so two models' results and logs
    // are never taken for one another, and one cannot resume the other.
    id: model === MODEL ? 'claude' : `claude-${model.replace(/^claude-/, '')}`,
    model,
    label: `Claude Code, ${model}`,
    prompt: glance ? 'glance' : 'recorded',
    kind: 'model',
    hosted: true,
    destination:
      'Anthropic, through the Claude Code subscription sign-in on this device',
    async open() {
      // openLab refuses, before any process, when the shell carries an API
      // key, token, gateway or provider switch.
      lab = await openLab(
        run ? { environment, run, model } : { environment, model },
      );
      return {
        model,
        cliVersion: lab.access.version,
        authentication: lab.access.authentication,
      };
    },
    request,
    async decide(testCase) {
      const report = await lab.evaluate(testCase, request(testCase));
      return {
        decision: report.decision,
        elapsedMs: report.elapsedMs,
        latency: 'measured',
        usage: report.usage,
        provider: report.provider,
      };
    },
    async close() {
      await lab?.close();
      lab = undefined;
    },
  };
}

// FNV-1a, so the same input always gets the same stand-in delay.
function hash(text) {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    value = Math.imul(value ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return value;
}

const VOLUNTEER =
  /\b(?:i'll|i will|i can|i've got|leave (?:it|that|this) with me)\b/i;
const NO_OWNER =
  /\b(?:someone|somebody|nobody|no one|who(?:'s| is| will)?)\b.*\b(?:should|needs? to|has to|have to|could|must|own|owns|owning|take|taking|picked up)\b/i;
const VAGUE_TIME =
  /\b(?:soon|at some point|sometime|eventually|when (?:i|we) get a (?:chance|minute))\b/i;
const MOVES_ON =
  /^(?:moving on|ok(?:ay)?,? next|next (?:item|up)|anyway|on another note|let's (?:leave|park|come back to|table)|actually|scratch that|never mind)\b/i;

/** A deterministic keyword stand-in that proves the harness offline. It is
 * not the app's phrase rules and not a model; its agreement with any label
 * says nothing about cue quality. Its delay is made up from the input so
 * that some decisions land inside the budget and some outside. */
export function fakeEvaluator({ latencyMs } = {}) {
  return {
    id: 'fake',
    label: 'Deterministic fake evaluator (no model)',
    kind: 'fake',
    hosted: false,
    async open() {
      return { model: null };
    },
    // It reads the same input a model would be sent, and no system prompt.
    request: (testCase) => ({
      systemPrompt: null,
      input: buildPrompt(testCase),
    }),
    async decide(testCase) {
      const input = buildPrompt(testCase);
      const newest = testCase.events.at(-1);
      const text = newest.text;
      const question = text.trim().endsWith('?');
      const cue = testCase.existingCue;
      const decision = {
        action: 'quiet',
        cue: null,
        sourceIds: [newest.id],
        reason: 'Fake evaluator: no keyword matched the newest line.',
        observedUse: 'not_observed',
      };
      if (cue) {
        const sources = [...new Set([...cue.sourceIds, newest.id])].slice(0, 4);
        if (!cue.sourceIds.includes(newest.id)) {
          if (VOLUNTEER.test(text) && !question) {
            decision.action = 'resolved';
            decision.sourceIds = sources;
            decision.reason = 'Fake evaluator: the newest line volunteers.';
          } else if (MOVES_ON.test(text.trim())) {
            decision.action = 'withdraw';
            decision.sourceIds = sources;
            decision.reason = 'Fake evaluator: the newest line moves on.';
          }
        }
      } else if (
        testCase.userName &&
        question &&
        new RegExp(`\\b${testCase.userName}\\b`).test(text)
      ) {
        decision.action = 'show';
        decision.cue = text.slice(0, 240);
        decision.reason = 'Fake evaluator: a question uses the listener name.';
      } else if (NO_OWNER.test(text) && !VOLUNTEER.test(text)) {
        decision.action = 'show';
        decision.cue = 'Who will take this on?';
        decision.reason = 'Fake evaluator: a task with no one named.';
      } else if (VAGUE_TIME.test(text) && !question) {
        decision.action = 'show';
        decision.cue = 'When is this needed by?';
        decision.reason = 'Fake evaluator: a vague time word.';
      }
      return {
        decision: validateDecision(decision, testCase),
        elapsedMs: latencyMs ?? 1_200 + (hash(input) % 4_600),
        latency: 'simulated',
      };
    },
    async close() {},
  };
}

/** The phrase rules, as recorded outcomes only: one final action per case,
 * with no cited sources, wording or delay. The rules run in Rust; this
 * adapter reads the record the engine's replay tests assert. */
export function rulesEvaluator(outcomes) {
  return {
    id: 'rules',
    label: 'Phrase rules (recorded outcomes)',
    kind: 'rules',
    hosted: false,
    async open() {
      return { model: null };
    },
    // Nothing is read but the recorded outcome for the case.
    request: () => ({ systemPrompt: null, input: null }),
    async decide(testCase) {
      const action = outcomes?.[testCase.id];
      if (!action)
        throw new Error(`No recorded rule outcome for ${testCase.id}.`);
      return {
        decision: {
          action,
          cue: null,
          sourceIds: null,
          reason: null,
          observedUse: null,
        },
        elapsedMs: null,
        latency: 'none',
      };
    },
    async close() {},
  };
}

/** How long an unread cue stays, as the engine's CUE_MS. */
export const CUE_LIFETIME_MS = 18_000;

/** The labels themselves as an evaluator, after a fixed delay: it shows a
 * cue at each labelled moment and clears it at the labelled line, and is
 * otherwise quiet. It sees only what a request holds, so a moment that has
 * left the six-line window is not shown. No model is involved. It answers
 * one question: if an evaluator agreed with every label and took this
 * long, which cues would still be on time? */
export function labelsEvaluator(conversations, { latencyMs = 4_000 } = {}) {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  return {
    id: 'labels',
    label: `The labels, after a fixed ${latencyMs} ms (no model)`,
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
      const { lines } = byId.get(testCase.id);
      const at = new Map(lines.map((item, i) => [item.id, i]));
      const inRequest = new Set(testCase.events.map((event) => event.id));
      const newest = lines[at.get(testCase.events.at(-1).id)];
      const heard = lines.slice(0, at.get(newest.id) + 1);
      const decision = {
        action: 'quiet',
        cue: null,
        sourceIds: [newest.id],
        reason: 'The labels expect no change here.',
        observedUse: 'not_observed',
      };
      const cue = testCase.existingCue;
      if (cue) {
        // The moment this cue is for; a fixture's own cue has none.
        const moment = lines.find(
          (item) =>
            item.expect === 'show' && (item.cue ?? item.about) === cue.text,
        );
        const ending = heard.findLast(
          (item) =>
            ['resolved', 'withdraw'].includes(item.expect) &&
            item.of === (moment?.id ?? 'seed') &&
            inRequest.has(item.id),
        );
        if (ending) {
          decision.action = ending.expect;
          decision.sourceIds = [...new Set([...cue.sourceIds, ending.id])];
          decision.reason = 'A line labelled as ending this cue was heard.';
        }
      } else {
        const moment = heard.findLast(
          (item) =>
            item.expect === 'show' &&
            inRequest.has(item.id) &&
            !(item.until && at.get(item.until) <= at.get(newest.id)) &&
            !heard.some((other) => other.of === item.id) &&
            newest.atMs - item.atMs < CUE_LIFETIME_MS,
        );
        if (moment) {
          decision.action = 'show';
          // The label's own short wording for a card, where it has one.
          decision.cue =
            moment.cue ?? moment.about ?? 'A cue for the labelled moment.';
          decision.sourceIds = [moment.id];
          decision.reason = 'A labelled moment is open.';
        }
      }
      return { decision, elapsedMs: latencyMs, latency: 'simulated' };
    },
    async close() {},
  };
}

/** Every evaluator the lab can use, by the name given to --evaluator. Each
 * takes what the runner knows: the environment, the recorded rule outcomes
 * for the chosen set, the conversations being replayed, and an optional
 * made-up delay. Adding a provider
 * means adding one entry here. */
export const EVALUATORS = {
  claude: ({ environment, glance, model }) =>
    claudeEvaluator({ environment, glance, model }),
  fake: ({ latencyMs }) => fakeEvaluator({ latencyMs }),
  rules: ({ rules }) => {
    if (!rules)
      throw new Error(
        'The phrase rules have no recorded outcomes for the timed conversations: they run in Rust and have not been replayed on these. Use --set with one of the three case sets, or another evaluator.',
      );
    return rulesEvaluator(rules);
  },
  labels: ({ conversations, latencyMs }) => {
    if (!conversations)
      throw new Error(
        'The labels evaluator replays labelled lines; use it with the simulation (npm run lab:sim).',
      );
    return labelsEvaluator(conversations, { latencyMs });
  },
};

export function createEvaluator(name, context, evaluators = EVALUATORS) {
  if (!Object.hasOwn(evaluators, name))
    throw new Error(
      `Unknown evaluator. Choose one of: ${Object.keys(evaluators).join(', ')}.`,
    );
  return evaluators[name](context);
}

/** Whether an evaluator must be treated as sending text off the device.
 * Only an explicit false says it does not. */
export const isHosted = (evaluator) => evaluator.hosted !== false;
