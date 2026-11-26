import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/bridge';
import { notMacos, platformName, usePlatform } from '../lib/platform';

type LoginStatus = 'off' | 'on' | 'needsApproval' | 'unavailable';

interface Presence {
  menuBar: boolean;
  keepRunning: boolean;
  openAtLogin: LoginStatus;
  error?: string;
}

function message(failure: unknown, fallback: string) {
  return typeof failure === 'string' && failure ? failure : fallback;
}

/** Settings: keep running in the menu bar when the notebook is closed, and
 * Open at login. Both off by default. Open at login is what macOS says,
 * read each time this section opens. */
export function MenuBarSettings() {
  const [presence, setPresence] = useState<Presence | null>(null);
  const [error, setError] = useState('');
  const platform = usePlatform();

  useEffect(() => {
    let alive = true;
    invoke<Presence>('presence_settings')
      .then((next) => alive && setPresence(next))
      .catch(() => alive && setPresence(null));
    return () => {
      alive = false;
    };
  }, []);

  async function change(command: string, args?: Record<string, unknown>) {
    setError('');
    try {
      const next = await invoke<Presence>(command, args);
      setPresence(next);
      if (next.error) setError(next.error);
    } catch (failure) {
      setError(message(failure, 'The change was not confirmed. Try again.'));
    }
  }

  // The browser preview has no menu bar or login items; neither do other
  // platforms yet, which say so.
  if (desktop && notMacos(platform))
    return (
      <section className="setting" aria-labelledby="menu-bar-setting">
        <div>
          <h2 id="menu-bar-setting">Menu bar and login</h2>
          <p>
            Not available on {platformName(platform)} yet: TalkQTE has no{' '}
            {platform?.os === 'windows' ? 'notification-area' : 'tray'} icon
            here and does not open at login. Closing the notebook quits TalkQTE.
          </p>
        </div>
      </section>
    );
  if (!desktop || !presence?.menuBar) return null;
  const login = presence.openAtLogin;
  return (
    <section className="setting" aria-labelledby="menu-bar-setting">
      <div>
        <h2 id="menu-bar-setting">Menu bar and login</h2>
        <p>
          Shows session state in the menu bar, opens the notebook, and opens
          start controls; nothing starts from the menu bar by itself.
        </p>
        <label className="processing-option">
          <input
            type="checkbox"
            checked={presence.keepRunning}
            onChange={(event) =>
              void change('set_keep_running_in_menu_bar', {
                enabled: event.target.checked,
              })
            }
          />
          <span>Keep running in the menu bar when the notebook is closed</span>
        </label>
        <p className="small muted">
          Off by default: closing the notebook quits TalkQTE. When on, closing
          hides the window so call detection keeps running; quit from the menu
          bar.
        </p>
        <label className="processing-option">
          <input
            type="checkbox"
            checked={login === 'on' || login === 'needsApproval'}
            disabled={login === 'unavailable'}
            onChange={(event) =>
              void change('set_open_at_login', {
                enabled: event.target.checked,
              })
            }
          />
          <span>Open at login</span>
        </label>
        <p className="small muted" role="status">
          {login === 'on' &&
            'TalkQTE opens when you log in to this Mac. You can also change this in System Settings → General → Login Items.'}
          {login === 'off' && 'Off by default. macOS keeps this setting.'}
          {login === 'needsApproval' &&
            'macOS needs your approval before TalkQTE opens at login: allow it in System Settings → General → Login Items.'}
          {login === 'unavailable' &&
            'Open at login is not available for this copy of TalkQTE.'}
        </p>
        {login === 'needsApproval' && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => void invoke('open_login_items').catch(() => {})}
          >
            Open Login Items
          </button>
        )}
        {error && (
          <p role="alert" className="setting-error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
