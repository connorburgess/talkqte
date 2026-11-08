// Browser-only visual development adapter. This is not the desktop session engine.
import demo from '../demo.json';
import type {
  Commands,
  ContextItem,
  LiveStatus,
  MergeOutcome,
  ModelStatus,
  PickedNotes,
  Snapshot,
} from './types';

const state: Snapshot = {
  revision: 0,
  title: demo.title,
  description: demo.description,
  status: 'ready',
  live: false,
  elapsedMs: 0,
  durationMs: demo.durationMs,
  transcript: [],
  cue: null,
  notes: '',
  sensitivity: 'balanced',
  userName: null,
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
// Mirrors the desktop engine's answer detection for the bundled demo only.
const resolutions: Record<string, string> = { s5: 'Timing' };
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
    if (
      state.cue &&
      !state.cue.resolvedBy &&
      resolutions[segment.id] === state.cue.kind
    ) {
      if (state.cue.held)
        state.cue.resolvedBy = { sourceId: segment.id, evidence: segment.text };
      else {
        state.cue = null;
        cooldown = segment.atMs + quietMs();
      }
      continue;
    }
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
        resolvedBy: null,
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
    case 'cancel_context_import':
      break;
    case 'remove_context_item': {
      const { sourceId } = args as Commands['remove_context_item'];
      contextItems = contextItems.filter((item) => item.sourceId !== sourceId);
      emitContext();
      break;
    }
    case 'start_live_session':
    case 'stop_live_session':
    case 'download_model':
    case 'cancel_model_download':
    case 'remove_model':
      throw new Error('Live sessions are available in the desktop app.');
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
      void response; // Dismiss is the only response.
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
    case 'set_user_name':
      // Stored only; the preview's scripted questions never use the name.
      state.userName = (args as Commands['set_user_name']).name?.trim() || null;
      break;
    case 'set_sensitivity':
      state.sensitivity = (args as Commands['set_sensitivity']).value;
      break;
    case 'set_overlay':
      state.overlayEnabled = (args as Commands['set_overlay']).enabled;
      break;
  }
  emit();
}
// The browser preview never opens the microphone or transcribes.
export function liveStatus(): LiveStatus {
  return { available: false, reason: 'Available in the desktop app.' };
}
// A fictional notes file stands in for the desktop file chooser.
const exampleNotes: ContextItem[] = [
  {
    provider: 'file',
    sourceId: 'g1',
    title: 'Garden welcome guide',
    sourceDate: '2026-10-28',
    excerpt:
      'Draft a one-page guide. Robin suggested a map of the tool shed and a note on watering times.',
    revision: 1,
  },
  {
    provider: 'file',
    sourceId: 'g2',
    title: 'Visitor questions',
    sourceDate: '2026-11-02',
    excerpt:
      'Visitors asked where to find watering cans and who to ask for help.',
    revision: 1,
  },
  {
    provider: 'file',
    sourceId: 'g3',
    title: 'Sign at the gate',
    sourceDate: '2026-11-05',
    excerpt: 'A small sign with a link might be cheaper than printing.',
    revision: 1,
  },
];
let contextItems: ContextItem[] = [];
const contextListeners = new Set<(items: ContextItem[]) => void>();
function emitContext() {
  for (const receive of contextListeners)
    receive(structuredClone(contextItems));
}
export function connectContext(receive: (items: ContextItem[]) => void) {
  contextListeners.add(receive);
  receive(structuredClone(contextItems));
  return () => {
    contextListeners.delete(receive);
  };
}
export function contextItemsNow(): ContextItem[] {
  return structuredClone(contextItems);
}
export function pickContextFile(): PickedNotes {
  return {
    fileName: 'garden-notes.json',
    skipped: 0,
    notes: exampleNotes.map((note) => ({
      sourceId: note.sourceId,
      title: note.title,
      sourceDate: note.sourceDate,
      preview: note.excerpt,
    })),
  };
}
export function importContextNotes(ids: string[]): MergeOutcome {
  const outcome: MergeOutcome = {
    added: 0,
    updated: 0,
    unchanged: 0,
    overLimit: 0,
    rejected: 0,
  };
  for (const note of exampleNotes) {
    if (!ids.includes(note.sourceId)) continue;
    if (contextItems.some((item) => item.sourceId === note.sourceId))
      outcome.unchanged++;
    else {
      contextItems.push(structuredClone(note));
      outcome.added++;
    }
  }
  emitContext();
  return outcome;
}
// The preview never downloads anything.
export function modelStatus(): ModelStatus {
  return {
    revision: 0,
    status: 'unavailable',
    name: 'tiny.en',
    sizeBytes: 77_704_715,
    neededBytes: 77_704_715 + 512 * 1024 * 1024,
    received: 0,
    message: null,
  };
}
export function exportPreview() {
  reviewedExport = `# ${state.title}\n\nFictional demo transcript; not derived from microphone audio.\n\n## Notes\n\n${state.notes}\n\n## Demo transcript\n\n${state.transcript.map((segment) => `**${segment.speaker}:** ${segment.text}`).join('\n\n')}\n`;
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
