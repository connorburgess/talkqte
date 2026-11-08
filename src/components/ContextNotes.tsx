import { useEffect, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import * as bridge from '../lib/bridge';
import type { ContextItem, PickedNotes } from '../lib/types';

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
  const [chosen, setChosen] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
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
            Notes you chose from a file · not from this conversation · kept in
            memory, never exported
          </span>
        </div>
        <button
          ref={addButton}
          className="secondary-button"
          disabled={busy || working}
          onClick={pick}
        >
          <FileText size={15} />
          Add notes from a file
        </button>
      </div>
      {items.length > 0 ? (
        <ul className="context-list">
          {items.map((item) => (
            <li key={`${item.provider}:${item.sourceId}`}>
              <div>
                <strong>{item.title}</strong>
                <span className="muted small">
                  {item.sourceDate} · From a file
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
          No prior notes selected. A TalkQTE notes file is a JSON file with a
          list of notes, each with an id, a date, and text.
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
