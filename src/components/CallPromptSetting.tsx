import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { desktop } from '../lib/bridge';
import { platformName, usePlatform } from '../lib/platform';

interface Settings {
  enabled: boolean;
  autoStart: boolean;
  notFor: string[];
}

/** Settings: offer to start or auto-start a session when a call begins.
 * Both are off until the person turns them on; saved in the settings file. */
export function CallPromptSetting() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const platform = usePlatform();

  useEffect(() => {
    let alive = true;
    invoke<Settings>('call_prompt_settings')
      .then((next) => alive && setSettings(next))
      .catch(() => alive && setError('This setting is unavailable.'));
    // The menu bar has the same switch.
    let stop: (() => void) | undefined;
    if (desktop)
      void listen<Settings>('call-prompt:settings', ({ payload }) => {
        if (alive) setSettings(payload);
      })
        .then((unlisten) => {
          if (alive) stop = unlisten;
          else unlisten();
        })
        .catch(() => {});
    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  async function change(command: string, args?: Record<string, unknown>) {
    setError('');
    try {
      setSettings(await invoke<Settings>(command, args));
    } catch (failure) {
      setError(
        typeof failure === 'string' && failure
          ? failure
          : 'The change was not confirmed. Try again.',
      );
    }
  }

  // The browser preview has no microphone or applications to notice.
  if (!desktop) return null;
  if (platform && !platform.callPrompt)
    return (
      <section className="setting" aria-labelledby="call-prompt-setting">
        <div>
          <h2 id="call-prompt-setting">When a call starts</h2>
          <p>
            Not available on {platformName(platform)} yet. On a Mac, TalkQTE can
            offer or start a live session when another app starts using the
            microphone; here, start a live session from the notebook.
          </p>
        </div>
      </section>
    );
  return (
    <section className="setting" aria-labelledby="call-prompt-setting">
      <div>
        <h2 id="call-prompt-setting">When a call starts</h2>
        <p>
          While TalkQTE is open, it can notice when another app uses your
          microphone for 3 seconds. It reads only whether the microphone is in
          use and which app is in front, never audio or what is on screen, and
          that stays on this Mac. Offer in the dock gives a 1-click Start
          button. Start automatically begins listening immediately when a known
          meeting app or browser starts using the microphone (when your keys are
          configured and no session is running), sending your microphone to
          Deepgram and recent lines to Anthropic until you press Stop, and shows
          Listening · Stop in the dock. A browser call (Google Meet, for
          example) looks like any other use of the microphone in a browser.
          TalkQTE has to be running to notice. It remembers these settings, and
          the apps you said not to ask about, by their identifiers only.
        </p>
        {settings && (
          <>
            <label className="processing-option call-prompt-setting-option">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) =>
                  void change('set_call_prompt', {
                    enabled: event.target.checked,
                  })
                }
              />
              <span>Offer in the dock when a call seems to start</span>
            </label>
            <label className="processing-option call-prompt-setting-option">
              <input
                type="checkbox"
                checked={settings.autoStart}
                onChange={(event) =>
                  void change('set_call_prompt', {
                    autoStart: event.target.checked,
                  })
                }
              />
              <span>Start automatically when a call begins</span>
            </label>
          </>
        )}
        {!!settings?.notFor.length && (
          <p className="small muted call-prompt-not-for">
            <span>Not offered for: {settings.notFor.join(', ')}.</span>
            <button
              className="secondary-button"
              onClick={() => void change('clear_call_prompt_apps')}
            >
              Offer for these again
            </button>
          </p>
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
