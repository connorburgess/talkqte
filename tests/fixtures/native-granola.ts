// Fictional native IPC boundary for the chooser. No account or network access.
// Rust tests separately verify fetching, cancellation, and source retention.
import { emit } from '@tauri-apps/api/event';
import type {
  ContextItem,
  GranolaStatus,
  NoteFreshness,
  NoteSummary,
  UpdateCheckReport,
} from '../../src/lib/types';
import {
  CHECKED_AT_MS,
  IMPORTED_AT_MS,
  PROVIDER_UPDATED_AT_MS,
} from './native-granola-times';

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
// The signed-in Granola connection reports no update check; `?update-check`
// stands in for a provider whose workspace identity can be verified.
const updateCheck = new URLSearchParams(location.search).has('update-check');
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
// A simulated provider for the explicit update check. It stands in for the
// Rust rules in context_refresh.rs, which have their own tests; no real
// Granola connection offers this check yet.
type Failure = Exclude<
  UpdateCheckReport['status'],
  'checked' | 'cancelled' | 'reimported'
>;
/** The check that ended because an import returned all of its notes. */
let reimported = 0;
interface Provider {
  changed?: string[];
  missing?: string[];
  /** Notes the provider itself reports as no longer available. */
  withdrawn?: string[];
  fail?: Failure;
  hold?: boolean;
}
let provider: Provider = {};
let freshness: NoteFreshness[] = [];
let check: { id: number; selection: string[] } | null = null;
let checkId = 0;
let unsettled = false;
const checkRequests: string[][] = [];
let stopRequests = 0;
const heldChecks: Array<(how: 'answer' | 'timeout') => void> = [];
const isGranola = (item: ContextItem) => item.provider === 'granola';
function forget(sourceId?: string) {
  freshness = freshness.filter(
    (note) => sourceId !== undefined && note.sourceId !== sourceId,
  );
  if (!check) return;
  check.selection = check.selection.filter(
    (id) => sourceId !== undefined && id !== sourceId,
  );
  if (check.selection.length === 0) check = null;
}
function record(
  sourceId: string,
  state: NoteFreshness['state'],
  reason: NoteFreshness['reason'],
) {
  const earlier = freshness.find((note) => note.sourceId === sourceId);
  const next: NoteFreshness = {
    sourceId,
    revision: items.find(
      (item) => isGranola(item) && item.sourceId === sourceId,
    )!.revision,
    state,
    // A withdrawn copy stays withheld until a check or import returns it.
    reason:
      state === 'notVerified' &&
      earlier &&
      (earlier.reason === 'withdrawn' || earlier.reason === 'revoked')
        ? earlier.reason
        : reason,
    verifiedAtMs:
      state === 'notVerified' ? (earlier?.verifiedAtMs ?? null) : CHECKED_AT_MS,
    providerUpdatedAtMs: null,
  };
  freshness = [...freshness.filter((note) => note.sourceId !== sourceId), next];
}
const report = (status: UpdateCheckReport['status']): UpdateCheckReport => ({
  status,
  retryAfterS: status === 'rateLimited' ? 7 : null,
  notes: currentFreshness(),
});
const currentFreshness = () =>
  freshness.flatMap((note) => {
    const item = items.find(
      (item) =>
        isGranola(item) &&
        item.sourceId === note.sourceId &&
        item.revision === note.revision,
    );
    return item
      ? [
          {
            ...note,
            providerUpdatedAtMs: item.revision > 1 ? item.revision : null,
          },
        ]
      : [];
  });
