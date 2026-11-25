import { useEffect, useId, useState } from 'react';
import {
  deleteAllKeptMeetings,
  failure,
  historyStatus,
  keptMeetings,
  setAfterSessionKeep,
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
        <h2 id={`${id}-title`}>Kept meetings</h2>
        {status.availability === 'labRun' && (
          <p className="history-help">
            This is a lab run: kept meetings are not read or written.
          </p>
        )}
        {status.availability === 'unavailable' && (
          <p className="history-help">
            Kept meetings are not available in this launch.
          </p>
        )}
        {status.availability === 'newer' && (
          <p className="history-help">
            Your kept meetings were saved by a newer version of TalkQTE. This
            version leaves them exactly as they are. Delete all meetings still
            removes them.
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
                <option value="auto">Auto-save to Meetings (default)</option>
                <option value="ask">Ask each time</option>
                <option value="off">Don’t keep automatically or ask</option>
              </select>
            </div>
            <p className="history-help" id={`${id}-offer`}>
              By default, non-empty live sessions save automatically to your
              Meetings list when they stop (without storing any application
              name). Choose Ask each time to confirm in the dock or notebook
              first, or Don’t keep to leave ended sessions in memory until you
              quit or start another.
            </p>
            <p className="history-help">
              A kept meeting holds its title, date, length, the sources used,
              the transcript, your notes, the cues shown and any meeting notes
              you kept. Never audio or keys. Kept meetings are stored
              unencrypted on this Mac under your account, in{' '}
              <code>{where}</code>, readable only by you; FileVault, if it is
              on, encrypts the disk. A deleted meeting is removed from that
              folder, but a backup made earlier, such as Time Machine, may still
              hold a copy.
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
                    ? 'No meetings are kept.'
                    : count === 1
                      ? '1 meeting is kept.'
                      : `${count} meetings are kept.`}
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
              Delete every kept meeting from this Mac? This cannot be undone.
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
                      setNotice('Every kept meeting was deleted.');
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
