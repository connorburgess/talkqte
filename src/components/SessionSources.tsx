import { useEffect, useRef, useState } from 'react';
import './processing.css';
import {
  processingApi,
  sourceProblem,
  type ApplicationAudioAction,
  type ApplicationAudioStatus,
} from '../lib/processing';

/** What the next live session listens to. */
export type SourceMode = 'microphone' | 'both' | 'application';
export interface SourceChoice {
  mode: SourceMode;
  /** The listed application chosen, for `both` and `application`. */
  application: { id: string; name: string } | null;
  /** An application to choose once listed, matched by bundle identifier:
   * the one a call-starting offer named. Nothing is listed for it. */
  wanted?: { name: string; bundleId: string };
}
export const microphoneOnly: SourceChoice = {
  mode: 'microphone',
  application: null,
};

/** A choice that can start now: an application mode needs its application. */
export function ready(choice: SourceChoice): boolean {
  return choice.mode === 'microphone' || choice.application !== null;
}

const commandErrors: Record<string, string> = {
  busy: 'Application audio is still listing, starting or stopping. Wait, then try again.',
  changed: 'The selection changed. List applications again.',
  unknown_source:
    'That application is no longer listed. List applications again.',
  not_acknowledged: 'Read the notice above, then list applications again.',
};

const modes: { mode: SourceMode; label: string; hint: string }[] = [
  {
    mode: 'microphone',
    label: 'Microphone',
    hint: 'Everyone your Mac’s microphone hears, as in a room.',
  },
  {
    mode: 'both',
    label: 'Microphone and one application',
    hint: 'For a call: you through the microphone, the other side from the app you choose.',
  },
  {
    mode: 'application',
    label: 'One application only',
    hint: 'Only the app’s sound, such as a recording. The microphone is not used.',
  },
];

/** Before a live session: listen to the microphone, one application, or
 * both. Listing applications follows the scope notice and may bring up the
 * macOS Screen & System Audio Recording prompt; nothing is captured until
 * the session starts, and nothing is sent until its review is approved. The
 * notebook shows this only in a build that can hear an application. */
export function SessionSources({
  value,
  onChange,
  disabled,
}: {
  value: SourceChoice;
  onChange: (choice: SourceChoice) => void;
  disabled: boolean;
}) {
  const [status, setStatus] = useState<ApplicationAudioStatus | null>(null);
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

  // The application a call-starting offer named is chosen once the person
  // has listed applications and it is there.
  useEffect(() => {
    if (!value.wanted || value.application || !status) return;
    const wanted = value.wanted;
    const match = status.choices.find(
      (item) => item.bundleId === wanted.bundleId,
    );
    if (match) onChange({ ...value, application: match, wanted: undefined });
  }, [status, value, onChange]);

  // A chosen application that is no longer listed is no longer chosen.
  useEffect(() => {
    if (
      value.application &&
      status &&
      status.phase !== 'reviewing' &&
      !status.choices.some((item) => item.id === value.application?.id)
    )
      onChange({ ...value, application: null });
  }, [status, value, onChange]);

  async function act(action: ApplicationAudioAction) {
    setBusy(true);
    setError('');
    try {
      const next = await processingApi.applicationAudio(action);
      if (next) receive(next);
    } catch (failure) {
      setError(
        commandErrors[String(failure)] ??
          'The change was not confirmed. Check the status and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const needsApplication = value.mode !== 'microphone';
  const problem = sourceProblem(status?.problem);
  const listing = status?.phase === 'listing';
  const choices = status?.choices ?? [];
  const off = disabled || busy;

  return (
    <section className="session-sources" aria-labelledby="sources-title">
      <fieldset disabled={disabled}>
        <legend id="sources-title">Listen to</legend>
        {modes.map((item) => (
          <label key={item.mode} className="processing-option">
            <input
              type="radio"
              name="session-sources"
              value={item.mode}
              checked={value.mode === item.mode}
              onChange={() => onChange({ ...value, mode: item.mode })}
            />
            <span>
              <strong className="session-sources-label">{item.label}</strong>
              <span className="session-sources-hint">{item.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {needsApplication && (
        <div className="session-sources-application">
          {value.wanted && !value.application && (
            <p className="session-sources-wanted" role="status">
              For the call in {value.wanted.name}: list applications, check it
              is chosen, then start.
            </p>
          )}
          <p className="processing-muted">
            {status?.scopeNotice ??
              'Audio from all windows of this application may be included.'}{' '}
            The first time you list applications, macOS asks you to allow Screen
            &amp; System Audio Recording for TalkQTE. Nothing is captured or
            sent until you press Start live session; starting sends the selected
            source(s) to Deepgram and recent lines to Anthropic until Stop
            {value.mode === 'both'
              ? '; that one start covers the microphone and the application'
              : ''}
            .
          </p>
          {value.mode === 'both' && (
            <p className="session-sources-headphones">
              Use headphones if you can. Through speakers the microphone also
              hears the call; TalkQTE leaves out lines it can tell are repeats,
              but not all of them.
            </p>
          )}
          {listing ? (
            <div className="processing-actions">
              <button
                className="secondary-button"
                disabled={off}
                onClick={() => void act({ kind: 'cancelList' })}
              >
                Cancel listing
              </button>
            </div>
          ) : choices.length === 0 ? (
            <div className="processing-actions">
              <button
                className="secondary-button"
                disabled={off || !status}
                onClick={() => void act({ kind: 'list', acknowledged: true })}
              >
                List applications
              </button>
            </div>
          ) : (
            <>
              <fieldset disabled={disabled}>
                <legend>Application</legend>
                {choices.map((item) => (
                  <label key={item.id} className="processing-option">
                    <input
                      type="radio"
                      name="session-sources-application"
                      value={item.id}
                      checked={value.application?.id === item.id}
                      onChange={() => onChange({ ...value, application: item })}
                    />
                    <span>{item.name}</span>
                  </label>
                ))}
              </fieldset>
              <p className="processing-muted">
                Only open applications with a window are listed. If yours is
                missing, open it or one of its windows, then list again. A
                browser can be listed and still give no sound: browser calls are
                not yet known to work.
              </p>
              <div className="processing-actions">
                <button
                  className="secondary-button"
                  disabled={off}
                  onClick={() => {
                    onChange({ ...value, application: null });
                    void act({ kind: 'list', acknowledged: true });
                  }}
                >
                  List again
                </button>
              </div>
            </>
          )}
          {status?.bySetting && (
            <p className="processing-muted">
              The TALKQTE_DEV_APPLICATION_SOURCE launch setting acknowledged
              this notice and asked for one start; it does not retry.
            </p>
          )}
          {(problem || error) && (
            <p className="session-sources-error" role="alert">
              {error || problem}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
