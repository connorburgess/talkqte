// Fictional native IPC boundary for the chooser. No account or network access.
// Rust tests separately verify fetching, cancellation, and source retention.
import { emit } from '@tauri-apps/api/event';
import type {
  ContextItem,
  GranolaStatus,
  NoteSummary,
} from '../../src/lib/types';

const notes: NoteSummary[] = Array.from({ length: 24 }, (_, index) => ({
  sourceId: `garden-${index}`,
  title:
    index === 0
      ? 'Garden welcome guide: signs, accessible paths, and a plan for the volunteer open day'
      : `Fictional garden planning ${index + 1}`,
  sourceDate: '2026-11-02',
  preview: '',
}));
let connected = false;
let holdStatus = new URLSearchParams(location.search).has(
  'hold-granola-status',
);
const statuses: Array<(fail: boolean) => void> = [];
let pending = false;
let generation = 0;
let failNext = false;
let holdNext = false;
let release: (() => void) | undefined;
let holdNextListing = false;
let failNextDisconnect = false;
const listings: Array<(fail: boolean) => void> = [];
let completedListings = 0;
const suggestions: Array<(result: string[] | string) => void> = [];
let completedSuggestions = 0;
let items: ContextItem[] = [];
const selections: string[][] = [];
export const commands = [
  'granola_status',
  'connect_granola',
  'list_granola_notes',
  'disconnect_granola',
  'suggest_granola_focus',
  'context_items',
  'import_context_notes',
  'cancel_context_import',
  'remove_context_item',
  'remove_context_from',
];
const status = () => ({
  connected,
  tools: connected
    ? ['list_meetings', 'get_meetings', 'query_granola_meetings']
    : [],
});
export async function command(name: string, args: unknown) {
  switch (name) {
    case 'granola_status': {
      const value = status();
      if (!holdStatus) return value;
      return new Promise<GranolaStatus>((resolve, reject) => {
        statuses.push((fail) =>
          fail
            ? reject(new Error('Granola status unavailable.'))
            : resolve(value),
        );
      });
    }
    case 'connect_granola':
      connected = true;
      return status();
    case 'disconnect_granola':
      if (failNextDisconnect) {
        failNextDisconnect = false;
        throw new Error('Granola could not disconnect. Try again.');
      }
      connected = false;
      pending = false;
      generation++;
      return status();
    case 'context_items':
      return items;
    case 'remove_context_item': {
      const { provider, sourceId } = args as ContextItem;
      items = items.filter(
        (item) => item.provider !== provider || item.sourceId !== sourceId,
      );
      await emit('context:changed', items);
      return;
    }
    case 'remove_context_from': {
      const removed = items.length;
      items = [];
      await emit('context:changed', items);
      return removed;
    }
    case 'suggest_granola_focus':
      // Deliberately allow a retired success to cross IPC. The UI must reject
      // it too; native connection retirement has its own Rust tests.
      try {
        return await new Promise<string[]>((resolve, reject) => {
          suggestions.push((result) =>
            typeof result === 'string'
              ? reject(new Error(result))
              : resolve(result),
          );
        });
      } finally {
        completedSuggestions++;
      }
    case 'list_granola_notes': {
      const current = generation;
      if (holdNextListing) {
        holdNextListing = false;
        try {
          await new Promise<void>((resolve, reject) => {
            listings.push((fail) =>
              fail
                ? reject(new Error('The old Granola listing failed.'))
                : resolve(),
            );
          });
        } finally {
          completedListings++;
        }
      }
      if (current === generation) {
        pending = true;
        generation++;
      }
      // A success may already be crossing IPC when Disconnect is clicked.
      // Exercise the UI's own guard as well as the native retirement tests.
      return { fileName: 'Granola · the last 30 days', notes, skipped: 0 };
    }
    case 'cancel_context_import':
      pending = false;
      generation++;
      return;
    case 'import_context_notes': {
      if (!pending) throw new Error('Choose notes first.');
      const { ids } = args as { ids: string[] };
      selections.push([...ids]);
      const current = generation;
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (current !== generation)
        throw new Error('Import cancelled. Nothing was imported.');
      if (failNext) {
        failNext = false;
        throw new Error(
          'The selected notes could not be read. Nothing was imported. Try again, or cancel to choose other notes.',
        );
      }
      items = notes
        .filter((note) => ids.includes(note.sourceId))
        .map((note) => ({
          ...note,
          provider: 'granola',
          excerpt: 'Robin will label the watering cans before the open day.',
          revision: 1,
        }));
      pending = false;
      await emit('context:changed', items);
      return {
        added: items.length,
        updated: 0,
        unchanged: 0,
        rejected: 0,
        overLimit: 0,
      };
    }
  }
}
declare global {
  interface Window {
    granolaTest: {
      holdStatuses: (hold?: boolean) => void;
      releaseStatuses: (fail?: boolean) => void;
      pendingStatuses: number;
      fail: () => void;
      hold: () => void;
      release: () => void;
      holdListing: () => void;
      releaseListing: (index: number, fail?: boolean) => void;
      failDisconnect: () => void;
      completedListings: number;
      releaseSuggestion: (index: number, result: string[] | string) => void;
      suggestionRequests: number;
      completedSuggestions: number;
      selections: string[][];
    };
  }
}
window.granolaTest = {
  holdStatuses: (hold = true) => {
    holdStatus = hold;
  },
  releaseStatuses: (fail = false) => {
    holdStatus = false;
    for (const finish of statuses.splice(0)) finish(fail);
  },
  get pendingStatuses() {
    return statuses.length;
  },
  fail: () => {
    failNext = true;
  },
  hold: () => {
    holdNext = true;
  },
  release: () => release?.(),
  holdListing: () => {
    holdNextListing = true;
  },
  releaseListing: (index, fail = false) => listings[index]?.(fail),
  failDisconnect: () => {
    failNextDisconnect = true;
  },
  get completedListings() {
    return completedListings;
  },
  releaseSuggestion: (index, result) => suggestions[index]?.(result),
  get suggestionRequests() {
    return suggestions.length;
  },
  get completedSuggestions() {
    return completedSuggestions;
  },
  selections,
};
