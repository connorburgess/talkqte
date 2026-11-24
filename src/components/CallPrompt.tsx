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
 * by itself, and Start only opens the notebook's ordinary start. */
export function CallPrompt({
  offer,
  busy,
  onAnswer,
}: {
  offer: CallPromptOffer;
  busy: boolean;
  onAnswer: (answer: CallPromptAnswer) => void;
}) {
  const app = offer.application;
  return (
    <section className="call-prompt" aria-labelledby="call-prompt-title">
      <p id="call-prompt-title" className="call-prompt-title" role="status">
        {app
          ? offer.kind === 'browser'
            ? `The microphone is in use and ${app} is in front. A call?`
            : `A call seems to be starting in ${app}.`
          : 'The microphone is in use. A call?'}
      </p>
      <p className="call-prompt-detail">
        {app
          ? `Start a session with your microphone and ${app}? You choose and approve everything in the notebook; nothing is heard until then.`
          : 'Start a session with your microphone? You approve it in the notebook; nothing is heard until then.'}
        {offer.kind === 'browser' && ' A browser’s audio may not be heard yet.'}
      </p>
      <div className="call-prompt-actions">
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => onAnswer('start')}
        >
          <Play size={15} aria-hidden="true" />
          Start session…
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
