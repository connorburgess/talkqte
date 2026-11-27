import { invoke } from '@tauri-apps/api/core';
export type QaLine = { id: string; atMs: number; text: string };
export type QaScope = {
  ticket: string;
  providerName: string;
  model: string;
  lines: QaLine[];
  omitted: boolean;
  worstMicroUsd: number;
};
export type QaAnswer = {
  answer: string;
  insufficient: boolean;
  citations: string[];
};
export type QaEntry = { question: string; answer: QaAnswer; scope: QaScope };
export const questionScope = () => invoke<QaScope>('question_scope');
export const questionHistory = () => invoke<QaEntry[]>('question_history');
export const askQuestion = (ticket: string, question: string) =>
  invoke<QaAnswer>('ask_question', { ticket, question });
export const cancelQuestion = (ticket: string) =>
  invoke<void>('cancel_question', { ticket });
export const openMeetingPanel = (panel: 'transcript' | 'ask') =>
  invoke<void>('open_meeting_panel', { panel });
