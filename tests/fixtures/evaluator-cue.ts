import type { Cue, CueSource } from '../../src/lib/types';

// Fictional disclosure only. No evaluator, account, or meeting is used.
export const mixedSources: CueSource[] = [
  {
    id: 'transcript:line-1',
    revision: 0,
    text: 'Can we send the garden guide on Friday?',
    provenance: { kind: 'transcript', atMs: 62_000, speaker: 'Maya' },
  },
  {
    id: 'prior:granola:review',
    revision: 7,
    text: 'Legal review takes two days.',
    provenance: {
      kind: 'priorNote',
      provider: 'granola',
      date: '2026-11-01',
      title: 'Garden guide review',
    },
  },
  {
    id: 'prior:file:print',
    revision: 2,
    text: 'Leave one day for printing.',
    provenance: {
      kind: 'priorNote',
      provider: 'file',
      date: '2026-11-02',
      title: 'Printing plan',
    },
  },
];

export const mixedCue: Cue = {
  id: 'fictional-evaluation',
  kind: 'Suggestion',
  question: 'Will the draft be ready Tuesday?',
  // The pre-change UI renders this as one transcript quote. Typed sources
  // let the new UI disclose each original without that false attribution.
  evidence:
    '1:02 · Maya\nCan we send the garden guide on Friday?\n\nPrior note · granola · 2026-11-01 · Garden guide review\nLegal review takes two days.\n\nPrior note · file · 2026-11-02 · Printing plan\nLeave one day for printing.',
  sourceId: mixedSources[0].id,
  sources: mixedSources,
  remainingMs: 18_000,
  totalMs: 18_000,
  held: false,
  expanded: false,
  resolvedBy: null,
  note: null,
  aboutFocus: false,
};
