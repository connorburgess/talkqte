import { Bookmark, MessageCircle, X } from 'lucide-react';
import type { Cue } from '../lib/types';

export function Question({
  cue,
  paused,
  busy,
  onRespond,
}: {
  cue: Cue;
  paused: boolean;
  busy: boolean;
  onRespond: (response: 'save' | 'dismiss') => void;
}) {
  return (
    <section className="question" aria-label="Suggested question">
      <div className="question-top">
        <span>
          <MessageCircle size={16} /> {cue.kind}
        </span>
        <span className="countdown">
          {paused ? 'Paused' : `${Math.ceil(cue.remainingMs / 1000)}s`}
        </span>
      </div>
      <h2 aria-live="polite">{cue.question}</h2>
      <p className="evidence">“{cue.evidence}”</p>
      <div className="question-actions">
        <button
          className="save-question"
          disabled={paused || busy}
          onClick={() => onRespond('save')}
        >
          <Bookmark size={16} /> Save question
        </button>
        <button
          className="dismiss-question"
          disabled={paused || busy}
          onClick={() => onRespond('dismiss')}
        >
          <X size={16} /> Dismiss
        </button>
      </div>
      <div className="time-track" aria-hidden="true">
        <div style={{ width: `${(100 * cue.remainingMs) / cue.totalMs}%` }} />
      </div>
    </section>
  );
}
