import type { ReactNode } from 'react';
import { desktop } from '../lib/bridge';
import type { CloudTranscription } from '../lib/transcription';
import {
  microphoneLabel,
  type Microphone,
  type MicrophoneSnapshot,
} from '../lib/microphone';

function MicrophoneInput({ state }: { state: MicrophoneSnapshot | null }) {
  if (!desktop || !state) return null;
  const opened = ['starting', 'listening', 'stopping'].includes(state.status);
  return (
    <div className="microphone-input">
      {opened && (state.deviceName || state.status === 'listening') && (
        <p>
          {state.status === 'stopping' ? 'Releasing input: ' : 'Input: '}
          <bdi>{state.deviceName || 'name unavailable'}</bdi>
        </p>
      )}
      <details>
        <summary>Change microphone</summary>
        <p>
          On macOS, stop the microphone or live session and wait for Off. After
          an error, wait until Start is available. Choose an input in macOS
          System Settings → Sound → Input, then start again here. Each start
          uses the macOS default input; TalkQTE does not switch devices
          automatically.
        </p>
      </details>
    </div>
  );
}

export function MicrophoneControl({
  microphone,
  live = false,
  preparing = false,
  cancelling = false,
  action,
  processingConfigured = false,
  sourceMayBeCapturing = false,
  sourceSession = null,
  transcription,
}: {
  microphone: Microphone;
  live?: boolean;
  preparing?: boolean;
  cancelling?: boolean;
  action?: ReactNode;
  processingConfigured?: boolean;
  /** Development builds only: a selected application may still be captured. */
  sourceMayBeCapturing?: boolean;
  /** Development builds only: the application a live session was started
   * for alone, with no microphone. */
  sourceSession?: string | null;
  /** Development builds that selected cloud transcription only. */
  transcription?: CloudTranscription;
}) {
  const { state, error, busy, active, start, stop } = microphone;
  // Every live session names its transcription service.
  const provider = transcription?.provider ?? 'the transcription service';
  if (live || preparing)
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
          <MicrophoneInput state={state} />
          {preparing ? (
            <p role="status">
              {cancelling
                ? 'Start cancelled. Waiting for the start to finish before you can start again.'
                : 'Starting the live session. Cancel start to prevent capture.'}
            </p>
          ) : (
            <p>
              {sourceSession
                ? `Audio from ${sourceSession} is sent to ${provider} for transcription once you enable cue processing for this session; until then nothing is transcribed. The microphone is not used. TalkQTE does not record audio.`
                : `Your microphone is sent to ${provider} for transcription once you enable cue processing for this session; until then nothing is transcribed. TalkQTE does not record audio.`}
              {processingConfigured
                ? ' Cue processing has separate permissions below.'
                : ' TalkQTE does not save the transcript.'}{' '}
              {sourceSession
                ? 'Stop live session to end it.'
                : 'Stop live session to release the microphone.'}
            </p>
          )}
          {(error || state?.message) && (
            <p className="microphone-message" role="alert">
              {error || state?.message}
            </p>
          )}
        </div>
      </section>
    );
  const stopping =
    state?.status === 'stopping' ||
    (state?.status === 'error' && !state.canStart);
  const canStop =
    (active && state?.status !== 'error') || (!!error && !state) || stopping;
  const idle =
    !active &&
    !stopping &&
    !error &&
    state?.status !== 'error' &&
    !state?.message &&
    !microphone.stopPending;
  const description = sourceMayBeCapturing
    ? 'Shows whether your microphone picks up sound. Nothing from the microphone is recorded or transcribed. Audio from a selected application may still be captured; see Cue processing below.'
    : 'Shows whether your microphone picks up sound. Nothing is recorded or transcribed, and no system audio is used.';
  return (
    <section
      className={`microphone-panel${idle ? ' is-quiet' : ''}`}
      aria-label="Microphone"
    >
      <div className="microphone-panel-body">
        <div className="microphone-heading">
          <div>
            <strong>Microphone check</strong>
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
