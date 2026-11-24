import { useEffect, useId, useRef, useState } from 'react';
import {
  failure,
  keptMeetings,
  meetingDate,
  minutes,
  sourceNames,
  type KeptListing,
} from '../lib/meetingHistory';
import { KeptMeetingView } from './KeptMeetingView';
import './meeting-history.css';

/** The Meetings page: kept meetings, newest first, with a search over their
 * titles and text. Choosing one opens it read-only. Nothing here sends
 * anything anywhere; the search runs on this Mac. */
export function MeetingHistory() {
  const id = useId();
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<KeptListing | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const searchField = useRef<HTMLInputElement>(null);
  const returnTo = useRef<string | null>(null);
  const request = useRef(0);

  const load = async (text: string) => {
    const mine = ++request.current;
    try {
      const next = await keptMeetings(text.trim());
      if (mine === request.current) {
        setListing(next);
        setError('');
      }
    } catch (problem) {
      if (mine === request.current)
        setError(failure(problem, 'Kept meetings could not be listed.'));
    }
  };

  // Search after a short pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query]);

  // Back from a meeting: focus its row again, or the search if it is gone.
  useEffect(() => {
    if (open || !listing || !returnTo.current) return;
    const row = document.getElementById(`${id}-row-${returnTo.current}`);
    returnTo.current = null;
    (row ?? searchField.current)?.focus();
  }, [open, listing]);

  if (open)
    return (
      <KeptMeetingView
        id={open}
        onClose={(change) => {
          returnTo.current = change === 'deleted' ? '' : open;
          setOpen(null);
          if (change === 'deleted') setNotice('Meeting deleted.');
          void load(query);
        }}
      />
    );

  const availability = listing?.availability;
  return (
    <div className="secondary-page history" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`}>Meetings</h1>
      <p className="page-description">
        Meetings you chose to keep, newest first. They are stored on this Mac
        only, until you delete them.
      </p>
      {availability === 'labRun' && (
        <p className="history-help">
          This is a lab run: kept meetings are not read or written.
        </p>
      )}
      {availability === 'unavailable' && (
        <p className="history-help">
          Kept meetings are not available in this launch.
        </p>
      )}
      {availability === 'newer' && (
        <p className="history-help">
          Your kept meetings were saved by a newer version of TalkQTE. This
          version leaves them exactly as they are; update TalkQTE to read them.
        </p>
      )}
      {availability === 'on' && (
        <>
          <label className="history-field history-search" htmlFor={`${id}-q`}>
            Search titles and text
            <input
              id={`${id}-q`}
              ref={searchField}
              type="search"
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {listing && listing.unreadable > 0 && (
            <p className="history-help">
              {listing.unreadable === 1
                ? '1 kept meeting could not be read and is not shown.'
                : `${listing.unreadable} kept meetings could not be read and are not shown.`}{' '}
              It is left as it is; Settings → Delete all meetings removes it.
            </p>
          )}
          {listing && listing.meetings.length === 0 && (
            <p className="history-empty" role="status">
              {query.trim()
                ? 'No kept meeting matches that search.'
                : 'No meetings are kept yet. After a live session ends, choose Keep meeting to keep it here.'}
            </p>
          )}
          {listing && listing.meetings.length > 0 && (
            <ul className="history-list" aria-label="Kept meetings">
              {listing.meetings.map((meeting) => (
                <li key={meeting.id}>
                  <button
                    id={`${id}-row-${meeting.id}`}
                    className="history-row"
                    onClick={() => {
                      setNotice('');
                      setOpen(meeting.id);
                    }}
                  >
                    <span className="history-row-title">{meeting.title}</span>
                    <span className="history-row-meta">
                      {meetingDate(meeting.startedAtMs)} ·{' '}
                      {minutes(meeting.durationMs)} ·{' '}
                      {sourceNames[meeting.sources]}
                      {meeting.hasMeetingNotes ? ' · Meeting notes' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
