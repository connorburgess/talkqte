import { useEffect, useState } from 'react';
import { desktop } from '../lib/bridge';
import { notMacos, usePlatform } from '../lib/platform';
import {
  resetSettings,
  settingsStatus,
  type SettingsStatus,
} from '../lib/savedSettings';

function message(failure: unknown, fallback: string) {
  return typeof failure === 'string' && failure ? failure : fallback;
}

/** Settings: what TalkQTE remembers between launches, and Reset settings.
 * `onReset` runs after the file is gone, so the page can show defaults. */
export function SavedSettings({ onReset }: { onReset: () => void }) {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const platform = usePlatform();

  useEffect(() => {
    let alive = true;
    void settingsStatus().then((next) => alive && setStatus(next));
    return () => {
      alive = false;
    };
  }, []);

  // The browser preview keeps nothing between visits.
  if (!desktop) return null;
  const labRun = status?.saving === 'labRun';
  return (
    <section className="setting" aria-labelledby="saved-settings">
      <div>
        <h2 id="saved-settings">Saved settings</h2>
        <p>
          TalkQTE remembers the choices on this page between launches: your
          name, the transcription language, the notes model, how questions look
          and when they appear, where the companion sits, panel sizes and the
          call-starting offer.{' '}
          {platform?.os === 'windows'
            ? 'They are kept in a small settings file in your user profile’s app data folder. Keys stay in Windows Credential Manager, and nothing from a meeting is saved there.'
            : platform?.os === 'linux'
              ? 'They are kept in a small settings file in your home folder that only your account can read. Keys stay in your desktop keyring, and nothing from a meeting is saved there.'
              : 'They are kept in a small settings file on this Mac that only your account can read. Keys stay in your Keychain, and nothing from a meeting is saved there.'}
        </p>
        {labRun && (
          <p className="small muted" role="status">
            This is a lab run: its choices are not saved, and your settings file
            is not read.
          </p>
        )}
        {status?.saving === 'unavailable' && (
          <p className="small muted" role="status">
            Settings cannot be saved on{' '}
            {notMacos(platform) ? 'this computer' : 'this Mac'}, so they last
            until you quit.
          </p>
        )}
        {status?.saving === 'newer' && (
          <p className="small muted" role="status">
            Your settings were saved by a newer version of TalkQTE. This version
            uses its defaults and leaves them as they are; Reset settings
            deletes them so this version can save yours.
          </p>
        )}
        {status?.error && (
          <p className="setting-error" role="alert">
            {status.error}
          </p>
        )}
        {error && (
          <p className="setting-error" role="alert">
            {error}
          </p>
        )}
        <p className="visually-hidden" role="status">
          {notice}
        </p>
      </div>
      <div className="setting-control">
        {confirming ? (
          <>
            <p id="reset-settings-question">
              Return every setting to its default?
            </p>
            <button
              type="button"
              className="secondary-button"
              aria-describedby="reset-settings-question"
              onClick={() => {
                setError('');
                resetSettings().then(
                  () => {
                    setConfirming(false);
                    setNotice('Settings are back to their defaults.');
                    onReset();
                    void settingsStatus().then(setStatus);
                  },
                  (failure) =>
                    setError(message(failure, 'Settings were not reset.')),
                );
              }}
            >
              Reset settings
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirming(false)}
            >
              Keep them
            </button>
          </>
        ) : (
          <button
            type="button"
            className="secondary-button"
            disabled={labRun}
            onClick={() => {
              setNotice('');
              setConfirming(true);
            }}
          >
            Reset settings…
          </button>
        )}
      </div>
    </section>
  );
}
