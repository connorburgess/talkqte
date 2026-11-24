// Fictional kept meetings for browser tests: an in-memory stand-in for the
// Rust history commands. It writes nothing; storage, permissions, versions
// and bounds are tested in Rust.
import { clockTime, type Snapshot } from '../../src/lib/types';
import type {
  HistoryAvailability,
  KeptMeeting,
  KeptSummary,
} from '../../src/lib/meetingHistory';

export const commands = [
  'meeting_history_status',
  'set_offer_to_keep',
  'keep_meeting_in_history',
  'update_kept_session_meeting',
  'kept_meetings',
  'open_kept_meeting',
  'rename_kept_meeting',
  'delete_kept_meeting',
  'delete_all_kept_meetings',
  'kept_meeting_export_preview',
  'export_kept_meeting',
];

/** Every command the notebook invoked, with its arguments. */
export const calls: { command: string; args: unknown }[] = [];
let availability: HistoryAvailability = 'on';
let offer = true;
let meetings: KeptMeeting[] = [];
let next = 0;
/** The session the last keep came from, and what it held then. */
let sessionKept: { id: string; notes: string; session: number } | null = null;
let failNext: string | null = null;
let unreadable = 0;
let pendingExport: string | null = null;
const exported: string[] = [];
let cancelNextExport = false;

const summary = (meeting: KeptMeeting): KeptSummary => ({
  id: meeting.id,
  title: meeting.title,
  revision: meeting.revision,
  startedAtMs: meeting.startedAtMs,
  durationMs: meeting.durationMs,
  sources: meeting.sources,
  hasMeetingNotes: meeting.meetingNotes !== undefined,
});

function fromSession(current: Snapshot, includeApplication: boolean) {
  const application = current.sources?.application;
  const both = !!(current.sources?.microphone && application);
  return {
    startedAtMs: Date.now() - current.elapsedMs,
    durationMs: current.elapsedMs,
    sources: both ? 'both' : application ? 'application' : 'microphone',
    application: includeApplication ? application : undefined,
    transcribedBy: 'Deepgram',
    transcript: current.transcript.map((line) => ({
      atMs: line.atMs,
      label:
        both && (line.speaker === 'You' || line.speaker === 'Them')
          ? (line.speaker.toLowerCase() as 'you' | 'them')
          : undefined,
      text: line.text,
    })),
    notes: current.notes,
    cues: [],
  } satisfies Omit<KeptMeeting, 'id' | 'title' | 'revision'>;
}

