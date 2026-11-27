import type { ReactNode, Ref } from 'react';
import { desktop } from '../lib/bridge';
import { usePlatform } from '../lib/platform';
import type { CloudTranscription } from '../lib/transcription';
import {
  microphoneLabel,
  type Microphone,
  type MicrophoneSnapshot,
} from '../lib/microphone';

function MicrophoneInput({
  state,
  inline = false,
}: {
  state: MicrophoneSnapshot | null;
  /** Inside a unified disclosure, show input guidance flat without nested details. */
  inline?: boolean;
}) {
  const platform = usePlatform();
  if (!desktop || !state) return null;
  const opened = ['starting', 'listening', 'stopping'].includes(state.status);
  const guidance =
    platform?.os === 'windows' ? (
      <p>
        Stop the microphone or live session and wait for Off. After an error,
        wait until Start is available. Choose an input in Windows Settings →
        System → Sound → Input, then start again here. Each start uses the
        Windows default input; TalkQTE does not switch devices automatically.
      </p>
    ) : platform?.os === 'linux' ? (
      <p>
        Stop the microphone or live session and wait for Off. After an error,
        wait until Start is available. Choose an input in your desktop&apos;s
        sound settings, then start again here. Each start uses the default
        input; TalkQTE does not switch devices automatically.
      </p>
    ) : (
      <p>
        On macOS, stop the microphone or live session and wait for Off. After an
        error, wait until Start is available. Choose an input in macOS System
        Settings → Sound → Input, then start again here. Each start uses the
        macOS default input; TalkQTE does not switch devices automatically.
      </p>
    );
  return (
    <div className="microphone-input">
      {opened && (state.deviceName || state.status === 'listening') && (
        <p>
          {state.status === 'stopping' ? 'Releasing input: ' : 'Input: '}
          <bdi>{state.deviceName || 'name unavailable'}</bdi>
        </p>
      )}
      {inline ? (
        <div className="microphone-input-guidance">
          <strong>Change microphone:</strong> {guidance}
        </div>
      ) : (
        <details>
          <summary>Change microphone</summary>
          {guidance}
        </details>
      )}
    </div>
  );
}

