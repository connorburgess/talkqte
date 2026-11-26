import { invoke } from '@tauri-apps/api/core';
import { desktop } from './bridge';

/** Whether kept meetings can be used in this launch. */
export type HistoryAvailability = 'on' | 'labRun' | 'unavailable' | 'newer';

export type AfterSessionKeep = 'auto' | 'ask' | 'off';

export type MeetingSources = 'microphone' | 'application' | 'both';

export interface KeptSummary {
  id: string;
  title: string;
  revision: number;
  /** When the meeting started, milliseconds since 1970 (UTC). */
  startedAtMs: number;
  durationMs: number;
  sources: MeetingSources;
  hasMeetingNotes: boolean;
  folder?: string;
}

export interface KeptLine {
  atMs: number;
  /** Where the line was heard, in a meeting with both sources. */
  label?: 'you' | 'them';
  /** Marked during the meeting as a likely echo of the application. */
  echo?: boolean;
  text: string;
}

export interface KeptCue {
  atMs: number;
  kind: string;
  question: string;
  evidence: string;
}

export interface KeptMeeting {
  id: string;
  title: string;
  revision: number;
  folder?: string;
  startedAtMs: number;
  durationMs: number;
  sources: MeetingSources;
  /** Only when the person chose to keep it. */
  application?: string;
  transcribedBy?: string;
  transcript: KeptLine[];
  notes: string;
  cues: KeptCue[];
  meetingNotes?: string;
}

export interface KeptListing {
  availability: HistoryAvailability;
  meetings: KeptSummary[];
  folders: string[];
  /** Kept meetings that could not be read; not shown, never changed. */
  unreadable: number;
}

export interface HistoryStatus {
  availability: HistoryAvailability;
  afterSessionKeep: AfterSessionKeep;
  /** The current session's number: Not this one applies to it alone. */
  session: number;
  /** The ended session's kept meeting, once the person kept it or it was
   * auto-saved. */
  kept?: { id: string; title: string; changed: boolean };
}

const browserOnly = () =>
  Promise.reject(new Error('Kept meetings are available in the desktop app.'));

export function historyStatus(): Promise<HistoryStatus> {
  if (!desktop)
    return Promise.resolve({
      availability: 'unavailable',
      afterSessionKeep: 'auto',
      session: 0,
    });
  return invoke<HistoryStatus>('meeting_history_status');
}

export function setAfterSessionKeep(mode: AfterSessionKeep) {
  if (!desktop) return browserOnly();
  return invoke<void>('set_after_session_keep', { mode });
}

export function keepMeeting(title: string, includeApplication: boolean) {
  if (!desktop) return browserOnly();
  return invoke<KeptSummary>('keep_meeting_in_history', {
    title,
    includeApplication,
  });
}

export function updateKeptSessionMeeting() {
  if (!desktop) return browserOnly();
  return invoke<KeptSummary>('update_kept_session_meeting');
}

export function keptMeetings(query?: string): Promise<KeptListing> {
  if (!desktop)
    return Promise.resolve({
      availability: 'unavailable',
      meetings: [],
      folders: [],
      unreadable: 0,
    });
  return invoke<KeptListing>('kept_meetings', { query: query || null });
}

export function openKeptMeeting(id: string) {
  if (!desktop) return browserOnly();
  return invoke<KeptMeeting>('open_kept_meeting', { id });
}

export function renameKeptMeeting(id: string, title: string) {
  if (!desktop) return browserOnly();
  return invoke<KeptSummary>('rename_kept_meeting', { id, title });
}

export function createMeetingFolder(name: string) {
  if (!desktop) return browserOnly();
  return invoke<string[]>('create_meeting_folder', { name });
}

export function renameMeetingFolder(oldName: string, newName: string) {
  if (!desktop) return browserOnly();
  return invoke<string[]>('rename_meeting_folder', { oldName, newName });
}

export function deleteMeetingFolder(name: string) {
  if (!desktop) return browserOnly();
  return invoke<string[]>('delete_meeting_folder', { name });
}

export function setKeptMeetingFolder(id: string, folder: string | null) {
  if (!desktop) return browserOnly();
  return invoke<KeptSummary>('set_kept_meeting_folder', { id, folder });
}

export function deleteKeptMeeting(id: string) {
  if (!desktop) return browserOnly();
  return invoke<void>('delete_kept_meeting', { id });
}

export function deleteAllKeptMeetings() {
  if (!desktop) return browserOnly();
  return invoke<number>('delete_all_kept_meetings');
}

export function keptMeetingExportPreview(id: string) {
  if (!desktop) return browserOnly();
  return invoke<string>('kept_meeting_export_preview', { id });
}

export function exportKeptMeeting() {
  if (!desktop) return browserOnly();
  return invoke<boolean>('export_kept_meeting');
}

/** The default title: the meeting's date and time, in the person's locale. */
export function defaultTitle(startedAtMs: number) {
  const when = new Date(startedAtMs);
  return `Meeting, ${when.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}, ${when.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

export function meetingDate(startedAtMs: number) {
  return new Date(startedAtMs).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function minutes(durationMs: number) {
  const total = Math.max(0, Math.round(durationMs / 60_000));
  return total < 1 ? 'under a minute' : `${total} min`;
}

export const sourceNames: Record<MeetingSources, string> = {
  microphone: 'Microphone',
  application: 'Application',
  both: 'Microphone and application',
};

export function failure(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}
