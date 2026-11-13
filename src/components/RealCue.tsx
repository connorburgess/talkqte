import { clockTime, type Cue, type CueSource } from '../lib/types';
import { describeCue, type RealCueInput } from './LiveCueStatus';

function sourceLabel(source: CueSource) {
  return source.provenance.kind === 'priorNote'
    ? `Prior note, not from this conversation · ${source.provenance.title} · ${source.provenance.date}`
    : `This conversation · ${clockTime(source.provenance.atMs)} · ${source.provenance.speaker}`;
}

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

/** The live session's cue, shown read-only beside the layout's example. */
export function RealCue({ input }: { input: RealCueInput }) {
  const { note, cue, origin, status, resolution } = describeCue(input);
  return (
    <section aria-labelledby="real-cue-title">
      <h2 id="real-cue-title" className="mock-real-heading">
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
          {/* WebKit drops list semantics without list-style unless asked. */}
          <ul className="mock-lines" role="list" aria-label="Real cue sources">
            {cue.sources?.length ? (
              cue.sources.map((source) => (
                <li key={source.id}>
                  {sourceLabel(source)}: “{source.text}”
                </li>
              ))
            ) : cue.note ? (
              <li>
                Prior note, not from this conversation · {cue.note.title} ·{' '}
                {cue.note.sourceDate}
                {unverified(cue.note)}: “{cue.evidence}”
              </li>
            ) : (
              <li>From the live transcript: “{cue.evidence}”</li>
            )}
          </ul>
          {resolution && cue.resolvedBy && (
            <>
              <p className="mock-empty">{resolution}</p>
              <ul
                className="mock-lines"
                role="list"
                aria-label="Real cue resolution"
              >
                {cue.resolvedBy.sources?.length ? (
                  cue.resolvedBy.sources.map((source) => (
                    <li key={source.id}>
                      {sourceLabel(source)}: “{source.text}”
                    </li>
                  ))
                ) : (
                  <li>From the live transcript: “{cue.resolvedBy.evidence}”</li>
                )}
              </ul>
            </>
          )}
          {status && <p className="mock-empty">{status}</p>}
        </div>
      )}
    </section>
  );
}
