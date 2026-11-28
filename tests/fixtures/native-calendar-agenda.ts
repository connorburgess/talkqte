// Fictional Apple Calendar agenda fixture for browser tests: an in-memory
// stand-in for the four main-window-only calendar agenda commands and
// `calendar:agenda-changed` event. Never touches real macOS Calendar or EventKit.
import { emit } from '@tauri-apps/api/event';
import type {
  CalendarAgendaEvent,
  CalendarAgendaSnapshot,
  CalendarPermissionStatus,
  CalendarSourceSummary,
} from '../../src/lib/calendarAgenda';

export const commands = [
  'calendar_agenda',
  'set_calendar_agenda',
  'set_included_calendars',
  'refresh_calendar_agenda',
];

function localIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addIsoDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function atLocalEpochS(iso: string, hour: number, minute: number): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(new Date(y, m - 1, d, hour, minute, 0).getTime() / 1000);
}

export function defaultFictionalCalendars(): CalendarSourceSummary[] {
  return [
    { id: 'cal-work', title: 'Work', sourceLabel: 'iCloud', included: true },
    {
      id: 'cal-design',
      title: 'Design Studio',
      sourceLabel: 'Google',
      included: true,
    },
    {
      id: 'cal-community',
      title: 'Garden Club',
      sourceLabel: 'Outlook',
      included: true,
    },
  ];
}

export function defaultFictionalEvents(
  todayIso: string,
): CalendarAgendaEvent[] {
  const nowS = Math.floor(Date.now() / 1000);
  const yesterday = addIsoDays(todayIso, -1);
  const tomorrow = addIsoDays(todayIso, 1);
  const dayThree = addIsoDays(todayIso, 3);
  const dayFive = addIsoDays(todayIso, 5);

  return [
    {
      occurrenceKey: 'occ-allday-freeze',
      title: 'Autumn catalog print freeze',
      calendarId: 'cal-work',
      calendarTitle: 'Work',
      isAllDay: true,
      localDate: todayIso,
      endLocalDate: tomorrow,
      startEpochS: atLocalEpochS(todayIso, 0, 0),
      endEpochS: atLocalEpochS(addIsoDays(tomorrow, 1), 0, 0),
      hasMeetingLink: false,
    },
    {
      occurrenceKey: 'occ-yesterday-retro',
      title: 'Greenhouse build retro',
      calendarId: 'cal-work',
      calendarTitle: 'Work',
      isAllDay: false,
      localDate: yesterday,
      endLocalDate: yesterday,
      startEpochS: atLocalEpochS(yesterday, 15, 0),
      endEpochS: atLocalEpochS(yesterday, 15, 45),
      hasMeetingLink: true,
    },
    {
      occurrenceKey: 'occ-now-planning',
      title: 'Garden supply planning',
      calendarId: 'cal-work',
      calendarTitle: 'Work',
      isAllDay: false,
      localDate: todayIso,
      endLocalDate: todayIso,
      startEpochS: nowS - 12 * 60,
      endEpochS: nowS + 28 * 60,
      hasMeetingLink: true,
    },
    {
      occurrenceKey: 'occ-overlap-a',
      title: 'Signage wording review',
      calendarId: 'cal-design',
      calendarTitle: 'Design Studio',
      isAllDay: false,
      localDate: todayIso,
      endLocalDate: todayIso,
      startEpochS: nowS + 60 * 60,
      endEpochS: nowS + 105 * 60,
      hasMeetingLink: true,
    },
    {
      occurrenceKey: 'occ-overlap-b',
      title: 'Compost supplier check-in',
      calendarId: 'cal-community',
      calendarTitle: 'Garden Club',
      isAllDay: false,
      localDate: todayIso,
      endLocalDate: todayIso,
      startEpochS: nowS + 75 * 60,
      endEpochS: nowS + 120 * 60,
      hasMeetingLink: false,
    },
    {
      occurrenceKey: 'occ-tomorrow-sync',
      title: 'Weekly community sync',
      calendarId: 'cal-work',
      calendarTitle: 'Work',
      isAllDay: false,
      localDate: tomorrow,
      endLocalDate: tomorrow,
      startEpochS: atLocalEpochS(tomorrow, 10, 0),
      endEpochS: atLocalEpochS(tomorrow, 10, 45),
      hasMeetingLink: true,
    },
    {
      occurrenceKey: 'occ-day3-walkthrough',
      title: 'Seed library walkthrough',
      calendarId: 'cal-design',
      calendarTitle: 'Design Studio',
      isAllDay: false,
      localDate: dayThree,
      endLocalDate: dayThree,
      startEpochS: atLocalEpochS(dayThree, 14, 0),
      endEpochS: atLocalEpochS(dayThree, 14, 30),
      hasMeetingLink: true,
    },
    {
      occurrenceKey: 'occ-day5-vendor',
      title: 'Planter vendor pricing',
      calendarId: 'cal-community',
      calendarTitle: 'Garden Club',
      isAllDay: false,
      localDate: dayFive,
      endLocalDate: dayFive,
      startEpochS: atLocalEpochS(dayFive, 11, 0),
      endEpochS: atLocalEpochS(dayFive, 11, 30),
      hasMeetingLink: false,
    },
  ];
}

