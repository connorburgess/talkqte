import { useEffect, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import { processingApi, type ProcessingSnapshot } from '../lib/processing';

/**
 * What the notebook already holds about the running session and its Stop.
 * The layout calls the notebook's own Stop, so a press sends exactly what
 * the notebook's button sends.
 */
export interface RealStopInput {
  preparing: boolean;
  cancelling: boolean;
  /** A live session is running: microphone, or one application alone. */
  live: boolean;
  finishing: boolean;
  /** The capture control's own state: busy, and whether it is known. */
  busy: boolean;
  snapshot: ProcessingSnapshot | null;
  /** The notebook's Stop live session and Cancel start handler. */
  stop: () => void;
  /** The capture control's own failure message for its last Stop. */
  failed: boolean;
  /** Reads the capture state again, as the processing panel does after a
   * source Stop whose reply may fail after it applied. */
  refresh: () => Promise<unknown>;
}

/** The source's own Stop, offered exactly as the processing panel offers it. */
function sourceOperation(snapshot: ProcessingSnapshot | null) {
  const source = snapshot?.source;
  return source && (source.phase === 'starting' || source.phase === 'listening')
    ? source.operation
    : null;
}

type StopKey = 'cancel' | 'session' | 'source';

function shownStops({ preparing, live, finishing, snapshot }: RealStopInput) {
  const keys: StopKey[] = [];
  if (preparing) keys.push('cancel');
  else if (live || finishing) keys.push('session');
  if (sourceOperation(snapshot)) keys.push('source');
  return keys;
}

const labels: Record<StopKey, string> = {
  cancel: 'Cancel start',
  session: 'Stop live session',
  source: 'Stop application audio',
};

/** The real Stop controls the layout shows now, by their names. */
export function realStopNames(input: RealStopInput) {
  return shownStops(input).map((key) => labels[key]);
}

/** Whether a shown Stop ends or cancels the session itself, not only a
 * selected application's source. */
export function stopsSession(input: RealStopInput) {
  return shownStops(input).some((key) => key !== 'source');
}

/**
 * The running session's real Stop, beside the layout's real rows. It shows
 * in every active real state the notebook shows its own: Cancel start while
 * preparing, Stop live session while running or stopping, and Stop
 * application audio while a selected application's source is starting or
 * capturing. Focus follows the notebook's rule: when the pressed control
 * goes and focus was dropped, it moves to the next Stop or to the Capture
 * row, never from another control or application.
 */
export function RealStop({
  input,
  fallback,
}: {
  input: RealStopInput;
  /** Where focus goes when no Stop remains: the real Capture row. */
  fallback: () => HTMLElement | null;
}) {
  const shown = shownStops(input);
  const operation = sourceOperation(input.snapshot);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const buttons = useRef<Partial<Record<StopKey, HTMLButtonElement | null>>>(
    {},
  );
  const pressed = useRef<StopKey | null>(null);
  const shownKey = shown.join(' ');
  // A Stop that failed leaves its button in place; forget the press, so a
  // later end of the session by other means does not move focus.
  useEffect(() => {
    if (input.failed && pressed.current !== 'source') pressed.current = null;
  }, [input.failed]);
  // A new or finished source clears an earlier source alert.
  useEffect(() => {
    setSourceError('');
  }, [operation]);
  useEffect(() => {
    const key = pressed.current;
    if (!key || shown.includes(key)) return;
    pressed.current = null;
    if (document.hasFocus() && document.activeElement === document.body)
      (
        shown.map((next) => buttons.current[next]).find(Boolean) ?? fallback()
      )?.focus();
    // The shown set alone decides; its key string tracks it.
  }, [shownKey]);
  if (!shown.length) return null;
  const press = (key: StopKey, action: () => void) => () => {
    pressed.current = key;
    action();
  };
  const stopSource = () => {
    if (!operation) return;
    setSourceBusy(true);
    setSourceError('');
    processingApi
      .stopSource(operation)
      .catch(() => {
        pressed.current = null;
        setSourceError(
          'Stop application audio was not confirmed. Check the status and try again.',
        );
      })
      // As the processing panel does: a reply can fail after the stop
      // applied, so read the state again either way.
      .finally(() => {
        setSourceBusy(false);
        input.refresh().catch(() => {});
      });
  };
  return (
    <div className="mock-real-stop" role="group" aria-label="Real session Stop">
      {shown.includes('cancel') && (
        <button
          ref={(node) => {
            buttons.current.cancel = node;
          }}
          className="secondary-button mock-real-control"
          disabled={
            input.busy ||
            input.cancelling ||
            input.snapshot?.startup !== 'loading'
          }
          onClick={press('cancel', input.stop)}
        >
          {input.cancelling ? 'Cancelling…' : 'Cancel start'}
        </button>
      )}
      {shown.includes('session') && (
        <button
          ref={(node) => {
            buttons.current.session = node;
          }}
          className="secondary-button mock-real-control"
          disabled={input.busy || !input.snapshot}
          onClick={press('session', input.stop)}
        >
          <Square size={14} />
          Stop live session
        </button>
      )}
      {shown.includes('source') && (
        <button
          ref={(node) => {
            buttons.current.source = node;
          }}
          className="secondary-button mock-real-control"
          disabled={sourceBusy}
          onClick={press('source', stopSource)}
        >
          <Square size={14} />
          {sourceBusy ? 'Stopping…' : 'Stop application audio'}
        </button>
      )}
      {sourceError && (
        <p className="mock-empty" role="alert">
          {sourceError}
        </p>
      )}
    </div>
  );
}
