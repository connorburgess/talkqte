import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import {
  processingApi,
  sourceProblem,
  type ApplicationAudioAction,
  type ApplicationAudioStatus,
} from '../lib/processing';

const commandErrors: Record<string, string> = {
  busy: 'Application audio is still listing, starting or stopping. Wait, then try again.',
  changed: 'The selection changed. List applications again.',
  unknown_source:
    'That application is no longer listed. List applications again.',
  not_acknowledged: 'Read the notice above, then list applications again.',
};

/** Development builds with `native-audio-spike` only: choose one running
 * application and start a live session fed by its audio alone, with no
 * microphone. The notebook mounts this only when the processing snapshot
 * reports an application source, which no other build does. */
export function ApplicationAudioStart() {
  const [status, setStatus] = useState<ApplicationAudioStatus | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(0);

  function receive(next: ApplicationAudioStatus) {
    if (next.revision < latest.current) return;
    latest.current = next.revision;
    setStatus(next);
  }

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    void processingApi
      .listenApplicationAudio((next) => alive && receive(next))
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      })
      .catch(() => {});
    void processingApi
      .applicationAudio({ kind: 'snapshot' })
      .then((next) => alive && next && receive(next))
      .catch(
        () => alive && setError('Application audio status is unavailable.'),
      );
    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  async function act(...actions: ApplicationAudioAction[]) {
    setBusy(true);
    setError('');
    try {
      let next: ApplicationAudioStatus | null = null;
      for (const action of actions) {
        // A start goes to the review just made, never an older one.
        const step =
          action.kind === 'startSession' && next?.operation
            ? { ...action, review: next.operation }
            : action;
        next = await processingApi.applicationAudio(step);
        if (next) receive(next);
      }
    } catch (failure) {
      setError(
        commandErrors[String(failure)] ??
          'The change was not confirmed. Check the status and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!status)
    return error ? <p className="processing-muted">{error}</p> : null;
  // Once starting, the source's status line and its own Stop take over.
  if (!['off', 'listing', 'reviewing'].includes(status.phase)) return null;
  const choice = status.choices.find((item) => item.id === chosen);
  const problem = sourceProblem(status.problem);

  return (
    <div className="processing-review processing-source-start">
      <h3>Application audio · development build</h3>
      <p className="processing-muted">
        Start a live session from one application's audio, without the
        microphone. {status.scopeNotice} Listing applications can show the macOS
        Screen &amp; System Audio Recording prompt.
      </p>
      {status.bySetting && (
        <p className="processing-muted">
          The TALKQTE_DEV_APPLICATION_SOURCE launch setting acknowledged this
          notice and asked for one start; it does not retry.
        </p>
      )}
      {status.phase === 'listing' ? (
        <div className="processing-actions">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void act({ kind: 'cancelList' })}
          >
            Cancel listing
          </button>
        </div>
      ) : status.choices.length === 0 ? (
        <div className="processing-actions">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void act({ kind: 'list', acknowledged: true })}
          >
            List applications
          </button>
        </div>
      ) : (
        <>
          <fieldset>
            <legend>Application</legend>
            {status.choices.map((item) => (
              <label key={item.id} className="processing-option">
                <input
                  type="radio"
                  name="application-audio-source"
                  value={item.id}
                  checked={chosen === item.id}
                  onChange={() => setChosen(item.id)}
                />
                <span>{item.name}</span>
              </label>
            ))}
          </fieldset>
          <div className="processing-actions">
            <button
              className="primary-button"
              disabled={busy || !choice}
              onClick={() =>
                choice &&
                void act(
                  { kind: 'review', source: choice.id },
                  { kind: 'startSession', review: '' },
                )
              }
            >
              <Play size={17} />
              {busy
                ? 'Starting…'
                : choice
                  ? `Start session from ${choice.name}`
                  : 'Start session'}
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setChosen('');
                void act({ kind: 'list', acknowledged: true });
              }}
            >
              List again
            </button>
          </div>
        </>
      )}
      {(problem || error) && (
        <p className="processing-message" role="alert">
          {error || problem}
        </p>
      )}
    </div>
  );
}