function isUnavailableEnv(): boolean {
  const params = new URLSearchParams(location.search);
  const os = params.get('platform');
  return os === 'windows' || os === 'linux' || params.has('lab');
}

const initialToday = localIso(new Date());
let allEvents: CalendarAgendaEvent[] = defaultFictionalEvents(initialToday);
let selectedIds: string[] | null = null;
let grantResult: 'connected' | 'denied' = 'connected';
let nextError: string | null = null;
let liveRunning = false;
const agendaCalls: { command: string; args?: unknown }[] = [];

let state: CalendarAgendaSnapshot = {
  revision: 1,
  permission: isUnavailableEnv() ? 'unavailable' : 'off',
  agendaEnabled: false,
  promptsEnabled: false,
  syncState: 'idle',
  pausedWhileLive: false,
  stale: false,
  lastUpdatedEpochMs: null,
  error: null,
  todayLocalDate: initialToday,
  timezoneLabel: 'UTC',
  horizonStartDate: addIsoDays(initialToday, -1),
  horizonEndDate: addIsoDays(initialToday, 14),
  truncated: false,
  calendars: defaultFictionalCalendars(),
  events: [],
};

function filteredEvents(): CalendarAgendaEvent[] {
  if (!state.agendaEnabled || state.permission !== 'connected') return [];
  const allowed =
    selectedIds === null
      ? new Set(state.calendars.map((c) => c.id))
      : new Set(selectedIds);
  return allEvents.filter((e) => allowed.has(e.calendarId));
}

function syncCalendarFlags(
  cals: CalendarSourceSummary[],
): CalendarSourceSummary[] {
  if (selectedIds === null) return cals.map((c) => ({ ...c, included: true }));
  const allowed = new Set(selectedIds);
  return cals.map((c) => ({ ...c, included: allowed.has(c.id) }));
}

async function publish(
  patch: Partial<CalendarAgendaSnapshot>,
): Promise<CalendarAgendaSnapshot> {
  state = {
    ...state,
    ...patch,
    revision: state.revision + 1,
  };
  const copy = structuredClone(state);
  await emit('calendar:agenda-changed', copy);
  return copy;
}

export function setGrant(next: 'connected' | 'denied') {
  grantResult = next;
}

export function setPromptsEnabled(enabled: boolean) {
  state = { ...state, promptsEnabled: enabled };
}

export function setLiveRunning(running: boolean) {
  liveRunning = running;
  if (state.agendaEnabled && state.permission === 'connected') {
    state = {
      ...state,
      revision: state.revision + 1,
      pausedWhileLive: running,
    };
    void emit('calendar:agenda-changed', structuredClone(state));
  }
}

export function reset() {
  selectedIds = null;
  nextError = null;
  state = {
    ...state,
    revision: state.revision + 1,
    permission: isUnavailableEnv() ? 'unavailable' : 'off',
    agendaEnabled: false,
    promptsEnabled: false,
    syncState: 'idle',
    pausedWhileLive: false,
    stale: false,
    lastUpdatedEpochMs: null,
    error: null,
    truncated: false,
    calendars: defaultFictionalCalendars(),
    events: [],
  };
  void emit('calendar:agenda-changed', structuredClone(state));
}

