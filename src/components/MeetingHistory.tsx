import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Pencil,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { desktop } from '../lib/bridge';
import {
  deleteKeptMeeting,
  exportKeptMeeting,
  failure,
  historyStatus,
  keptMeetingExportPreview,
  keptMeetings,
  meetingDate,
  minutes,
  openKeptMeeting,
  renameKeptMeeting,
  sourceNames,
  type AfterSessionKeep,
  type KeptListing,
  type KeptMeeting,
} from '../lib/meetingHistory';
import { clockTime } from '../lib/types';
import './meeting-history.css';

function sourceDescription(meeting: KeptMeeting) {
  if (meeting.sources === 'both' && meeting.application) {
    return `Microphone and ${meeting.application}`;
  }
  if (meeting.sources === 'application' && meeting.application) {
    return `Application (${meeting.application})`;
  }
  return sourceNames[meeting.sources];
}

/** Meetings page: list kept meetings newest first, search by title or text,
 * open read-only with notes/meeting notes/cues/transcript, rename, export,
 * and delete. */
export function MeetingHistory({
  refreshKey,
  openRequest,
}: {
  refreshKey?: number;
  openRequest?: { id: string; seq: number } | null;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<KeptListing | null>(null);
  const [afterKeep, setAfterKeep] = useState<AfterSessionKeep>('auto');
  const [selected, setSelected] = useState<KeptMeeting | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Rename state for the opened meeting.
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const renameInput = useRef<HTMLInputElement>(null);

  // Delete confirmation for the opened meeting.
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Export review modal for the opened meeting.
  const [exportPreview, setExportPreview] = useState<string | null>(null);
  const [exportError, setExportError] = useState('');
  const exportDialog = useRef<HTMLDialogElement>(null);
  const exportButton = useRef<HTMLButtonElement>(null);

  const listRequest = useRef(0);
  const openRequestRef = useRef(0);
  const handledOpenSeq = useRef(0);
  const backButton = useRef<HTMLButtonElement>(null);

  const loadList = async (search: string) => {
    const request = ++listRequest.current;
    setLoading(true);
    try {
      const [next, status] = await Promise.all([
        keptMeetings(search.trim() || undefined),
        historyStatus().catch(() => null),
      ]);
      if (request !== listRequest.current) return;
      setListing(next);
      if (status) setAfterKeep(status.afterSessionKeep);
      if (next.availability !== 'on') {
        setSelected(null);
      }
    } catch (problem) {
      if (request !== listRequest.current) return;
      setError(failure(problem, 'Meetings could not be read.'));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  };

  useEffect(() => {
    void loadList(query);
  }, [query, refreshKey]);

  // If the currently open meeting disappeared after a refresh (e.g. Delete all
  // in Settings), close it.
  useEffect(() => {
    if (!selected || !listing) return;
    if (
      listing.availability !== 'on' ||
      (!query.trim() &&
        !listing.meetings.some((item) => item.id === selected.id))
    ) {
      setSelected(null);
    }
  }, [listing, selected, query]);

  useEffect(() => {
    const dialog = exportDialog.current;
    if (!dialog) return;
    if (exportPreview !== null && !dialog.open) {
      dialog.showModal();
    } else if (exportPreview === null && dialog.open) {
      dialog.close();
      exportButton.current?.focus();
    }
  }, [exportPreview]);

  useEffect(() => {
    if (renaming) renameInput.current?.focus();
  }, [renaming]);

  const openMeeting = async (meetingId: string) => {
    const request = ++openRequestRef.current;
    setBusy(true);
    setError('');
    setNotice('');
    setRenaming(false);
    setConfirmDelete(false);
    try {
      const meeting = await openKeptMeeting(meetingId);
      if (request !== openRequestRef.current) return;
      setSelected(meeting);
      setDraftTitle(meeting.title);
      requestAnimationFrame(() => backButton.current?.focus());
    } catch (problem) {
      if (request !== openRequestRef.current) return;
      setError(failure(problem, 'That meeting could not be opened.'));
    } finally {
      if (request === openRequestRef.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!openRequest || openRequest.seq <= handledOpenSeq.current) return;
    handledOpenSeq.current = openRequest.seq;
    void openMeeting(openRequest.id);
  }, [openRequest]);

  const submitRename = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const updated = await renameKeptMeeting(selected.id, draftTitle);
      setSelected((current) =>
        current && current.id === updated.id
          ? { ...current, title: updated.title, revision: updated.revision }
          : current,
      );
      setDraftTitle(updated.title);
      setRenaming(false);
      setNotice(`Renamed to “${updated.title}”.`);
      await loadList(query);
    } catch (problem) {
      setError(failure(problem, 'The meeting could not be renamed.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteMeeting = async () => {
    if (!selected) return;
    const title = selected.title;
    setBusy(true);
    setError('');
    try {
      await deleteKeptMeeting(selected.id);
      setSelected(null);
      setConfirmDelete(false);
      setRenaming(false);
      setNotice(`Deleted “${title}”.`);
      await loadList(query);
    } catch (problem) {
      setError(failure(problem, 'The meeting could not be deleted.'));
    } finally {
      setBusy(false);
    }
  };

  const openExport = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    setExportError('');
    try {
      setExportPreview(await keptMeetingExportPreview(selected.id));
    } catch (problem) {
      setError(failure(problem, 'Could not prepare the export.'));
    } finally {
      setBusy(false);
    }
  };

  const saveExport = async () => {
    setBusy(true);
    setExportError('');
    try {
      if (await exportKeptMeeting()) {
        setExportPreview(null);
        setNotice('Export saved.');
      }
    } catch (problem) {
      setExportError(failure(problem, 'Could not save the export.'));
    } finally {
      setBusy(false);
    }
  };

  if (selected) {
    const both = selected.sources === 'both';
    return (
      <div className="history">
        <div className="history-detail-bar">
          <button
            ref={backButton}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setSelected(null);
              setRenaming(false);
              setConfirmDelete(false);
              setError('');
            }}
          >
            <ArrowLeft size={16} />
            Back to meetings
          </button>
          <div className="history-actions">
            {!renaming && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setDraftTitle(selected.title);
                  setConfirmDelete(false);
                  setError('');
                  setRenaming(true);
                }}
              >
                <Pencil size={15} />
                Rename
              </button>
            )}
            <button
              ref={exportButton}
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void openExport()}
            >
              <ArrowUpRight size={16} />
              Export…
            </button>
            {!confirmDelete && (
              <button
                type="button"
                className="secondary-button history-danger"
                disabled={busy}
                onClick={() => {
                  setRenaming(false);
                  setError('');
                  setConfirmDelete(true);
                }}
              >
                <Trash2 size={15} />
                Delete meeting…
              </button>
            )}
          </div>
        </div>

        <p className="visually-hidden" role="status">
          {notice}
        </p>

        {error && <p role="alert">{error}</p>}

        {confirmDelete && (
          <div
            className="history-confirm"
            role="group"
            aria-labelledby={`${id}-delete-title`}
          >
            <p id={`${id}-delete-title`}>
              Delete “{selected.title}” from this Mac? This cannot be undone.
            </p>
            <div className="history-actions">
              <button
                type="button"
                className="secondary-button history-danger"
                disabled={busy}
                onClick={() => void confirmDeleteMeeting()}
              >
                Delete meeting
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <header className="history-detail-head">
          {renaming ? (
            <form
              className="history-rename"
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename();
              }}
            >
              <label className="history-field" htmlFor={`${id}-rename`}>
                Meeting title
                <input
                  ref={renameInput}
                  id={`${id}-rename`}
                  type="text"
                  value={draftTitle}
                  maxLength={200}
                  disabled={busy}
                  onChange={(event) => setDraftTitle(event.target.value)}
                />
              </label>
              <div className="history-actions">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={busy || !draftTitle.trim()}
                >
                  Save title
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setRenaming(false);
                    setDraftTitle(selected.title);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <h1>{selected.title}</h1>
          )}
          <p className="history-meta">
            <span>{meetingDate(selected.startedAtMs)}</span>
            <span>{minutes(selected.durationMs)}</span>
            <span>{sourceDescription(selected)}</span>
            {selected.transcribedBy && (
              <span>Transcribed by {selected.transcribedBy}</span>
            )}
          </p>
        </header>

        <section
          className="history-section"
          aria-labelledby={`${id}-notes-heading`}
        >
          <h2 id={`${id}-notes-heading`}>Your notes</h2>
          {selected.notes.trim() ? (
            <pre className="history-text">{selected.notes}</pre>
          ) : (
            <p className="history-help">No notes.</p>
          )}
        </section>

        {selected.meetingNotes !== undefined && (
          <section
            className="history-section"
            aria-labelledby={`${id}-meeting-notes-heading`}
          >
            <h2 id={`${id}-meeting-notes-heading`}>Meeting notes</h2>
            <pre className="history-text">{selected.meetingNotes}</pre>
          </section>
        )}

        <section
          className="history-section"
          aria-labelledby={`${id}-cues-heading`}
        >
          <h2 id={`${id}-cues-heading`}>Cues shown ({selected.cues.length})</h2>
          {selected.cues.length === 0 ? (
            <p className="history-help">No cues shown.</p>
          ) : (
            <ul className="history-cues">
              {selected.cues.map((cue, index) => (
                <li key={`${cue.atMs}-${index}`} className="history-cue-item">
                  <div className="history-cue-head">
                    <span>{cue.kind}</span>
                    <time>{clockTime(cue.atMs)}</time>
                  </div>
                  <p className="history-cue-question">{cue.question}</p>
                  {cue.evidence.trim() && (
                    <p className="history-help">From: “{cue.evidence}”</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          className="history-section"
          aria-labelledby={`${id}-transcript-heading`}
        >
          <h2 id={`${id}-transcript-heading`}>
            Transcript ({selected.transcript.length})
          </h2>
          {selected.transcript.length === 0 ? (
            <p className="history-help">No transcript lines.</p>
          ) : (
            <div className="transcript">
              {selected.transcript.map((line, index) => (
                <article
                  key={`${line.atMs}-${index}`}
                  className={`transcript-segment${line.echo ? ' is-echo' : ''}`}
                >
                  <div className="transcript-segment-head">
                    {both && (
                      <span>{line.label === 'them' ? 'Them' : 'You'}</span>
                    )}
                    {line.echo && (
                      <span className="transcript-echo-label">Likely echo</span>
                    )}
                    <time>{clockTime(line.atMs)}</time>
                  </div>
                  <p>{line.text}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <dialog
          ref={exportDialog}
          className="export-dialog"
          onCancel={() => setExportPreview(null)}
          aria-labelledby={`${id}-export-title`}
        >
          <div className="dialog-heading">
            <h2 id={`${id}-export-title`}>Review your export</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close export preview"
              onClick={() => setExportPreview(null)}
            >
              <X size={20} />
            </button>
          </div>
          <p>
            This is the exact text that will be saved as Markdown. Review it
            before choosing a destination.
          </p>
          <pre>{exportPreview}</pre>
          {exportError && (
            <p role="alert" className="export-error">
              {exportError}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setExportPreview(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void saveExport()}
            >
              <ArrowDownToLine size={16} />
              Choose destination
            </button>
          </div>
        </dialog>
      </div>
    );
  }

  return (
    <div className="history">
      <h1>Meetings</h1>
      <p className="page-description">Saved on this Mac, newest first.</p>

      <p className="visually-hidden" role="status">
        {notice}
      </p>

      {error && <p role="alert">{error}</p>}

      {!desktop && listing?.availability !== 'on' ? (
        <p className="history-help">
          Meetings are available in the desktop app.
        </p>
      ) : listing?.availability === 'labRun' ? (
        <p className="history-help" role="status">
          Lab runs don’t read or save meetings.
        </p>
      ) : listing?.availability === 'unavailable' ? (
        <p className="history-help" role="status">
          Meetings are not available in this launch.
        </p>
      ) : listing?.availability === 'newer' ? (
        <p className="history-help" role="status">
          Your meetings were saved by a newer version of TalkQTE and are left as
          they are. Delete all meetings in Settings removes them.
        </p>
      ) : (
        <>
          <div className="history-search">
            <label className="visually-hidden" htmlFor={`${id}-search`}>
              Search meetings
            </label>
            <Search size={16} aria-hidden="true" />
            <input
              id={`${id}-search`}
              type="search"
              value={query}
              maxLength={200}
              placeholder="Search meetings…"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setQuery('')}
              >
                Clear
              </button>
            )}
          </div>

          {listing && listing.unreadable > 0 && (
            <p className="history-help" role="status">
              {listing.unreadable === 1
                ? '1 meeting could not be read and was left untouched.'
                : `${listing.unreadable} meetings could not be read and were left untouched.`}
            </p>
          )}

          {listing && listing.meetings.length === 0 ? (
            <div className="history-empty">
              {query.trim() ? (
                <>
                  <p>No meetings match “{query.trim()}”.</p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setQuery('')}
                  >
                    Clear search
                  </button>
                </>
              ) : (
                <p>
                  {afterKeep === 'ask'
                    ? 'No meetings yet. Choose Keep meeting after a session ends to save one here.'
                    : afterKeep === 'off'
                      ? 'No meetings yet. Auto-save is off in Settings.'
                      : 'No meetings yet. Ended sessions save here automatically.'}
                </p>
              )}
            </div>
          ) : (
            <ul className="history-list" aria-label="Meetings">
              {(listing?.meetings ?? []).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="history-item"
                    disabled={busy}
                    onClick={() => void openMeeting(item.id)}
                  >
                    <span className="history-item-title">{item.title}</span>
                    <span className="history-meta">
                      <span>{meetingDate(item.startedAtMs)}</span>
                      <span>{minutes(item.durationMs)}</span>
                      <span>{sourceNames[item.sources]}</span>
                      {item.hasMeetingNotes && (
                        <span className="history-tag">Meeting notes</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {loading && !listing && (
            <p className="history-help" role="status">
              Loading meetings…
            </p>
          )}
        </>
      )}
    </div>
  );
}
