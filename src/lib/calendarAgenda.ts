import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { desktop } from './bridge';

export type CalendarPermissionStatus =
  'off' | 'connected' | 'denied' | 'unavailable';

export type CalendarSyncState =
  'idle' | 'loading' | 'refreshing' | 'ready' | 'error';

export const CALENDAR_RESULTS_LIMITED_DETAIL =
  'Results are limited by local agenda caps (up to 100 calendars, 10,000 scanned items, or 250 shown events across yesterday through +14 days). Some calendars or events may not appear.';

export const CALENDAR_RESULTS_LIMITED_SHORT =
  'Results are limited (up to 100 calendars, 10,000 scanned items, or 250 shown events); some calendars or meetings may not appear.';

export interface CalendarSourceSummary {
  id: string;
  title: string;
  sourceLabel: string;
  included: boolean;
}

export interface CalendarAgendaEvent {
  occurrenceKey: string;
  title: string;
  calendarId: string;
  calendarTitle: string;
  isAllDay: boolean;
  localDate: string;
  endLocalDate: string;
  startEpochS: number;
  endEpochS: number;
  hasMeetingLink: boolean;
}

export interface CalendarAgendaSnapshot {
  revision: number;
  permission: CalendarPermissionStatus;
  agendaEnabled: boolean;
  promptsEnabled: boolean;
  syncState: CalendarSyncState;
  pausedWhileLive: boolean;
  stale: boolean;
  lastUpdatedEpochMs: number | null;
  error: string | null;
  todayLocalDate: string;
  timezoneLabel: string;
  horizonStartDate: string;
  horizonEndDate: string;
  truncated: boolean;
  calendars: CalendarSourceSummary[];
  events: CalendarAgendaEvent[];
}

const VALID_PERMISSIONS: readonly CalendarPermissionStatus[] = [
  'off',
  'connected',
  'denied',
  'unavailable',
];

const VALID_SYNC_STATES: readonly CalendarSyncState[] = [
  'idle',
  'loading',
  'refreshing',
  'ready',
  'error',
];

function isCalendarSourceSummary(
  value: unknown,
): value is CalendarSourceSummary {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    typeof v.sourceLabel === 'string' &&
    typeof v.included === 'boolean'
  );
}

function isCalendarAgendaEvent(value: unknown): value is CalendarAgendaEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.occurrenceKey === 'string' &&
    typeof v.title === 'string' &&
    typeof v.calendarId === 'string' &&
    typeof v.calendarTitle === 'string' &&
    typeof v.isAllDay === 'boolean' &&
    typeof v.localDate === 'string' &&
    typeof v.endLocalDate === 'string' &&
    typeof v.startEpochS === 'number' &&
    typeof v.endEpochS === 'number' &&
    typeof v.hasMeetingLink === 'boolean'
  );
}

export function isCalendarAgendaSnapshot(
  value: unknown,
): value is CalendarAgendaSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.revision === 'number' &&
    VALID_PERMISSIONS.includes(v.permission as CalendarPermissionStatus) &&
    typeof v.agendaEnabled === 'boolean' &&
    typeof v.promptsEnabled === 'boolean' &&
    VALID_SYNC_STATES.includes(v.syncState as CalendarSyncState) &&
    typeof v.pausedWhileLive === 'boolean' &&
    typeof v.stale === 'boolean' &&
    (v.lastUpdatedEpochMs === null ||
      typeof v.lastUpdatedEpochMs === 'number') &&
    (v.error === null || typeof v.error === 'string') &&
    typeof v.todayLocalDate === 'string' &&
    typeof v.timezoneLabel === 'string' &&
    typeof v.horizonStartDate === 'string' &&
    typeof v.horizonEndDate === 'string' &&
    typeof v.truncated === 'boolean' &&
    Array.isArray(v.calendars) &&
    v.calendars.every(isCalendarSourceSummary) &&
    Array.isArray(v.events) &&
    v.events.every(isCalendarAgendaEvent)
  );
}

