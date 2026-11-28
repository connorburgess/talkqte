// Fictional UI stand-in only. These authored answers do not establish model quality.
import type { QaAnswer, QaEntry, QaScope } from '../../src/lib/meetingQa';
import type { Snapshot } from '../../src/lib/types';
import * as history from './native-meeting-history';
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
let bound = '';
let scopeError = '';
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
  const selected = (args as { saved?: { id: string; revision: number } })
    ?.saved;
  let stored;
  if (selected && name !== 'cancel_question') {
    stored = history.command(
      'open_kept_meeting',
      { id: selected.id },
      () => current,
      () => 1,
    ) as import('../../src/lib/meetingHistory').KeptMeeting;
    if (stored.revision !== selected.revision)
      throw 'The selected saved meeting changed. Reopen it before asking.';
  }
  if ((args as { resetConversation?: boolean })?.resetConversation)
    entries = [];

  const key = selected
    ? `${selected.id}-${selected.revision}`
    : `current-${current.session}`;
  if (name === 'question_scope') {
    if (scopeError) throw scopeError;
    if (bound !== key) {
      entries = [];
      bound = key;
    }
    if (
      (!stored && !current.live) ||
      !(stored?.transcript.length ?? current.transcript.length)
    )
      throw 'Wait for transcript lines before asking a question.';
    scope = {
      ticket: `synthetic-${++seq}`,
      providerName: 'Anthropic',
      model: 'fictional-model',
      lines: stored
        ? stored.transcript.map(({ atMs, text }, i) => ({
            id: `saved-line-${i}`,
            atMs,
            text,
          }))
        : current.transcript.map(({ id, atMs, text }) => ({ id, atMs, text })),
      omitted: false,
      source: selected
        ? { kind: 'saved', ...selected }
        : { kind: 'current', session: current.session },
      priorPairs: Math.min(3, entries.length),
      omittedPairs: Math.max(0, entries.length - 3),
      worstMicroUsd: 12000,
    };
    return structuredClone(scope);
  }
  if (name === 'question_history')
    return bound === key ? structuredClone(entries) : [];
  if (name === 'cancel_question') {
    if (
      (args as { close?: boolean })?.close &&
      scope?.ticket === (args as { ticket: string }).ticket
    )
      entries = [];
    failure = held ? 'Question cancelled.' : '';
    release?.();
    return;
  }
  if (name === 'open_meeting_panel') return;
  if (name === 'ask_question') {
    const askedScope = structuredClone(scope);
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
    entries.push({ question, answer, scope: askedScope });
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
      scopeError: (message: string) => void;
    };
  }
}
window.qaTest = {
  scopeError: (message) => {
    scopeError = message;
  },
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
