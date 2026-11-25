// Fictional meeting notes for browser tests: an in-memory stand-in for the
// Rust notes commands. It records what the notebook asked for and contacts
// nothing; the real request, checks and prompt are tested in Rust.
import type { Snapshot } from '../../src/lib/types';
import type {
  MeetingNotesDraft,
  MeetingNotesPlan,
} from '../../src/lib/meetingNotes';
import type { CueProvider } from '../../src/lib/providerKeys';
import {
  currentPreferences,
  providerName as getProviderName,
  setCuratedNotesModel,
} from './native-provider-keys';

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
let draft: MeetingNotesDraft | null = null;
let failure: string | null = null;
let kept: string | null = null;
let hold = false;
let release: (() => void) | undefined;
let failNext: string | null = null;
let refuseNext: string | null = null;
let cancelled = false;

function notesDestination(provider: CueProvider): string {
  switch (provider) {
    case 'openai':
      return 'the OpenAI API (US), with your own OpenAI API key, billed to your OpenAI account';
    case 'gemini':
      return 'the Gemini API (Google AI Studio), with your own Gemini API key, billed to your Google account';
    default:
      return 'the Anthropic API (US), with your own Anthropic API key, billed to your Anthropic account';
  }
}

/** Stands in for Rust's digest of exactly what would be sent. */
const fingerprint = (current: Snapshot, include: boolean) => {
  const prefs = currentPreferences();
  return `fictional-${prefs.cueProvider}-${current.transcript.length}-${prefs.effectiveNotesModel}-${include ? current.notes : ''}`;
};

const baseFictionalDraft = {
  markdown:
    "## Meeting notes\n\nWritten by a model from this meeting's transcript.\n\n### Summary\n\n- The greenhouse keys were discussed. (transcript 00:05)\n\n### Decisions\n\nNone stated.\n\n### Action items\n\n- Return the keys to the blue tin. Owner: not stated. Due: not stated. (transcript 00:05)\n\n### Open questions\n\nNone stated.\n",
  items: [
    {
      section: 'summary' as const,
      text: 'The greenhouse keys were discussed.',
      sources: [
        {
          label: 'transcript 00:05',
          text: 'The fictional greenhouse keys are in the blue tin.',
        },
      ],
    },
    {
      section: 'actions' as const,
      text: 'Return the keys to the blue tin.',
      sources: [
        {
          label: 'transcript 00:05',
          text: 'The fictional greenhouse keys are in the blue tin.',
        },
      ],
    },
  ],
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
  const prefs = currentPreferences();
  const provider = prefs.cueProvider;
  const providerName = getProviderName(provider);
  const customModel = prefs.effectiveNotesCustom;

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
        provider,
        providerName,
        model: prefs.effectiveNotesModel,
        customModel,
        likelyMicroUsd: customModel ? null : 74_000,
        worstMicroUsd: customModel ? null : 336_000,
        spendCapMicroUsd: customModel ? null : 1_000_000,
        destination: notesDestination(provider),
        cueSpentMicroUsd: 12_000,
        fingerprint: fingerprint(current, include),
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
      const { includeNotes, fingerprint: confirmed } = args as {
        includeNotes: boolean;
        fingerprint: string;
      };
      if (confirmed !== fingerprint(current, includeNotes))
        throw 'What would be sent has changed since you looked (the transcript, your notes or the notes setting). Review it again. Nothing was sent.';
      cancelled = false;
      await publish({ meetingNotes: 'writing' });
      if (hold) {
        hold = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
      // Stop waiting while the key was being read: nothing is sent.
      if (cancelled) {
        await publish({ meetingNotes: 'none' });
        throw 'Stopped before anything was sent. Nothing was sent.';
      }
      if (failNext) {
        failure = failNext;
        failNext = null;
        await publish({ meetingNotes: 'failed' });
        throw failure;
      }
      draft = {
        ...structuredClone(baseFictionalDraft),
        spentMicroUsd: customModel ? null : 41_000,
        providerName,
        customModel,
      };
      await publish({ meetingNotes: 'draft' });
      return draft;
    }
    case 'cancel_meeting_notes':
      cancelled = true;
      release?.();
      return;
    case 'meeting_notes_result':
      return {
        ...(draft && phase === 'draft' ? { draft } : {}),
        ...(failure && phase === 'failed' ? { failure } : {}),
        ...(kept && phase === 'kept' ? { kept } : {}),
        ...(draft && phase === 'draft'
          ? { spentMicroUsd: draft.spentMicroUsd ?? null }
          : {}),
        providerName,
        customModel,
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
      return prefs.effectiveNotesModel;
    case 'set_meeting_notes_model': {
      return setCuratedNotesModel((args as { model: string }).model);
    }
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
