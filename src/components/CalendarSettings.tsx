import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/bridge';
import {
  calendarAgenda,
  formatClockTime,
  isCalendarAgendaSnapshot,
  openCalendarSettings,
  refreshCalendarAgenda,
  setCalendarAgenda,
  setIncludedCalendars,
  watchCalendarAgenda,
  type CalendarAgendaSnapshot,
  type CalendarPermissionStatus,
} from '../lib/calendarAgenda';
import { platformName, usePlatform } from '../lib/platform';

export type { CalendarPermissionStatus };

export interface CalendarSettingsState {
  enabled: boolean;
  status: CalendarPermissionStatus;
  error?: string;
}

function statusLabel(status: CalendarPermissionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'denied':
      return 'Permission denied — enable in System Settings → Privacy & Security → Calendars';
    case 'unavailable':
      return 'Not available on this platform yet';
    default:
      return 'Off';
  }
}

function agendaStatusLabel(snapshot: CalendarAgendaSnapshot): string {
  if (snapshot.permission === 'unavailable') {
    return 'Unavailable in this run';
  }
  if (snapshot.permission === 'denied') {
    return 'Permission denied or revoked — enable in System Settings → Privacy & Security → Calendars';
  }
  if (!snapshot.agendaEnabled) return 'Off';
  if (snapshot.syncState === 'loading' || snapshot.syncState === 'refreshing') {
    return 'Reading Apple Calendar (local Mac cache)…';
  }
  if (snapshot.permission === 'off') {
    return 'Waiting for macOS Calendar permission';
  }
  if (snapshot.stale) {
    return snapshot.lastUpdatedEpochMs
      ? `Connected · stale cache (last updated ${formatClockTime(snapshot.lastUpdatedEpochMs)})`
      : 'Connected · stale cache';
  }
  const limitSuffix = snapshot.truncated ? ' · results limited' : '';
  const count = snapshot.calendars.filter((c) => c.included).length;
  if (snapshot.calendars.length > 0) {
    return `Connected · ${count} of ${snapshot.calendars.length} calendars shown${limitSuffix}`;
  }
  return `Connected${limitSuffix}`;
}

/** Settings → Capture & prompts:
 * 1) Pre-call dock prompts (calendar_settings / set_calendar_prompts), off by default.
 * 2) Separate Notebook Home Calendar agenda (calendar_agenda / set_calendar_agenda /
 *    set_included_calendars), also off by default. Reads Apple Calendar's local Mac
 *    cache only; never uploads calendar data or reads attendees. */
