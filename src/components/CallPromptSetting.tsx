import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/bridge';

interface Settings {
  enabled: boolean;
  notFor: string[];
}

/** Settings: offer to start a session when a call seems to be starting.
 * Off until the person turns it on; for this launch only. */
export function CallPromptSetting() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    invoke<Settings>('call_prompt_settings')
      .then((next) => alive && setSettings(next))
      .catch(() => alive && setError('This setting is unavailable.'));
    return () => {
      alive = false;
    };
  }, []);

  async function change(command: string, args?: Record<string, unknown>) {
    setError('');
    try {
      setSettings(await invoke<Settings>(command, args));
    } catch {
      setError('The change was not confirmed. Try again.');
    }
  }

  // The browser preview has no microphone or applications to notice.
  if (!desktop) return null;
  return (
    <section className="setting" aria-labelledby="call-prompt-setting">
      <div>
        <h2 id="call-prompt-setting">When a call starts</h2>
        <p>
          While TalkQTE is open, it can notice that another app is using your
          microphone and offer, in the companion, to start a session with the
          microphone and that app. It reads only whether the microphone is in
          use and which app is in front, never audio or what is on screen, and
          that stays on this Mac. It never starts a session by itself: Start
          opens the notebook, where you choose and approve as usual. A browser
          call (Google Meet, for example) looks like any other use of the
          microphone in a browser. TalkQTE has to be running to notice. This
          setting lasts until you quit.
        </p>
        {settings && (
          <label className="processing-option">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) =>
                void change('set_call_prompt', {
                  enabled: event.target.checked,
                })
              }
            />
            <span>Offer to start a session when a call seems to start</span>
          </label>
        )}
        {!!settings?.notFor.length && (
          <p className="small muted">
            Not offered for: {settings.notFor.join(', ')}.{' '}
            <button
              className="secondary-button"
              onClick={() => void change('clear_call_prompt_apps')}
            >
              Offer for these again
            </button>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
