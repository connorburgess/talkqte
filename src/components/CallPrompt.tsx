import { Play, X } from 'lucide-react';

/** The companion's offer when a call seems to be starting. */
export interface CallPromptOffer {
  id: number;
  /** The frontmost application to preselect beside the microphone. */
  application?: string;
  kind?: 'meeting' | 'browser';
}
export type CallPromptAnswer =
  'start' | 'dismiss' | 'notForThisApp' | 'dontAskAgain';

/** Quiet and small: it never takes focus (the companion cannot), goes away
 * by itself, and Start begins listening and processing in one click. */
export function CallPrompt({
  offer,
  busy,
  large = false,
  onAnswer,
}: {
  offer: CallPromptOffer;
  busy: boolean;
  large?: boolean;
  onAnswer: (answer: CallPromptAnswer) => void;
}) {
  const app = offer.application;
  return (
    <section
      className={`call-prompt${large ? ' is-large' : ''}`}
      aria-labelledby="call-prompt-title"
    >
      <p id="call-prompt-title" className="call-prompt-title" role="status">
        {app
          ? offer.kind === 'browser'
            ? `The microphone is in use and ${app} is in front. A call?`
            : `A call seems to be starting in ${app}.`
          : 'The microphone is in use. A call?'}
      </p>
      <p className="call-prompt-detail">
        Start listening with your microphone? Sends audio to Deepgram and recent
        lines to Anthropic until you stop.
        {offer.kind === 'browser' && ' A browser call includes mic audio only.'}
      </p>
      <div className="call-prompt-actions">
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => onAnswer('start')}
        >
          <Play size={13} fill="currentColor" aria-hidden="true" />
          Start
        </button>
        {app && (
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => onAnswer('notForThisApp')}
          >
            Not for {app}
          </button>
        )}
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => onAnswer('dontAskAgain')}
        >
          Don’t ask again
        </button>
        <button
          className="companion-control"
          aria-label="Not now"
          title="Not now"
          disabled={busy}
          onClick={() => onAnswer('dismiss')}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
