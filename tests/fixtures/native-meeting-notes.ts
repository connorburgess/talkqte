// Fictional meeting notes for browser tests: an in-memory stand-in for the
// Rust notes commands. It records what the notebook asked for and contacts
// nothing; the real request, checks and prompt are tested in Rust.
import type { Snapshot } from '../../src/lib/types';
import type {
  MeetingNotesDraft,
  MeetingNotesPlan,
} from '../../src/lib/meetingNotes';

export const commands = [
  'meeting_notes_plan',
  'write_meeting_notes',
  'cancel_meeting_notes',
  'meeting_notes_result',
  'keep_meeting_notes',
  'discard_meeting_notes',
  'meeting_notes_model',
  'set_meeting_notes_model',
];

type Publish = (value: Partial<Snapshot>) => Promise<void>;

/** Every command the notebook invoked, with its arguments. */
export const calls: { command: string; args: unknown }[] = [];
let model = 'claude-opus-5-5';
let draft: MeetingNotesDraft | null = null;
let failure: string | null = null;
let kept: string | null = null;
let hold = false;
let release: (() => void) | undefined;
let failNext: string | null = null;
let refuseNext: string | null = null;

const fictionalDraft: MeetingNotesDraft = {
  markdown:
    "## Meeting notes\n\nWritten by a model from this meeting's transcript.\n\n### Summary\n\n- The greenhouse keys were discussed. (transcript 00:05)\n\n### Decisions\n\nNone stated.\n\n### Action items\n\n- Return the keys to the blue tin. Owner: not stated. Due: not stated. (transcript 00:05)\n\n### Open questions\n\nNone stated.\n",
  items: [
    {
      section: 'summary',
      text: 'The greenhouse keys were discussed.',
      sources: [
        {
          label: 'transcript 00:05',
          text: 'The fictional greenhouse keys are in the blue tin.',
        },
      ],
    },
    {
      section: 'actions',
      text: 'Return the keys to the blue tin.',
      sources: [
        {
          label: 'transcript 00:05',
          text: 'The fictional greenhouse keys are in the blue tin.',
        },
      ],
    },
  ],
  spentMicroUsd: 41_000,
};

/** Kept notes, for the stand-in's export preview. */
export const keptNotes = () => kept;

export async function command(
  name: string,
  args: unknown,
  publish: Publish,
  session: () => Snapshot,
) {
  calls.push({ command: name, args: structuredClone(args) });
  const current = session();
  const phase = current.meetingNotes ?? 'none';
  switch (name) {
    case 'meeting_notes_plan': {
      if (!current.live || current.status !== 'ended')
        throw 'Meeting notes can be written once a live session has ended. Nothing was sent.';
      if (phase !== 'none')
        throw 'Notes were already requested for this meeting. Each meeting gets one request. Nothing was sent.';
      const include = (args as { includeNotes: boolean }).includeNotes;
      const plan: MeetingNotesPlan = {
        transcriptLines: current.transcript.length,
        minutes: 1,
        kilobytes: 1,
        model,
        likelyMicroUsd: 74_000,
        worstMicroUsd: 336_000,
        spendCapMicroUsd: 1_000_000,
        destination:
          'the Anthropic API (US), with your own Anthropic API key, billed to your Anthropic account',
        cueSpentMicroUsd: 12_000,
      };
      if (include)
        plan.noteLines = current.notes
          .split('\n')
          .filter((l) => l.trim()).length;
      return plan;
    }
    case 'write_meeting_notes': {
      if (refuseNext) {
        const refusal = refuseNext;
        refuseNext = null;
        throw refusal;
      }
      await publish({ meetingNotes: 'writing' });
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
      if (failNext) {
        failure = failNext;
        failNext = null;
        await publish({ meetingNotes: 'failed' });
        throw failure;
      }
      draft = structuredClone(fictionalDraft);
      await publish({ meetingNotes: 'draft' });
      return draft;
    }
    case 'cancel_meeting_notes':
      failNext =
        'Cancelled. What was already sent may still be billed. No notes were written, and nothing else will be sent for this meeting.';
      release?.();
      return;
    case 'meeting_notes_result':
      return {
        ...(draft && phase === 'draft' ? { draft } : {}),
        ...(failure && phase === 'failed' ? { failure } : {}),
        ...(kept && phase === 'kept' ? { kept } : {}),
        spentMicroUsd: 41_000,
      };
    case 'keep_meeting_notes':
      kept = (args as { markdown: string }).markdown;
      draft = null;
      await publish({ meetingNotes: 'kept' });
      return;
    case 'discard_meeting_notes':
      kept = null;
      draft = null;
      await publish({ meetingNotes: 'discarded' });
      return;
    case 'meeting_notes_model':
      return model;
    case 'set_meeting_notes_model':
      model = (args as { model: string }).model;
      return model;
  }
}

export const meetingNotesTest = {
  calls,
  hold: () => {
    hold = true;
  },
  release: () => release?.(),
  failNext: (text: string) => {
    failNext = text;
  },
  refuseNext: (text: string) => {
    refuseNext = text;
  },
  /** A new session: the stand-in forgets this one's notes. */
  reset: () => {
    draft = null;
    failure = null;
    kept = null;
  },
};

declare global {
  interface Window {
    meetingNotesTest: typeof meetingNotesTest;
  }
}
window.meetingNotesTest = meetingNotesTest;
