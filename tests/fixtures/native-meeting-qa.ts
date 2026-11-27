// Fictional UI stand-in only. These authored answers do not establish model quality.
import type { QaAnswer, QaEntry, QaScope } from '../../src/lib/meetingQa';
import type { Snapshot } from '../../src/lib/types';
import { emit } from '@tauri-apps/api/event';
export const commands = [
  'question_scope',
  'question_history',
  'ask_question',
  'cancel_question',
  'open_meeting_panel',
];
export const calls: { command: string; args: unknown }[] = [];
let entries: QaEntry[] = [];
let seq = 0;
let scope: QaScope;
let held = false;
let release: (() => void) | undefined;
let failure = '';
let next: QaAnswer = {
  answer: 'The team chose a Saturday greenhouse check.',
  insufficient: false,
  citations: ['qa-1'],
};
export async function command(name: string, args: unknown, current: Snapshot) {
  calls.push({ command: name, args: structuredClone(args) });
  if (name === 'question_scope') {
    if (!current.live || !current.transcript.length)
      throw 'Wait for transcript lines before asking a question.';
    scope = {
      ticket: `synthetic-${++seq}`,
      providerName: 'Anthropic',
      model: 'fictional-model',
      lines: current.transcript
        .slice(-200)
        .map(({ id, atMs, text }) => ({ id, atMs, text })),
      omitted: current.transcript.length > 200,
      worstMicroUsd: 12000,
    };
    return structuredClone(scope);
  }
  if (name === 'question_history') return structuredClone(entries);
  if (name === 'cancel_question') {
    failure = 'Question cancelled.';
    release?.();
    return;
  }
  if (name === 'open_meeting_panel') return;
  if (name === 'ask_question') {
    if (held)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    held = false;
    if (failure) {
      const message = failure;
      failure = '';
      throw message;
    }
    const { question } = args as { question: string };
    const answer = structuredClone(next);
    entries.push({ question, answer, scope: structuredClone(scope) });
    return answer;
  }
}
declare global {
  interface Window {
    qaTest: {
      calls: typeof calls;
      openPanel: (panel: 'transcript' | 'ask') => Promise<void>;
      hold: () => void;
      release: () => void;
      fail: (message: string) => void;
      answer: (value: QaAnswer) => void;
    };
  }
}
window.qaTest = {
  calls,
  openPanel: (panel) => emit('meeting:open-panel', panel),
  hold: () => {
    held = true;
  },
  release: () => release?.(),
  fail: (message) => {
    failure = message;
  },
  answer: (value) => {
    next = value;
  },
};
