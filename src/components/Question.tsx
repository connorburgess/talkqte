import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, X } from 'lucide-react';
import {
  clockTime,
  type Cue,
  type CueSnapshot,
  type CueSource,
} from '../lib/types';
import './cue-card.css';

/** Words after these arrive together, so no cue keeps the eye waiting. */
const CUE_WORDS = 14;
/** An even speaking pace: about 160 words a minute. */
const LETTER_MS = 60;
/** A spoken line starts once the card has opened, and never runs long. */
const SPOKEN_START_MS = 260;
const SPOKEN_MAX_MS = 6_000;

function hasPriorNotes(sources?: CueSource[]) {
  return sources?.some((source) => source.provenance.kind === 'priorNote');
}

const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Which edges of a scrolling card have more beyond them. Text there fades
 * into the edge, so a card of fixed height never shows a line cut in half.
 */
function useEdgeFades(card: RefObject<HTMLElement | null>) {
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = () => {
    const element = card.current;
    if (!element) return;
    const start = element.scrollTop > 1;
    const end =
      element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    setEdges((now) =>
      now.start === start && now.end === end ? now : { start, end },
    );
  };
  // After every render: the cue, its sources or the text size may differ.
  useLayoutEffect(measure);
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    element.addEventListener('scroll', measure, { passive: true });
    // An answer opening in place changes what fits once it has opened.
    element.addEventListener('animationend', measure);
    const resized = new ResizeObserver(measure);
    resized.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      element.removeEventListener('animationend', measure);
      resized.disconnect();
    };
  }, []);
  return edges;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(reducedMotion);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/**
 * What the cue is, as the first words of its sentence. Every kind but
 * Suggestion comes from a fixed phrase rule, so none of these claim more
 * than the rule matched.
 */
function lead(cue: Cue) {
  if (cue.note) return 'From your notes';
  switch (cue.kind) {
    case 'Said':
      return cue.held && cue.remainingMs === 0 ? 'Said earlier' : 'Just said';
    case 'Asked you':
      return 'Asked you';
    case 'Open question':
      return 'Asked the group';
    case 'Still open':
      return 'From your focus';
    case 'Suggestion':
      return 'Suggested';
    default:
      return 'You could ask';
  }
}

/** Where the cue came from and, in a few words, why it is here now. */
function origin(cue: Cue, live: boolean) {
  const conversation = live ? 'this conversation' : 'the demo conversation';
  const from =
    cue.held && cue.remainingMs === 0 && !cue.resolvedBy
      ? `From earlier in ${conversation}`
      : `From ${conversation}`;
  if (cue.kind === 'Still open')
    return `${from} · no line has used these focus words yet`;
  return cue.aboutFocus ? `${from} · uses words from your focus list` : from;
}

/**
 * The line a cue came from. A Said cue is its line, quoted, so nothing is
 * repeated under it. Where another cue is itself words from its line (a
 * question put to you), an ellipsis stands in for them and only the rest of
 * the line is shown.
 */
function sourceLine(cue: Cue) {
  if (cue.kind === 'Said') return '';
  const line = cue.evidence.trim();
  const own = cue.question.trim();
  const at = own ? line.indexOf(own) : -1;
  if (at < 0) return line;
  const before = line.slice(0, at).trimEnd();
  const after = line.slice(at + own.length).trimStart();
  return before || after ? [before, '…', after].filter(Boolean).join(' ') : '';
}

/**
 * Text as separate words, so an arriving cue can darken them one by one.
 * Nothing starts hidden: every word is readable from the first frame.
 *
 * A suggested cue's words darken in reading order, quickly; the delay stops
 * growing after `cap` words.
 *
 * Words that were spoken (a Said quote, a later answer) darken at about the
 * pace they were said. The engine gives a line one time and no word
 * timings, and a live line reaches the card only after it has been
 * transcribed, so this is a replay at an even pace per letter, not the
 * speaker's own timing. The line a cue came from is shown at once.
 */
function Words({
  text,
  cap = 0,
  spoken = false,
}: {
  text: string;
  cap?: number;
  spoken?: boolean;
}) {
  const parts = text.split(/(\s+)/);
  const letters = parts.map((part, index) =>
    index % 2 ? 0 : Math.max(1, part.replace(/[^\p{L}\p{N}]/gu, '').length),
  );
  const total = letters.reduce((sum, count) => sum + count, 0);
  const duration = Math.min(total * LETTER_MS, SPOKEN_MAX_MS);
  let before = 0;
  return parts.map((part, index) => {
    if (index % 2) return part;
    const style = spoken
      ? {
          '--at': `${Math.round(SPOKEN_START_MS + (before / total) * duration)}ms`,
        }
      : { '--i': Math.min(index / 2, cap) };
    before += letters[index];
    return (
      <span
        key={index}
        className={spoken ? 'cue-word cue-spoken' : 'cue-word'}
        style={style as CSSProperties}
      >
        {part}
      </span>
    );
  });
}

