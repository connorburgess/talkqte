// Fictional context store and delayed startup replies. No files or accounts.
import { emit } from '@tauri-apps/api/event';
import type { ContextItem } from '../../src/lib/types';

const notes: ContextItem[] = [
  {
    provider: 'file',
    sourceId: 'garden-signs',
    title: 'Garden signs planning',
    sourceDate: '2026-11-02',
    excerpt: 'The fictional garden team chose clear signs for the open day.',
    revision: 1,
  },
  {
    provider: 'granola',
    sourceId: 'garden-paths',
    title: 'Garden paths review',
    sourceDate: '2026-11-03',
    excerpt: 'The fictional team will review the paths before opening.',
    revision: 1,
  },
];
let items = new URLSearchParams(location.search).has('empty-context')
  ? []
  : structuredClone(notes);
const replies: Array<(fail: boolean) => void> = [];
const removals: Array<(fail: boolean) => void> = [];
const publish = () => emit('context:changed', structuredClone(items));
const waitForRemoval = async () => {
  if (!new URLSearchParams(location.search).has('hold-removal')) return;
  await new Promise<void>((resolve, reject) =>
    removals.push((fail) =>
      fail ? reject(new Error('Removal unavailable.')) : resolve(),
    ),
  );
};

export const commands = [
  'context_items',
  'remove_context_item',
  'remove_context_from',
];
export async function command(name: string, args: unknown) {
  switch (name) {
    case 'context_items': {
      const value = structuredClone(items);
      if (!new URLSearchParams(location.search).has('hold-context'))
        return value;
      return new Promise<ContextItem[]>((resolve, reject) =>
        replies.push((fail) =>
          fail ? reject(new Error('Context unavailable.')) : resolve(value),
        ),
      );
    }
    case 'remove_context_item': {
      await waitForRemoval();
      const { provider, sourceId } = args as ContextItem;
      items = items.filter(
        (item) => item.provider !== provider || item.sourceId !== sourceId,
      );
      await publish();
      return;
    }
    case 'remove_context_from': {
      await waitForRemoval();
      const removed = items.length;
      items = [];
      await publish();
      return removed;
    }
  }
}

declare global {
  interface Window {
    contextTest: {
      pending: () => number;
      release: (fail?: boolean) => void;
      releaseRemoval: (fail?: boolean) => void;
      pendingRemovals: () => number;
      publish: typeof publish;
      importNotes: () => Promise<void>;
      items: () => ContextItem[];
    };
  }
}
window.contextTest = {
  pending: () => replies.length,
  release: (fail = false) => replies.splice(0).forEach((reply) => reply(fail)),
  releaseRemoval: (fail = false) =>
    removals.splice(0).forEach((reply) => reply(fail)),
  pendingRemovals: () => removals.length,
  publish,
  importNotes: async () => {
    items = structuredClone(notes);
    await publish();
  },
  items: () => structuredClone(items),
};
