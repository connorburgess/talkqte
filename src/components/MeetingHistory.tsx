import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowDown,
  ArrowUp,
  GripVertical,
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { desktop } from '../lib/bridge';
import {
  createMeetingFolder,
  deleteKeptMeeting,
  deleteMeetingFolder,
  exportKeptMeeting,
  failure,
  historyStatus,
  keptMeetingExportPreview,
  keptMeetings,
  meetingDate,
  minutes,
  openKeptMeeting,
  positionKeptMeeting,
  renameKeptMeeting,
  renameKeptMeetingSpeaker,
  renameMeetingFolder,
  setKeptMeetingFolder,
  setKeptMeetingArchived,
  sourceNames,
  type AfterSessionKeep,
  type KeptListing,
  type KeptMeeting,
  type KeptSummary,
} from '../lib/meetingHistory';
import { clockTime } from '../lib/types';
import { SpeakerChip } from './SpeakerChip';
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

/** Meetings page: saved organization order, search by title or text,
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
  const [showArchived, setShowArchived] = useState(false);
  const [notesOnly, setNotesOnly] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    if (!filtersOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (fromDate && toDate && fromDate > toDate) return;
      event.preventDefault();
      setFiltersOpen(false);
      filtersButton.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filtersOpen, fromDate, toDate]);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragHandles = useRef(new Map<string, HTMLButtonElement>());
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
  const [editingSpeaker, setEditingSpeaker] = useState<{
    key: string;
    speakerId: number;
  } | null>(null);

  // Delete confirmation for the opened meeting.
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Optional collapsible folder state.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInput = useRef<HTMLInputElement>(null);
  const newFolderButton = useRef<HTMLButtonElement>(null);
  const folderHeaders = useRef(new Map<string, HTMLElement>());
  const folderSelectors = useRef(new Map<string, HTMLSelectElement>());
  const focusFolder = (name: string) =>
    requestAnimationFrame(() => folderHeaders.current.get(name)?.focus());
  const focusNewFolder = () =>
    requestAnimationFrame(() => newFolderButton.current?.focus());
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [draftFolderName, setDraftFolderName] = useState('');
  const renameFolderInput = useRef<HTMLInputElement>(null);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<string | null>(
    null,
  );
  const [collapsedFolders, setCollapsedFolders] = useState<
    Record<string, boolean>
  >({});
  const [searchCollapsed, setSearchCollapsed] = useState<
    Record<string, boolean>
  >({});

  // Export review modal for the opened meeting.
  const [exportPreview, setExportPreview] = useState<string | null>(null);
  const [exportError, setExportError] = useState('');
  const [showEchoes, setShowEchoes] = useState(false);
  const exportDialog = useRef<HTMLDialogElement>(null);
  const exportButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setShowEchoes(false);
  }, [selected?.id]);

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

  useEffect(() => {
    if (creatingFolder) newFolderInput.current?.focus();
  }, [creatingFolder]);

  useEffect(() => {
    if (renamingFolder !== null) renameFolderInput.current?.focus();
  }, [renamingFolder]);

  const openMeeting = async (meetingId: string) => {
    const request = ++openRequestRef.current;
    setBusy(true);
    setError('');
    setNotice('');
    setRenaming(false);
    setEditingSpeaker(null);
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

  const submitSpeakerRename = async (speakerId: number, name: string) => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const updated = await renameKeptMeetingSpeaker(
        selected.id,
        speakerId,
        name,
      );
      setSelected(updated);
      setEditingSpeaker(null);
      const resolved =
        updated.speakerNames?.[speakerId] ?? `Speaker ${speakerId + 1}`;
      setNotice(`Speaker updated to “${resolved}”.`);
      await loadList(query);
    } catch (problem) {
      throw new Error(failure(problem, 'The speaker could not be renamed.'));
    } finally {
      setBusy(false);
    }
  };

  const toggleArchived = async (meetingId: string, archived: boolean) => {
    setBusy(true);
    setError('');
    try {
      const updated = await setKeptMeetingArchived(meetingId, archived);
      setSelected((current) =>
        current && current.id === updated.id
          ? {
              ...current,
              archived: updated.archived,
              revision: updated.revision,
            }
          : current,
      );
      setNotice(
        archived
          ? `Archived “${updated.title}”.`
          : `Unarchived “${updated.title}”.`,
      );
      await loadList(query);
    } catch (problem) {
      setError(
        failure(
          problem,
          archived
            ? 'The meeting could not be archived.'
            : 'The meeting could not be unarchived.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const positionMeeting = async (
    meetingId: string,
    folder: string | null,
    anchorId: string | null,
    placement: 'before' | 'after',
  ) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setDragging(null);
    setDropTarget(null);
    try {
      await positionKeptMeeting(meetingId, folder, anchorId, placement);
      await loadList(query);
      setNotice(
        `Meeting moved ${anchorId ? placement + ' the selected meeting' : 'to the end of ' + (folder ?? 'Unfiled')}.`,
      );
      requestAnimationFrame(() =>
        (
          dragHandles.current.get(meetingId) ??
          folderHeaders.current.get(folder ?? '') ??
          newFolderButton.current
        )?.focus(),
      );
    } catch (problem) {
      setError(failure(problem, 'The meeting could not be moved. Try again.'));
      requestAnimationFrame(() => dragHandles.current.get(meetingId)?.focus());
    } finally {
      setBusy(false);
    }
  };

  const dropMeeting = (
    event: React.DragEvent,
    folder: string | null,
    anchorId: string | null = null,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (
      !busy &&
      dragging &&
      dragging !== anchorId &&
      event.dataTransfer.getData('application/x-talkqte-meeting-id') ===
        dragging
    ) {
      void positionMeeting(dragging, folder, anchorId, 'before');
    }
    setDragging(null);
    setDropTarget(null);
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

  const submitCreateFolder = async () => {
    setBusy(true);
    setError('');
    try {
      const updated = await createMeetingFolder(newFolderName);
      const createdName = updated[updated.length - 1] ?? newFolderName.trim();
      setCreatingFolder(false);
      setNewFolderName('');
      setNotice(`Created folder “${createdName}”.`);
      await loadList(query);
      focusFolder(createdName);
    } catch (problem) {
      setError(failure(problem, 'The folder could not be created.'));
    } finally {
      setBusy(false);
    }
  };

  const submitRenameFolder = async () => {
    if (!renamingFolder) return;
    const oldName = renamingFolder;
    setBusy(true);
    setError('');
    try {
      const updated = await renameMeetingFolder(oldName, draftFolderName);
      const nextName =
        updated.find(
          (f) =>
            f.toLowerCase() ===
            draftFolderName.trim().replace(/\s+/g, ' ').toLowerCase(),
        ) ?? draftFolderName.trim();
      setCollapsedFolders((prev) => {
        if (!Object.hasOwn(prev, oldName)) return prev;
        const next = { ...prev };
        next[nextName] = prev[oldName];
        if (nextName !== oldName) delete next[oldName];
        return next;
      });
      setRenamingFolder(null);
      setDraftFolderName('');
      setNotice(`Renamed folder to “${nextName}”.`);
      await loadList(query);
      focusFolder(nextName);
    } catch (problem) {
      setError(failure(problem, 'The folder could not be renamed.'));
    } finally {
      setBusy(false);
    }
  };

  const submitDeleteFolder = async () => {
    if (!confirmDeleteFolder) return;
    const target = confirmDeleteFolder;
    setBusy(true);
    setError('');
    try {
      await deleteMeetingFolder(target);
      setCollapsedFolders((prev) => {
        if (!Object.hasOwn(prev, target)) return prev;
        const next = { ...prev };
        delete next[target];
        return next;
      });
      setConfirmDeleteFolder(null);
      setNotice(
        `Deleted folder “${target}”. Any meetings inside moved to the top.`,
      );
      await loadList(query);
      focusNewFolder();
    } catch (problem) {
      setError(failure(problem, 'The folder could not be deleted.'));
    } finally {
      setBusy(false);
    }
  };

  const moveMeeting = async (meetingId: string, folder: string | null) => {
    setBusy(true);
    setError('');
    try {
      const updated = await setKeptMeetingFolder(meetingId, folder);
      setSelected((current) =>
        current && current.id === updated.id
          ? {
              ...current,
              folder: updated.folder,
              revision: updated.revision,
            }
          : current,
      );
      setNotice(
        updated.folder
          ? `Moved to “${updated.folder}”.`
          : 'Moved to Unfiled / Top.',
      );
      await loadList(query);
    } catch (problem) {
      setError(failure(problem, 'The meeting could not be moved.'));
    } finally {
      setBusy(false);
      requestAnimationFrame(() =>
        folderSelectors.current.get(meetingId)?.focus(),
      );
    }
  };

  const folders = listing?.folders ?? [];

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
              setEditingSpeaker(null);
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
              Export Markdown…
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void toggleArchived(selected.id, !selected.archived)
              }
            >
              {selected.archived ? 'Unarchive' : 'Archive'}
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
            {selected.archived && <span className="history-tag">Archived</span>}
          </p>
          {(folders.length > 0 || selected.folder) && (
            <div className="history-detail-folder">
              <label
                className="history-folder-label"
                htmlFor={`${id}-detail-folder`}
              >
                Folder
                <select
                  id={`${id}-detail-folder`}
                  className="history-folder-select"
                  value={selected.folder ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    void moveMeeting(selected.id, event.target.value || null)
                  }
                >
                  <option value="">Unfiled / Top</option>
                  {folders.map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
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

        {(() => {
          const spokenTranscript = selected.transcript.filter(
            (line) => !line.echo,
          );
          const echoCount =
            selected.transcript.length - spokenTranscript.length;
          const visibleTranscript = showEchoes
            ? selected.transcript
            : spokenTranscript;
          return (
            <section
              className="history-section"
              aria-labelledby={`${id}-transcript-heading`}
            >
              <div className="history-section-head">
                <h2 id={`${id}-transcript-heading`}>
                  Transcript ({spokenTranscript.length})
                </h2>
                {echoCount > 0 && (
                  <button
                    type="button"
                    className="transcript-echo-toggle"
                    aria-expanded={showEchoes}
                    onClick={() => setShowEchoes((open) => !open)}
                  >
                    {showEchoes
                      ? `Hide ${echoCount} likely echo ${echoCount === 1 ? 'line' : 'lines'}`
                      : `Show ${echoCount} likely echo ${echoCount === 1 ? 'line' : 'lines'}`}
                  </button>
                )}
              </div>
              {selected.transcript.length === 0 ? (
                <p className="history-help">No transcript lines.</p>
              ) : visibleTranscript.length === 0 ? null : (
                <div className="transcript">
                  {visibleTranscript.map((line, index) => (
                    <article
                      key={`${line.atMs}-${index}`}
                      className={`transcript-segment${line.echo ? ' is-echo' : ''}`}
                    >
                      <div className="transcript-segment-head">
                        {line.speakerId !== undefined ? (
                          <SpeakerChip
                            speakerId={line.speakerId}
                            label={
                              selected.speakerNames?.[line.speakerId] ??
                              `Speaker ${line.speakerId + 1}`
                            }
                            disabled={busy}
                            isEditing={
                              editingSpeaker?.key === `${line.atMs}-${index}` &&
                              editingSpeaker.speakerId === line.speakerId
                            }
                            onStartEdit={() => {
                              setError('');
                              setEditingSpeaker({
                                key: `${line.atMs}-${index}`,
                                speakerId: line.speakerId!,
                              });
                            }}
                            onCancelEdit={() => setEditingSpeaker(null)}
                            onRename={submitSpeakerRename}
                          />
                        ) : (
                          both && (
                            <span>
                              {line.label === 'them' ? 'Them' : 'You'}
                            </span>
                          )
                        )}
                        {line.echo && (
                          <span className="transcript-echo-label">
                            Likely echo
                          </span>
                        )}
                        <time>{clockTime(line.atMs)}</time>
                      </div>
                      <p>{line.text}</p>
                    </article>
                  ))}
                </div>
              )}
            </section>
          );
        })()}

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

  const archivedCount = (listing?.meetings ?? []).filter(
    (item) => item.archived,
  ).length;
  const filtered = notesOnly || !!fromDate || !!toDate;
  const activeFilterCount =
    (notesOnly ? 1 : 0) +
    (fromDate ? 1 : 0) +
    (toDate ? 1 : 0) +
    (showArchived ? 1 : 0);
  const clearAllFilters = () => {
    setFromDate('');
    setToDate('');
    setNotesOnly(false);
    setShowArchived(false);
  };
  const invalidDates = !!fromDate && !!toDate && fromDate > toDate;
  const visibleMeetings = (listing?.meetings ?? []).filter((item) => {
    const when = new Date(item.startedAtMs);
    const localDate = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
    return (
      !invalidDates &&
      (showArchived || !item.archived) &&
      (!notesOnly || item.hasNotes) &&
      (!fromDate || localDate >= fromDate) &&
      (!toDate || localDate <= toDate)
    );
  });
  const searching = query.trim().length > 0;
  const canonicalFolder = new Map(folders.map((f) => [f.toLowerCase(), f]));
  const unfiledMeetings: KeptSummary[] = [];
  const meetingsByFolder = new Map<string, KeptSummary[]>(
    folders.map((folder) => [folder, []]),
  );
  for (const item of visibleMeetings) {
    const matched = item.folder
      ? canonicalFolder.get(item.folder.toLowerCase())
      : undefined;
    if (matched) {
      meetingsByFolder.get(matched)!.push(item);
    } else {
      unfiledMeetings.push(item);
    }
  }
  const visibleFolders =
    searching || filtered
      ? folders.filter(
          (folder) => (meetingsByFolder.get(folder)?.length ?? 0) > 0,
        )
      : folders;

  const renderMeetingRow = (item: KeptSummary) => {
    const folder = item.folder
      ? (canonicalFolder.get(item.folder.toLowerCase()) ?? null)
      : null;
    const siblings = folder ? meetingsByFolder.get(folder)! : unfiledMeetings;
    const index = siblings.findIndex((sibling) => sibling.id === item.id);
    const button = (
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
          {item.archived && <span className="history-tag">Archived</span>}
        </span>
      </button>
    );
    return (
      <li
        key={item.id}
        className={`history-row${item.archived ? ' is-archived' : ''}${dropTarget === item.id ? ' is-drop-target' : ''}`}
        onDragOver={(event) => {
          if (!busy && dragging && dragging !== item.id) {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            setDropTarget(item.id);
          }
        }}
        onDrop={(event) => dropMeeting(event, folder, item.id)}
      >
        {button}
        <div className="history-row-tools">
          <div
            className="history-order-controls"
            role="group"
            aria-label={`Organize ${item.title}`}
          >
            <button
              type="button"
              className="icon-button history-drag-handle"
              aria-label={`Drag ${item.title}`}
              title="Drag to a folder or before another meeting. Or use Move up, Move down and Folder."
              ref={(node) => {
                if (node) dragHandles.current.set(item.id, node);
                else dragHandles.current.delete(item.id);
              }}
              draggable={!busy}
              disabled={busy}
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  'application/x-talkqte-meeting-id',
                  item.id,
                );
                event.dataTransfer.effectAllowed = 'move';
                setDragging(item.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
            >
              <GripVertical size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Move ${item.title} up`}
              title="Move up"
              disabled={busy || index === 0}
              onClick={() =>
                void positionMeeting(
                  item.id,
                  folder,
                  siblings[index - 1].id,
                  'before',
                )
              }
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Move ${item.title} down`}
              title="Move down"
              disabled={busy || index === siblings.length - 1}
              onClick={() =>
                void positionMeeting(
                  item.id,
                  folder,
                  siblings[index + 1].id,
                  'after',
                )
              }
            >
              <ArrowDown size={15} aria-hidden="true" />
            </button>
          </div>
          {folders.length > 0 && (
            <select
              ref={(node) => {
                if (node) folderSelectors.current.set(item.id, node);
                else folderSelectors.current.delete(item.id);
              }}
              className="history-row-folder"
              aria-label={`Folder for ${item.title}`}
              value={item.folder ?? ''}
              disabled={busy}
              onChange={(event) =>
                void moveMeeting(item.id, event.target.value || null)
              }
            >
              <option value="">Unfiled / Top</option>
              {folders.map((folder) => (
                <option key={folder} value={folder}>
                  {folder}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="text-button history-archive-button"
            aria-label={`${item.archived ? 'Unarchive' : 'Archive'} ${item.title}`}
            disabled={busy}
            onClick={() => void toggleArchived(item.id, !item.archived)}
          >
            {item.archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      </li>
    );
  };

  return (
    <div className="history">
      <div className="history-page-head">
        <h1>Meetings</h1>
        <p className="page-description">Saved locally on this Mac.</p>
      </div>

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
          <div className="history-controls">
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
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchCollapsed({});
                }}
              />
              {query && (
                <button
                  type="button"
                  className="text-button history-clear-search"
                  onClick={() => {
                    setQuery('');
                    setSearchCollapsed({});
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <button
              ref={filtersButton}
              type="button"
              className={`secondary-button history-filters-btn${activeFilterCount > 0 ? ' has-active' : ''}`}
              aria-expanded={filtersOpen || invalidDates}
              aria-controls={`${id}-filters`}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              <span>
                Filters
                {activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
              </span>
            </button>
            {!creatingFolder && (
              <button
                type="button"
                ref={newFolderButton}
                className="secondary-button history-new-folder-btn"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setNotice('');
                  setRenamingFolder(null);
                  setConfirmDeleteFolder(null);
                  setNewFolderName('');
                  setCreatingFolder(true);
                }}
              >
                <Plus size={15} aria-hidden="true" />
                New folder
              </button>
            )}
          </div>

          {activeFilterCount > 0 && !filtersOpen && !invalidDates && (
            <div
              className="history-active-filters"
              role="region"
              aria-label="Active meeting filters"
            >
              {fromDate && (
                <span className="history-filter-chip">From {fromDate}</span>
              )}
              {toDate && (
                <span className="history-filter-chip">To {toDate}</span>
              )}
              {notesOnly && (
                <span className="history-filter-chip">Has notes</span>
              )}
              {showArchived && (
                <span className="history-filter-chip">Including archived</span>
              )}
              <button
                type="button"
                className="text-button"
                onClick={clearAllFilters}
              >
                Clear filters
              </button>
            </div>
          )}

          {creatingFolder && (
            <form
              className="history-folder-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreateFolder();
              }}
            >
              <label className="history-field" htmlFor={`${id}-new-folder`}>
                Folder name
                <input
                  ref={newFolderInput}
                  id={`${id}-new-folder`}
                  type="text"
                  value={newFolderName}
                  maxLength={80}
                  placeholder="e.g. Client A"
                  disabled={busy}
                  onChange={(event) => setNewFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setCreatingFolder(false);
                      setNewFolderName('');
                      focusNewFolder();
                    }
                  }}
                />
              </label>
              <div className="history-actions">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={busy || !newFolderName.trim()}
                >
                  Create folder
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setCreatingFolder(false);
                    setNewFolderName('');
                    focusNewFolder();
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
          {(filtersOpen || invalidDates) && (
            <div
              id={`${id}-filters`}
              className="history-filter-popover"
              role="group"
              aria-label="Filter meetings"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setFiltersOpen(false);
                  filtersButton.current?.focus();
                }
              }}
            >
              <div className="history-filter-row">
                <label className="history-field">
                  From date
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                  />
                </label>
                <label className="history-field">
                  To date
                  <input
                    type="date"
                    value={toDate}
                    onChange={(event) => setToDate(event.target.value)}
                  />
                </label>
                <label className="history-check">
                  <input
                    type="checkbox"
                    checked={notesOnly}
                    onChange={(event) => setNotesOnly(event.target.checked)}
                  />
                  Has notes
                </label>
                {(archivedCount > 0 || showArchived) && (
                  <label className="history-check">
                    <input
                      type="checkbox"
                      checked={showArchived}
                      onChange={(event) =>
                        setShowArchived(event.target.checked)
                      }
                    />
                    <span>Show archived ({archivedCount})</span>
                  </label>
                )}
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={clearAllFilters}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </div>
          )}
          {invalidDates && (
            <p role="alert">From date must be on or before To date.</p>
          )}

          {listing && listing.unreadable > 0 && (
            <p className="history-help" role="status">
              {listing.unreadable === 1
                ? '1 meeting could not be read and was left untouched.'
                : `${listing.unreadable} meetings could not be read and were left untouched.`}
            </p>
          )}

          {listing &&
          visibleMeetings.length === 0 &&
          (searching || filtered || folders.length === 0) ? (
            <div className="history-empty">
              {filtered ? (
                <>
                  <p>
                    No meetings match these filters
                    {searching ? ' and search' : ''}.
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setFromDate('');
                      setToDate('');
                      setNotesOnly(false);
                    }}
                  >
                    Clear filters
                  </button>
                </>
              ) : searching ? (
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
              ) : archivedCount > 0 && !showArchived ? (
                <>
                  <p>
                    {archivedCount === 1
                      ? '1 archived meeting is hidden from the list and from auto prior context.'
                      : `${archivedCount} archived meetings are hidden from the list and from auto prior context.`}
                  </p>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setShowArchived(true)}
                  >
                    Show archived
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
            <>
              <section
                className={`history-unfiled${dropTarget === 'unfiled' ? ' is-drop-target' : ''}`}
                aria-label="Unfiled meetings"
                onDragOver={(event) => {
                  if (!busy && dragging) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDropTarget('unfiled');
                  }
                }}
                onDrop={(event) => dropMeeting(event, null)}
              >
                <h2 className="history-group-title">Unfiled</h2>
                {unfiledMeetings.length > 0 ? (
                  <ul className="history-list" aria-label="Meetings">
                    {unfiledMeetings.map(renderMeetingRow)}
                  </ul>
                ) : (
                  <p className="history-help">
                    Drop a meeting here to move it out of a folder.
                  </p>
                )}
              </section>

              {visibleFolders.map((folder) => {
                const folderMeetings = meetingsByFolder.get(folder) ?? [];
                const isEditingFolder =
                  renamingFolder === folder || confirmDeleteFolder === folder;
                const isOpen = isEditingFolder
                  ? true
                  : searching || filtered
                    ? !(
                        Object.hasOwn(searchCollapsed, folder) &&
                        searchCollapsed[folder]
                      )
                    : !(
                        Object.hasOwn(collapsedFolders, folder) &&
                        collapsedFolders[folder]
                      );
                const countWord =
                  folderMeetings.length === 1 ? 'meeting' : 'meetings';
                return (
                  <div
                    key={folder}
                    className={`history-folder-group${dropTarget === `folder:${folder}` ? ' is-drop-target' : ''}`}
                    onDragOver={(event) => {
                      if (!busy && dragging) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setDropTarget(`folder:${folder}`);
                      }
                    }}
                    onDrop={(event) => dropMeeting(event, folder)}
                  >
                    <details className="history-folder" open={isOpen}>
                      <summary
                        ref={(node) => {
                          if (node) folderHeaders.current.set(folder, node);
                          else folderHeaders.current.delete(folder);
                        }}
                        className="history-folder-summary"
                        onClick={(event) => {
                          event.preventDefault();
                          if (isEditingFolder) return;
                          if (searching || filtered) {
                            setSearchCollapsed((prev) => ({
                              ...prev,
                              [folder]: isOpen,
                            }));
                          } else {
                            setCollapsedFolders((prev) => ({
                              ...prev,
                              [folder]: isOpen,
                            }));
                          }
                        }}
                      >
                        <ChevronRight
                          size={16}
                          className="history-folder-chevron"
                          aria-hidden="true"
                        />
                        <span className="history-folder-name">{folder}</span>
                        <span className="history-folder-sep" aria-hidden="true">
                          ·
                        </span>
                        <span className="history-folder-count">
                          {folderMeetings.length}
                        </span>
                        <span className="visually-hidden"> {countWord}</span>
                      </summary>
                      <div className="history-folder-body">
                        {renamingFolder === folder && (
                          <form
                            className="history-folder-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void submitRenameFolder();
                            }}
                          >
                            <label
                              className="history-field"
                              htmlFor={`${id}-rename-folder`}
                            >
                              Folder name
                              <input
                                ref={renameFolderInput}
                                id={`${id}-rename-folder`}
                                type="text"
                                value={draftFolderName}
                                maxLength={80}
                                disabled={busy}
                                onChange={(event) =>
                                  setDraftFolderName(event.target.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape') {
                                    setRenamingFolder(null);
                                    setDraftFolderName('');
                                    focusFolder(folder);
                                  }
                                }}
                              />
                            </label>
                            <div className="history-actions">
                              <button
                                type="submit"
                                className="primary-button"
                                disabled={busy || !draftFolderName.trim()}
                              >
                                Save folder
                              </button>
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={busy}
                                onClick={() => {
                                  setRenamingFolder(null);
                                  setDraftFolderName('');
                                  focusFolder(folder);
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </form>
                        )}

                        {confirmDeleteFolder === folder && (
                          <div
                            className="history-confirm"
                            role="group"
                            aria-labelledby={`${id}-delete-folder-title`}
                          >
                            <p id={`${id}-delete-folder-title`}>
                              Delete folder “{folder}”? Any meetings in this
                              folder will move to unfiled at the top (none will
                              be deleted).
                            </p>
                            <div className="history-actions">
                              <button
                                type="button"
                                className="secondary-button history-danger"
                                disabled={busy}
                                onClick={() => void submitDeleteFolder()}
                              >
                                Delete folder
                              </button>
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={busy}
                                onClick={() => {
                                  setConfirmDeleteFolder(null);
                                  focusFolder(folder);
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {folderMeetings.length === 0 ? (
                          <p className="history-help">
                            No meetings in this folder yet.
                          </p>
                        ) : (
                          <ul
                            className="history-list"
                            aria-label={`Meetings in ${folder}`}
                          >
                            {folderMeetings.map(renderMeetingRow)}
                          </ul>
                        )}
                      </div>
                    </details>
                    <div className="history-folder-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Rename folder ${folder}`}
                        title="Rename folder"
                        disabled={busy}
                        onClick={() => {
                          setError('');
                          setNotice('');
                          setCreatingFolder(false);
                          setConfirmDeleteFolder(null);
                          setDraftFolderName(folder);
                          setRenamingFolder(folder);
                        }}
                      >
                        <Pencil size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button history-danger-icon"
                        aria-label={`Delete folder ${folder}`}
                        title="Delete folder"
                        disabled={busy}
                        onClick={() => {
                          setError('');
                          setNotice('');
                          setCreatingFolder(false);
                          setRenamingFolder(null);
                          setConfirmDeleteFolder(folder);
                        }}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
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