export async function command(name: string, args: unknown) {
  agendaCalls.push({ command: name, args: structuredClone(args ?? null) });
  if (isUnavailableEnv()) {
    return structuredClone({
      ...state,
      permission: 'unavailable' as CalendarPermissionStatus,
      agendaEnabled: false,
      events: [],
    });
  }
  switch (name) {
    case 'calendar_agenda': {
      // Lightweight synchronous permission re-check (e.g. on Schedule Glance open).
      if (state.agendaEnabled && grantResult === 'denied') {
        return publish({
          permission: 'denied',
          syncState: 'idle',
          pausedWhileLive: liveRunning,
          stale: false,
          error: null,
          events: [],
        });
      }
      if (state.agendaEnabled && state.permission === 'connected') {
        state = { ...state, pausedWhileLive: liveRunning };
      }
      return structuredClone(state);
    }
    case 'set_calendar_agenda': {
      const enabled = Boolean((args as { enabled?: boolean })?.enabled);
      if (!enabled) {
        return publish({
          agendaEnabled: false,
          permission: 'off',
          syncState: 'idle',
          pausedWhileLive: false,
          stale: false,
          lastUpdatedEpochMs: null,
          error: null,
          events: [],
        });
      }
      if (grantResult === 'denied') {
        return publish({
          agendaEnabled: true,
          permission: 'denied',
          syncState: 'idle',
          pausedWhileLive: liveRunning,
          stale: false,
          lastUpdatedEpochMs: null,
          error: null,
          events: [],
        });
      }
      const calendars = syncCalendarFlags(state.calendars);
      state = {
        ...state,
        agendaEnabled: true,
        permission: 'connected',
        calendars,
      };
      return publish({
        agendaEnabled: true,
        permission: 'connected',
        syncState: 'ready',
        pausedWhileLive: liveRunning,
        stale: false,
        lastUpdatedEpochMs: Date.now(),
        error: null,
        calendars,
        events: filteredEvents(),
      });
    }
    case 'set_included_calendars': {
      const ids = Array.isArray((args as { ids?: unknown })?.ids)
        ? (args as { ids: string[] }).ids.filter(
            (id): id is string => typeof id === 'string',
          )
        : [];
      selectedIds = [...ids];
      const calendars = syncCalendarFlags(state.calendars);
      state = { ...state, calendars };
      return publish({
        calendars,
        events: filteredEvents(),
        lastUpdatedEpochMs: state.agendaEnabled
          ? Date.now()
          : state.lastUpdatedEpochMs,
        stale: false,
        error: null,
      });
    }
    case 'refresh_calendar_agenda': {
      if (nextError) {
        const message = nextError;
        nextError = null;
        return publish({
          syncState: 'error',
          error: message,
          pausedWhileLive: liveRunning,
        });
      }
      if (!state.agendaEnabled) return structuredClone(state);
      if (grantResult === 'denied') {
        return publish({
          permission: 'denied',
          syncState: 'idle',
          pausedWhileLive: liveRunning,
          stale: false,
          error: null,
          events: [],
        });
      }
      const calendars = syncCalendarFlags(state.calendars);
      state = { ...state, permission: 'connected', calendars };
      return publish({
        permission: 'connected',
        syncState: 'ready',
        pausedWhileLive: liveRunning,
        stale: false,
        lastUpdatedEpochMs: Date.now(),
        error: null,
        calendars,
        events: filteredEvents(),
      });
    }
    default:
      throw new Error(`Unknown calendar agenda command: ${name}`);
  }
}

export const testApi = {
  agenda: () => structuredClone(state),
  agendaCalls: () => structuredClone(agendaCalls),
  setAgendaEvents: (events: CalendarAgendaEvent[]) => {
    allEvents = structuredClone(events);
  },
  setNextAgendaError: (message: string | null) => {
    nextError = message;
  },
  emitAgenda: (patch: Partial<CalendarAgendaSnapshot>) => publish(patch),
  emitRawAgenda: (raw: CalendarAgendaSnapshot) =>
    emit('calendar:agenda-changed', structuredClone(raw)),
};
