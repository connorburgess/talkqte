import { X } from 'lucide-react';
import type {
  EndPrompt as EndPromptOffer,
  EndPromptAction,
} from '../lib/types';

function summary(transcriptLines: number, hasNotes: boolean) {
  const lines =
    transcriptLines > 0
      ? `${transcriptLines} ${transcriptLines === 1 ? 'line' : 'lines'}`
      : null;
  if (lines && hasNotes) return `${lines} · notes`;
  if (lines)
    return `${transcriptLines} transcript ${transcriptLines === 1 ? 'line' : 'lines'}`;
  return 'Your notes';
}

/** Floating companion card when a non-empty live session stops: either a
 * confirmation that it auto-saved (`saved`), a choice to keep (`ask`), or
 * brief confirmation (`kept`). Never shows transcript text, notes, titles,
 * or application names. */
export function EndPrompt({
  prompt,
  busy,
  large = false,
  onAction,
}: {
  prompt: EndPromptOffer;
  busy: boolean;
  large?: boolean;
  onAction: (action: EndPromptAction) => void;
}) {
  const detail = summary(prompt.transcriptLines, prompt.hasNotes);
  const canWriteNotes = prompt.transcriptLines > 0;

  return (
    <section
      className={`end-prompt${large ? ' is-large' : ''}`}
      aria-labelledby="end-prompt-title"
    >
      <p id="end-prompt-title" className="call-prompt-title" role="status">
        {prompt.state === 'saved'
          ? 'Meeting saved'
          : prompt.state === 'kept'
            ? 'Kept'
            : 'Meeting ended'}
      </p>
      <p className="call-prompt-detail">
        {prompt.state === 'ask'
          ? `${detail} · Keep in your Meetings list?`
          : `${detail} · Saved to your Meetings list.`}
      </p>
      {prompt.error && (
        <p role="alert" className="end-prompt-error">
          {prompt.error}
        </p>
      )}
      <div className="call-prompt-actions">
        {prompt.state === 'ask' ? (
          <>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => onAction('keep')}
            >
              Keep meeting
            </button>
            {canWriteNotes && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => onAction('writeNotes')}
              >
                Write notes
              </button>
            )}
          </>
        ) : prompt.state === 'saved' ? (
          <>
            {canWriteNotes && (
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => onAction('writeNotes')}
              >
                Write notes
              </button>
            )}
            <button
              className={canWriteNotes ? 'secondary-button' : 'primary-button'}
              disabled={busy}
              onClick={() => onAction('open')}
            >
              Open
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => onAction('delete')}
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => onAction('open')}
            >
              Open
            </button>
            {canWriteNotes && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => onAction('writeNotes')}
              >
                Write notes
              </button>
            )}
          </>
        )}
        <button
          className="companion-control"
          aria-label="Dismiss"
          title="Dismiss"
          disabled={busy}
          onClick={() => onAction('dismiss')}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