/** The warning for a reminder whose copy the last update check left unconfirmed. */
function Unconfirmed({ at }: { at: number | null }) {
  return (
    <>
      Not verified ·{' '}
      {at === null ? (
        'never confirmed'
      ) : (
        <>
          last confirmed{' '}
          <time dateTime={new Date(at).toISOString()}>
            {new Date(at).toLocaleString(undefined, {
              // A session-only time: the year adds nothing.
              day: 'numeric',
              month: 'short',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
        </>
      )}
    </>
  );
}

function Sources({ sources, label }: { sources: CueSource[]; label: string }) {
  return (
    <ul className="cue-sources" aria-label={label} role="list">
      {sources.map((source) => (
        <li key={source.id}>
          <span className="cue-source-label">
            {source.provenance.kind === 'priorNote'
              ? `${source.provenance.title} · ${
                  source.provenance.provider === 'granola'
                    ? 'Granola'
                    : 'Imported file'
                } · ${source.provenance.date} · prior note`
              : `This conversation · ${clockTime(source.provenance.atMs)} · ${source.provenance.speaker}`}
          </span>{' '}
          <blockquote className="cue-quote">“{source.text}”</blockquote>
        </li>
      ))}
    </ul>
  );
}

interface QuestionProps {
  cue: Cue;
  size: CueSnapshot['questionSize'];
  /** The question comes from local transcription, not the fictional demo. */
  live?: boolean;
  announce?: boolean;
  busy: boolean;
  onDismiss: () => void;
  /** Holds the cue until it is dismissed; the source is always in view. */
  onInspect: (expanded: boolean) => void;
}

export function Question({
  cue,
  size,
  live = false,
  announce = true,
  busy,
  onDismiss,
  onInspect,
  leaving = false,
  onLeft,
}: QuestionProps & {
  /** The cue has gone; the card is on its way out and takes no input. */
  leaving?: boolean;
  onLeft?: () => void;
}) {
  const reduced = useReducedMotion();
  const card = useRef<HTMLElement>(null);
  // A cue first seen already held was read earlier: its words do not replay.
  const [settled] = useState(cue.held);
  // An answer that arrives while the cue is showing opens in place; one that
  // was already there when the cue was first shown is simply there.
  const [answered] = useState(!!cue.resolvedBy);
  // The words scroll inside the card; Dismiss and the card's edges do not.
  const scroller = useRef<HTMLDivElement>(null);
  const fades = useEdgeFades(scroller);
  // A leaving card takes no input, so it must not keep keyboard focus: the
  // window that dismissed it decides where focus goes next.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (
      leaving &&
      focused instanceof HTMLElement &&
      card.current?.contains(focused)
    )
      focused.blur();
  }, [leaving]);
  const staysId = useId();
  const said = cue.kind === 'Said';
  // An Asked you question stays without a countdown (ROADMAP U4).
  const timed = cue.kind !== 'Asked you';
  const left = cue.totalMs ? Math.min(1, cue.remainingMs / cue.totalMs) : 0;
  // Reduced motion: the line moves in four steps, not continuously.
  const shown = reduced ? Math.ceil(left * 4) / 4 : left;
  const quote = sourceLine(cue);
  const purpose = lead(cue);
  // A long cue is set smaller, so the whole of it stays on the card.
  const length = purpose.length + cue.question.length;
  const scale = length > 140 ? ' cue-longer' : length > 90 ? ' cue-long' : '';
  return (
    <section
      ref={card}
      className={`question question-${size} cue-card${
        cue.kind === 'Asked you' ? ' cue-asked' : ''
      }${scale}${cue.held ? ' is-held' : ''}${settled ? ' is-settled' : ''}${
        fades.start ? ' fades-start' : ''
      }${fades.end ? ' fades-end' : ''}${leaving ? ' is-leaving' : ''}`}
      aria-label={leaving ? undefined : 'Suggested question'}
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) onLeft?.();
      }}
    >
      <div className="cue-scroll" ref={scroller}>
        <div className="cue-line">
          <span className="cue-lead">{purpose}</span>{' '}
          <h2 aria-live={announce ? 'polite' : undefined}>
            {said && '“'}
            <Words text={cue.question} cap={CUE_WORDS} spoken={said} />
            {said && '”'}
          </h2>
        </div>
        <button
          className="cue-time"
          aria-label={cue.held ? 'Held' : 'Hold'}
          title={
            cue.held ? 'Held until you dismiss it' : 'Hold until you dismiss it'
          }
          aria-disabled={cue.held || busy}
          aria-describedby={timed || cue.held ? undefined : staysId}
          onClick={() => {
            if (!cue.held && !busy) onInspect(false);
          }}
        >
          {timed || cue.held ? (
            <span
              className="cue-track"
              style={{ '--left': cue.held ? 1 : shown } as CSSProperties}
            >
              <span className="cue-fill" />
            </span>
          ) : (
            <span className="cue-stays" id={staysId}>
              Stays longer · no countdown
            </span>
          )}
          <span className="cue-hold">{cue.held ? 'Held' : 'Hold'}</span>
        </button>
        {cue.resolvedBy && (
          <div className={`cue-answer${answered ? '' : ' is-arriving'}`}>
            <div className="cue-source">
              <span className="cue-source-label">
                <Check className="cue-tick" size={14} aria-hidden="true" />
                {hasPriorNotes(cue.resolvedBy.sources)
                  ? 'Marked resolved from these sources'
                  : 'Answered later in the conversation'}
              </span>{' '}
              {cue.resolvedBy.sources?.length ? (
                <Sources
                  sources={cue.resolvedBy.sources}
                  label="Resolution sources"
                />
              ) : (
                <blockquote className="cue-quote">
                  “<Words text={cue.resolvedBy.evidence} spoken />”
                </blockquote>
              )}
            </div>
          </div>
        )}
        <div className="cue-source">
          {cue.sources?.length ? (
            <>
              {hasPriorNotes(cue.sources) && (
                <p>Prior notes are not from this conversation.</p>
              )}
              <Sources sources={cue.sources} label="Cue sources" />
              {cue.aboutFocus && (
                <p>
                  This suggestion cites speech with words from your focus list.
                </p>
              )}
            </>
          ) : cue.note ? (
            <>
              <span className="cue-source-label">
                Its title came up · imported note, {cue.note.sourceDate}
              </span>{' '}
              {/* Present for every note reminder, so a warning that appears
                or changes in place is announced; empty when there is none.
                Above the excerpt, so a long one cannot push it out of view. */}
              <span
                className="question-warning"
                aria-live={announce ? 'polite' : undefined}
              >
                {cue.note.unconfirmed && (
                  <Unconfirmed at={cue.note.unconfirmed.lastConfirmedMs} />
                )}
              </span>
              <blockquote className="cue-quote">“{cue.evidence}”</blockquote>
            </>
          ) : (
            <>
              <span className="cue-source-label">{origin(cue, live)}</span>
              {quote && (
                <>
                  {' '}
                  <blockquote className="cue-quote">“{quote}”</blockquote>
                </>
              )}
            </>
          )}
        </div>
      </div>
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

