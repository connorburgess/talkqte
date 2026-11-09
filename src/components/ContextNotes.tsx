import { useEffect, useRef, useState } from 'react';
import { FileText, Link2, X } from 'lucide-react';
import * as bridge from '../lib/bridge';
import type { ContextItem, GranolaStatus, PickedNotes } from '../lib/types';

/**
 * Prior notes the user imported from a file for this session. They are shown
 * apart from the conversation, never feed a cue yet, and are never exported.
 */
export function ContextNotes({
  items,
  busy,
  onError,
  onNotice,
}: {
  items: ContextItem[];
  busy: boolean;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [picked, setPicked] = useState<PickedNotes | null>(null);
  const [granola, setGranola] = useState<GranolaStatus>({
    connected: false,
    tools: [],
  });
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    // The desktop keeps the session for the app run; the preview has none.
    bridge
      .granolaStatus()
      .then(setGranola)
      .catch(() => setGranola({ connected: false, tools: [] }));
  }, []);
  const [chosen, setChosen] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const allChosen =
    !!picked &&
    picked.notes.length > 0 &&
    picked.notes.every((note) => chosen.includes(note.sourceId));
  const addButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (picked) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [picked]);
  // Focus goes back to the Add button once the chooser has closed and the
  // button is enabled again.
  useEffect(() => {
    if (!picked && !working && returnFocus.current) {
      returnFocus.current = false;
      addButton.current?.focus();
    }
  }, [picked, working]);

  async function run(work: () => Promise<void>) {
    setWorking(true);
    onError('');
    try {
      await work();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }
  const pick = () =>
    void run(async () => {
      const result = await bridge.pickContextFile();
      if (!result) return;
      returnFocus.current = true;
      setChosen([]);
      setPicked(result);
    });
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
      const result = await bridge.listGranolaNotes();
      returnFocus.current = true;
      setChosen([]);
      setPicked(result);
    });
  const disconnectGranola = () =>
    void run(async () => {
      setGranola(await bridge.disconnectGranola());
      onNotice(
        'Granola disconnected. Imported notes stay until you remove them.',
      );
    });
  const importChosen = () =>
    void run(async () => {
      const outcome = await bridge.importContextNotes(chosen);
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
      <div className="context-heading">
        <div>
          <strong>Prior context</strong>
          <span className="muted small">
            Notes you chose from a file or from Granola · not from this
            conversation · kept in memory, never exported
          </span>
        </div>
        <div className="context-actions">
          {items.length > 0 && (
            <button
              className="text-button"
              disabled={busy || working}
              onClick={() =>
                void run(async () => {
                  // This button unmounts with the list; focus moves to Add.
                  returnFocus.current = true;
                  const removed = await bridge.removeAllContext();
                  onNotice(
                    removed === 1
                      ? '1 imported note removed.'
                      : `${removed} imported notes removed.`,
                  );
                })
              }
            >
              Remove all
            </button>
          )}
          <button
            ref={addButton}
            className="secondary-button"
            disabled={busy || working}
            onClick={pick}
          >
            <FileText size={15} />
            Add notes from a file
          </button>
          {bridge.desktop &&
            (granola.connected ? (
              <>
                <button
                  className="secondary-button"
                  disabled={busy || working}
                  onClick={chooseGranola}
                >
                  <Link2 size={15} />
                  Choose Granola notes
                </button>
                <button
                  className="text-button"
                  disabled={busy || working}
                  onClick={disconnectGranola}
                >
                  Disconnect Granola
                </button>
              </>
            ) : signingIn ? (
              <button className="text-button" onClick={cancelSignIn}>
                Cancel sign-in
              </button>
            ) : (
              <button
                className="secondary-button"
                disabled={busy || working}
                onClick={connectGranola}
              >
                <Link2 size={15} />
                Connect Granola
              </button>
            ))}
        </div>
      </div>
      {granola.connected && (
        <p className="muted small connection-terms" role="status">
          Granola connected as you.{' '}
          {granola.tools.includes('get_meetings')
            ? 'TalkQTE may list and read the notes you choose from the last 30 days'
            : 'This account offers no note access to TalkQTE'}
          {granola.tools.includes('query_granola_meetings')
            ? ', and may ask its assistant one question when you press Suggest from Granola'
            : ''}
          ; it reads no transcripts and writes nothing back. Disconnect forgets
          the sign-in; imported notes stay until you remove them.
        </p>
      )}
      {signingIn && (
        <p className="muted small" role="status">
          Sign in to Granola in your browser, then return here. Nothing is read
          until you choose notes.
        </p>
      )}
      {items.length > 0 ? (
        <ul className="context-list">
          {items.map((item) => (
            <li key={`${item.provider}:${item.sourceId}`}>
              <div>
                <strong>{item.title}</strong>
                <span className="muted small">
                  {item.sourceDate} ·{' '}
                  {item.provider === 'granola' ? 'From Granola' : 'From a file'}
                </span>
                <p>{item.excerpt}</p>
              </div>
              <button
                className="icon-button"
                aria-label={`Remove ${item.title} (${item.sourceDate})`}
                title="Remove"
                disabled={busy || working}
                onClick={() =>
                  void run(() =>
                    bridge.command('remove_context_item', {
                      provider: item.provider,
                      sourceId: item.sourceId,
                    }),
                  )
                }
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">
          No prior notes selected. Connect Granola to choose from your notes of
          the last 30 days, or add a file. A TalkQTE notes file is a JSON file
          with a list of notes, each with an id, a date, and text.
        </p>
      )}
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
      >
        <div className="dialog-heading">
          <h2 id="context-pick-title">
            Choose notes{picked ? ` from ${picked.fileName}` : ''}
          </h2>
          <button
            className="icon-button"
            aria-label="Close without importing"
            disabled={working}
            onClick={cancel}
          >
            <X size={20} />
          </button>
        </div>
        <p>
          Only the notes you tick are kept, for this session. They appear beside
          your notebook as prior context and never feed a question on their own.
        </p>
        {picked && picked.skipped > 0 && (
          <p className="muted small">
            {picked.skipped} more{' '}
            {picked.skipped === 1 ? 'note is' : 'notes are'} not listed: the
            file has repeated ids or more than 200 notes.
          </p>
        )}
        {picked && picked.notes.length > 1 && (
          <p className="context-choose-all small">
            <button
              type="button"
              className="text-button"
              disabled={working}
              onClick={() =>
                setChosen(
                  allChosen ? [] : picked.notes.map((note) => note.sourceId),
                )
              }
            >
              {allChosen ? 'Clear all' : 'Select all'}
            </button>
          </p>
        )}
        <ul className="context-choices">
          {picked?.notes.map((note, index) => (
            <li key={note.sourceId}>
              <label>
                <input
                  type="checkbox"
                  aria-describedby={`context-preview-${index}`}
                  checked={chosen.includes(note.sourceId)}
                  onChange={(e) =>
                    setChosen((current) =>
                      e.target.checked
                        ? [...current, note.sourceId]
                        : current.filter((id) => id !== note.sourceId),
                    )
                  }
                />
                <span>
                  <strong>{note.title}</strong>
                  <span className="muted small"> {note.sourceDate}</span>
                </span>
              </label>
              <span className="context-preview" id={`context-preview-${index}`}>
                {note.preview}
              </span>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            disabled={working}
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={working || chosen.length === 0}
            onClick={importChosen}
          >
            Import {chosen.length || ''} selected
          </button>
        </div>
      </dialog>
    </section>
  );
}
