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
  saved: Cue[];
  notes: string;
  sensitivity: 'balanced' | 'quiet';
}
export type Commands = {
  start_demo: undefined;
  pause_demo: undefined;
  resume_demo: undefined;
  end_demo: undefined;
  respond_to_cue: { id: string; response: 'save' | 'dismiss' };
  inspect_cue: { id: string; expanded: boolean };
  set_companion_position: { value: CueSnapshot['companionPosition'] };
  set_question_size: { value: CueSnapshot['questionSize'] };
  update_notes: { notes: string };
  set_sensitivity: { value: Snapshot['sensitivity'] };
  set_overlay: { enabled: boolean };
};
export function clockTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
