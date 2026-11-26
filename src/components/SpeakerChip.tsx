import { useEffect, useId, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';

/** Clickable remote speaker chip (`Speaker 1`, or a custom name) that opens a
 * lightweight inline rename input and updates all lines for that speaker. */
export function SpeakerChip({
  speakerId,
  label,
  disabled,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onRename,
}: {
  speakerId: number;
  label: string;
  disabled?: boolean;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onRename: (speakerId: number, name: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const errorId = useId();
  const chipRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancellingRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const committedRef = useRef(false);

  useEffect(() => {
    if (isEditing) {
      setDraft(label);
      setError('');
      cancellingRef.current = false;
      committedRef.current = false;
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      chipRef.current?.focus();
    }
  }, [isEditing, label]);

  const cancel = () => {
    cancellingRef.current = true;
    restoreFocusRef.current = true;
    onCancelEdit();
  };

  const commit = async (restoreFocus = false) => {
    if (cancellingRef.current || committedRef.current || saving) return;
    committedRef.current = true;
    const trimmed = draft.trim().replace(/\s+/g, ' ');
    if (trimmed === label) {
      restoreFocusRef.current = restoreFocus;
      onCancelEdit();
      return;
    }
    setError('');
    setSaving(true);
    try {
      restoreFocusRef.current = restoreFocus;
      await onRename(speakerId, trimmed);
    } catch (problem) {
      restoreFocusRef.current = false;
      committedRef.current = false;
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setSaving(false);
    }
  };

  if (isEditing) {
    return (
      <form
        className="transcript-speaker-rename"
        onSubmit={(event) => {
          event.preventDefault();
          void commit(true);
        }}
        onBlur={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            void commit();
          }
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={80}
          disabled={disabled || saving}
          aria-label={`Speaker ${speakerId + 1} name`}
          placeholder={`Speaker ${speakerId + 1}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.nativeEvent.isComposing || event.keyCode === 229)
            ) {
              event.preventDefault();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            }
          }}
        />
        <button
          type="submit"
          onMouseDown={(event) => event.preventDefault()}
          className="secondary-button"
          disabled={disabled || saving}
        >
          Save
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || saving}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={cancel}
        >
          Cancel
        </button>
        {error && (
          <span id={errorId} className="transcript-speaker-error" role="alert">
            {error}
          </span>
        )}
      </form>
    );
  }

  return (
    <button
      ref={chipRef}
      type="button"
      className="transcript-speaker-chip"
      disabled={disabled}
      aria-label={`Rename ${label}`}
      title="Rename speaker"
      onClick={onStartEdit}
    >
      <strong>{label}</strong>
      <Pencil size={11} aria-hidden="true" />
    </button>
  );
}
