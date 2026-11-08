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
  set_overlay: { enabled: boolean };
  start_live_session: undefined;
  stop_live_session: undefined;
  download_model: undefined;
  cancel_model_download: undefined;
  remove_model: undefined;
};
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
