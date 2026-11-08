import { useId } from 'react';
import { Bookmark, ChevronDown, ChevronUp, X } from 'lucide-react';
import type { Cue, CueSnapshot } from '../lib/types';

export function Question({
  cue,
  size,
  announce = true,
  busy,
  onRespond,
  onInspect,
}: {
  cue: Cue;
  size: CueSnapshot['questionSize'];
  announce?: boolean;
  busy: boolean;
  onRespond: (response: 'save' | 'dismiss') => void;
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
            ? 'Earlier in the demo. Kept here until you save or dismiss.'
            : 'Kept here until you save or dismiss.'}
        </p>
      )}
      <div className="question-actions">
        <button
          className="save-question"
          disabled={busy}
          onClick={() => onRespond('save')}
        >
          <Bookmark size={16} /> Save question
        </button>
        <button
          className="dismiss-question"
          disabled={busy}
          onClick={() => onRespond('dismiss')}
        >
          <X size={16} /> Dismiss
        </button>
      </div>
    </section>
  );
}
