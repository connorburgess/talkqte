import { useEffect, useRef, useState } from 'react';
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
  const chipRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancellingRef = useRef(false);
  const committedRef = useRef(false);

  useEffect(() => {
    if (isEditing) {
      setDraft(label);
      cancellingRef.current = false;
      committedRef.current = false;
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, label]);

  const cancel = () => {
    cancellingRef.current = true;
    onCancelEdit();
    requestAnimationFrame(() => chipRef.current?.focus());
  };

  const commit = async () => {
    if (cancellingRef.current || committedRef.current || saving) return;
    committedRef.current = true;
    const trimmed = draft.trim().replace(/\s+/g, ' ');
    if (trimmed === label) {
      onCancelEdit();
      return;
    }
    setSaving(true);
    try {
      await onRename(speakerId, trimmed);
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
          void commit();
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
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancel();
            }
          }}
        />
        <button
          type="submit"
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