export function command(
  name: string,
  args: unknown,
  current: () => Snapshot,
  session: () => number,
) {
  calls.push({ command: name, args: structuredClone(args) });
  if (
    failNext &&
    name !== 'meeting_history_status' &&
    name !== 'kept_meetings'
  ) {
    const failure = failNext;
    failNext = null;
    throw failure;
  }
  const words = (query: string | null) =>
    (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  switch (name) {
    case 'meeting_history_status': {
      const kept =
        sessionKept && sessionKept.session === session()
          ? meetings.find((meeting) => meeting.id === sessionKept!.id)
          : undefined;
      return {
        availability,
        offer,
        session: session(),
        kept: kept && {
          id: kept.id,
          title: kept.title,
          changed: current().notes !== sessionKept!.notes,
        },
      };
    }
    case 'set_offer_to_keep':
      offer = (args as { offer: boolean }).offer;
      return null;
    case 'keep_meeting_in_history': {
      const { title, includeApplication } = args as {
        title: string;
        includeApplication: boolean;
      };
      const trimmed = title.trim();
      if (!trimmed) throw 'Give the meeting a title of up to 200 characters.';
      const meeting: KeptMeeting = {
        id: (++next).toString(16).padStart(32, '0'),
        title: trimmed,
        revision: 1,
        ...fromSession(current(), includeApplication),
      };
      meetings.push(meeting);
      sessionKept = {
        id: meeting.id,
        notes: current().notes,
        session: session(),
      };
      return summary(meeting);
    }
    case 'update_kept_session_meeting': {
      const meeting = meetings.find((item) => item.id === sessionKept?.id);
      if (!meeting) throw 'That meeting is no longer kept.';
      meeting.notes = current().notes;
      meeting.revision += 1;
      sessionKept!.notes = current().notes;
      return summary(meeting);
    }
    case 'kept_meetings': {
      const query = words((args as { query: string | null }).query);
      if (availability !== 'on')
        return { availability, meetings: [], unreadable: 0 };
      const found = meetings
        .filter((meeting) => {
          const text = [
            meeting.title,
            meeting.notes,
            meeting.meetingNotes ?? '',
            ...meeting.transcript.map((line) => line.text),
            ...meeting.cues.flatMap((cue) => [cue.question, cue.evidence]),
          ]
            .join('\n')
            .toLowerCase();
          return query.every((word) => text.includes(word));
        })
        .sort((a, b) => b.startedAtMs - a.startedAtMs)
        .map(summary);
      return { availability, meetings: found, unreadable };
    }
    case 'open_kept_meeting': {
      const meeting = meetings.find(
        (item) => item.id === (args as { id: string }).id,
      );
      if (!meeting) throw 'That meeting is no longer kept.';
      return structuredClone(meeting);
    }
    case 'rename_kept_meeting': {
      const { id, title } = args as { id: string; title: string };
      const meeting = meetings.find((item) => item.id === id);
      if (!meeting) throw 'That meeting is no longer kept.';
      if (!title.trim())
        throw 'Give the meeting a title of up to 200 characters.';
      meeting.title = title.trim().replace(/\s+/g, ' ');
      meeting.revision += 1;
      pendingExport = null;
      return summary(meeting);
    }
    case 'delete_kept_meeting': {
      const { id } = args as { id: string };
      if (!meetings.some((item) => item.id === id))
        throw 'That meeting is no longer kept.';
      meetings = meetings.filter((item) => item.id !== id);
      if (sessionKept?.id === id) sessionKept = null;
      pendingExport = null;
      return null;
    }
    case 'delete_all_kept_meetings': {
      const count = meetings.length;
      meetings = [];
      sessionKept = null;
      unreadable = 0;
      availability = 'on';
      pendingExport = null;
      return count;
    }
    case 'kept_meeting_export_preview': {
      const { id } = args as { id: string };
      const meeting = meetings.find((item) => item.id === id);
      if (!meeting) throw 'That meeting is no longer kept.';
      const flat = (text: string) => text.trim().replace(/\s+/g, ' ');
      const source =
        meeting.sources === 'microphone'
          ? 'Microphone'
          : meeting.sources === 'application'
            ? meeting.application
              ? `Application (${flat(meeting.application)})`
              : 'Application'
            : meeting.application
              ? `Microphone and ${flat(meeting.application)}`
              : 'Microphone and application';
      const lines = [
        `# ${flat(meeting.title)}`,
        '',
        `Length ${clockTime(meeting.durationMs)} · ${source}`,
        '',
        '## Notes',
        '',
        meeting.notes.trim() ? meeting.notes : 'None.',
      ];
      if (meeting.meetingNotes !== undefined) {
        lines.push('', meeting.meetingNotes);
      }
      lines.push('', '## Cues shown', '');
      if (meeting.cues.length === 0) {
        lines.push('None.');
      } else {
        for (const cue of meeting.cues) {
          const ev = cue.evidence.trim()
            ? ` (from: "${flat(cue.evidence)}")`
            : '';
          lines.push(
            `- ${clockTime(cue.atMs)} · ${flat(cue.kind)}: ${flat(cue.question)}${ev}`,
          );
        }
      }
      lines.push('', '## Transcript', '');
      if (meeting.transcribedBy) {
        lines.push(
          `Transcribed by ${flat(meeting.transcribedBy)}. Speakers are not identified.`,
          '',
        );
      }
      if (meeting.transcript.length === 0) {
        lines.push('None.');
      } else {
        for (const line of meeting.transcript) {
          const label =
            meeting.sources === 'both'
              ? line.echo
                ? ' You (likely an echo of Them):'
                : line.label === 'you'
                  ? ' You:'
                  : line.label === 'them'
                    ? ' Them:'
                    : ''
              : '';
          lines.push(`- ${clockTime(line.atMs)}${label} ${flat(line.text)}`);
        }
      }
      pendingExport = `${lines.join('\n')}\n`;
      return pendingExport;
    }
    case 'export_kept_meeting': {
      if (!pendingExport)
        throw 'Review the export before choosing a destination.';
      if (cancelNextExport) {
        cancelNextExport = false;
        return false;
      }
      exported.push(pendingExport);
      pendingExport = null;
      return true;
    }
  }
  throw new Error(`unknown history command ${name}`);
}

declare global {
  interface Window {
    historyTest: {
      calls: typeof calls;
      meetings: () => KeptMeeting[];
      exports: () => string[];
      add: (meeting: Omit<KeptMeeting, 'id' | 'revision'>) => string;
      setAvailability: (value: HistoryAvailability) => void;
      setUnreadable: (count: number) => void;
      failNext: (message: string) => void;
      cancelNextExport: () => void;
    };
  }
}

window.historyTest = {
  calls,
  meetings: () => structuredClone(meetings),
  exports: () => [...exported],
  add: (meeting) => {
    const id = (++next).toString(16).padStart(32, '0');
    meetings.push({ ...meeting, id, revision: 1 });
    return id;
  },
  setAvailability: (value) => {
    availability = value;
  },
  setUnreadable: (count) => {
    unreadable = count;
  },
  failNext: (message) => {
    failNext = message;
  },
  cancelNextExport: () => {
    cancelNextExport = true;
  },
};
