// One adapter boundary for whatever decides about a cue. The batch runner
// and the timing simulation only use this shape, so another provider (a
// different CLI, a local model) is one more function here:
//
//   id, label          what made the decisions, for the results file
//   kind               'model' | 'fake' | 'rules'
//   hosted             true when case text leaves the device
//   destination        where it goes, in plain words (hosted only)
//   open()             one-time checks; returns facts for the results file
//   decide(testCase)   { decision, elapsedMs, latency, usage?, provider? }
//   close()
//
// `latency` says what elapsedMs is: 'measured' wall time of a real request,
// 'simulated' for the fake, or 'none' for recorded rule outcomes.
import { MODEL, buildPrompt, openLab, validateDecision } from './cue-lab.mjs';

/** Claude Code through the subscription sign-in. Hosted inference. */
export function claudeEvaluator({ environment = process.env, run } = {}) {
  let lab;
  return {
    id: 'claude',
    label: `Claude Code, ${MODEL}`,
    kind: 'model',
    hosted: true,
    destination:
      'Anthropic, through the Claude Code subscription sign-in on this device',
    async open() {
      // openLab refuses, before any process, when the shell carries an API
      // key, token, gateway or provider switch.
      lab = await openLab(run ? { environment, run } : { environment });
      return {
        model: MODEL,
        cliVersion: lab.access.version,
        authentication: lab.access.authentication,
      };
    },
    async decide(testCase) {
      const report = await lab.evaluate(testCase);
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
    async decide(testCase) {
      const action = outcomes[testCase.id];
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
