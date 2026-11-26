import { useEffect, useRef, useState } from 'react';
import { FileText, History, Link2, X } from 'lucide-react';
import * as bridge from '../lib/bridge';
import { setKeptMeetingArchived } from '../lib/meetingHistory';
import {
  savedNotesExplanation,
  usePriorContextAvailability,
} from '../lib/priorContextAvailability';
import { PriorContextAvailability } from './PriorContextAvailability';
import type {
  ContextItem,
  GranolaStatus,
  NoteSummary,
  PickedNotes,
} from '../lib/types';
import {
  GranolaNoteFreshness,
  GranolaUpdateCheck,
  useGranolaUpdateCheck,
} from './GranolaUpdateCheck';
import './context-date.css';

/**
 * Prior notes the user imported from a file for this session. They are shown
 * apart from the conversation and excluded from Markdown exports. Sending them
 * to a cue provider requires a separate processing review and approval.
 */
export function ContextNotes({
  items,
  busy,
  onError,
  onNotice,
  onGranola,
  onOpenMeetings,
  onOpenSettings,
}: {
  items: ContextItem[];
  busy: boolean;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  /** Called whenever the Granola connection is known or changes. */
  onGranola?: (status: GranolaStatus) => void;
  onOpenMeetings?: () => void;
  onOpenSettings?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const savedNotes = usePriorContextAvailability(
    expanded && items.length === 0,
  );
  const historyUnavailable =
    savedNotes.state.phase === 'ready' &&
    savedNotes.state.listing.availability !== 'on';
  const emptyHistoryReason =
    items.length === 0 &&
    savedNotes.state.phase === 'ready' &&
    (savedNotes.state.listing.availability !== 'on' ||
      savedNotes.state.listing.meetings.length === 0 ||
      savedNotes.state.listing.meetings.every(
        (meeting) => 'hasNotes' in meeting && meeting.hasNotes === false,
      ))
      ? savedNotesExplanation(savedNotes.state)
      : null;
  const [picked, setPicked] = useState<PickedNotes | null>(null);
  const [pickedFrom, setPickedFrom] = useState<'file' | 'granola' | 'history'>(
    'file',
  );
  const [granola, setGranolaState] = useState<GranolaStatus>({
    connected: false,
    tools: [],
  });
  const granolaRevision = useRef(0);
  const updates = useGranolaUpdateCheck();
  const setGranola = (status: GranolaStatus) => {
    granolaRevision.current++;
    setGranolaState(status);
    updates.connectionChanged(status);
    onGranola?.(status);
  };
  // A finding belongs to the copy that was checked, not to a later one.
  useEffect(() => updates.keepOnly(items), [items]);
  const [signingIn, setSigningIn] = useState(false);
  const [listing, setListing] = useState(false);
  useEffect(() => {
    // A startup snapshot must not replace a later connection result or report
    // through a notebook view that has since closed.
    let active = true;
    const revision = granolaRevision.current;
    const receive = (status: GranolaStatus) => {
      if (active && revision === granolaRevision.current) setGranola(status);
    };
    bridge
      .granolaStatus()
      .then(receive)
      .catch(() => receive({ connected: false, tools: [] }));
    return () => {
      active = false;
    };
  }, []);
  const [chosen, setChosen] = useState<string[]>([]);
  // Dates the person entered for file notes that have none of their own.
  const [dates, setDates] = useState<Record<string, string>>({});
  const [filePathOpen, setFilePathOpen] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [working, setWorking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pickError, setPickError] = useState('');
  const operation = useRef(0);
  const granolaButton = useRef<HTMLButtonElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  const returnConnectFocus = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const selectionLimit = pickedFrom === 'granola' ? 10 : 200;
  const allChosen =
    !!picked &&
    chosen.length === Math.min(picked.notes.length, selectionLimit) &&
    chosen.length > 0;
  // A Markdown or plain-text note without a date waits for one; TalkQTE
  // never guesses it. Rust says which files ask.
  const needsDate = (note: NoteSummary) =>
    !!picked?.asksForDates && !note.sourceDate;
  // A complete date the app accepts; a year before 1900 counts as missing.
  const entered = (id: string) => {
    const date = dates[id] ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '1900-01-01' ? date : '';
  };
  const undated =
    picked?.notes.filter(
      (note) =>
        needsDate(note) &&
        chosen.includes(note.sourceId) &&
        !entered(note.sourceId),
    ).length ?? 0;
  const addButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  const returnAddAfterRemove = useRef(false);
  const focusBeforeRemoval = (button: HTMLButtonElement) => {
    // Removal disables the buttons and may unmount them. Move focus only
    // when it is on the activated control, before the asynchronous request.
    const wasFocused = document.activeElement === button;
    if (wasFocused) summary.current?.focus();
    return wasFocused;
  };
  useEffect(() => {
    if (picked) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [picked]);
  // Return to the control that opened this chooser after it is enabled again.
  useEffect(() => {
    if (!working && returnAddAfterRemove.current) {
      returnAddAfterRemove.current = false;
      if (document.activeElement === summary.current)
        addButton.current?.focus();
    }
    if (!picked && !working && returnFocus.current) {
      returnFocus.current = false;
      (pickedFrom === 'granola'
        ? granolaButton
        : pickedFrom === 'history'
          ? historyButton
          : addButton
      ).current?.focus();
    }
    if (!working && returnConnectFocus.current) {
      returnConnectFocus.current = false;
      connectButton.current?.focus();
    }
  }, [picked, working, granola.connected]);

  async function run(work: () => Promise<void>) {
    const current = ++operation.current;
    setWorking(true);
    setPickError('');
    onError('');
    try {
      await work();
    } catch (e) {
      if (current === operation.current) {
        const message = e instanceof Error ? e.message : String(e);
        if (picked) setPickError(message);
        else onError(message);
      }
    } finally {
      if (current === operation.current) {
        setWorking(false);
        setImporting(false);
      }
    }
  }
  const pick = () =>
    void run(async () => {
      const result = await bridge.pickContextFile();
      if (!result) return;
      returnFocus.current = true;
      setChosen([]);
      setDates({});
      setPickedFrom('file');
      setPicked(result);
    });
  const readPath = () => {
    const path = filePath;
    setFilePath('');
    setFilePathOpen(false);
    void run(async () => {
      const result = await bridge.readContextFilePath(path);
      returnFocus.current = true;
      setChosen([]);
      setDates({});
      setPickedFrom('file');
      setPicked(result);
    });
  };
  const cancel = () =>
    void run(async () => {
      await bridge.command('cancel_context_import');
      setPicked(null);
    });
  // Sign-in opens the browser and waits for the return; Cancel sign-in
  // ends the wait. Nothing is read until the person lists and ticks notes.
  const connectGranola = () => {
    setSigningIn(true);
    void run(async () => {
      try {
        const status = await bridge.connectGranola();
        setGranola(status);
        onNotice(
          status.tools.includes('get_meetings')
            ? 'Granola connected. Choose which recent notes to bring in.'
            : 'Granola connected, but this account offers no note access.',
        );
      } finally {
        setSigningIn(false);
      }
    });
  };
  const cancelSignIn = () =>
    void bridge.command('cancel_granola_sign_in').catch(() => {});
  const chooseGranola = () =>
    void run(async () => {
      const current = operation.current;
      setListing(true);
      try {
        const result = await bridge.listGranolaNotes();
        if (current !== operation.current) return;
        returnFocus.current = true;
        setChosen([]);
        setPickedFrom('granola');
        setPicked(result);
      } finally {
        if (current === operation.current) setListing(false);
      }
    });
  const chooseHistory = () =>
    void run(async () => {
      const result = await bridge.listKeptMeetingsForContext();
      returnFocus.current = true;
      setChosen([]);
      setPickedFrom('history');
      setPicked(result);
    });
  const disconnectGranola = () =>
    void run(async () => {
      // Retire the listing UI immediately, independently of its response.
      // A failed disconnect keeps the connection and allows an explicit retry.
      setListing(false);
      setGranola(await bridge.disconnectGranola());
      returnConnectFocus.current = true;
      onNotice(
        'Granola disconnected. Imported notes stay until you remove them.',
      );
    });
  const importChosen = () =>
    void run(async () => {
      const current = operation.current;
      setImporting(true);
      const outcome = await bridge.importContextNotes(
        chosen,
        picked?.asksForDates
          ? Object.fromEntries(
              chosen.filter(entered).map((id) => [id, entered(id)]),
            )
          : undefined,
      );
      // Rust decides which earlier findings the import ended.
      if (pickedFrom === 'granola')
        void bridge
          .granolaStatus()
          .then((status) => updates.sync(status.freshness ?? []))
          .catch(() => {});
      if (current !== operation.current) return;
      setPicked(null);
      const parts = [
        outcome.added ? `${outcome.added} imported` : '',
        outcome.updated ? `${outcome.updated} updated` : '',
        outcome.unchanged ? `${outcome.unchanged} already imported` : '',
        outcome.rejected ? `${outcome.rejected} skipped (no date or text)` : '',
        outcome.overLimit ? `${outcome.overLimit} over the limit of 20` : '',
      ].filter(Boolean);
      onNotice(parts.length ? `${parts.join(', ')}.` : 'Nothing imported.');
    });

  return (
    <section className="context-panel" aria-label="Prior context">
      <details
        className="context-disclosure"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary
          ref={summary}
          onBlur={() => {
            returnAddAfterRemove.current = false;
          }}
          aria-disabled={working || undefined}
          onClick={(event) => {
            // Keep cancellation and disconnect reachable while a request is pending.
            if (working && event.currentTarget.closest('details')?.open)
              event.preventDefault();
          }}
        >
          <strong>Prior context</strong>
          <span className="muted small">
            {items.length === 1
              ? '1 note selected'
              : `${items.length} notes selected`}
            {granola.connected ? ' · Granola connected' : ''}
          </span>
        </summary>
        {items.length === 0 && (
          <PriorContextAvailability
            state={savedNotes.state}
            busy={busy || working}
            refresh={savedNotes.refresh}
            onOpenMeetings={onOpenMeetings}
            onOpenSettings={onOpenSettings}
          />
        )}
        <div className="context-heading">
          <div>
            <span className="muted small">
              Use your written notes or kept meeting notes from past meetings,
              files, or Granola. Transcripts are not used as prior context.
              Imported notes stay in memory for this session and are excluded
              from Markdown exports. Review and approve them separately before
              sending them to a cue provider.
            </span>
          </div>
          <div className="context-controls">
            <div className="context-actions">
              <button
                ref={addButton}
                className="secondary-button"
                disabled={busy || working}
                onClick={pick}
              >
                <FileText size={15} />
                Add notes from a file
              </button>
              {bridge.desktop && (
                <button
                  ref={historyButton}
                  className="secondary-button"
                  disabled={busy || working || historyUnavailable}
                  onClick={chooseHistory}
                >
                  <History size={15} />
                  Choose kept meetings
                </button>
              )}
              {bridge.desktop &&
                (granola.connected ? (
                  <button
                    className="secondary-button"
                    disabled={busy || working}
                    ref={granolaButton}
                    onClick={chooseGranola}
                  >
                    <Link2 size={15} />
                    {listing
                      ? 'Loading Granola notes…'
                      : 'Choose Granola notes'}
                  </button>
                ) : !signingIn ? (
                  <button
                    ref={connectButton}
                    className="secondary-button"
                    disabled={busy || working}
                    onClick={connectGranola}
                  >
                    <Link2 size={15} />
                    Connect Granola
                  </button>
                ) : null)}
            </div>
            <div className="context-secondary-actions">
              <button
                className="text-button"
                disabled={busy || working}
                onClick={() => {
                  setFilePath('');
                  setFilePathOpen(true);
                }}
              >
                Use a local file path
              </button>
              {bridge.desktop && granola.connected && (
                <button
                  className="text-button"
                  disabled={busy || (working && !listing)}
                  onClick={disconnectGranola}
                >
                  Disconnect Granola
                </button>
              )}
              {bridge.desktop && !granola.connected && signingIn && (
                <button className="text-button" onClick={cancelSignIn}>
                  Cancel sign-in
                </button>
              )}
              {items.length > 0 && (
                <button
                  className="text-button"
                  disabled={busy || working}
                  onClick={(event) => {
                    returnAddAfterRemove.current = focusBeforeRemoval(
                      event.currentTarget,
                    );
                    void run(async () => {
                      const removed = await bridge.removeAllContext();
                      onNotice(
                        removed === 1
                          ? '1 imported note removed.'
                          : `${removed} imported notes removed.`,
                      );
                    });
                  }}
                >
                  Remove all
                </button>
              )}
            </div>
          </div>
        </div>
        {filePathOpen && (
          <form
            className="context-path-form"
            onSubmit={(event) => {
              event.preventDefault();
              readPath();
            }}
          >
            <p className="muted small">
              If the system file chooser is unavailable, enter the full local
              path. This only lists notes for selection; nothing is imported
              yet.
            </p>
            <label>
              Local notes file path
              <input
                value={filePath}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setFilePath(event.target.value)}
              />
            </label>
            <div className="context-actions">
              <button
                type="submit"
                className="secondary-button"
                disabled={busy || working || !filePath}
              >
                Read notes file
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setFilePath('');
                  setFilePathOpen(false);
                }}
              >
                Cancel file path
              </button>
            </div>
          </form>
        )}
        {granola.connected && (
          <p className="muted small connection-terms" role="status">
            Granola connected.{' '}
            {granola.tools.includes('get_meetings')
              ? 'Reads only notes you select (last 30 days)'
              : 'No note access on this account'}
            {granola.tools.includes('query_granola_meetings')
              ? ' and answers Suggest from Granola'
              : ''}
            ; no transcripts or writeback. Disconnect forgets sign-in; imported
            notes stay until removed.
          </p>
        )}
        {signingIn && (
          <p className="muted small" role="status">
            Sign in to Granola in your browser, then return here. Nothing is
            read until you choose notes.
          </p>
        )}
        {listing && (
          <p className="muted small" role="status">
            Loading recent notes… You can disconnect while you wait.
          </p>
        )}
        {granola.connected && granola.updateCheck && (
          <GranolaUpdateCheck
            updates={updates}
            count={items.filter((item) => item.provider === 'granola').length}
          />
        )}
        {items.length > 0 && (
          <ul className="context-list">
            {items.map((item) => (
              <li key={`${item.provider}:${item.sourceId}`}>
                <div>
                  <div className="context-item-head">
                    <strong>{item.title}</strong>
                    {item.autoSelected && (
                      <span className="context-auto-chip">Auto</span>
                    )}
                  </div>
                  <span className="muted small">
                    {item.sourceDate} ·{' '}
                    {item.provider === 'granola'
                      ? 'From Granola'
                      : item.provider === 'history'
                        ? item.autoSelected
                          ? 'Auto-selected from kept meetings'
                          : 'From a kept meeting'
                        : 'From a file'}
                  </span>
                  {item.provider === 'granola' && (
                    <GranolaNoteFreshness
                      freshness={updates.freshness.find(
                        (note) => note.sourceId === item.sourceId,
                      )}
                    />
                  )}
                  <p>{item.excerpt}</p>
                </div>
                <div className="context-item-actions">
                  {item.provider === 'history' && bridge.desktop && (
                    <button
                      type="button"
                      className="text-button context-archive-button"
                      aria-label={`Archive ${item.title} (${item.sourceDate}) so it is never auto-selected`}
                      title="Archive (never include again)"
                      disabled={busy || working}
                      onClick={(event) => {
                        focusBeforeRemoval(event.currentTarget);
                        void run(async () => {
                          await setKeptMeetingArchived(item.sourceId, true);
                          onNotice(`Archived “${item.title}”.`);
                        });
                      }}
                    >
                      Archive
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${item.title} (${item.sourceDate})`}
                    title="Remove for this session"
                    disabled={busy || working}
                    onClick={(event) => {
                      focusBeforeRemoval(event.currentTarget);
                      void run(() =>
                        bridge.command('remove_context_item', {
                          provider: item.provider,
                          sourceId: item.sourceId,
                        }),
                      );
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </details>
      <dialog
        ref={dialog}
        className="export-dialog context-dialog"
        onCancel={(e) => {
          e.preventDefault();
          cancel();
        }}
        onClose={() => {
          // A native close (a second Escape) must still release the file.
          if (picked) cancel();
        }}
        aria-labelledby="context-pick-title"
        aria-describedby="context-pick-description"
      >
        <div className="dialog-heading">
          <h2 id="context-pick-title">
            Choose notes{picked ? ` from ${picked.fileName}` : ''}
          </h2>
          <button
            className="icon-button"
            aria-label="Close without importing"
            disabled={working && !importing}
            onClick={cancel}
          >
            <X size={20} />
          </button>
        </div>
        <p id="context-pick-description">
          Selected notes stay in memory for this session under Prior context and
          never trigger cues on their own. Sending them to a cue provider needs
          a separate processing review and approval.
        </p>
        {pickedFrom === 'history' && (
          <p className="small muted">
            Only your written notes and kept meeting notes are listed, never
            transcripts. Archived notes can be chosen manually. Tick the notes
            you want to review and import; nothing is selected automatically in
            this chooser.
          </p>
        )}
        {pickedFrom === 'granola' && picked && picked.notes.length > 0 && (
          <p className="small">
            Choose up to 10 notes per import. Keep up to 20 in this session.
          </p>
        )}
        {picked && picked.skipped > 0 && (
          <p className="muted small">
            {picked.skipped} more{' '}
            {picked.skipped === 1 ? 'note is' : 'notes are'} not listed
            {pickedFrom === 'granola'
              ? ': Granola returned a partial list, or it exceeds the 200-note chooser limit.'
              : pickedFrom === 'history'
                ? ': only kept meetings with your notes or kept meeting notes (up to 200) are listed.'
                : ': the file has repeated ids or more than 200 notes.'}
          </p>
        )}
        {picked && picked.notes.length > 1 && (
          <div className="context-choose-all small">
            <span role="status">
              {chosen.length} of {picked.notes.length} selected
            </span>
            <button
              type="button"
              className="text-button"
              disabled={working}
              onClick={() =>
                setChosen(
                  allChosen
                    ? []
                    : picked.notes
                        .slice(0, selectionLimit)
                        .map((note) => note.sourceId),
                )
              }
            >
              {allChosen
                ? 'Clear all'
                : picked.notes.length > selectionLimit
                  ? `Select first ${selectionLimit}`
                  : 'Select all'}
            </button>
          </div>
        )}
        {picked && picked.notes.length === 0 && (
          <p className="context-empty" role="status">
            {pickedFrom === 'granola'
              ? 'No notes came back from Granola for the last 30 days. If you have meetings there from that time, the listing is not working yet; nothing was imported.'
              : pickedFrom === 'history'
                ? emptyHistoryReason
                  ? `${emptyHistoryReason.title} ${emptyHistoryReason.detail} Nothing was imported.`
                  : 'No reusable saved notes could be listed. Review Meetings, or add notes from a file or Granola. Nothing was imported.'
                : 'This file has no notes with an id, a date, and text; nothing was imported.'}
          </p>
        )}
        <ul className="context-choices">
          {picked?.notes.map((note, index) => (
            <li key={note.sourceId}>
              <label>
                <input
                  type="checkbox"
                  aria-describedby={
                    note.preview ? `context-preview-${index}` : undefined
                  }
                  disabled={
                    working ||
                    (chosen.length >= selectionLimit &&
                      !chosen.includes(note.sourceId))
                  }
                  checked={chosen.includes(note.sourceId)}
                  onChange={(e) =>
                    setChosen((current) =>
                      e.target.checked
                        ? [...current, note.sourceId]
                        : current.filter((id) => id !== note.sourceId),
                    )
                  }
                />
                <span className="context-choice-copy">
                  <strong>{note.title}</strong>
                  {needsDate(note) ? (
                    <span className="muted small">No date in the file</span>
                  ) : (
                    <time className="muted small" dateTime={note.sourceDate}>
                      {note.sourceDate}
                    </time>
                  )}
                  {note.preview && (
                    <span
                      className="context-preview"
                      id={`context-preview-${index}`}
                    >
                      {note.preview}
                    </span>
                  )}
                </span>
              </label>
              {needsDate(note) && (
                <label className="context-date">
                  <span>Date</span>
                  <input
                    type="date"
                    min="1900-01-01"
                    aria-label={`Date of ${note.title}`}
                    disabled={working}
                    value={dates[note.sourceId] ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDates((current) => ({
                        ...current,
                        [note.sourceId]: value,
                      }));
                    }}
                  />
                </label>
              )}
            </li>
          ))}
        </ul>
        {undated > 0 && (
          <p className="small" role="status">
            Enter the date of each ticked note that has none in the file.
            TalkQTE never guesses a date.
          </p>
        )}
        {pickError && (
          <p className="export-error" role="alert">
            {pickError}
          </p>
        )}
        {importing && (
          <p role="status">
            Reading selected notes… You can cancel without importing.
          </p>
        )}
        <div className="dialog-actions">
          <button
            className="secondary-button"
            disabled={working && !importing}
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={working || chosen.length === 0 || undated > 0}
            onClick={importChosen}
          >
            {importing
              ? 'Importing…'
              : `Import ${chosen.length || ''} selected`}
          </button>
        </div>
      </dialog>
    </section>
  );
}
