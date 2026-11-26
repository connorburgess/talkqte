import { Play } from 'lucide-react';

/** The companion's offer when a call seems to be starting. */
export interface CallPromptOffer {
  id: number;
  /** The frontmost or mic-active application to preselect beside the microphone. */
  application?: string;
  kind?: 'meeting' | 'browser';
}
export type CallPromptAnswer =
  'start' | 'dismiss' | 'notForThisApp' | 'dontAskAgain';

export function CalibratedCueMark() {
  return (
    <svg
      className="call-prompt-mark"
      width="22"
      height="22"
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="3.5"
        fill="#0d1014"
        stroke="#505c6e"
        strokeWidth="1"
      />
      <path
        d="M8 13V8h5M24 19v5h-5"
        fill="none"
        stroke="#f5f7fa"
        strokeWidth="2.4"
        strokeLinecap="square"
      />
      <rect x="10.5" y="14.5" width="11" height="3" rx="1" fill="#ebb45b" />
    </svg>
  );
}

/** Compact Direction C offer: never takes focus (the companion cannot), goes
 * away by itself, and Start begins listening and processing in one click. */
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
      <div className="call-prompt-head">
        <CalibratedCueMark />
        <p id="call-prompt-title" className="call-prompt-title" role="status">
          {app ? `Call in ${app}` : 'Start listening?'}
        </p>
      </div>
      <div className="call-prompt-actions">
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => onAnswer('start')}
        >
          <Play size={13} fill="currentColor" aria-hidden="true" />
          Start
        </button>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => onAnswer('dismiss')}
        >
          Not now
        </button>
      </div>
      <div className="call-prompt-subtle-actions">
        {app && (
          <button
            className="call-prompt-quiet"
            disabled={busy}
            onClick={() => onAnswer('notForThisApp')}
          >
            Not for {app}
          </button>
        )}
        <button
          className="call-prompt-quiet call-prompt-off"
          disabled={busy}
          title="Turn off call-starting offers"
          onClick={() => onAnswer('dontAskAgain')}
        >
          Off
        </button>
      </div>
    </section>
  );
}
