import { useEffect, useId, useRef } from 'react';
import { clockTime, type Cue, type CueSource } from '../lib/types';
import { describeCue, type RealCueInput } from './LiveCueStatus';

function sourceLabel(source: CueSource) {
  return source.provenance.kind === 'priorNote'
    ? `Prior note, not from this conversation · ${source.provenance.title} · ${source.provenance.date}`
    : `This conversation · ${clockTime(source.provenance.atMs)} · ${source.provenance.speaker}`;
}

/** The quoted words, shown once Why? opens the cue. */
const quote = (expanded: boolean, text: string) =>
  expanded ? `: “${text}”` : '';

/** The same warning the notebook card shows for an unconfirmed copy. */
function unverified(note: NonNullable<Cue['note']>) {
  if (!note.unconfirmed) return '';
  const at = note.unconfirmed.lastConfirmedMs;
  return at === null
    ? ' · not verified · never confirmed'
    : ` · not verified · last confirmed ${new Date(at).toLocaleString(
        undefined,
        { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
      )}`;
}

/**
 * The notebook's own handlers for the real cue and cue pause. The layout calls
 * these exactly; it adds no command of its own.
 */
export interface RealCueControls {
  busy: boolean;
  inspect: (expanded: boolean) => void;
  dismiss: () => void;
  toggleCues: () => void;
}

/** The live session's cue beside the layout's example, with its real controls. */
export function RealCue({
  input,
  controls,
}: {
  input: RealCueInput;
  controls: RealCueControls;
}) {
  const { note, cue, origin, status, resolution, pause } = describeCue(input);
  const sourcesId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const whyButton = useRef<HTMLButtonElement>(null);
  const pauseButton = useRef<HTMLButtonElement>(null);
  // Dismiss removes the focused control. Once the notebook's handler has
  // finished and the dismissed cue has gone, focus goes to the control that
  // takes its place (a new cue's Why?, Pause cues, or this heading), but only
  // if it was dropped; never from another control or application. The reply
  // and the snapshot can arrive in either order; a dismissal that leaves the
  // same cue in place (a failed command) is forgotten after a moment.
  const dismissedId = useRef<string | null>(null);
  const cueId = cue?.id ?? null;
  useEffect(() => {
    const id = dismissedId.current;
    if (id === null || controls.busy) return;
    if (cueId === id) {
      const forget = setTimeout(() => {
        if (dismissedId.current === id) dismissedId.current = null;
      }, 1_000);
      return () => clearTimeout(forget);
    }
    dismissedId.current = null;
    if (document.hasFocus() && document.activeElement === document.body)
      (whyButton.current ?? pauseButton.current ?? heading.current)?.focus();
  }, [controls.busy, cueId]);
  return (
    <section aria-labelledby="real-cue-title">
      <h2
        id="real-cue-title"
        className="mock-real-heading"
        ref={heading}
        tabIndex={-1}
      >
        <span className="mock-tag">Real</span> Cue
      </h2>
      {note !== null || !cue ? (
        <p className="mock-empty">{note}</p>
      ) : (
        <div className="mock-real-cue">
          <p className="mock-real-cue-text">
            {cue.kind === 'Said' ? `“${cue.question}”` : cue.question}
          </p>
          <p className="mock-empty">{origin}</p>
          <div className="mock-real-actions">
            <button
              ref={whyButton}
              className="secondary-button mock-real-control"
              aria-expanded={cue.expanded}
              aria-controls={sourcesId}
              disabled={controls.busy}
              onClick={() => controls.inspect(!cue.expanded)}
            >
              {cue.expanded ? 'Hide sources' : 'Why?'}
            </button>
            <button
              className="secondary-button mock-real-control"
              disabled={controls.busy}
              onClick={() => {
                dismissedId.current = cue.id;
                controls.dismiss();
              }}
            >
              Dismiss
            </button>
          </div>
          {/* Where each source is from, and any warning, always show, as on
              the notebook card; Why? adds the quoted words. */}
          <div id={sourcesId}>
            {/* WebKit drops list semantics without list-style unless asked. */}
            <ul
              className="mock-lines"
              role="list"
              aria-label="Real cue sources"
            >
              {cue.sources?.length ? (
                cue.sources.map((source) => (
                  <li key={source.id}>
                    {sourceLabel(source)}
                    {quote(cue.expanded, source.text)}
                  </li>
                ))
              ) : cue.note ? (
                <li>
                  Prior note, not from this conversation · {cue.note.title} ·{' '}
                  {cue.note.sourceDate}
                  {unverified(cue.note)}
                  {quote(cue.expanded, cue.evidence)}
                </li>
              ) : (
                <li>
                  From the live transcript{quote(cue.expanded, cue.evidence)}
                </li>
              )}
            </ul>
            {resolution && <p className="mock-empty">{resolution}</p>}
            {resolution && cue.resolvedBy && (
              <ul
                className="mock-lines"
                role="list"
                aria-label="Real cue resolution"
              >
                {cue.resolvedBy.sources?.length ? (
                  cue.resolvedBy.sources.map((source) => (
                    <li key={source.id}>
                      {sourceLabel(source)}
                      {quote(cue.expanded, source.text)}
                    </li>
                  ))
                ) : (
                  <li>
                    From the live transcript
                    {quote(cue.expanded, cue.resolvedBy.evidence)}
                  </li>
                )}
              </ul>
            )}
          </div>
          {status && <p className="mock-empty">{status}</p>}
        </div>
      )}
      {pause === 'available' && (
        <button
          ref={pauseButton}
          className="secondary-button mock-real-control mock-real-pause"
          disabled={controls.busy}
          title={
            input.cuesPaused
              ? 'Only new speech can raise a cue after resuming.'
              : input.sourceSession
                ? 'Clear the current cue; application audio and transcript continue.'
                : 'Clear the current cue; microphone and transcript continue.'
          }
          onClick={controls.toggleCues}
        >
          {input.cuesPaused ? 'Resume cues' : 'Pause cues'}
        </button>
      )}
      {pause === 'processor' && (
        <p className="mock-empty">
          Pause cues for this session is in the notebook’s Cue processing panel.
        </p>
      )}
    </section>
  );
}
