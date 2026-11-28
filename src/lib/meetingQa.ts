import { invoke } from '@tauri-apps/api/core';
export type QaLine = { id: string; atMs: number; text: string };
export type SavedRef = { id: string; revision: number };
export type QaScope = {
  ticket: string;
  providerName: string;
  model: string;
  lines: QaLine[];
  omitted: boolean;
  source: { kind: 'current'; session: string } | ({ kind: 'saved' } & SavedRef);
  priorPairs: number;
  omittedPairs: number;
  worstMicroUsd: number;
};
export type QaAnswer = {
  answer: string;
  insufficient: boolean;
  citations: string[];
};
export type QaEntry = { question: string; answer: QaAnswer; scope: QaScope };
export const questionScope = (saved?: SavedRef, resetConversation = false) =>
  invoke<QaScope>('question_scope', {
    saved: saved ?? null,
    resetConversation,
  });
export const questionHistory = (saved?: SavedRef) =>
  invoke<QaEntry[]>('question_history', { saved: saved ?? null });
export const askQuestion = (
  ticket: string,
  question: string,
  saved?: SavedRef,
) =>
  invoke<QaAnswer>('ask_question', { ticket, question, saved: saved ?? null });
export const cancelQuestion = (
  ticket: string,
  saved?: SavedRef,
  close = false,
) => invoke<void>('cancel_question', { ticket, saved: saved ?? null, close });
export const openMeetingPanel = (panel: 'transcript' | 'ask') =>
  invoke<void>('open_meeting_panel', { panel });
