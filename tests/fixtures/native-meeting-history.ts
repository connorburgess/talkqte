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
  'set_auto_prior_context',
  'keep_meeting_in_history',
  'update_kept_session_meeting',
  'kept_meetings',
  'open_kept_meeting',
  'rename_kept_meeting',
  'rename_kept_meeting_speaker',
  'set_kept_meeting_archived',
  'delete_kept_meeting',
  'delete_all_kept_meetings',
  'create_meeting_folder',
  'rename_meeting_folder',
  'delete_meeting_folder',
  'set_kept_meeting_folder',
  'kept_meeting_export_preview',
  'export_kept_meeting',
];

const preloaded = window as typeof window & {
  standInMeetings?: Omit<KeptMeeting, 'id' | 'revision'>[];
  standInAutoPriorContext?: boolean;
};

/** Every command the notebook invoked, with its arguments. */
export const calls: { command: string; args: unknown }[] = [];
let availability: HistoryAvailability = 'on';
let afterSessionKeep: AfterSessionKeep = 'auto';
let autoPriorContext: boolean = preloaded.standInAutoPriorContext ?? true;
let meetings: KeptMeeting[] = [];
let folders: string[] = [];
let next = 0;
let autoContextItems: ContextItem[] = [];
const manualContextItems = new Map<string, ContextItem>();
const dismissedAutoIds = new Set<string>();

for (const item of preloaded.standInMeetings ?? []) {
  const id = (++next).toString(16).padStart(32, '0');
  meetings.push({ ...item, id, revision: 1 });
}

const AUTO_STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'agenda',
  'ahead',
  'all',
  'and',
  'any',
  'are',
  'but',
  'call',
  'can',
  'catch',
  'check',
  'could',
  'daily',
  'discussion',
  'every',
  'first',
  'for',
  'from',
  'going',
  'has',
  'have',
  'into',
  'live',
  'meeting',
  'minutes',
  'month',
  'monthly',
  'not',
  'notes',
  'other',
  'our',
  'people',
  'planning',
  'quick',
  'really',
  'review',
  'session',
  'should',
  'standup',
  'still',
  'sync',
  'talkqte',
  'team',
  'that',
  'the',
  'their',
  'there',
  'these',
  'thing',
  'things',
  'think',
  'this',
  'those',
  'today',
  'tomorrow',
  'update',
  'was',
  'weekly',
  'were',
  'where',
  'which',
  'while',
  'will',
  'with',
  'would',
  'yesterday',
  'your',
]);

function contextTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}']+/u)) {
    const word = raw.replace(/^'+|'+$/g, '').toLowerCase();
    if (
      word.length >= 3 &&
      /\p{L}/u.test(word) &&
      !AUTO_STOP_WORDS.has(word) &&
      !tokens.includes(word)
    ) {
      tokens.push(word);
    }
  }
  return tokens;
}

export function refreshAutoContext(
  focus: string[],
  sessionTitle: string | null,
  status: Snapshot['status'],
  live: boolean,
): boolean {
  if (availability !== 'on') {
    if (autoContextItems.length === 0) return false;
    autoContextItems = [];
    return true;
  }
  if (!autoPriorContext) {
    if (autoContextItems.length === 0) return false;
    autoContextItems = [];
    return true;
  }
  if (status !== 'ready' || live) return false;

  const keywords: string[] = [];
  for (const line of focus) {
    for (const token of contextTokens(line)) {
      if (!keywords.includes(token)) keywords.push(token);
    }
  }
  if (sessionTitle) {
    for (const token of contextTokens(sessionTitle)) {
      if (!keywords.includes(token)) keywords.push(token);
    }
  }

  const candidates: {
    item: ContextItem;
    startedAtMs: number;
    matched: number;
    titleMatched: number;
  }[] = [];
  for (const meeting of meetings) {
    if (meeting.archived) continue;
    if (dismissedAutoIds.has(meeting.id)) continue;
    if (manualContextItems.has(meeting.id)) continue;
    const item = toContextItem(meeting);
    if (!item) continue;
    let matched = 0;
    let titleMatched = 0;
    if (keywords.length > 0) {
      const titleTokens = contextTokens(item.title);
      const noteTokens = contextTokens(item.excerpt);
      for (const kw of keywords) {
        const inTitle = titleTokens.includes(kw);
        const inNotes = noteTokens.includes(kw);
        if (inTitle) titleMatched++;
        if (inTitle || inNotes) matched++;
      }
    }
    candidates.push({
      item: { ...item, autoSelected: true },
      startedAtMs: meeting.startedAtMs,
      matched,
      titleMatched,
    });
  }
  candidates.sort(
    (a, b) =>
      b.matched - a.matched ||
      b.titleMatched - a.titleMatched ||
      b.startedAtMs - a.startedAtMs ||
      a.item.sourceId.localeCompare(b.item.sourceId),
  );
  const nextAuto = candidates.slice(0, 3).map((c) => c.item);
  if (JSON.stringify(nextAuto) === JSON.stringify(autoContextItems)) {
    return false;
  }
  autoContextItems = nextAuto;
  return true;
}

