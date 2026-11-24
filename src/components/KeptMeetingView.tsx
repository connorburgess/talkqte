import { useEffect, useId, useRef, useState } from 'react';
import {
  clock,
  deleteKeptMeeting,
  exportKeptMeeting,
  failure,
  meetingDate,
  minutes,
  openKeptMeeting,
  renameKeptMeeting,
  sourceNames,
  type KeptMeeting,
} from '../lib/meetingHistory';
import './meeting-history.css';

/** One kept meeting, read-only: its meeting notes, the person's notes, the
 * cues shown and the transcript. Rename, Export and Delete are explicit;
 * nothing else changes it. */
export function KeptMeetingView({
  id,
  onClose,
}: {
  id: string;
  onClose: (change?: 'deleted') => void;
}) {
  const uid = useId();
  const [meeting, setMeeting] = useState<KeptMeeting | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    openKeptMeeting(id)
      .then((value) => {
        if (!live) return;
        setMeeting(value);
        requestAnimationFrame(() => heading.current?.focus());
      })
      .catch(
        (problem) =>
          live && setError(failure(problem, 'That meeting could not be read.')),
      );
    return () => {
      live = false;
    };
  }, [id]);

  const act = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (problem) {
      setError(failure(problem, fallback));
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <button className="secondary-button" onClick={() => onClose()}>
      Back to meetings
    </button>
  );

  if (!meeting)
    return (
      <div className="secondary-page history">
        {back}
        {error && <p role="alert">{error}</p>}
      </div>
    );

  return (
    <article
      className="secondary-page history kept-meeting"
      aria-labelledby={`${uid}-title`}
    >
      <div className="history-actions">{back}</div>
      <h1 id={`${uid}-title`} ref={heading} tabIndex={-1}>
        {meeting.title}
      </h1>
      <p className="page-description">
        {meetingDate(meeting.startedAtMs)} · {minutes(meeting.durationMs)} ·{' '}
        {sourceNames[meeting.sources]}
        {meeting.application ? ` (${meeting.application})` : ''}
      </p>

      {renaming === null && !deleting && (
        <div className="history-actions">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => setRenaming(meeting.title)}
          >
            Rename
          </button>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (await exportKeptMeeting(meeting.id))
                  setNotice('Export saved.');
              }, 'The meeting could not be exported.')
            }
          >
            Export…
          </button>
          <button
            className="secondary-button history-danger"
            disabled={busy}
            onClick={() => setDeleting(true)}
          >
            Delete…
          </button>
        </div>
      )}

      {renaming !== null && (
        <form
          className="history-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const summary = await renameKeptMeeting(meeting.id, renaming);
              setMeeting({ ...meeting, title: summary.title });
              setRenaming(null);
              setNotice('Meeting renamed.');
              heading.current?.focus();
            }, 'The meeting could not be renamed.');
          }}
        >
          <label className="history-field" htmlFor={`${uid}-rename`}>
            Title
            <input
              id={`${uid}-rename`}
              type="text"
              value={renaming}
              maxLength={200}
              autoFocus
              disabled={busy}
              onChange={(event) => setRenaming(event.target.value)}
            />
          </label>
          <div className="history-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={busy || !renaming.trim()}
            >
              Save title
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => setRenaming(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {deleting && (
        <div
          className="history-confirm"
          role="group"
          aria-labelledby={`${uid}-delete`}
        >
          <p id={`${uid}-delete`}>
            Delete “{meeting.title}” from this Mac? This cannot be undone.
          </p>
          <div className="history-actions">
            <button
              className="secondary-button history-danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await deleteKeptMeeting(meeting.id);
                  onClose('deleted');
                }, 'The meeting could not be deleted.')
              }
            >
              Delete meeting
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              autoFocus
              onClick={() => setDeleting(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}

      {meeting.meetingNotes && (
        <section aria-labelledby={`${uid}-mn`} className="kept-section">
          <h2 id={`${uid}-mn`}>Meeting notes</h2>
          <pre className="kept-text">{meeting.meetingNotes}</pre>
        </section>
      )}
      <section aria-labelledby={`${uid}-notes`} className="kept-section">
        <h2 id={`${uid}-notes`}>Your notes</h2>
        {meeting.notes.trim() ? (
          <pre className="kept-text">{meeting.notes}</pre>
        ) : (
          <p className="history-help">None.</p>
        )}
      </section>
      <section aria-labelledby={`${uid}-cues`} className="kept-section">
        <h2 id={`${uid}-cues`}>Cues shown</h2>
        {meeting.cues.length === 0 ? (
          <p className="history-help">None.</p>
        ) : (
          <ol className="kept-lines">
            {meeting.cues.map((cue, index) => (
              <li key={index}>
                <span className="kept-time">{clock(cue.atMs)}</span>
                <span>
                  {cue.kind}: {cue.question}
                  {cue.evidence && (
                    <span className="history-help">
                      {' '}
                      (from: “{cue.evidence}”)
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-labelledby={`${uid}-transcript`} className="kept-section">
        <h2 id={`${uid}-transcript`}>Transcript</h2>
        <p className="history-help">
          {meeting.transcribedBy
            ? `Transcribed by ${meeting.transcribedBy}. Speakers are not identified.`
            : 'Speakers are not identified.'}
          {meeting.sources === 'both' &&
            ' You marks a line heard by the microphone and Them a line from the application; they say where a line was heard, not who said it.'}
        </p>
        <ol className="kept-lines">
          {meeting.transcript.map((line, index) => (
            <li key={index} className={line.echo ? 'is-echo' : undefined}>
              <span className="kept-time">{clock(line.atMs)}</span>
              <span>
                {line.label && (
                  <strong>
                    {line.label === 'you' ? 'You' : 'Them'}
                    {line.echo ? ' (likely an echo of Them)' : ''}:{' '}
                  </strong>
                )}
                {line.text}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
