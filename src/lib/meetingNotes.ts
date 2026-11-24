import { invoke } from '@tauri-apps/api/core';
import { desktop } from './bridge';

/** Where this session's model-written notes stand (Rust's `Phase`). */
export type MeetingNotesPhase =
  'none' | 'writing' | 'draft' | 'failed' | 'kept' | 'discarded';

/** What a notes request would send and cost; counts only, never content. */
export interface MeetingNotesPlan {
  transcriptLines: number;
  minutes: number;
  /** Present only when the person chose to include their notes. */
  noteLines?: number;
  kilobytes: number;
  model: string;
  likelyMicroUsd: number;
  worstMicroUsd: number;
  spendCapMicroUsd: number;
  destination: string;
  /** This session's cue spend with the same key, when there was any. */
  cueSpentMicroUsd?: number;
  /** Names exactly what would be sent; the request must match it. */
  fingerprint: string;
}

export interface CitedLine {
  /** "transcript 03:41" or "your notes line 3". */
  label: string;
  text: string;
}

export interface CheckItem {
  section: 'summary' | 'decisions' | 'actions' | 'openQuestions';
  text: string;
  owner?: string;
  due?: string;
  sources: CitedLine[];
}

export interface MeetingNotesDraft {
  markdown: string;
  items: CheckItem[];
  /** Absent when the API did not report the cost. */
  spentMicroUsd?: number;
}

export interface MeetingNotesResult {
  draft?: MeetingNotesDraft;
  failure?: string;
  kept?: string;
  spentMicroUsd?: number;
}

/** The models the app lists for notes, most careful first. */
export const notesModels = [
  {
    id: 'claude-opus-5-5',
    label: 'Most careful (default)',
    cost: 'highest cost',
  },
  { id: 'claude-sonnet-5-5', label: 'Balanced', cost: 'about half the cost' },
  {
    id: 'claude-haiku-5-5',
    label: 'Quickest',
    cost: 'lowest cost, least careful',
  },
] as const;

// The browser preview never has a live session, so it never writes notes.
const unavailable = () =>
  Promise.reject(
    new Error(
      'The browser preview cannot write meeting notes. Nothing was sent.',
    ),
  );

export function meetingNotesPlan(includeNotes: boolean) {
  if (!desktop) return unavailable();
  return invoke<MeetingNotesPlan>('meeting_notes_plan', { includeNotes });
}

/** Sends this meeting's one request, only if what would be sent still
 * matches the confirmed plan; resolves when the notes are checked. */
export function writeMeetingNotes(includeNotes: boolean, fingerprint: string) {
  if (!desktop) return unavailable();
  return invoke<MeetingNotesDraft>('write_meeting_notes', {
    includeNotes,
    fingerprint,
  });
}

/** The refusal Rust sends when the input changed after the plan. */
export const planChanged = 'What would be sent has changed since you looked';

export function cancelMeetingNotes() {
  if (!desktop) return Promise.resolve();
  return invoke<void>('cancel_meeting_notes');
}

export function meetingNotesResult() {
  if (!desktop) return unavailable();
  return invoke<MeetingNotesResult>('meeting_notes_result');
}

export function keepMeetingNotes(markdown: string) {
  if (!desktop) return unavailable();
  return invoke<void>('keep_meeting_notes', { markdown });
}

export function discardMeetingNotes() {
  if (!desktop) return unavailable();
  return invoke<void>('discard_meeting_notes');
}

let previewModel: string = notesModels[0].id;

export function meetingNotesModel(): Promise<string> {
  if (!desktop) return Promise.resolve(previewModel);
  return invoke<string>('meeting_notes_model');
}

export function setMeetingNotesModel(model: string): Promise<string> {
  if (!desktop) {
    previewModel = model;
    return Promise.resolve(previewModel);
  }
  return invoke<string>('set_meeting_notes_model', { model });
}

export const dollars = (microUsd: number) =>
  `$${(microUsd / 1_000_000).toFixed(2)}`;
