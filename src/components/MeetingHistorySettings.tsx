import { useEffect, useId, useState } from 'react';
import {
  deleteAllKeptMeetings,
  failure,
  historyStatus,
  keptMeetings,
  setAfterSessionKeep,
  setAutoPriorContext,
  type AfterSessionKeep,
  type HistoryStatus,
} from '../lib/meetingHistory';
import './meeting-history.css';

const where = '~/Library/Application Support/com.talkqte.desktop/meetings';

/** Settings → Kept meetings: whether ended meetings are kept automatically,
 * asked about, or left unsaved; where kept meetings live; and Delete all
 * meetings with an inline confirmation. */
export function MeetingHistorySettings({
  onDeleted,
}: {
  onDeleted?: () => void;
}) {
  const id = useId();
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [count, setCount] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = async () => {
    const [next, listing] = await Promise.all([
      historyStatus(),
      keptMeetings(),
    ]);
    setStatus(next);
    setCount(listing.meetings.length + listing.unreadable);
  };

  useEffect(() => {
    refresh().catch(() => setStatus(null));
  }, []);

  if (!status) return null;
  const off =
    status.availability === 'labRun' || status.availability === 'unavailable';

  return (
    <section className="setting" aria-labelledby={`${id}-title`}>
      <div className="history-settings">
        <h2 id={`${id}-title`}>Meetings</h2>
        {status.availability === 'labRun' && (
          <p className="history-help">Lab runs don’t read or save meetings.</p>
        )}
        {status.availability === 'unavailable' && (
          <p className="history-help">
            Meetings are not available in this launch.
          </p>
        )}
        {status.availability === 'newer' && (
          <p className="history-help">
            Your meetings were saved by a newer version of TalkQTE and are left
            as they are. Delete all meetings still removes them.
          </p>
        )}
        {!off && (
          <>
            <div className="setting-control">
              <label htmlFor={`${id}-after-keep`}>
                After a live session ends
              </label>
              <select
                id={`${id}-after-keep`}
                value={status.afterSessionKeep}
                disabled={busy}
                aria-describedby={`${id}-offer`}
                onChange={(event) => {
                  const mode = event.target.value as AfterSessionKeep;
                  setBusy(true);
                  setError('');
                  setAfterSessionKeep(mode)
                    .then(refresh)
                    .catch((problem) =>
                      setError(
                        failure(problem, 'The setting was not changed.'),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                <option value="auto">Save automatically (default)</option>
                <option value="ask">Ask each time</option>
                <option value="off">Don’t save</option>
              </select>
            </div>
            <p className="history-help" id={`${id}-offer`}>
              Non-empty live sessions save to Meetings on stop (without the app
              name). Ask each time confirms first; Don’t save leaves ended
              sessions in memory until you quit or start another.
            </p>
            <label className="processing-option">
              <input
                type="checkbox"
                checked={status.autoPriorContext}
                disabled={busy}
                aria-describedby={`${id}-auto-prior`}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setBusy(true);
                  setError('');
                  setAutoPriorContext(enabled)
                    .then(refresh)
                    .catch((problem) =>
                      setError(
                        failure(problem, 'The setting was not changed.'),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              />
              <span>Auto-select relevant past meetings as prior context</span>
            </label>
            <p className="history-help" id={`${id}-auto-prior`}>
              When on (default), up to 3 non-archived meetings with notes are
              pre-selected for each session based on Focus and title—notes only,
              never transcripts. You can remove any item for a session or
              archive a meeting so it is never auto-selected.
            </p>
            <p className="history-help">
              Saves title, date, length, sources, transcript, notes, cues, and
              kept meeting notes—never audio or keys. Stored unencrypted in{' '}
              <code>{where}</code>, readable only by your account (FileVault
              encrypts the disk); earlier backups like Time Machine may keep
              copies after deletion.
            </p>
            {!confirming && (
              <div className="history-actions">
                <button
                  className="secondary-button history-danger"
                  disabled={busy || count === 0}
                  onClick={() => {
                    setNotice('');
                    setConfirming(true);
                  }}
                >
                  Delete all meetings…
                </button>
                <span className="history-help">
                  {count === 0
                    ? 'No saved meetings.'
                    : count === 1
                      ? '1 saved meeting.'
                      : `${count} saved meetings.`}
                </span>
              </div>
            )}
          </>
        )}
        {status.availability === 'newer' && !confirming && (
          <div className="history-actions">
            <button
              className="secondary-button history-danger"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Delete all meetings…
            </button>
          </div>
        )}
        {confirming && (
          <div
            className="history-confirm"
            role="group"
            aria-labelledby={`${id}-confirm`}
          >
            <p id={`${id}-confirm`}>
              Delete all saved meetings from this Mac? This cannot be undone.
              Export any you want to keep first.
            </p>
            <div className="history-actions">
              <button
                className="secondary-button history-danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError('');
                  deleteAllKeptMeetings()
                    .then(() => {
                      setConfirming(false);
                      setNotice('All saved meetings deleted.');
                      onDeleted?.();
                      return refresh();
                    })
                    .catch((problem) =>
                      setError(
                        failure(problem, 'The meetings could not be deleted.'),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Delete all meetings
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </section>
  );
}
