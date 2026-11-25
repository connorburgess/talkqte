// Fictional kept meetings for browser tests: an in-memory stand-in for the
// Rust history commands. It writes nothing; storage, permissions, versions
// and bounds are tested in Rust.
import {
  clockTime,
  type ContextItem,
  type EndPrompt,
  type EndPromptAction,
  type PickedNotes,
  type Snapshot,
} from '../../src/lib/types';
import type {
  AfterSessionKeep,
  HistoryAvailability,
  KeptMeeting,
  KeptSummary,
} from '../../src/lib/meetingHistory';

function defaultTitle(startedAtMs: number): string {
  const when = new Date(startedAtMs);
  if (Number.isNaN(when.getTime())) return 'Kept meeting';
  const date = when.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const time = when.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Meeting, ${date}, ${time}`;
}

export const commands = [
  'meeting_history_status',
  'set_after_session_keep',
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
let afterSessionKeep: AfterSessionKeep = 'auto';
let meetings: KeptMeeting[] = [];
let next = 0;
/** The session the last keep came from, and what it held then. */
let sessionKept: { id: string; notes: string; session: number } | null = null;
let endPrompt: (EndPrompt & { keptId: string | null }) | null = null;
let failNext: string | null = null;
let unreadable = 0;
let pendingExport: string | null = null;
const exported: string[] = [];
let cancelNextExport = false;
let pendingContext: ContextItem[] | null = null;

function toContextItem(meeting: KeptMeeting): ContextItem | null {
  const mn = meeting.meetingNotes?.trim() || '';
  const n = meeting.notes.trim();
  const excerpt =
    mn && n ? `Meeting notes:\n${mn}\n\nYour notes:\n${n}` : mn || n;
  if (!excerpt) return null;
  const date = new Date(meeting.startedAtMs).toISOString().slice(0, 10);
  return {
    provider: 'history',
    sourceId: meeting.id,
    title: meeting.title,
    sourceDate: date,
    excerpt: excerpt.slice(0, 2000),
    revision: meeting.revision,
  };
}

export function listForContext(): PickedNotes {
  if (availability === 'newer')
    throw 'Your kept meetings were saved by a newer TalkQTE. This version leaves them as they are; update TalkQTE to change them.';
  if (availability !== 'on')
    throw 'Kept meetings are not available in this launch.';
  const sorted = [...meetings].sort((a, b) => b.startedAtMs - a.startedAtMs);
  const items: ContextItem[] = [];
  let skipped = 0;
  for (const meeting of sorted) {
    const item = toContextItem(meeting);
    if (item && items.length < 200) items.push(item);
    else skipped++;
  }
  pendingContext = items;
  return {
    fileName: 'kept meetings',
    notes: items.map((item) => {
      const flat = item.excerpt.replace(/\s+/g, ' ').trim();
      return {
        sourceId: item.sourceId,
        title: item.title,
        sourceDate: item.sourceDate,
        preview: flat.length > 120 ? `${flat.slice(0, 120)}…` : flat,
      };
    }),
    skipped,
    asksForDates: false,
  };
}

export function hasPendingContext() {
  return pendingContext !== null;
}

export function cancelPendingContext() {
  pendingContext = null;
}

export function importPendingContext(ids: string[]) {
  const list = pendingContext ?? [];
  pendingContext = null;
  const selected = list.filter((item) => ids.includes(item.sourceId));
  return {
    outcome: {
      added: selected.length,
      updated: 0,
      unchanged: 0,
      overLimit: 0,
      rejected: 0,
    },
    items: selected,
  };
}

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

export function resetAfterSessionKeep() {
  afterSessionKeep = 'auto';
}

export function currentEndPrompt(session: number): EndPrompt | null {
  if (!endPrompt || endPrompt.session !== session) return null;
  return {
    session: endPrompt.session,
    state: endPrompt.state,
    transcriptLines: endPrompt.transcriptLines,
    hasNotes: endPrompt.hasNotes,
    ...(endPrompt.error ? { error: endPrompt.error } : {}),
  };
}

export function clearEndPrompt() {
  endPrompt = null;
}

function saveSessionMeeting(
  current: Snapshot,
  session: number,
  title: string,
  includeApplication: boolean,
): KeptMeeting {
  if (failNext) {
    const failure = failNext;
    failNext = null;
    throw failure;
  }
  const meeting: KeptMeeting = {
    id: (++next).toString(16).padStart(32, '0'),
    title,
    revision: 1,
    ...fromSession(current, includeApplication),
  };
  meetings.push(meeting);
  sessionKept = {
    id: meeting.id,
    notes: current.notes,
    session,
  };
  return meeting;
}

export function onSessionEnded(
  current: Snapshot,
  session: number,
): { endPrompt: EndPrompt | null; changed: boolean } {
  const transcriptLines = current.transcript.length;
  const hasNotes = current.notes.trim().length > 0;
  if (
    !current.live ||
    current.status !== 'ended' ||
    availability !== 'on' ||
    (transcriptLines === 0 && !hasNotes) ||
    afterSessionKeep === 'off'
  ) {
    endPrompt = null;
    return { endPrompt: null, changed: false };
  }
  if (afterSessionKeep === 'auto') {
    const existing =
      sessionKept && sessionKept.session === session
        ? meetings.find((item) => item.id === sessionKept!.id)
        : undefined;
    if (existing) {
      endPrompt = {
        session,
        state: 'saved',
        transcriptLines,
        hasNotes,
        keptId: existing.id,
      };
      return { endPrompt: currentEndPrompt(session), changed: false };
    }
    try {
      const meeting = saveSessionMeeting(
        current,
        session,
        defaultTitle(Date.now() - current.elapsedMs),
        false,
      );
      endPrompt = {
        session,
        state: 'saved',
        transcriptLines,
        hasNotes,
        keptId: meeting.id,
      };
      return { endPrompt: currentEndPrompt(session), changed: true };
    } catch (problem) {
      endPrompt = {
        session,
        state: 'ask',
        transcriptLines,
        hasNotes,
        keptId: null,
        error: typeof problem === 'string' ? problem : String(problem),
      };
      return { endPrompt: currentEndPrompt(session), changed: false };
    }
  }
  endPrompt = {
    session,
    state: 'ask',
    transcriptLines,
    hasNotes,
    keptId: null,
  };
  return { endPrompt: currentEndPrompt(session), changed: false };
}

export function respondToEndPrompt(
  action: EndPromptAction,
  requestedSession: number,
  current: Snapshot,
  activeSession: number,
): {
  endPrompt: EndPrompt | null;
  changed: boolean;
  openId?: string;
  writeNotes?: boolean;
} {
  if (
    !endPrompt ||
    endPrompt.session !== requestedSession ||
    requestedSession !== activeSession
  ) {
    return { endPrompt: currentEndPrompt(activeSession), changed: false };
  }
  if (action === 'dismiss') {
    endPrompt = null;
    return { endPrompt: null, changed: false };
  }
  if (action === 'writeNotes') {
    if (endPrompt.transcriptLines === 0) {
      return { endPrompt: currentEndPrompt(activeSession), changed: false };
    }
    endPrompt = null;
    return { endPrompt: null, changed: false, writeNotes: true };
  }
  if (action === 'open') {
    const id = endPrompt.keptId;
    if (!id)
      return { endPrompt: currentEndPrompt(activeSession), changed: false };
    endPrompt = null;
    return { endPrompt: null, changed: false, openId: id };
  }
  if (action === 'keep') {
    const existing =
      sessionKept && sessionKept.session === activeSession
        ? meetings.find((item) => item.id === sessionKept!.id)
        : undefined;
    if (existing) {
      endPrompt = {
        ...endPrompt,
        state: 'kept',
        keptId: existing.id,
        error: undefined,
      };
      return { endPrompt: currentEndPrompt(activeSession), changed: false };
    }
    try {
      const meeting = saveSessionMeeting(
        current,
        activeSession,
        defaultTitle(Date.now() - current.elapsedMs),
        false,
      );
      endPrompt = {
        ...endPrompt,
        state: 'kept',
        keptId: meeting.id,
        error: undefined,
      };
      return { endPrompt: currentEndPrompt(activeSession), changed: true };
    } catch (problem) {
      endPrompt = {
        ...endPrompt,
        state: 'ask',
        error: typeof problem === 'string' ? problem : String(problem),
      };
      return { endPrompt: currentEndPrompt(activeSession), changed: false };
    }
  }
  if (action === 'delete') {
    const id = endPrompt.keptId;
    if (!id) {
      endPrompt = null;
      return { endPrompt: null, changed: false };
    }
    if (failNext) {
      const problem = failNext;
      failNext = null;
      endPrompt = { ...endPrompt, error: problem };
      return { endPrompt: currentEndPrompt(activeSession), changed: false };
    }
    meetings = meetings.filter((item) => item.id !== id);
    if (sessionKept?.id === id) sessionKept = null;
    pendingExport = null;
    endPrompt = null;
    return { endPrompt: null, changed: true };
  }
  return { endPrompt: currentEndPrompt(activeSession), changed: false };
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
        afterSessionKeep,
        session: session(),
        kept: kept && {
          id: kept.id,
          title: kept.title,
          changed: current().notes !== sessionKept!.notes,
        },
      };
    }
    case 'set_after_session_keep':
      afterSessionKeep = (args as { mode: AfterSessionKeep }).mode;
      return null;
    case 'keep_meeting_in_history': {
      const { title, includeApplication } = args as {
        title: string;
        includeApplication: boolean;
      };
      const trimmed = title.trim();
      if (!trimmed) throw 'Give the meeting a title of up to 200 characters.';
      const snapshot = current();
      if (snapshot.transcript.length === 0 && !snapshot.notes.trim())
        throw 'Nothing to keep yet.';
      const meeting = saveSessionMeeting(
        snapshot,
        session(),
        trimmed,
        includeApplication,
      );
      endPrompt = null;
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
      if (endPrompt?.keptId === id) endPrompt = null;
      pendingExport = null;
      return null;
    }
    case 'delete_all_kept_meetings': {
      const count = meetings.length;
      meetings = [];
      sessionKept = null;
      endPrompt = null;
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
      setAfterSessionKeep: (value: AfterSessionKeep) => void;
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
  setAfterSessionKeep: (value) => {
    afterSessionKeep = value;
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
