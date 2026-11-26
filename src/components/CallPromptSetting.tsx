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
 * Offer in the dock is on by default on macOS (off in lab runs);
 * Start automatically is off until the person turns it on; saved in the
 * settings file. */
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
          While TalkQTE is open, it notices when another app uses your
          microphone or camera (on by default; turn it off here or from the
          offer). It reads only local mic/camera-active metadata and the app’s
          bundle identifier, never audio, video, or what is on screen, and that
          stays on this Mac. Offer in the dock shows a 1-click Start button
          without starting capture; Start automatically (off by default) begins
          listening once a known call app or browser uses your microphone (never
          on a camera-only preview screen), sending your mic and macOS system
          audio to Deepgram and recent lines to Anthropic until Stop, showing
          Listening · Stop in the dock. While a live session runs, TalkQTE also
          offers a Call ended dock prompt if your call’s camera and mic go
          inactive. App preferences save by bundle identifier only.
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
