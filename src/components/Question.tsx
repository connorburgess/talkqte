import { useId } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { Cue, CueSnapshot } from '../lib/types';

export function Question({
  cue,
  size,
  announce = true,
  busy,
  onDismiss,
  onInspect,
}: {
  cue: Cue;
  size: CueSnapshot['questionSize'];
  announce?: boolean;
  busy: boolean;
  onDismiss: () => void;
  onInspect: (expanded: boolean) => void;
}) {
  const contextId = useId();
  return (
    <section
      className={`question question-${size}`}
      aria-label="Suggested question"
    >
      <h2 aria-live={announce ? 'polite' : undefined}>{cue.question}</h2>
      <p className="question-meta">Demo question · {cue.kind}</p>
      <button
        className="question-disclosure"
        aria-expanded={cue.expanded}
        aria-controls={contextId}
        aria-disabled={busy}
        onClick={() => {
          if (!busy) onInspect(!cue.expanded);
        }}
      >
        {cue.expanded ? 'Hide context' : 'Why?'}
        {cue.expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      <div id={contextId} hidden={!cue.expanded} className="question-context">
        <p>From the fictional transcript</p>
        <blockquote className="evidence">“{cue.evidence}”</blockquote>
      </div>
      {cue.held && (
        <p className="question-held">
          {cue.remainingMs === 0
            ? 'Earlier in the demo. Kept here until you dismiss it.'
            : 'Kept here until you dismiss it.'}
        </p>
      )}
      <div className="question-actions">
        <button
          className="dismiss-question"
          disabled={busy}
          onClick={onDismiss}
        >
          <X size={16} /> Dismiss
        </button>
      </div>
    </section>
  );
}
