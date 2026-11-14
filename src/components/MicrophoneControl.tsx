import type { ReactNode } from 'react';
import { desktop } from '../lib/bridge';
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
}) {
  const { state, error, busy, active, start, stop } = microphone;
  if (live || preparing)
    return (
      <section className="microphone-panel" aria-label="Microphone">
        <div className="microphone-heading">
          <div>
            <strong>
              {preparing ? 'Preparing live session' : 'Live session'}
            </strong>
            <span className="microphone-status" role="status">
              {microphoneLabel(state)}
            </span>
            {state?.status === 'listening' && (
              <span className="microphone-activity">
                <span
                  className={`status-dot ${state.activity}`}
                  aria-hidden="true"
                />
                {state.activity === 'active'
                  ? 'Signal detected'
                  : 'Quiet input'}
              </span>
            )}
          </div>
          {action}
        </div>
        <MicrophoneInput state={state} />
        {preparing ? (
          <p role="status">
            {cancelling
              ? 'Start cancelled. Waiting for model preparation to finish before you can start again.'
              : 'Preparing local transcription. Cancel start to prevent capture.'}
          </p>
        ) : (
          <p>
            {sourceSession
              ? `Audio from ${sourceSession} is transcribed on this device; the microphone is not used. Audio is not recorded.`
              : 'Your microphone is transcribed on this device. Audio is not recorded.'}
            {processingConfigured
              ? ' Cue processing has separate permissions below.'
              : ' The transcript is not saved or sent.'}{' '}
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
      </section>
    );
  const stopping =
    state?.status === 'stopping' ||
    (state?.status === 'error' && !state.canStart);
  const canStop =
    (active && state?.status !== 'error') || (!!error && !state) || stopping;
  return (
    <section className="microphone-panel" aria-label="Microphone">
      <div className="microphone-heading">
        <div>
          <strong>Microphone only</strong>
          <span className="microphone-status" role="status">
            {error && !state ? 'Status unavailable' : microphoneLabel(state)}
          </span>
          {state?.status === 'listening' && (
            <span className="microphone-activity">
              <span
                className={`status-dot ${state.activity}`}
                aria-hidden="true"
              />
              {state.activity === 'active' ? 'Signal detected' : 'Quiet input'}
            </span>
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
      <MicrophoneInput state={state} />
      <p>
        {sourceMayBeCapturing
          ? 'Activity check only. No recording or transcription from the microphone. Audio from a selected application may still be captured; see Cue processing below.'
          : 'Activity check only. No recording, transcription, or system audio.'}{' '}
        Demo questions are scripted.
      </p>
      {active && state?.status !== 'error' && (
        <p>
          Demo and companion controls do not stop this check. Use Stop
          microphone to release it.
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
    </section>
  );
}
