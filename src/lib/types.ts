export type Status = 'ready' | 'running' | 'paused' | 'ended';
export interface Segment {
  id: string;
  atMs: number;
  speaker: string;
  text: string;
}
export interface Cue {
  id: string;
  kind: string;
  question: string;
  evidence: string;
  sourceId: string;
  remainingMs: number;
  totalMs: number;
  held: boolean;
  expanded: boolean;
  resolvedBy: { sourceId: string; evidence: string } | null;
  /** Set for a context reminder: the imported note it quotes. */
  note: { title: string; sourceDate: string; provider: string } | null;
  /** The line uses words from the meeting goal: shown sooner, kept longer. */
  aboutGoal: boolean;
}
export interface CueSnapshot {
  revision: number;
  status: Status;
  /** A live session fed by local transcription, not the scripted demo. */
  live: boolean;
  cue: Cue | null;
  overlayEnabled: boolean;
  companionPosition: 'bottomRight' | 'topCenter' | 'topLeft' | 'topRight';
  questionSize: 'standard' | 'large';
}
export interface Snapshot extends CueSnapshot {
  title: string;
  description: string;
  elapsedMs: number;
  durationMs: number;
  transcript: Segment[];
  notes: string;
  sensitivity: 'balanced' | 'quiet';
  /** Session-only; used to notice questions asked of the user by name. */
  userName: string | null;
  /** Session-only; lets questions that use its words through sooner. */
  goal: string | null;
}
export type Commands = {
  start_demo: undefined;
  pause_demo: undefined;
  resume_demo: undefined;
  end_demo: undefined;
  respond_to_cue: { id: string; response: 'dismiss' };
  inspect_cue: { id: string; expanded: boolean };
  set_companion_position: { value: CueSnapshot['companionPosition'] };
  set_question_size: { value: CueSnapshot['questionSize'] };
  update_notes: { notes: string };
  set_sensitivity: { value: Snapshot['sensitivity'] };
  set_user_name: { name: string | null };
  set_goal: { goal: string | null };
  set_overlay: { enabled: boolean };
  start_live_session: undefined;
  stop_live_session: undefined;
  download_model: undefined;
  cancel_model_download: undefined;
  remove_model: undefined;
  cancel_context_import: undefined;
  remove_context_item: { sourceId: string };
};
/** One prior note the user imported; never mistaken for the conversation. */
export interface ContextItem {
  provider: 'granola' | 'file';
  sourceId: string;
  title: string;
  sourceDate: string;
  excerpt: string;
  revision: number;
}
export interface NoteSummary {
  sourceId: string;
  title: string;
  sourceDate: string;
  preview: string;
}
export interface PickedNotes {
  fileName: string;
  notes: NoteSummary[];
  /** Notes in the file not listed: beyond the limit of 200, or repeated. */
  skipped: number;
}
export interface MergeOutcome {
  added: number;
  updated: number;
  unchanged: number;
  overLimit: number;
  rejected: number;
}
export interface ModelStatus {
  revision: number;
  status: 'unavailable' | 'developer' | 'missing' | 'downloading' | 'installed';
  name: string;
  sizeBytes: number;
  neededBytes: number;
  received: number;
  message: string | null;
}
export interface LiveStatus {
  available: boolean;
  reason: string | null;
}
export function clockTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