export function MicrophoneControl({
  microphone,
  live = false,
  preparing = false,
  cancelling = false,
  compact = false,
  inSettings = false,
  unified = false,
  stopActionRef,
  action,
  processingConfigured = false,
  processingApproved = true,
  sourceMayBeCapturing = false,
  sourceSession = null,
  transcription,
}: {
  microphone: Microphone;
  live?: boolean;
  preparing?: boolean;
  cancelling?: boolean;
  /** Compact active-mic indicator shown outside Settings when mic check runs. */
  compact?: boolean;
  /** Full microphone check inside Settings. */
  inSettings?: boolean;
  /** Composed into the unified Notebook live session header. */
  unified?: boolean;
  stopActionRef?: Ref<HTMLButtonElement>;
  action?: ReactNode;
  processingConfigured?: boolean;
  processingApproved?: boolean;
  /** macOS builds: a selected application may still be captured. */
  sourceMayBeCapturing?: boolean;
  /** macOS builds: the application a live session was started
   * for alone, with no microphone. */
  sourceSession?: string | null;
  /** Development builds that selected cloud transcription only. */
  transcription?: CloudTranscription;
}) {
  const { state, error, busy, active, start, stop } = microphone;
  // Every live session names its transcription service.
  const provider = transcription?.provider ?? 'the transcription service';
  if (live || preparing) {
    const routingLine =
      processingConfigured && !processingApproved
        ? sourceSession
          ? `Audio from ${sourceSession} is sent to ${provider} once cue processing is enabled; until then nothing is transcribed. The microphone is not used. TalkQTE does not record audio.`
          : `Your microphone is sent to ${provider} once cue processing is enabled; until then nothing is transcribed. TalkQTE does not record audio.`
        : sourceSession
          ? `Audio from ${sourceSession} is sent to ${provider} for transcription. The microphone is not used. TalkQTE does not record audio.`
          : `Your microphone is sent to ${provider} for transcription. TalkQTE does not record audio.`;
    const stopTail = sourceSession
      ? ' Stop live session to end it.'
      : ' Stop live session to release the microphone.';
    const retentionText =
      'Transcript saving follows Settings → Meetings, independently of cue processing. Save automatically requests a local save of non-empty sessions on stop. Ask each time waits for your choice; Don’t save leaves the session in memory. Check the status after Stop to confirm a save. Lab runs do not save meetings.';
    if (unified)
      return (
        <section
          className="microphone-panel is-live is-unified"
          aria-label="Microphone"
        >
          <div className="microphone-unified-bar">
            <div className="microphone-unified-status">
              <span className="microphone-status" role="status">
                {microphoneLabel(state)}
              </span>
              {state?.status === 'listening' && (
                <>
                  <span className="status-sep" aria-hidden="true">
                    ·
                  </span>
                  <span
                    className={`microphone-activity${
                      state.activity === 'active' ? ' is-active' : ''
                    }`}
                  >
                    <span
                      className={`status-dot ${state.activity}`}
                      aria-hidden="true"
                    />
                    {state.activity === 'active'
                      ? 'Signal detected'
                      : 'Quiet input'}
                  </span>
                </>
              )}
            </div>
            {action}
          </div>
          {preparing ? (
            <p className="microphone-unified-prep" role="status">
              {cancelling
                ? 'Start cancelled. Waiting for the start to finish before you can start again.'
                : 'Starting the live session. Cancel start to prevent capture.'}
            </p>
          ) : (
            <details className="microphone-more is-unified-details">
              <summary>Routing, input &amp; transcript saving</summary>
              <div className="microphone-disclosures">
                <p>
                  {routingLine}
                  {stopTail}
                </p>
                <MicrophoneInput state={state} inline />
                <p className="microphone-retention">{retentionText}</p>
              </div>
            </details>
          )}
          {preparing && <MicrophoneInput state={state} inline />}
          {(error || state?.message) && (
            <p className="microphone-message" role="alert">
              {error || state?.message}
            </p>
          )}
        </section>
      );
    return (
      <section className="microphone-panel is-live" aria-label="Microphone">
        <div className="microphone-panel-body">
          <div className="microphone-heading">
            <div>
              <strong>
                {preparing ? 'Preparing live session' : 'Live session'}
              </strong>
              <span className="status-sep" aria-hidden="true">
                ·
              </span>
              <span className="microphone-status" role="status">
                {microphoneLabel(state)}
              </span>
              {state?.status === 'listening' && (
                <>
                  <span className="status-sep" aria-hidden="true">
                    ·
                  </span>
                  <span
                    className={`microphone-activity${
                      state.activity === 'active' ? ' is-active' : ''
                    }`}
                  >
                    <span
                      className={`status-dot ${state.activity}`}
                      aria-hidden="true"
                    />
                    {state.activity === 'active'
                      ? 'Signal detected'
                      : 'Quiet input'}
                  </span>
                </>
              )}
            </div>
            {action}
          </div>
          <div className="microphone-disclosures">
            {preparing ? (
              <p role="status">
                {cancelling
                  ? 'Start cancelled. Waiting for the start to finish before you can start again.'
                  : 'Starting the live session. Cancel start to prevent capture.'}
              </p>
            ) : (
              <p>
                {routingLine}
                {stopTail}
              </p>
            )}
            <MicrophoneInput state={state} />
            {!preparing && (
              <details className="microphone-more">
                <summary>Transcript saving details</summary>
                <p className="microphone-retention">{retentionText}</p>
              </details>
            )}
          </div>
          {(error || state?.message) && (
            <p className="microphone-message" role="alert">
              {error || state?.message}
            </p>
          )}
        </div>
      </section>
    );
  }
  const stopping =
    state?.status === 'stopping' ||
    (state?.status === 'error' && !state.canStart);
  const canStop =
    (active && state?.status !== 'error') || (!!error && !state) || stopping;
  if (compact)
    return (
      <section className="microphone-panel is-compact" aria-label="Microphone">
        <div className="microphone-panel-body">
          <div className="microphone-heading">
            <div>
              <strong>Microphone check</strong>
              <span className="status-sep" aria-hidden="true">
                ·
              </span>
              <span className="microphone-status" role="status">
                {error && !state
                  ? 'Status unavailable'
                  : microphoneLabel(state)}
              </span>
              {state?.status === 'listening' && (
                <>
                  <span className="status-sep" aria-hidden="true">
                    ·
                  </span>
                  <span
                    className={`microphone-activity${
                      state.activity === 'active' ? ' is-active' : ''
                    }`}
                  >
                    <span
                      className={`status-dot ${state.activity}`}
                      aria-hidden="true"
                    />
                    {state.activity === 'active'
                      ? 'Signal detected'
                      : 'Quiet input'}
                  </span>
                </>
              )}
            </div>
            <button
              ref={stopActionRef}
              className="secondary-button"
              disabled={
                !desktop || busy || stopping || (!canStop && !state?.canStart)
              }
              onClick={() => void stop()}
              aria-label="Stop microphone"
            >
              {stopping ? 'Stopping…' : 'Stop microphone'}
            </button>
          </div>
          {microphone.stopPending && state?.status !== 'stopping' && (
            <p aria-live="polite">Stop requested… waiting for microphone.</p>
          )}
          {(error || state?.message) && (
            <p
              className="microphone-message"
              role={error || state?.status === 'error' ? 'alert' : undefined}
            >
              {error || state?.message}
            </p>
          )}
        </div>
      </section>
    );
  const idle =
    !active &&
    !stopping &&
    !error &&
    state?.status !== 'error' &&
    !state?.message &&
    !microphone.stopPending;
  const description = sourceMayBeCapturing
    ? 'Shows whether your microphone picks up sound. Nothing from the microphone is recorded or transcribed. Audio from a selected application may still be captured; see Cue processing above.'
    : 'Shows whether your microphone picks up sound. Nothing is recorded or transcribed, and no system audio is used.';
  return (
    <section
      className={`microphone-panel${inSettings ? ' is-settings' : ''}${
        idle ? ' is-quiet' : ''
      }`}
      aria-label="Microphone"
    >
      <div className="microphone-panel-body">
        <div className="microphone-heading">
          <div>
            {inSettings ? (
              <h2>Microphone check</h2>
            ) : (
              <strong>Microphone check</strong>
            )}
            <span className="status-sep" aria-hidden="true">
              ·
            </span>
            <span className="microphone-status" role="status">
              {error && !state ? 'Status unavailable' : microphoneLabel(state)}
            </span>
            {state?.status === 'listening' && (
              <>
                <span className="status-sep" aria-hidden="true">
                  ·
                </span>
                <span
                  className={`microphone-activity${
                    state.activity === 'active' ? ' is-active' : ''
                  }`}
                >
                  <span
                    className={`status-dot ${state.activity}`}
                    aria-hidden="true"
                  />
                  {state.activity === 'active'
                    ? 'Signal detected'
                    : 'Quiet input'}
                </span>
              </>
            )}
          </div>
          <button
            className="secondary-button"
            disabled={
              !desktop || busy || stopping || (!canStop && !state?.canStart)
            }
            onClick={() => void (canStop ? stop() : start())}
            aria-label={canStop ? 'Stop microphone' : 'Start microphone'}
          >
            {stopping
              ? 'Stopping…'
              : canStop
                ? 'Stop microphone'
                : 'Start microphone'}
          </button>
        </div>
        {idle ? (
          <>
            <p>{description}</p>
            <MicrophoneInput state={state} />
          </>
        ) : (
          <>
            <MicrophoneInput state={state} />
            <p>{description}</p>
          </>
        )}
        {active && state?.status !== 'error' && (
          <p>
            Companion controls do not stop this check. Use Stop microphone to
            release it.
          </p>
        )}
        {microphone.stopPending && state?.status !== 'stopping' && (
          <p aria-live="polite">Stop requested… waiting for microphone.</p>
        )}
        {(error || state?.message) && (
          <p
            className="microphone-message"
            role={error || state?.status === 'error' ? 'alert' : undefined}
          >
            {error || state?.message}
          </p>
        )}
      </div>
    </section>
  );
}
