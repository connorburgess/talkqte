import { useEffect, useId, useRef, useState } from 'react';
import {
  defaultTitle,
  failure,
  historyStatus,
  keepMeeting,
  updateKeptSessionMeeting,
  type HistoryStatus,
} from '../lib/meetingHistory';
import type { Snapshot } from '../lib/types';
import './meeting-history.css';

/** After a non-empty live session has ended: shows the kept meeting status
 * (when auto-saved or manually kept), or offers to keep it when
 * `afterSessionKeep` is `"ask"`. Once kept, later notes or meeting notes can
 * be added to it. */
export function KeepInHistory({
  snapshot,
  historyRevision = 0,
  onKept,
  onStatus,
}: {
  snapshot: Snapshot;
  historyRevision?: number;
  onKept?: () => void;
  onStatus?: (status: HistoryStatus | null) => void;
}) {
  const id = useId();
  const ended =
    snapshot.live &&
    snapshot.status === 'ended' &&
    (snapshot.transcript.length > 0 || snapshot.notes.trim().length > 0);
  const application =
    snapshot.sources?.application &&
    snapshot.sources.application !== 'System audio'
      ? snapshot.sources.application
      : null;
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [title, setTitle] = useState('');
  const [includeApplication, setIncludeApplication] = useState(false);
  // The session the person answered Not this one for.
  const [declined, setDeclined] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keptHeading = useRef<HTMLParagraphElement>(null);
  const focusKept = useRef(false);

  // Each session starts with a fresh offer and a title from its own date.
  const session = status?.session;
  useEffect(() => {
    if (session === undefined) return;
    setTitle(defaultTitle(Date.now() - snapshot.elapsedMs));
    setIncludeApplication(false);
    setError('');
  }, [session]);

  // Whether the session was kept, and whether it changed since, follows
  // every change to the session or kept meetings.
  useEffect(() => {
    if (!ended) {
      setStatus(null);
      onStatus?.(null);
      return;
    }
    let live = true;
    historyStatus()
      .then((value) => {
        if (!live) return;
        setStatus(value);
        onStatus?.(value);
      })
      .catch(() => {
        if (!live) return;
        setStatus(null);
        onStatus?.(null);
      });
    return () => {
      live = false;
    };
  }, [ended, snapshot.revision, historyRevision]);

  useEffect(() => {
    if (focusKept.current && keptHeading.current) {
      focusKept.current = false;
      keptHeading.current.focus();
    }
  });

  if (!ended || !status || status.availability !== 'on') return null;
  const kept = status.kept;
  if (
    !kept &&
    (status.afterSessionKeep === 'off' || declined === status.session)
  )
    return null;

  const act = async (work: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError('');
    try {
      await work();
      const next = await historyStatus();
      setStatus(next);
      onStatus?.(next);
      onKept?.();
    } catch (problem) {
      setError(failure(problem, fallback));
    } finally {
      setBusy(false);
    }
  };

  if (kept)
    return (
      <section className="keep-history is-kept" aria-labelledby={`${id}-kept`}>
        <p id={`${id}-kept`} ref={keptHeading} tabIndex={-1}>
          Saved to Meetings as “{kept.title}”.
        </p>
        {kept.changed && (
          <div className="keep-history-row">
            <p className="keep-history-help">
              Notes changed since this was saved.
            </p>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void act(
                  updateKeptSessionMeeting,
                  'The saved meeting could not be updated.',
                )
              }
            >
              Update saved meeting
            </button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    );

  return (
    <section className="keep-history" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Keep this meeting?</h2>
      <p className="keep-history-help" id={`${id}-help`}>
        Saves transcript, notes, cues, and meeting notes on this Mac—never
        audio. Note reminders and Focus lines are left out.
      </p>
      <label className="keep-history-field" htmlFor={`${id}-name`}>
        Title
        <input
          id={`${id}-name`}
          type="text"
          value={title}
          maxLength={200}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      {application && (
        <label className="keep-history-check">
          <input
            type="checkbox"
            checked={includeApplication}
            disabled={busy}
            onChange={(event) => setIncludeApplication(event.target.checked)}
          />
          Include application name ({application})
        </label>
      )}
      <div className="keep-history-actions">
        <button
          className="primary-button"
          disabled={busy || !title.trim()}
          aria-describedby={`${id}-help`}
          onClick={() => {
            focusKept.current = true;
            void act(
              () => keepMeeting(title, includeApplication),
              'The meeting could not be saved. Nothing was written.',
            );
          }}
        >
          Keep meeting
        </button>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => setDeclined(status.session)}
        >
          Not this one
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
