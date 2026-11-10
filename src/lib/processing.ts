/** Native read-only snapshot/event; mutation commands remain a proposed
 * contract exercised through fictional IPC. The app does not mount it yet. */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface ProcessingNote {
  provider: 'file' | 'granola';
  sourceId: string;
  revision: number;
  title: string;
  sourceDate: string;
}
export type NoteSelection = Pick<
  ProcessingNote,
  'provider' | 'sourceId' | 'revision'
>;
export interface ProcessingScope {
  conversation: 'newSpeechOnly' | 'recentAndNewSpeech';
  notes: NoteSelection[];
}
export interface ProcessorSummary {
  id: string;
  revision: number;
  name: string;
  model: string;
  location: 'onDevice' | 'hosted';
  destination: string;
  dataPolicy: string;
}
export type ProcessingIssue =
  | 'scopeChanged'
  | 'inputLimit'
  | 'authentication'
  | 'allowance'
  | 'rateLimit'
  | 'worker'
  | null;
export interface ProcessingSnapshot {
  /** Monotonic across sessions; late snapshots cannot restore an older state. */
  revision: number;
  session: string;
  /** Changes when permission, processor or source membership/revisions change. */
  scopeRevision: number;
  phase: 'off' | 'active' | 'paused' | 'unavailable' | 'stopping' | 'ended';
  capture: 'unknown' | 'starting' | 'running' | 'stopping' | 'off';
  processor: ProcessorSummary | null;
  notes: ProcessingNote[];
  approved: ProcessingScope | null;
  issue: ProcessingIssue;
  lastDecision: 'quiet' | 'cue' | null;
}
export interface ProcessingReview {
  id: string;
  session: string;
  scopeRevision: number;
  processor: ProcessorSummary;
  scope: ProcessingScope;
  notes: ProcessingNote[];
}
export const noteKey = (note: NoteSelection) =>
  JSON.stringify([note.provider, note.sourceId, note.revision]);
export const processingApi = {
  snapshot: () => invoke<ProcessingSnapshot>('processing_snapshot'),
  listen: (receive: (snapshot: ProcessingSnapshot) => void) =>
    listen<ProcessingSnapshot>('processing:changed', ({ payload }) =>
      receive(payload),
    ),
  review: (scope: ProcessingScope) =>
    invoke<ProcessingReview>('review_processing_scope', { scope }),
  approve: (id: string) => invoke<void>('approve_processing_scope', { id }),
  cancel: (id: string) => invoke<void>('cancel_processing_review', { id }),
  disable: () => invoke<void>('revoke_processing'),
  pause: (paused: boolean) => invoke<void>('set_live_cues_paused', { paused }),
  stop: () => invoke<void>('stop_live_session'),
};