/**
 * The current cue, or the one that has just gone while it leaves. A cue
 * that is replaced, and any cue under reduced motion, goes at once.
 */
export function CueCard({
  cue,
  empty = null,
  ...props
}: Omit<QuestionProps, 'cue'> & {
  cue: Cue | null;
  /** Shown when there is no cue and none is leaving. */
  empty?: ReactNode;
}) {
  const [seen, setSeen] = useState<{ cue: Cue | null; leaving: Cue | null }>({
    cue,
    leaving: null,
  });
  if (seen.cue !== cue)
    setSeen({
      cue,
      leaving: cue || !seen.cue || reducedMotion() ? null : seen.cue,
    });
  const left = () =>
    setSeen((current) =>
      current.leaving ? { ...current, leaving: null } : current,
    );
  // The animation's end removes the card; this covers a page that never
  // runs it, such as a hidden window.
  const leaving = !cue && !!seen.leaving;
  useEffect(() => {
    if (!leaving) return;
    const fallback = setTimeout(left, 600);
    return () => clearTimeout(fallback);
  }, [leaving]);
  const shown = cue ?? seen.leaving;
  if (!shown) return empty;
  return (
    <Question
      key={shown.id}
      {...props}
      cue={shown}
      leaving={!cue}
      onLeft={left}
    />
  );
}
