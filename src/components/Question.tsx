import { useId } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { Cue, CueSnapshot } from '../lib/types';

export function Question({
  cue,
  size,
  live = false,
  announce = true,
  busy,
  onDismiss,
  onInspect,
  onKeep,
}: {
  cue: Cue;
  size: CueSnapshot['questionSize'];
  /** The question comes from local transcription, not the fictional demo. */
  live?: boolean;
  announce?: boolean;
  busy: boolean;
  onDismiss: () => void;
  onInspect: (expanded: boolean) => void;
  /** Keeps a quoted line in the notebook; only a Said cue offers it. */
  onKeep?: () => void;
}) {
  const contextId = useId();
  return (
    <section
      className={`question question-${size}`}
      aria-label="Suggested question"
    >
      <h2 aria-live={announce ? 'polite' : undefined}>
        {cue.kind === 'Said' ? `“${cue.question}”` : cue.question}
      </h2>
      <p className="question-meta">
        {cue.note
          ? `Reminder from your notes · ${cue.note.sourceDate}`
          : `${live ? 'Live question' : 'Demo question'} · ${cue.kind}${
              cue.aboutFocus ? ' · about what matters' : ''
            }`}
      </p>
      <button
        className="question-disclosure"
        aria-expanded={cue.expanded}
        aria-controls={contextId}
        aria-disabled={busy}
        aria-label={cue.expanded ? 'Hide context' : undefined}
        title={cue.expanded ? 'Hide context' : undefined}
        onClick={() => {
          if (!busy) onInspect(!cue.expanded);
        }}
      >
        {cue.expanded ? <ChevronUp size={18} /> : 'Why?'}
        {!cue.expanded && <ChevronDown size={16} />}
      </button>
      <div id={contextId} hidden={!cue.expanded} className="question-context">
        <p>
          {cue.note
            ? `From your imported note, ${cue.note.sourceDate} · not from this conversation`
            : live
              ? 'From the live transcript'
              : 'From the fictional transcript'}
        </p>
        <blockquote className="evidence">“{cue.evidence}”</blockquote>
        {cue.aboutFocus && (
          <p>
            This line uses words from your focus list, so it came through sooner
            and stays longer.
          </p>
        )}
        {cue.resolvedBy && (
          <>
            <p>Answered later</p>
            <blockquote className="evidence">
              “{cue.resolvedBy.evidence}”
            </blockquote>
          </>
        )}
      </div>
      {cue.resolvedBy ? (
        <p className="question-held">
          This was answered in the conversation. Kept here until you dismiss it.
        </p>
      ) : (
        cue.held && (
          <p className="question-held">
            {cue.remainingMs === 0
              ? `Earlier in the ${live ? 'session' : 'demo'}. Kept here until you dismiss it.`
              : 'Kept here until you dismiss it.'}
          </p>
        )
      )}
      {cue.kind === 'Said' && onKeep && (
        <button
          className="text-button keep-line"
          disabled={busy}
          onClick={onKeep}
        >
          Keep this line
        </button>
      )}
      {/* Last in reading order; drawn in the corner. */}
      <button
        className="dismiss-question"
        aria-label="Dismiss"
        title="Dismiss"
        disabled={busy}
        onClick={onDismiss}
      >
        <X size={18} />
      </button>
    </section>
  );
}
