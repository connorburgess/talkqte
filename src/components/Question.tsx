import { useId } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import {
  clockTime,
  type Cue,
  type CueSnapshot,
  type CueSource,
} from '../lib/types';

function hasPriorNotes(sources?: CueSource[]) {
  return sources?.some((source) => source.provenance.kind === 'priorNote');
}

function Sources({ sources, label }: { sources: CueSource[]; label: string }) {
  return (
    <ul className="evidence-sources" aria-label={label} role="list">
      {sources.map((source) => (
        <li key={source.id}>
          {source.provenance.kind === 'priorNote' ? (
            <>
              <p className="source-title">{source.provenance.title}</p>
              <p className="source-label">
                {source.provenance.provider === 'granola'
                  ? 'Granola'
                  : 'Imported file'}
                {' · '}
                {source.provenance.date} · prior note
              </p>
            </>
          ) : (
            <p className="source-label">
              This conversation · {clockTime(source.provenance.atMs)} ·{' '}
              {source.provenance.speaker}
            </p>
          )}
          <blockquote className="evidence">“{source.text}”</blockquote>
        </li>
      ))}
    </ul>
  );
}

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
          : hasPriorNotes(cue.sources)
            ? 'Suggestion with prior context'
            : `${live ? 'Live question' : 'Demo question'} · ${cue.kind}${
                cue.aboutFocus ? ' · about what matters' : ''
              }`}
      </p>
      {cue.note?.unconfirmed && (
        <p
          className="question-meta"
          aria-live={announce ? 'polite' : undefined}
        >
          This copy could not be verified at the last check.{' '}
          {cue.note.unconfirmed.lastConfirmedMs === null ? (
            'No check on record has confirmed it.'
          ) : (
            <>
              Last confirmed{' '}
              <time
                dateTime={new Date(
                  cue.note.unconfirmed.lastConfirmedMs,
                ).toISOString()}
              >
                {new Date(cue.note.unconfirmed.lastConfirmedMs).toLocaleString(
                  undefined,
                  { dateStyle: 'medium', timeStyle: 'short' },
                )}
              </time>
              .
            </>
          )}
        </p>
      )}
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
        {cue.sources?.length ? (
          <>
            {hasPriorNotes(cue.sources) && (
              <p>Prior notes are not from this conversation.</p>
            )}
            <Sources sources={cue.sources} label="Cue sources" />
          </>
        ) : (
          <>
            <p>
              {cue.note
                ? `From your imported note, ${cue.note.sourceDate} · not from this conversation`
                : live
                  ? 'From the live transcript'
                  : 'From the fictional transcript'}
            </p>
            <blockquote className="evidence">“{cue.evidence}”</blockquote>
          </>
        )}
        {cue.aboutFocus && (
          <p>
            {cue.sources?.length
              ? 'This suggestion cites speech with words from your focus list.'
              : 'This line uses words from your focus list, so it came through sooner and stays longer.'}
          </p>
        )}
        {cue.resolvedBy && (
          <>
            <p className="resolution-label">
              {hasPriorNotes(cue.resolvedBy.sources)
                ? 'Resolution sources'
                : 'Answered later'}
            </p>
            {cue.resolvedBy.sources?.length ? (
              <Sources
                sources={cue.resolvedBy.sources}
                label="Resolution sources"
              />
            ) : (
              <blockquote className="evidence">
                “{cue.resolvedBy.evidence}”
              </blockquote>
            )}
          </>
        )}
      </div>
      {cue.resolvedBy ? (
        <p className="question-held">
          {hasPriorNotes(cue.resolvedBy.sources)
            ? 'Marked resolved from these sources. Kept here until you dismiss it.'
            : 'This was answered in the conversation. Kept here until you dismiss it.'}
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
