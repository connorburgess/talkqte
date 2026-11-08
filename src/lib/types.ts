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
}
export interface CueSnapshot {
  revision: number;
  status: Status;
  cue: Cue | null;
  overlayEnabled: boolean;
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
  update_notes: { notes: string };
  set_sensitivity: { value: Snapshot['sensitivity'] };
  set_overlay: { enabled: boolean };
};
export function clockTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
