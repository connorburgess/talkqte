import { desktop } from '../lib/bridge';
import type { ContextItem } from '../lib/types';

/** The browser preview imports its own built-in notes, not a chosen file. */
const provider = (item: ContextItem, onDesktop: boolean) =>
  item.provider === 'granola'
    ? 'Granola'
    : onDesktop
      ? 'Imported file'
      : 'Built-in fictional note';

/**
 * The prior notes selected in the notebook, shown read-only; adding or
 * removing them happens in the notebook. Cues quote only from these, though
 * a copy an update check reported as withdrawn stays listed and is not
 * quoted.
 * The selected list carries no verification state, so no "not verified"
 * warning can be shown here; a cue that quotes an unconfirmed copy carries
 * its own warning in the Real Cue section.
 */
export function RealContext({
  items,
  onDesktop = desktop,
}: {
  items: ContextItem[];
  onDesktop?: boolean;
}) {
  return (
    <section aria-labelledby="real-context-title">
      <h2 id="real-context-title" className="mock-real-heading">
        <span className="mock-tag">Real</span> Prior context
      </h2>
      {items.length ? (
        <>
          <p className="mock-empty">
            {items.length === 1
              ? '1 note selected in the notebook.'
              : `${items.length} notes selected in the notebook.`}{' '}
            Add or remove notes in the notebook’s Prior context panel.
            {!onDesktop &&
              ' In this browser preview these are its built-in fictional notes, not a file you chose.'}
          </p>
          <ul className="mock-lines" role="list" aria-label="Real prior notes">
            {items.map((item) => (
              <li key={`${item.provider}:${item.sourceId}`}>
                <span className="mock-speaker">{item.title}</span> ·{' '}
                {provider(item, onDesktop)} · {item.sourceDate} · not from this
                conversation
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mock-empty">
          None. Add notes in the notebook’s Prior context panel.
        </p>
      )}
    </section>
  );
}
