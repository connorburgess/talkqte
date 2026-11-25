import { useEffect, useId, useState } from 'react';
import { desktop } from '../lib/bridge';
import {
  checkForUpdates,
  downloadAndInstallUpdate,
  setCheckForUpdatesAtLaunch,
  watchUpdates,
  type UpdateStatus,
} from '../lib/updates';

function failureMessage(failure: unknown, fallback: string) {
  if (typeof failure === 'string' && failure) return failure;
  if (failure instanceof Error && failure.message) return failure.message;
  return fallback;
}

function progressSummary(status: UpdateStatus): string {
  if (status.phase === 'installing') return 'Installing update…';
  if (status.phase === 'restarting') return 'Restarting TalkQTE…';
  const downloaded = status.downloadedBytes ?? 0;
  const total = status.totalBytes ?? 0;
  if (total > 0) {
    const percent = Math.min(100, Math.round((downloaded / total) * 100));
    return `Downloading update… ${percent}%`;
  }
  return 'Downloading update…';
}

/** Settings → Updates: current version, launch-check toggle, manual check,
 * and install/restart offer when no live session, mic check, or dictation is active. */
export function UpdateSettings() {
  const id = useId();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    let stop: (() => void) | undefined;
    watchUpdates((next) => {
      if (!alive) return;
      setStatus(next);
      if (next.phase !== 'error' && next.error === undefined) {
        setError('');
      } else if (next.error) {
        setError(next.error);
      }
    })
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      })
      .catch(() => {
        if (alive) setError('Update controls are unavailable.');
      });
    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  if (!desktop) return null;
  if (!status) {
    return error ? (
      <section className="setting" aria-labelledby={`${id}-title`}>
        <div className="update-settings">
          <h2 id={`${id}-title`}>Updates</h2>
          <p className="update-error" role="alert">
            {error}
          </p>
        </div>
      </section>
    ) : null;
  }

  const paused = status.hold !== null;
  const inProgress =
    status.phase === 'checking' ||
    status.phase === 'downloading' ||
    status.phase === 'installing' ||
    status.phase === 'restarting';
  const canCheck =
    !busy && !inProgress && !status.labRun && status.configured && !paused;
  const shownError = error || status.error || '';

  return (
    <section className="setting" aria-labelledby={`${id}-title`}>
      <div className="update-settings">
        <div className="update-header">
          <h2 id={`${id}-title`}>Updates</h2>
          <span className="update-version">v{status.currentVersion}</span>
        </div>
        <p>
          Checks signed GitHub Releases for newer versions. Updates never check,
          prompt, or restart during a live session, microphone check, or voice
          dictation.
        </p>

        <label className="processing-option">
          <input
            type="checkbox"
            checked={status.checkAtLaunch}
            disabled={busy || inProgress || status.labRun}
            onChange={(event) => {
              const enabled = event.target.checked;
              setBusy(true);
              setError('');
              setCheckForUpdatesAtLaunch(enabled)
                .then((next) => setStatus(next))
                .catch((failure) =>
                  setError(
                    failureMessage(
                      failure,
                      'The update preference was not saved.',
                    ),
                  ),
                )
                .finally(() => setBusy(false));
            }}
          />
          <span>Check for updates on launch</span>
        </label>

        {status.labRun && (
          <p className="small muted" role="status">
            Lab runs do not check for updates.
          </p>
        )}

        {!status.labRun && !status.configured && (
          <p className="small muted" role="status">
            Updates are not configured in this build
          </p>
        )}

        {paused && (
          <p className="update-paused" role="status">
            Update paused until this session ends
          </p>
        )}

        <div className="update-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={!canCheck}
            onClick={() => {
              setBusy(true);
              setError('');
              checkForUpdates()
                .then((next) => {
                  setStatus(next);
                  if (next.error) setError(next.error);
                })
                .catch((failure) =>
                  setError(
                    failureMessage(
                      failure,
                      'Could not check for updates right now.',
                    ),
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {status.phase === 'checking'
              ? 'Checking for updates…'
              : 'Check for updates'}
          </button>
          {status.phase === 'upToDate' && !paused && !shownError && (
            <span className="small muted" role="status">
              TalkQTE is up to date.
            </span>
          )}
        </div>

        {!paused && status.available && (
          <div
            className="update-offer"
            role="group"
            aria-label={`Update available: v${status.available.version}`}
          >
            <div className="update-offer-head">
              <h3>Update available: v{status.available.version}</h3>
            </div>
            {status.available.notes && (
              <p className="update-notes">{status.available.notes}</p>
            )}
            <p className="small muted">
              Restarting quits TalkQTE; export or keep any session notes you
              want to save first.
            </p>
            {(status.phase === 'downloading' ||
              status.phase === 'installing' ||
              status.phase === 'restarting') && (
              <div className="update-progress" role="status">
                <progress
                  aria-label="Update download progress"
                  value={
                    status.phase === 'downloading' &&
                    status.totalBytes &&
                    status.totalBytes > 0
                      ? (status.downloadedBytes ?? 0)
                      : undefined
                  }
                  max={
                    status.phase === 'downloading' &&
                    status.totalBytes &&
                    status.totalBytes > 0
                      ? status.totalBytes
                      : undefined
                  }
                />
                <span className="small muted">{progressSummary(status)}</span>
              </div>
            )}
            <div className="update-offer-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy || inProgress}
                onClick={() => {
                  setBusy(true);
                  setError('');
                  downloadAndInstallUpdate()
                    .then((next) => {
                      setStatus(next);
                      if (next.error) setError(next.error);
                    })
                    .catch((failure) =>
                      setError(
                        failureMessage(
                          failure,
                          'Could not download and install the update.',
                        ),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {status.phase === 'downloading' ||
                status.phase === 'installing' ||
                status.phase === 'restarting'
                  ? progressSummary(status)
                  : 'Download and restart'}
              </button>
            </div>
          </div>
        )}

        {shownError && (
          <p className="update-error" role="alert">
            {shownError}
          </p>
        )}
      </div>
    </section>
  );
}
