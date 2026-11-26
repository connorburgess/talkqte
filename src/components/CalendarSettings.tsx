import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/bridge';
import { platformName, usePlatform } from '../lib/platform';

export type CalendarPermissionStatus =
  'off' | 'connected' | 'denied' | 'unavailable';

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

/** Settings → Calendar & call prompts: opt-in macOS Calendar awareness via
 * EventKit. Off by default; never uploads calendar data or reads attendees. */
export function CalendarSettings() {
  const [settings, setSettings] = useState<CalendarSettingsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const platform = usePlatform();

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
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(enabled: boolean) {
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

  async function openSystemSettings() {
    setError('');
    try {
      await invoke('open_calendar_settings');
    } catch {
      setError('Could not open System Settings.');
    }
  }

  if (!desktop) return null;

  if (platform && !platform.calendarPrompts) {
    return (
      <section className="setting" aria-labelledby="calendar-prompts-setting">
        <div>
          <h2 id="calendar-prompts-setting">Calendar &amp; call prompts</h2>
          <p>
            Not available on {platformName(platform)} yet. On a Mac, TalkQTE can
            read upcoming meeting titles and links locally from Apple Calendar
            for pre-call prompts.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="setting" aria-labelledby="calendar-prompts-setting">
      <div>
        <h2 id="calendar-prompts-setting">Calendar &amp; call prompts</h2>
        <p>
          Reads upcoming meeting titles and links locally from Apple Calendar
          (which syncs Google Calendar, iCloud, and Outlook) within a few
          minutes of start, and never uploads your calendar or reads attendees.
        </p>
        {settings && (
          <>
            <label className="processing-option call-prompt-setting-option">
              <input
                type="checkbox"
                checked={settings.enabled}
                disabled={busy}
                onChange={(event) => void toggle(event.target.checked)}
              />
              <span>Use macOS Calendar for upcoming meetings</span>
            </label>
            <p className="small muted calendar-permission-status" role="status">
              {statusLabel(settings.status)}
            </p>
            {settings.status === 'denied' && (
              <div className="call-prompt-not-for">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void openSystemSettings()}
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
  );
}