if ((preloaded.standInMeetings ?? []).length > 0 && autoPriorContext) {
  refreshAutoContext([], null, 'ready', false);
}

export function selectedContextItems(): ContextItem[] {
  return structuredClone([...manualContextItems.values(), ...autoContextItems]);
}

export function removeHistoryContextItem(sourceId: string) {
  const id = sourceId.trim();
  manualContextItems.delete(id);
  autoContextItems = autoContextItems.filter((item) => item.sourceId !== id);
  dismissedAutoIds.add(id);
}

export function removeAllHistoryContext(): number {
  const count = manualContextItems.size + autoContextItems.length;
  for (const id of manualContextItems.keys()) dismissedAutoIds.add(id);
  for (const item of autoContextItems) dismissedAutoIds.add(item.sourceId);
  manualContextItems.clear();
  autoContextItems = [];
  return count;
}
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
  for (const item of selected) {
    autoContextItems = autoContextItems.filter(
      (auto) => auto.sourceId !== item.sourceId,
    );
    dismissedAutoIds.delete(item.sourceId);
    manualContextItems.set(item.sourceId, structuredClone(item));
  }
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
  ...(meeting.folder ? { folder: meeting.folder } : {}),
  archived: !!meeting.archived,
});

function cleanFolderName(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > 80)
    throw 'Give the folder a name of up to 80 characters.';
  return cleaned;
}

function fromSession(current: Snapshot, includeApplication: boolean) {
  const application = current.sources?.application;
  const both = !!(current.sources?.microphone && application);
  const speakerNames =
    current.speakerNames && Object.keys(current.speakerNames).length > 0
      ? structuredClone(current.speakerNames)
      : undefined;
  return {
    startedAtMs: Date.now() - current.elapsedMs,
    durationMs: current.elapsedMs,
    sources: both ? 'both' : application ? 'application' : 'microphone',
    application: includeApplication ? application : undefined,
    transcribedBy: 'Deepgram',
    transcript: current.transcript.map((line) => ({
      atMs: line.atMs,
      label:
        both && line.speakerId !== undefined
          ? ('them' as const)
          : both && (line.speaker === 'You' || line.speaker === 'Them')
            ? (line.speaker.toLowerCase() as 'you' | 'them')
            : undefined,
      ...(line.speakerId !== undefined ? { speakerId: line.speakerId } : {}),
      text: line.text,
    })),
    ...(speakerNames ? { speakerNames } : {}),
    notes: current.notes,
    cues: [],
  } satisfies Omit<KeptMeeting, 'id' | 'title' | 'revision'>;
}

