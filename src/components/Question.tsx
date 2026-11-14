import { useId } from 'react';
import { ChevronRight, X } from 'lucide-react';
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

/** An untouched cue softens over its last seconds; nothing counts down. */
const LEAVING_MS = 4_000;
function leaving(cue: Cue) {
  return (
    !cue.held &&
    !cue.expanded &&
    !cue.resolvedBy &&
    cue.remainingMs > 0 &&
    cue.remainingMs <= LEAVING_MS
  );
}

/**
 * Present for every note reminder, so a warning that appears or changes in
 * place is announced; empty when there is none. Kept on the source line to
 * leave the companion its room.
 */
function NoteWarning({ cue, announce }: { cue: Cue; announce: boolean }) {
  const unconfirmed = cue.note?.unconfirmed;
  return (
    <span
      className="question-warning"
      aria-live={announce ? 'polite' : undefined}
    >
      {unconfirmed && (
        <>
          {' · '}not verified ·{' '}
          {unconfirmed.lastConfirmedMs === null ? (
            'never confirmed'
          ) : (
            <>
              last confirmed{' '}
              <time
                dateTime={new Date(unconfirmed.lastConfirmedMs).toISOString()}
              >
                {new Date(unconfirmed.lastConfirmedMs).toLocaleString(
                  undefined,
                  {
                    // A session-only time: the year adds nothing.
                    day: 'numeric',
                    month: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  },
                )}
              </time>
            </>
          )}
        </>
      )}
    </span>
  );
}

/** One quiet line naming where the cue comes from; it opens the excerpts. */
function sourceLine(cue: Cue, live: boolean) {
  const notes = cue.sources?.filter(
    (source) => source.provenance.kind === 'priorNote',
  );
  let line: string;
  if (notes?.length) {
    const first = notes[0].provenance;
    line =
      first.kind === 'priorNote'
        ? `From ${first.title} · ${first.date}${
            notes.length > 1 ? ` and ${notes.length - 1} more` : ''
          }`
        : '';
  } else if (cue.note) {
    line = `From your notes · ${cue.note.sourceDate}`;
  } else {
    line = live ? 'From the live transcript' : 'From this conversation';
  }
  return cue.aboutFocus ? `${line} · matches your focus` : line;
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
      className={`question question-${size}${leaving(cue) ? ' is-leaving' : ''}`}
      aria-label="Suggested question"
    >
      <h2 aria-live={announce ? 'polite' : undefined}>
        {cue.kind === 'Said' ? `“${cue.question}”` : cue.question}
      </h2>
      <button
        className="question-source"
        aria-expanded={cue.expanded}
        aria-controls={contextId}
        aria-disabled={busy}
        onClick={() => {
          if (!busy) onInspect(!cue.expanded);
        }}
      >
        <span>
          {sourceLine(cue, live)}
          {cue.note && <NoteWarning cue={cue} announce={announce} />}
        </span>
        <ChevronRight size={16} aria-hidden="true" />
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
            {cue.note && (
              <p>
                {cue.note.unconfirmed
                  ? // The source line above already names the note and date;
                    // this keeps a warned reminder inside the companion.
                    'Not from this conversation.'
                  : `From your imported note, ${cue.note.sourceDate} · not from this conversation`}
              </p>
            )}
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