export function CalendarSettings({
  agendaSnapshot,
  onAgendaChange,
}: {
  agendaSnapshot?: CalendarAgendaSnapshot | null;
  onAgendaChange?: (next: CalendarAgendaSnapshot) => void;
}) {
  const [settings, setSettings] = useState<CalendarSettingsState | null>(null);
  const [localAgenda, setLocalAgenda] = useState<CalendarAgendaSnapshot | null>(
    agendaSnapshot ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [agendaBusy, setAgendaBusy] = useState(false);
  const [error, setError] = useState('');
  const [agendaError, setAgendaError] = useState('');
  const platform = usePlatform();

  const agenda = agendaSnapshot ?? localAgenda;

  useEffect(() => {
    if (agendaSnapshot) setLocalAgenda(agendaSnapshot);
  }, [agendaSnapshot]);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    invoke<CalendarSettingsState>('calendar_settings')
      .then((next) => {
        if (alive) setSettings(next);
      })
      .catch(() => {
        if (alive) setError('Calendar settings are unavailable.');
      });
    calendarAgenda()
      .then((next) => {
        if (!alive || !isCalendarAgendaSnapshot(next)) return;
        setLocalAgenda(next);
        onAgendaChange?.(next);
      })
      .catch(() => {
        // Older native builds without calendar_agenda leave agenda unavailable.
      });
    let stopWatch: (() => void) | undefined;
    void watchCalendarAgenda((next) => {
      if (!alive) return;
      setLocalAgenda(next);
      onAgendaChange?.(next);
    }).then((unlisten) => {
      if (alive) stopWatch = unlisten;
      else unlisten();
    });
    return () => {
      alive = false;
      stopWatch?.();
    };
  }, []);

  async function togglePrompts(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      const next = await invoke<CalendarSettingsState>('set_calendar_prompts', {
        enabled,
      });
      setSettings(next);
      if (next.error) setError(next.error);
    } catch {
      setError('The calendar setting could not be updated. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleAgenda(enabled: boolean) {
    setAgendaBusy(true);
    setAgendaError('');
    try {
      const next = await setCalendarAgenda(enabled);
      if (isCalendarAgendaSnapshot(next)) {
        setLocalAgenda(next);
        onAgendaChange?.(next);
        if (next.error) setAgendaError(next.error);
      }
    } catch {
      setAgendaError(
        'The calendar agenda setting could not be updated. Try again.',
      );
    } finally {
      setAgendaBusy(false);
    }
  }

  async function refreshAgenda() {
    setAgendaBusy(true);
    setAgendaError('');
    try {
      const next = await refreshCalendarAgenda();
      if (isCalendarAgendaSnapshot(next)) {
        setLocalAgenda(next);
        onAgendaChange?.(next);
        if (next.error) setAgendaError(next.error);
      }
    } catch {
      setAgendaError('Could not refresh Apple Calendar. Try again.');
    } finally {
      setAgendaBusy(false);
    }
  }

  async function toggleIncludedCalendar(calendarId: string, included: boolean) {
    if (!agenda) return;
    const nextIds = agenda.calendars
      .filter((c) => (c.id === calendarId ? included : c.included))
      .map((c) => c.id);
    setAgendaBusy(true);
    setAgendaError('');
    try {
      const next = await setIncludedCalendars(nextIds);
      if (isCalendarAgendaSnapshot(next)) {
        setLocalAgenda(next);
        onAgendaChange?.(next);
        if (next.error) setAgendaError(next.error);
      }
    } catch {
      setAgendaError('The included calendars could not be updated. Try again.');
    } finally {
      setAgendaBusy(false);
    }
  }

  async function selectAllCalendars() {
    if (!agenda) return;
    const allIds = agenda.calendars.map((c) => c.id);
    setAgendaBusy(true);
    setAgendaError('');
    try {
      const next = await setIncludedCalendars(allIds);
      if (isCalendarAgendaSnapshot(next)) {
        setLocalAgenda(next);
        onAgendaChange?.(next);
        if (next.error) setAgendaError(next.error);
      }
    } catch {
      setAgendaError('The included calendars could not be updated. Try again.');
    } finally {
      setAgendaBusy(false);
    }
  }

  async function openSystemSettings(forAgenda: boolean) {
    if (forAgenda) setAgendaError('');
    else setError('');
    try {
      await openCalendarSettings();
    } catch {
      if (forAgenda) setAgendaError('Could not open System Settings.');
      else setError('Could not open System Settings.');
    }
  }

  if (!desktop) return null;

  if (platform && !platform.calendarPrompts) {
    const osName = platformName(platform);
    return (
      <>
        <section className="setting" aria-labelledby="calendar-prompts-setting">
          <div>
            <h2 id="calendar-prompts-setting">Calendar &amp; call prompts</h2>
            <p>
              Not available on {osName} yet. On a Mac, TalkQTE can read upcoming
              meeting titles and links locally from Apple Calendar for pre-call
              prompts.
            </p>
          </div>
        </section>
        <section className="setting" aria-labelledby="calendar-agenda-setting">
          <div>
            <h2 id="calendar-agenda-setting">Notebook Calendar agenda</h2>
            <p>
              Not available on {osName} yet. On a Mac, TalkQTE can show upcoming
              meetings from Apple Calendar’s local cache on Notebook Home.
            </p>
          </div>
        </section>
      </>
    );
  }

  const allIncluded =
    !!agenda &&
    agenda.calendars.length > 0 &&
    agenda.calendars.every((c) => c.included);
  const agendaWaitingPermission =
    !!agenda &&
    agenda.agendaEnabled &&
    agenda.permission === 'off' &&
    agenda.syncState !== 'loading' &&
    agenda.syncState !== 'refreshing';

  return (
    <>
      <section className="setting" aria-labelledby="calendar-prompts-setting">
        <div>
          <h2 id="calendar-prompts-setting">Calendar &amp; call prompts</h2>
          <p>
            Reads upcoming meeting titles and links locally from Apple Calendar
            (which syncs Google Calendar, iCloud, and Outlook) within a few
            minutes of start, and never uploads your calendar or reads
            attendees.
          </p>
          {settings && (
            <>
              <label className="processing-option call-prompt-setting-option">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  disabled={busy}
                  onChange={(event) => void togglePrompts(event.target.checked)}
                />
                <span>Use macOS Calendar for upcoming meetings</span>
              </label>
              <p
                className="small muted calendar-permission-status"
                role="status"
              >
                {statusLabel(settings.status)}
              </p>
              {settings.status === 'denied' && (
                <div className="call-prompt-not-for">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void openSystemSettings(false)}
                  >
                    Open Calendar privacy settings
                  </button>
                </div>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="call-prompt-setting-error">
              {error}
            </p>
          )}
        </div>
      </section>

      <section className="setting" aria-labelledby="calendar-agenda-setting">
        <div className="calendar-setting-group">
          <div className="calendar-setting-block">
            <h2 id="calendar-agenda-setting" tabIndex={-1}>
              Notebook Calendar agenda
            </h2>
            <p>
              Reads titles, times, and local calendar names from Apple
              Calendar’s local Mac cache (yesterday through 14 days ahead;
              bounded at up to 100 calendars, 10,000 scanned items, and 250
              shown events). Google Calendar, iCloud, and Outlook appear only if
              already synced in Apple Calendar. Never uploads your calendar or
              reads attendees. Your chosen calendar filter IDs save locally in
              Settings; preparing a meeting fills the editable session title
              only (which can save to Meetings or Markdown export if you keep or
              export that session).
            </p>
          </div>
          {agenda && agenda.permission === 'unavailable' ? (
            <p className="small muted calendar-permission-status" role="status">
              Unavailable in lab runs or on this platform.
            </p>
          ) : (
            agenda && (
              <>
                <label className="processing-option call-prompt-setting-option">
                  <input
                    type="checkbox"
                    checked={agenda.agendaEnabled}
                    disabled={agendaBusy}
                    onChange={(event) =>
                      void toggleAgenda(event.target.checked)
                    }
                  />
                  <span>Show Apple Calendar agenda on Notebook Home</span>
                </label>
                <p
                  className="small muted calendar-permission-status"
                  role="status"
                >
                  {agendaStatusLabel(agenda)}
                </p>
                {agenda.permission === 'denied' && (
                  <div className="calendar-empty-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={agendaBusy}
                      onClick={() => void openSystemSettings(true)}
                    >
                      Open Calendar privacy settings
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={agendaBusy}
                      onClick={() => void refreshAgenda()}
                    >
                      Check again
                    </button>
                  </div>
                )}
                {agendaWaitingPermission && (
                  <div className="calendar-empty-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={agendaBusy}
                      onClick={() => void toggleAgenda(true)}
                    >
                      Request access again
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={agendaBusy}
                      onClick={() => void refreshAgenda()}
                    >
                      Check again
                    </button>
                  </div>
                )}
                {agenda.agendaEnabled &&
                  agenda.permission === 'connected' &&
                  agenda.stale && (
                    <div className="calendar-empty-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          agendaBusy || agenda.syncState === 'refreshing'
                        }
                        onClick={() => void refreshAgenda()}
                      >
                        Refresh now
                      </button>
                    </div>
                  )}
                {agenda.agendaEnabled &&
                  agenda.permission === 'connected' &&
                  agenda.truncated && (
                    <p className="calendar-truncated-note" role="status">
                      Results are limited by local agenda caps (up to 100
                      calendars, 10,000 scanned items, or 250 shown events
                      across yesterday through +14 days). Hide calendars you do
                      not need below to narrow the list; if Apple Calendar has
                      more than 100 calendars, Select all only covers the 100
                      returned here.
                    </p>
                  )}
                {agenda.agendaEnabled &&
                  agenda.permission === 'connected' &&
                  agenda.calendars.length > 0 && (
                    <fieldset className="calendar-source-fieldset">
                      <div className="calendar-source-legend-row">
                        <legend>Included calendars</legend>
                        {!allIncluded && (
                          <button
                            type="button"
                            className="text-button"
                            disabled={agendaBusy}
                            onClick={() => void selectAllCalendars()}
                          >
                            Select all
                          </button>
                        )}
                      </div>
                      <div className="calendar-source-list">
                        {agenda.calendars.map((cal) => (
                          <label
                            key={cal.id}
                            className="calendar-source-option"
                          >
                            <span className="calendar-source-left">
                              <input
                                type="checkbox"
                                checked={cal.included}
                                disabled={agendaBusy}
                                onChange={(event) =>
                                  void toggleIncludedCalendar(
                                    cal.id,
                                    event.target.checked,
                                  )
                                }
                              />
                              <span>{cal.title}</span>
                            </span>
                            {cal.sourceLabel && (
                              <span className="calendar-source-label">
                                {cal.sourceLabel}
                              </span>
                            )}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                {(agendaError || agenda.error) && (
                  <p role="alert" className="call-prompt-setting-error">
                    {agendaError || agenda.error}
                  </p>
                )}
              </>
            )
          )}
        </div>
      </section>
    </>
  );
}
