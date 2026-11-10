/** Native status and guarded processing commands. The surface remains test-
 * mounted; normal-app integration and provider activation are separate gates. */
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
export interface StopTarget {
  operation: string | null;
  microphone: string;
}
export interface ProcessingSnapshot {
  /** Monotonic across sessions; late snapshots cannot restore an older state. */
  revision: number;
  session: string;
  /** Changes when permission, processor or source membership/revisions change. */
  scopeRevision: number;
  phase: 'off' | 'active' | 'paused' | 'unavailable' | 'stopping' | 'ended';
  capture: 'unknown' | 'starting' | 'running' | 'stopping' | 'off';
  stopTarget: StopTarget;
  startup: 'idle' | 'loading' | 'cancelling' | 'unknown';
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
export type ExpectedScope = Pick<
  ProcessingSnapshot,
  'session' | 'scopeRevision'
>;
const expectedScope = ({ session, scopeRevision }: ExpectedScope) => ({
  session,
  scopeRevision,
});
export const noteKey = (note: NoteSelection) =>
  JSON.stringify([note.provider, note.sourceId, note.revision]);
export const processingApi = {
  snapshot: () => invoke<ProcessingSnapshot>('processing_snapshot'),
  listen: (receive: (snapshot: ProcessingSnapshot) => void) =>
    listen<ProcessingSnapshot>('processing:changed', ({ payload }) =>
      receive(payload),
    ),
  review: (expected: ExpectedScope, scope: ProcessingScope) =>
    invoke<ProcessingReview>('review_processing_scope', {
      expected: expectedScope(expected),
      scope,
    }),
  approve: (id: string) => invoke<void>('approve_processing_scope', { id }),
  cancel: (id: string) => invoke<void>('cancel_processing_review', { id }),
  disable: (expected: ExpectedScope) =>
    invoke<void>('revoke_processing', { expected: expectedScope(expected) }),
  pause: (expected: ExpectedScope, paused: boolean) =>
    invoke<void>('set_processing_paused', {
      expected: expectedScope(expected),
      paused,
    }),
  stop: ({ operation, microphone }: StopTarget) =>
    invoke<void>('stop_capture', { target: { operation, microphone } }),
};