// --- Pure calendar-date & event helpers ---

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y || 2026, (m || 1) - 1, d || 1));
}

export function toIsoDateUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function localTodayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(isoDate: string, delta: number): string {
  const d = parseIsoDate(isoDate);
  d.setUTCDate(d.getUTCDate() + delta);
  return toIsoDateUtc(d);
}

export function clampDate(
  isoDate: string,
  minIso: string,
  maxIso: string,
): string {
  if (isoDate < minIso) return minIso;
  if (isoDate > maxIso) return maxIso;
  return isoDate;
}

export function buildWeekWindow(
  selectedDate: string,
  todayDate: string,
  horizonStart: string,
  horizonEnd: string,
): string[] {
  const dates: string[] = [];
  let cursor = horizonStart;
  while (cursor <= horizonEnd && dates.length < 31) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  if (dates.length <= 7) return dates;

  const selectedIdx = Math.max(0, dates.indexOf(selectedDate));
  const todayIdx = dates.indexOf(todayDate);
  // Anchor default week on Today when selected is within Today..Today+6.
  if (
    todayIdx >= 0 &&
    selectedIdx >= todayIdx &&
    selectedIdx < todayIdx + 7 &&
    todayIdx + 7 <= dates.length
  ) {
    return dates.slice(todayIdx, todayIdx + 7);
  }
  const start = Math.max(0, Math.min(selectedIdx - 2, dates.length - 7));
  return dates.slice(start, start + 7);
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatDayHeading(isoDate: string, todayIso: string): string {
  const d = parseIsoDate(isoDate);
  const base = `${WEEKDAY_SHORT[d.getUTCDay()]}, ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (isoDate === todayIso) return `Today · ${base}`;
  if (isoDate === addDays(todayIso, 1)) return `Tomorrow · ${base}`;
  if (isoDate === addDays(todayIso, -1)) return `Yesterday · ${base}`;
  return base;
}

export function formatWeekDayParts(isoDate: string): {
  weekday: string;
  dayNum: string;
  fullLabel: string;
} {
  const d = parseIsoDate(isoDate);
  const weekday = WEEKDAY_SHORT[d.getUTCDay()];
  const dayNum = String(d.getUTCDate());
  const fullLabel = `${weekday}, ${MONTH_SHORT[d.getUTCMonth()]} ${dayNum}`;
  return { weekday, dayNum, fullLabel };
}

export function formatClockTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatEventTimeRange(
  startEpochS: number,
  endEpochS: number,
  options?: {
    isoDate?: string;
    localDate?: string;
    endLocalDate?: string;
  },
): string {
  const start = new Date(startEpochS * 1000);
  const end = new Date(endEpochS * 1000);
  const fmt = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const isoDate = options?.isoDate;
  const localDate = options?.localDate;
  const endLocalDate = options?.endLocalDate;
  if (isoDate && localDate && endLocalDate && localDate < endLocalDate) {
    if (isoDate > localDate && isoDate < endLocalDate) return 'Continues';
    if (isoDate > localDate) return `Until ${fmt(end)}`;
    return `${fmt(start)}→`;
  }
  return `${fmt(start)}–${fmt(end)}`;
}

export function isOngoingEvent(
  event: CalendarAgendaEvent,
  nowEpochS: number,
): boolean {
  return (
    !event.isAllDay &&
    event.startEpochS <= nowEpochS &&
    nowEpochS < event.endEpochS
  );
}

export function remainingMinutes(
  event: CalendarAgendaEvent,
  nowEpochS: number,
): number {
  return Math.max(1, Math.ceil((event.endEpochS - nowEpochS) / 60));
}

export function eventsForDate(
  events: readonly CalendarAgendaEvent[],
  isoDate: string,
): {
  allDay: CalendarAgendaEvent[];
  timed: CalendarAgendaEvent[];
  overlappingKeys: Set<string>;
} {
  const allDay = events
    .filter(
      (event) =>
        event.isAllDay &&
        event.localDate <= isoDate &&
        isoDate <= event.endLocalDate,
    )
    .sort((a, b) => a.occurrenceKey.localeCompare(b.occurrenceKey));

  const timed = events
    .filter(
      (event) =>
        !event.isAllDay &&
        event.localDate <= isoDate &&
        isoDate <= event.endLocalDate,
    )
    .sort(
      (a, b) =>
        a.startEpochS - b.startEpochS ||
        a.endEpochS - b.endEpochS ||
        a.occurrenceKey.localeCompare(b.occurrenceKey),
    );

  const overlappingKeys = new Set<string>();
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (
        timed[i].startEpochS < timed[j].endEpochS &&
        timed[j].startEpochS < timed[i].endEpochS
      ) {
        overlappingKeys.add(timed[i].occurrenceKey);
        overlappingKeys.add(timed[j].occurrenceKey);
      }
    }
  }
  return { allDay, timed, overlappingKeys };
}

export function hasEventsOnDate(
  events: readonly CalendarAgendaEvent[],
  isoDate: string,
): boolean {
  return events.some(
    (event) => event.localDate <= isoDate && isoDate <= event.endLocalDate,
  );
}

// --- Browser preview in-memory fictional store (never touches real calendars) ---

const previewListeners = new Set<(snap: CalendarAgendaSnapshot) => void>();

function buildPreviewEvents(today: string): CalendarAgendaEvent[] {
  const now = new Date();
  const baseStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    Math.max(0, now.getMinutes() - 12),
    0,
  );
  const nowStartS = Math.floor(baseStart.getTime() / 1000);
  const tomorrow = addDays(today, 1);
  const dayTwo = addDays(today, 2);

  const atLocal = (iso: string, hour: number, min: number) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.floor(new Date(y, m - 1, d, hour, min, 0).getTime() / 1000);
  };

  return [
    {
      occurrenceKey: 'preview-allday-1',
      title: 'Fictional release freeze window',
      calendarId: 'cal-work',
      calendarTitle: 'Work',
      isAllDay: true,
      localDate: today,
      endLocalDate: tomorrow,
      startEpochS: atLocal(today, 0, 0),
      endEpochS: atLocal(dayTwo, 0, 0),
      hasMeetingLink: false,
    },
    {
      occurrenceKey: 'preview-now-1',
      title: 'Garden supply planning',
      calendarId: 'cal-work',
      calendarTitle: 'Work',
      isAllDay: false,
      localDate: today,
      endLocalDate: today,
      startEpochS: nowStartS,
      endEpochS: nowStartS + 45 * 60,
      hasMeetingLink: true,
    },
    {
      occurrenceKey: 'preview-later-1',
      title: 'Autumn signage wording review',
      calendarId: 'cal-design',
      calendarTitle: 'Design',
      isAllDay: false,
      localDate: today,
      endLocalDate: today,
      startEpochS: nowStartS + 90 * 60,
      endEpochS: nowStartS + 120 * 60,
      hasMeetingLink: true,
    },
    {
      occurrenceKey: 'preview-tomorrow-1',
      title: 'Weekly community sync',
      calendarId: 'cal-work',
      calendarTitle: 'Work',
      isAllDay: false,
      localDate: tomorrow,
      endLocalDate: tomorrow,
      startEpochS: atLocal(tomorrow, 10, 0),
      endEpochS: atLocal(tomorrow, 10, 45),
      hasMeetingLink: true,
    },
  ];
}

function initialPreviewSnapshot(): CalendarAgendaSnapshot {
  const today = localTodayIso();
  return {
    revision: 1,
    permission: 'off',
    agendaEnabled: false,
    promptsEnabled: false,
    syncState: 'idle',
    pausedWhileLive: false,
    stale: false,
    lastUpdatedEpochMs: null,
    error: null,
    todayLocalDate: today,
    timezoneLabel:
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time',
    horizonStartDate: addDays(today, -1),
    horizonEndDate: addDays(today, 14),
    truncated: false,
    calendars: [
      { id: 'cal-work', title: 'Work', sourceLabel: 'iCloud', included: true },
      {
        id: 'cal-design',
        title: 'Design',
        sourceLabel: 'Google',
        included: true,
      },
    ],
    events: [],
  };
}

let previewSnap: CalendarAgendaSnapshot = initialPreviewSnapshot();

function publishPreview(next: CalendarAgendaSnapshot): CalendarAgendaSnapshot {
  previewSnap = next;
  const copy = structuredClone(next);
  for (const listener of previewListeners) listener(copy);
  return copy;
}

// --- Public IPC adapters ---

export async function calendarAgenda(): Promise<CalendarAgendaSnapshot> {
  if (!desktop) return structuredClone(previewSnap);
  return invoke<CalendarAgendaSnapshot>('calendar_agenda');
}

export async function setCalendarAgenda(
  enabled: boolean,
): Promise<CalendarAgendaSnapshot> {
  if (!desktop) {
    const today = localTodayIso();
    const allEvents = buildPreviewEvents(today);
    const includedIds = new Set(
      previewSnap.calendars.filter((c) => c.included).map((c) => c.id),
    );
    return publishPreview({
      ...previewSnap,
      revision: previewSnap.revision + 1,
      agendaEnabled: enabled,
      permission: enabled ? 'connected' : 'off',
      syncState: enabled ? 'ready' : 'idle',
      stale: false,
      error: null,
      todayLocalDate: today,
      horizonStartDate: addDays(today, -1),
      horizonEndDate: addDays(today, 14),
      lastUpdatedEpochMs: enabled ? Date.now() : null,
      events: enabled
        ? allEvents.filter((e) => includedIds.has(e.calendarId))
        : [],
    });
  }
  return invoke<CalendarAgendaSnapshot>('set_calendar_agenda', { enabled });
}

export async function setIncludedCalendars(
  ids: string[],
): Promise<CalendarAgendaSnapshot> {
  if (!desktop) {
    const idSet = new Set(ids);
    const calendars = previewSnap.calendars.map((cal) => ({
      ...cal,
      included: idSet.has(cal.id),
    }));
    const allEvents = previewSnap.agendaEnabled
      ? buildPreviewEvents(previewSnap.todayLocalDate)
      : [];
    return publishPreview({
      ...previewSnap,
      revision: previewSnap.revision + 1,
      calendars,
      lastUpdatedEpochMs: previewSnap.agendaEnabled
        ? Date.now()
        : previewSnap.lastUpdatedEpochMs,
      events: allEvents.filter((e) => idSet.has(e.calendarId)),
    });
  }
  return invoke<CalendarAgendaSnapshot>('set_included_calendars', { ids });
}

export async function refreshCalendarAgenda(): Promise<CalendarAgendaSnapshot> {
  if (!desktop) {
    if (!previewSnap.agendaEnabled) return structuredClone(previewSnap);
    const today = localTodayIso();
    const includedIds = new Set(
      previewSnap.calendars.filter((c) => c.included).map((c) => c.id),
    );
    return publishPreview({
      ...previewSnap,
      revision: previewSnap.revision + 1,
      syncState: 'ready',
      stale: false,
      error: null,
      todayLocalDate: today,
      horizonStartDate: addDays(today, -1),
      horizonEndDate: addDays(today, 14),
      lastUpdatedEpochMs: Date.now(),
      events: buildPreviewEvents(today).filter((e) =>
        includedIds.has(e.calendarId),
      ),
    });
  }
  return invoke<CalendarAgendaSnapshot>('refresh_calendar_agenda');
}

export async function openCalendarSettings(): Promise<void> {
  if (!desktop) return;
  await invoke('open_calendar_settings');
}

export async function watchCalendarAgenda(
  receive: (snapshot: CalendarAgendaSnapshot) => void,
): Promise<() => void> {
  if (!desktop) {
    previewListeners.add(receive);
    return () => {
      previewListeners.delete(receive);
    };
  }
  return listen<unknown>('calendar:agenda-changed', ({ payload }) => {
    if (isCalendarAgendaSnapshot(payload)) receive(payload);
  });
}