async function checkUpdates(): Promise<UpdateCheckReport> {
  if (!connected) throw new Error('Connect Granola first.');
  if (!updateCheck)
    throw new Error(
      'This Granola connection cannot be checked for updates yet.',
    );
  if (check) throw new Error('A check is already running.');
  if (unsettled)
    throw new Error(
      'The earlier check has not finished at Granola yet. Try again in a moment.',
    );
  const selection = items.filter(isGranola).map((item) => item.sourceId);
  if (selection.length === 0) throw new Error('No Granola notes are selected.');
  const id = ++checkId;
  check = { id, selection };
  checkRequests.push([...selection]);
  const plan = { ...provider };
  if (plan.hold) {
    unsettled = true;
    const how = await new Promise<'answer' | 'timeout'>((resolve) => {
      heldChecks.push(resolve);
    });
    // After a local timeout the sent request is still out.
    if (how === 'timeout') plan.fail = 'timedOut';
    else unsettled = false;
  }
  if (check?.id !== id)
    return report(reimported === id ? 'reimported' : 'cancelled');
  const kept = check.selection.filter((sourceId) =>
    items.some((item) => isGranola(item) && item.sourceId === sourceId),
  );
  check = null;
  if (plan.fail) {
    const reason: Record<Failure, NoteFreshness['reason']> = {
      timedOut: 'timedOut',
      workspaceUnverified: 'workspace',
      workspaceChanged: 'workspace',
      unavailable: 'unavailable',
      expired: 'expired',
      revoked: 'revoked',
      rateLimited: 'rateLimited',
      unsupportedFormat: 'unsupportedFormat',
    };
    for (const sourceId of kept)
      record(sourceId, 'notVerified', reason[plan.fail]);
    return report(plan.fail);
  }
  let changed = false;
  for (const sourceId of kept) {
    const item = items.find(
      (item) => isGranola(item) && item.sourceId === sourceId,
    )!;
    if (plan.withdrawn?.includes(sourceId))
      record(sourceId, 'notVerified', 'withdrawn');
    else if (plan.missing?.includes(sourceId))
      record(sourceId, 'notVerified', 'missing');
    else if (
      plan.changed?.includes(sourceId) &&
      item.revision < PROVIDER_UPDATED_AT_MS
    ) {
      item.excerpt = 'Robin moved the open day to Sunday.';
      item.revision = PROVIDER_UPDATED_AT_MS;
      changed = true;
      record(sourceId, 'updated', null);
    } else record(sourceId, 'current', null);
  }
  if (changed) await emit('context:changed', items);
  return report('checked');
}
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
  'check_granola_updates',
  'stop_granola_update_check',
];
const status = () => ({
  connected,
  tools: connected
    ? ['list_meetings', 'get_meetings', 'query_granola_meetings']
    : [],
  updateCheck: connected && updateCheck,
  freshness: currentFreshness(),
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
      check = null;
      // What could not be confirmed stays marked after disconnecting.
      freshness = freshness.filter((note) => note.state === 'notVerified');
      return status();
    case 'check_granola_updates':
      return checkUpdates();
    case 'stop_granola_update_check':
      stopRequests++;
      check = null;
      return;
    case 'context_items':
      return items;
    case 'remove_context_item': {
      const { provider, sourceId } = args as ContextItem;
      items = items.filter(
        (item) => item.provider !== provider || item.sourceId !== sourceId,
      );
      if (provider === 'granola') forget(sourceId);
      await emit('context:changed', items);
      return;
    }
    case 'remove_context_from': {
      const removed = items.length;
      items = [];
      forget();
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
        .map(
          (note): ContextItem =>
            // As in the store, a repeated import keeps the existing copy.
            items.find((item) => item.sourceId === note.sourceId) ?? {
              ...note,
              provider: 'granola',
              excerpt:
                'Robin will label the watering cans before the open day.',
              revision: IMPORTED_AT_MS,
            },
        );
      pending = false;
      // An import is a fresh read: earlier findings about these notes end.
      const pendingCheck = check?.id;
      for (const id of ids) forget(id);
      if (pendingCheck && !check) reimported = pendingCheck;
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
      /** How the simulated provider answers the next update checks. */
      setProvider: (next: Provider) => void;
      releaseCheck: () => void;
      timeOutCheck: () => void;
      /** The request that timed out locally has now ended at the provider. */
      settleCheck: () => void;
      checkRequests: string[][];
      stopRequests: number;
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
  setProvider: (next) => {
    provider = next;
  },
  releaseCheck: () => heldChecks.shift()?.('answer'),
  timeOutCheck: () => heldChecks.shift()?.('timeout'),
  settleCheck: () => {
    unsettled = false;
  },
  checkRequests,
  get stopRequests() {
    return stopRequests;
  },
};