export function resetAfterSessionKeep() {
  afterSessionKeep = 'auto';
  autoPriorContext = true;
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
  forceSave = false,
): { endPrompt: EndPrompt | null; changed: boolean } {
  const transcriptLines = current.transcript.length;
  const hasNotes = current.notes.trim().length > 0;
  if (
    !current.live ||
    current.status !== 'ended' ||
    availability !== 'on' ||
    (transcriptLines === 0 && !hasNotes) ||
    (!forceSave && afterSessionKeep === 'off')
  ) {
    endPrompt = null;
    return { endPrompt: null, changed: false };
  }
  if (afterSessionKeep === 'auto' || forceSave) {
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
        current.meetingTitle || defaultTitle(Date.now() - current.elapsedMs),
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
        autoPriorContext: availability === 'labRun' ? false : autoPriorContext,
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
    case 'set_auto_prior_context':
      autoPriorContext = (args as { enabled: boolean }).enabled;
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
        return { availability, meetings: [], folders: [], unreadable: 0 };
      const found = meetings
        .filter((meeting) => {
          const text = [
            meeting.title,
            meeting.folder ?? '',
            meeting.notes,
            meeting.meetingNotes ?? '',
            ...Object.values(meeting.speakerNames ?? {}),
            ...meeting.transcript.map((line) => line.text),
            ...meeting.cues.flatMap((cue) => [cue.question, cue.evidence]),
          ]
            .join('\n')
            .toLowerCase();
          return query.every((word) => text.includes(word));
        })
        .sort((a, b) => b.startedAtMs - a.startedAtMs)
        .map(summary);
      return {
        availability,
        meetings: found,
        folders: [...folders],
        unreadable,
      };
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
    case 'rename_kept_meeting_speaker': {
      const { id, speakerId, name } = args as {
        id: string;
        speakerId: number;
        name: string;
      };
      const meeting = meetings.find((item) => item.id === id);
      if (!meeting) throw 'That meeting is no longer kept.';
      const normalized = name.trim().replace(/\s+/g, ' ');
      if ([...normalized].length > 80 || /[\p{Cc}]/u.test(name)) {
        throw 'Give the speaker a name of up to 80 characters.';
      }
      const fallback = `Speaker ${speakerId + 1}`;
      const nextNames = { ...(meeting.speakerNames ?? {}) };
      if (!normalized || normalized === fallback) {
        delete nextNames[speakerId];
      } else {
        nextNames[speakerId] = normalized;
      }
      meeting.speakerNames =
        Object.keys(nextNames).length > 0 ? nextNames : undefined;
      meeting.revision += 1;
      pendingExport = null;
      return structuredClone(meeting);
    }
    case 'set_kept_meeting_archived': {
      const { id, archived } = args as { id: string; archived: boolean };
      const meeting = meetings.find((item) => item.id === id);
      if (!meeting) throw 'That meeting is no longer kept.';
      meeting.archived = archived;
      meeting.revision += 1;
      if (archived) {
        removeHistoryContextItem(id);
      } else {
        dismissedAutoIds.delete(id);
      }
      return summary(meeting);
    }
    case 'delete_kept_meeting': {
      const { id } = args as { id: string };
      if (!meetings.some((item) => item.id === id))
        throw 'That meeting is no longer kept.';
      meetings = meetings.filter((item) => item.id !== id);
      autoContextItems = autoContextItems.filter(
        (item) => item.sourceId !== id,
      );
      manualContextItems.delete(id);
      dismissedAutoIds.delete(id);
      if (sessionKept?.id === id) sessionKept = null;
      if (endPrompt?.keptId === id) endPrompt = null;
      pendingExport = null;
      return null;
    }
    case 'delete_all_kept_meetings': {
      const count = meetings.length;
      meetings = [];
      folders = [];
      autoContextItems = [];
      manualContextItems.clear();
      dismissedAutoIds.clear();
      sessionKept = null;
      endPrompt = null;
      unreadable = 0;
      availability = 'on';
      pendingExport = null;
      return count;
    }
    case 'create_meeting_folder': {
      if (availability === 'newer')
        throw 'Your kept meetings were saved by a newer TalkQTE. This version leaves them as they are; update TalkQTE to change them.';
      if (availability !== 'on')
        throw 'Kept meetings are not available in this launch.';
      const clean = cleanFolderName((args as { name: string }).name);
      if (folders.some((f) => f.toLowerCase() === clean.toLowerCase()))
        throw 'A folder with that name already exists.';
      folders.push(clean);
      return [...folders];
    }
    case 'rename_meeting_folder': {
      if (availability === 'newer')
        throw 'Your kept meetings were saved by a newer TalkQTE. This version leaves them as they are; update TalkQTE to change them.';
      if (availability !== 'on')
        throw 'Kept meetings are not available in this launch.';
      const { oldName, newName } = args as { oldName: string; newName: string };
      const idx = folders.findIndex(
        (f) => f.toLowerCase() === oldName.trim().toLowerCase(),
      );
      if (idx === -1) throw 'That folder no longer exists.';
      const clean = cleanFolderName(newName);
      if (
        folders.some(
          (f, i) => i !== idx && f.toLowerCase() === clean.toLowerCase(),
        )
      )
        throw 'A folder with that name already exists.';
      const canonicalOld = folders[idx];
      folders[idx] = clean;
      for (const meeting of meetings) {
        if (meeting.folder?.toLowerCase() === canonicalOld.toLowerCase()) {
          meeting.folder = clean;
          meeting.revision += 1;
        }
      }
      pendingExport = null;
      return [...folders];
    }
    case 'delete_meeting_folder': {
      if (availability === 'newer')
        throw 'Your kept meetings were saved by a newer TalkQTE. This version leaves them as they are; update TalkQTE to change them.';
      if (availability !== 'on')
        throw 'Kept meetings are not available in this launch.';
      const { name } = args as { name: string };
      const idx = folders.findIndex(
        (f) => f.toLowerCase() === name.trim().toLowerCase(),
      );
      if (idx === -1) throw 'That folder no longer exists.';
      const canonical = folders[idx];
      folders.splice(idx, 1);
      for (const meeting of meetings) {
        if (meeting.folder?.toLowerCase() === canonical.toLowerCase()) {
          delete meeting.folder;
          meeting.revision += 1;
        }
      }
      pendingExport = null;
      return [...folders];
    }
    case 'set_kept_meeting_folder': {
      if (availability === 'newer')
        throw 'Your kept meetings were saved by a newer TalkQTE. This version leaves them as they are; update TalkQTE to change them.';
      if (availability !== 'on')
        throw 'Kept meetings are not available in this launch.';
      const { id, folder } = args as { id: string; folder: string | null };
      const meeting = meetings.find((item) => item.id === id);
      if (!meeting) throw 'That meeting is no longer kept.';
      if (folder === null) {
        delete meeting.folder;
      } else {
        const clean = cleanFolderName(folder);
        const match = folders.find(
          (f) => f.toLowerCase() === clean.toLowerCase(),
        );
        if (!match) throw 'That folder no longer exists.';
        meeting.folder = match;
      }
      meeting.revision += 1;
      pendingExport = null;
      return summary(meeting);
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
      const hasDiarized = meeting.transcript.some(
        (line) => line.speakerId !== undefined,
      );
      lines.push('', '## Transcript', '');
      if (meeting.transcribedBy) {
        lines.push(
          hasDiarized
            ? `Transcribed by ${flat(meeting.transcribedBy)}.`
            : `Transcribed by ${flat(meeting.transcribedBy)}. Speakers are not identified.`,
          '',
        );
      }
      if (meeting.transcript.length === 0) {
        lines.push('None.');
      } else {
        for (const line of meeting.transcript) {
          const speakerLabel =
            line.speakerId !== undefined
              ? flat(
                  meeting.speakerNames?.[line.speakerId] ??
                    `Speaker ${line.speakerId + 1}`,
                )
              : null;
          const label =
            meeting.sources === 'both'
              ? line.echo
                ? ' You (likely an echo of Them):'
                : line.label === 'you'
                  ? ' You:'
                  : speakerLabel
                    ? ` ${speakerLabel}:`
                    : line.label === 'them'
                      ? ' Them:'
                      : ''
              : speakerLabel
                ? ` ${speakerLabel}:`
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
      folders: () => string[];
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
  folders: () => [...folders],
  exports: () => [...exported],
  add: (meeting) => {
    const id = (++next).toString(16).padStart(32, '0');
    if (
      meeting.folder &&
      !folders.some((f) => f.toLowerCase() === meeting.folder!.toLowerCase())
    ) {
      folders.push(meeting.folder);
    }
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
