// Fictional component fixture only. No history files, accounts, or providers.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import type { ContextItem } from '../../src/lib/types';
import '../../src/styles.css';

const params = new URLSearchParams(location.search);
Object.defineProperty(window, 'isTauri', { value: true, configurable: true });
let scenario = params.get('case') ?? 'none';
let fail = scenario === 'error';
let hold = params.has('hold');
const pending: (() => void)[] = [];
const calls: { name: string; args: unknown }[] = [];
let imported: (items: ContextItem[]) => void = () => {};
const listing = () => {
  const archived = scenario === 'archived';
  const hasNotes = ![
    'none',
    'transcript-only',
    'unreadable',
    'partial-unreadable',
  ].includes(scenario);
  const unavailable = ['labRun', 'newer', 'unavailable'].includes(scenario);
  return {
    availability: unavailable ? scenario : 'on',
    meetings:
      scenario === 'none' || scenario === 'unreadable' || unavailable
        ? []
        : [
            {
              id: 'garden-notes',
              title: 'Fictional garden review',
              revision: 1,
              startedAtMs: Date.UTC(2026, 10, 10),
              durationMs: 600_000,
              sources: 'microphone',
              hasNotes: scenario === 'metadata-unknown' ? undefined : hasNotes,
              hasMeetingNotes: false,
              archived,
            },
          ],
    folders: [],
    unreadable:
      scenario === 'unreadable' ? 2 : scenario === 'partial-unreadable' ? 1 : 0,
  };
};
mockIPC(
  async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    switch (name) {
      case 'granola_status':
        return { connected: false, tools: [] };
      case 'kept_meetings': {
        const result = listing();
        if (hold) await new Promise<void>((resolve) => pending.push(resolve));
        if (fail) throw new Error('Fictional metadata read failed.');
        return result;
      }
      case 'meeting_history_status':
        return {
          availability: listing().availability,
          autoPriorContext: scenario !== 'auto-off',
          afterSessionKeep: scenario === 'saving-off' ? 'off' : 'auto',
          session: 1,
        };
      case 'list_kept_meetings_for_context':
        return {
          fileName: 'kept meetings',
          notes: listing()
            .meetings.filter((meeting) => meeting.hasNotes)
            .map((meeting) => ({
              sourceId: meeting.id,
              title: meeting.title,
              sourceDate: '2026-11-10',
              preview: 'Written note: check the garden gate.',
            })),
          skipped: listing().meetings.filter((meeting) => !meeting.hasNotes)
            .length,
          asksForDates: false,
        };
      case 'import_context_notes': {
        const ids = (args as { ids: string[] }).ids;
        imported(
          ids.map((sourceId) => ({
            provider: 'history',
            sourceId,
            title: 'Fictional garden review',
            sourceDate: '2026-11-10',
            excerpt: 'Written note: check the garden gate.',
            revision: 1,
          })),
        );
        return {
          added: ids.length,
          updated: 0,
          unchanged: 0,
          rejected: 0,
          overLimit: 0,
        };
      }
      case 'cancel_context_import':
        return;
    }
    throw new Error(`Unexpected fixture command: ${name}`);
  },
  { shouldMockEvents: true },
);
const { ContextNotes } = await import('../../src/components/ContextNotes');
function Fixture() {
  const [items, setItems] = useState<ContextItem[]>([]);
  const [notice, setNotice] = useState('');
  imported = setItems;
  return (
    <main className="secondary-page">
      <h1>Fictional prior context review</h1>
      <ContextNotes
        items={items}
        busy={false}
        onError={setNotice}
        onNotice={setNotice}
        onOpenMeetings={() => setNotice('Opened Meetings for review.')}
        onOpenSettings={() => setNotice('Opened meeting settings for review.')}
      />
      <p role="status">{notice}</p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
declare global {
  interface Window {
    priorContextTest: {
      calls: () => typeof calls;
      setScenario: (next: string, notify?: boolean) => Promise<void>;
      release: () => void;
      pending: () => number;
      useFileNotes: () => void;
    };
  }
}
window.priorContextTest = {
  calls: () => structuredClone(calls),
  setScenario: async (next, notify = true) => {
    scenario = next;
    fail = false;
    hold = false;
    if (notify) await emit('meeting-history:changed', null);
  },
  release: () => pending.splice(0).forEach((resolve) => resolve()),
  pending: () => pending.length,
  useFileNotes: () =>
    imported([
      {
        provider: 'file',
        sourceId: 'fictional-file',
        title: 'Fictional file notes',
        sourceDate: '2026-11-10',
        excerpt: 'Check the garden gate.',
        revision: 1,
      },
    ]),
};
