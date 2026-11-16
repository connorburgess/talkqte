// Browser-only visual development adapter. This is not the desktop session
// engine: it holds notes, settings and selected prior notes, and never runs a
// session, opens a microphone or raises a cue.
import type {
  Commands,
  ContextItem,
  LiveStatus,
  MergeOutcome,
  ModelStatus,
  PickedNotes,
  Snapshot,
  GranolaStatus,
  UpdateCheckReport,
} from './types';

const state: Snapshot = {
  revision: 0,
  title: '',
  description: '',
  status: 'ready',
  live: false,
  cuesPaused: false,
  elapsedMs: 0,
  durationMs: 0,
  transcript: [],
  cue: null,
  notes: '',
  sensitivity: 'balanced',
  userName: null,
  focus: [],
  overlayEnabled: true,
  companionPosition: 'bottomRight',
  questionSize: 'standard',
};
const listeners = new Set<(state: Snapshot) => void>();
let reviewedExport: string | null = null;
function emit() {
  state.revision++;
  for (const receive of listeners) receive(structuredClone(state));
}
export function connect(receive: (value: Snapshot) => void) {
  listeners.add(receive);
  receive(structuredClone(state));
  return () => {
    listeners.delete(receive);
  };
}
export function command<K extends keyof Commands>(name: K, args?: Commands[K]) {
  switch (name) {
    case 'cancel_context_import':
      break;
    case 'remove_context_item': {
      const { provider, sourceId } = args as Commands['remove_context_item'];
      contextItems = contextItems.filter(
        (item) => !(item.provider === provider && item.sourceId === sourceId),
      );
      emitContext();
      break;
    }
    case 'start_live_session':
    case 'stop_live_session':
    case 'set_live_cues_paused':
    case 'download_model':
    case 'cancel_model_download':
    case 'remove_model':
      throw new Error('Live sessions are available in the desktop app.');
    case 'respond_to_cue':
    case 'inspect_cue':
      // The browser preview never has a cue.
      throw new Error('That question has already passed.');
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
      // Stored only; the preview raises no cue that could use the name.
      state.userName = (args as Commands['set_user_name']).name?.trim() || null;
      break;
    case 'set_focus': {
      // Stands in for the engine's checks; the preview raises no cue that
      // could use the focus lines.
      const lines = (args as Commands['set_focus']).lines
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length > 5) throw new Error('Keep the focus to 5 lines.');
      for (const line of lines) {
        if ([...line].length > 80 || /[\p{Cc}]/u.test(line))
          throw new Error('Each focus line is up to 80 characters.');
        if (identifyingTerms(line).length < 2)
          throw new Error(
            `“${line}” needs a few specific words, such as “agree the launch plan for the newsletter”.`,
          );
      }
      state.focus = lines;
      break;
    }
    case 'cancel_granola_sign_in':
    case 'stop_granola_update_check':
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
// Fictional Markdown and plain-text files as the desktop app reads them:
// one note each, titled by a first-line heading or the file name, with a
// date only when the file states one (see notes_file.rs).
const noteFiles: Record<string, { fileName: string; notes: ContextItem[] }> = {
  markdown: {
    fileName: 'Welcome guide printing.md',
    notes: [
      {
        provider: 'file',
        sourceId: 'file-welcome-printing',
        title: 'Welcome guide printing',
        sourceDate: '',
        excerpt:
          '## Overview\nThe fictional print shop needs two days for a one-page guide.\n\n## Action items\n- Alex asks about a sign by the gate.',
        revision: 1,
      },
    ],
  },
  text: {
    fileName: 'Tool shed rota.txt',
    notes: [
      {
        provider: 'file',
        sourceId: 'file-tool-shed-rota',
        title: 'Tool shed rota',
        sourceDate: '2026-11-04',
        excerpt:
          'Date: 2026-11-04\nRobin has the fictional shed key on Tuesdays.',
        revision: 1,
      },
    ],
  },
};
// The same messages the desktop app gives for these files.
const refusedFiles: Record<string, string> = {
  'too-large': 'That file is larger than 1 MB. Choose a smaller notes file.',
  unsupported:
    'TalkQTE reads notes from a Markdown (.md) or plain-text (.txt) file, or a TalkQTE JSON notes file. Export or save the notes in one of those formats.',
};
// The notes of the file last picked, as the desktop app keeps them.
let pickedNotes: ContextItem[] = exampleNotes;
let contextItems: ContextItem[] = [];
/** Words of a note title or focus line that could identify it in conversation. */
function identifyingTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}']+/u)
        .filter(
          (w) => w.length >= 5 && /^\p{L}+$/u.test(w) && !STOP_WORDS.has(w),
        ),
    ),
  ];
}
// Mirrors the engine's list of words that never identify a note.
const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'agenda',
  'ahead',
  'catch',
  'check',
  'could',
  'daily',
  'discussion',
  'every',
  'first',
  'going',
  'meeting',
  'minutes',
  'monthly',
  'month',
  'notes',
  'other',
  'people',
  'planning',
  'quick',
  'really',
  'review',
  'should',
  'standup',
  'still',
  'sync',
  'team',
  'their',
  'there',
  'these',
  'thing',
  'things',
  'think',
  'those',
  'today',
  'update',
  'weekly',
  'where',
  'which',
  'while',
  'would',
  'yesterday',
  'tomorrow',
]);
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
export function removeAllContext(): number {
  const removed = contextItems.length;
  contextItems = [];
  emitContext();
  return removed;
}
export function contextItemsNow(): ContextItem[] {
  return structuredClone(contextItems);
}
// The browser preview has no account sign-in; Granola connects in the desktop app.
export function granolaStatus(): GranolaStatus {
  return { connected: false, tools: [] };
}
export function connectGranola(): GranolaStatus {
  throw new Error(
    'Granola connects in the desktop app, with your own sign-in.',
  );
}
export function listGranolaNotes(): PickedNotes {
  throw new Error('Connect Granola first.');
}
export function suggestGranolaFocus(): string[] {
  throw new Error(
    'Granola connects in the desktop app, with your own sign-in.',
  );
}
export function checkGranolaUpdates(): UpdateCheckReport {
  throw new Error('Connect Granola first.');
}
export function disconnectGranola(): GranolaStatus {
  return { connected: false, tools: [] };
}
export function pickContextFile(): PickedNotes {
  // `?notes=empty` previews a file with nothing to choose; `markdown` and
  // `text` preview one-note files, and `too-large` and `unsupported` files
  // the app refuses.
  const kind = new URLSearchParams(location.search).get('notes') ?? '';
  if (kind === 'empty') {
    pickedNotes = [];
    return {
      fileName: 'empty-notes.json',
      skipped: 0,
      notes: [],
      asksForDates: false,
    };
  }
  if (refusedFiles[kind]) throw new Error(refusedFiles[kind]);
  const file = noteFiles[kind] ?? {
    fileName: 'garden-notes.json',
    notes: exampleNotes,
  };
  pickedNotes = file.notes;
  return {
    fileName: file.fileName,
    skipped: 0,
    asksForDates: !!noteFiles[kind],
    notes: file.notes.map((note) => ({
      sourceId: note.sourceId,
      title: note.title,
      sourceDate: note.sourceDate,
      preview: note.excerpt,
    })),
  };
}
export function importContextNotes(
  ids: string[],
  dates: Record<string, string> = {},
): MergeOutcome {
  const outcome: MergeOutcome = {
    added: 0,
    updated: 0,
    unchanged: 0,
    overLimit: 0,
    rejected: 0,
  };
  for (const picked of pickedNotes) {
    if (!ids.includes(picked.sourceId)) continue;
    // An entered date fills only a Markdown or text note without one.
    const asks = pickedNotes !== exampleNotes;
    const note = {
      ...picked,
      sourceDate: picked.sourceDate || (asks && dates[picked.sourceId]) || '',
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(note.sourceDate)) outcome.rejected++;
    else if (contextItems.some((item) => item.sourceId === note.sourceId))
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
  reviewedExport = `# TalkQTE notes\n\n${state.notes}\n`;
  return reviewedExport;
}
export function exportMarkdown() {
  if (reviewedExport === null) throw new Error('Review the export first.');
  const url = URL.createObjectURL(
    new Blob([reviewedExport], { type: 'text/markdown;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'talkqte-notes.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
