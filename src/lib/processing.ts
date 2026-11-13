/** Native status and guarded capture/processing commands for the notebook.
 * Provider activation remains a separate gate; the app registers no evaluator. */
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
  /** Development builds only: the microphone alone, beside a combined capture. */
  microphone?: ProcessingSnapshot['capture'];
  /** Development builds only: the selected-application source. */
  source?: SourceCapture;
}
/** The selected-application source in a development build. Off only when
 * nothing was started or native cleanup was confirmed. */
export interface SourceCapture {
  phase:
    | 'off'
    | 'listing'
    | 'reviewing'
    | 'starting'
    | 'listening'
    | 'stopping'
    | 'cleanupFailed'
    | 'abandoned';
  mayBeCapturing: boolean;
  stalled: boolean;
  canRetry: boolean;
  application: string | null;
  problem: string | null;
  /** The review or operation, for the source's own Stop. */
  operation: string | null;
  /** The live session was started for this source alone; no microphone. */
  sourceSession: boolean;
}
/** The application a live session is running from alone, or null. Only
 * while that session's source is starting or capturing, and while both the
 * snapshot's and the microphone hook's own status read the microphone off:
 * the wording this drives says the microphone is not used. */
export function sourceOnlyApplication(
  snapshot: ProcessingSnapshot | null | undefined,
  microphoneStatus: string | undefined,
) {
  const source = snapshot?.source;
  if (
    !source?.sourceSession ||
    (source.phase !== 'starting' && source.phase !== 'listening') ||
    snapshot?.microphone !== 'off' ||
    microphoneStatus !== 'off'
  )
    return null;
  return source.application || 'the selected application';
}

/** One sentence for the source, or null when there is nothing to say. Never
 * says that nothing is captured while the source may be capturing. */
export function describeSource(source: SourceCapture | null | undefined) {
  if (!source || source.phase === 'off') return null;
  const app = source.application || 'the selected application';
  switch (source.phase) {
    case 'listing':
      return 'Application audio: waiting for macOS to list applications.';
    case 'reviewing':
      return `Application audio: ${app} is selected but not started.`;
    case 'starting':
      return `Application audio from ${app} is starting.`;
    case 'listening':
      return `Application audio from ${app} is being captured, including all of its windows.`;
    case 'stopping':
      return source.stalled
        ? `macOS has not confirmed that application audio from ${app} stopped. It may still be captured.`
        : `Stopping application audio from ${app}. It may be captured until macOS confirms.`;
    case 'cleanupFailed':
      return `Stopping application audio from ${app} failed. It may still be captured. A retry exists only as a development command.`;
    case 'abandoned':
      return `Application audio from ${app} was never confirmed stopped. It may still be captured. Nothing in TalkQTE can stop it; whether quitting does has not been checked.`;
  }
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
  /** Development builds only: Stop exactly this application source. */
  stopSource: (operation: string) =>
    invoke<unknown>('application_audio', {
      action: { kind: 'stop', operation },
    }).then(() => {}),
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
