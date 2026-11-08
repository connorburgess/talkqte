// Browser-only visual development adapter. This is not the desktop session engine.
import demo from '../demo.json';
import type { Commands, Cue, Snapshot } from './types';

const state: Snapshot = {
  revision: 0,
  title: demo.title,
  description: demo.description,
  status: 'ready',
  elapsedMs: 0,
  durationMs: demo.durationMs,
  transcript: [],
  cue: null,
  saved: [],
  notes: '',
  sensitivity: 'balanced',
  overlayEnabled: true,
  companionPosition: 'bottomRight',
  questionSize: 'standard',
};
const listeners = new Set<(state: Snapshot) => void>();
const prompts: Record<string, [string, string]> = {
  s2: ['Owner', 'Who will take the first draft?'],
  s4: ['Timing', 'What date should we aim for?'],
  s6: ['Decision', 'How will we choose between those options?'],
};
let generation = 0;
let cooldown = 0;
let deadline = 0;
let last = performance.now();
let timer: ReturnType<typeof setInterval> | undefined;
let reviewedExport: string | null = null;
const quietMs = () => (state.sensitivity === 'quiet' ? 30_000 : 10_000);
function emit() {
  state.revision++;
  for (const receive of listeners) receive(structuredClone(state));
}
function tick() {
  const now = performance.now();
  const delta = now - last;
  last = now;
  if (state.status !== 'running') return;
  state.elapsedMs = Math.min(state.durationMs, state.elapsedMs + delta);
  if (state.cue) {
    state.cue.remainingMs = Math.max(0, deadline - state.elapsedMs);
    if (!state.cue.remainingMs && !state.cue.held) {
      state.cue = null;
      cooldown = deadline + quietMs();
    }
  }
  for (const segment of demo.segments.slice(state.transcript.length)) {
    if (segment.atMs > state.elapsedMs) break;
    state.transcript.push(segment);
    const prompt = prompts[segment.id];
    if (
      prompt &&
      !state.cue &&
      segment.atMs >= cooldown &&
      state.elapsedMs - segment.atMs < 18_000
    ) {
      deadline = segment.atMs + 18_000;
      state.cue = {
        id: `${generation}:${segment.id}`,
        kind: prompt[0],
        question: prompt[1],
        evidence: segment.text,
        sourceId: segment.id,
        remainingMs: deadline - state.elapsedMs,
        totalMs: 18_000,
        held: false,
        expanded: false,
      };
    }
  }
  if (state.elapsedMs >= state.durationMs) {
    state.status = 'ended';
    if (!state.cue?.held) state.cue = null;
  }
  emit();
}
export function connect(receive: (value: Snapshot) => void) {
  listeners.add(receive);
  receive(structuredClone(state));
  if (!timer) {
    last = performance.now();
    timer = setInterval(tick, 200);
  }
  return () => {
    listeners.delete(receive);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
export function command<K extends keyof Commands>(name: K, args?: Commands[K]) {
  tick();
  switch (name) {
    case 'start_demo':
      if (state.status === 'running' || state.status === 'paused')
        throw new Error('End the current demo before replaying it.');
      generation++;
      cooldown = 0;
      state.elapsedMs = 0;
      state.transcript = [];
      state.cue = null;
      state.status = 'running';
      break;
    case 'pause_demo':
      state.status = 'paused';
      break;
    case 'resume_demo':
      state.status = 'running';
      break;
    case 'end_demo':
      state.status = 'ended';
      state.cue = null;
      break;
    case 'respond_to_cue': {
      const { id, response } = args as Commands['respond_to_cue'];
      const cue = state.cue;
      if (!cue || cue.id !== id)
        throw new Error('That question has already passed.');
      if (
        response === 'save' &&
        !state.saved.some((saved: Cue) => saved.sourceId === cue.sourceId)
      )
        state.saved.push(cue);
      state.cue = null;
      cooldown = state.elapsedMs + quietMs();
      break;
    }
    case 'inspect_cue': {
      const { id, expanded } = args as Commands['inspect_cue'];
      if (!state.cue || state.cue.id !== id)
        throw new Error('That question has already passed.');
      state.cue.expanded = expanded;
      state.cue.held = true;
      break;
    }
    case 'set_companion_position':
      state.companionPosition = (
        args as Commands['set_companion_position']
      ).value;
      break;
    case 'set_question_size':
      state.questionSize = (args as Commands['set_question_size']).value;
      break;
    case 'update_notes': {
      const { notes } = args as Commands['update_notes'];
      if ([...notes].length > 20_000)
        throw new Error('Notes can contain up to 20,000 characters.');
      state.notes = notes;
      break;
    }
    case 'set_sensitivity':
      state.sensitivity = (args as Commands['set_sensitivity']).value;
      break;
    case 'set_overlay':
      state.overlayEnabled = (args as Commands['set_overlay']).enabled;
      break;
  }
  emit();
}
export function exportPreview() {
  reviewedExport = `# ${state.title}\n\nFictional demo transcript; not derived from microphone audio.\n\n## Notes\n\n${state.notes}\n\n## Saved questions\n\n${state.saved.map((cue) => `- ${cue.question}\n  Context: ${cue.evidence}`).join('\n') || 'No saved questions.'}\n\n## Demo transcript\n\n${state.transcript.map((segment) => `**${segment.speaker}:** ${segment.text}`).join('\n\n')}\n`;
  return reviewedExport;
}
export function exportMarkdown() {
  if (reviewedExport === null) throw new Error('Review the export first.');
  const url = URL.createObjectURL(
    new Blob([reviewedExport], { type: 'text/markdown;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'talkqte-demo.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
