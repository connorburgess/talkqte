import { CalibratedCueMark } from './CallPrompt';

/** Compact companion card shown while a live session is running after a
 * previously active call's camera and microphone go inactive. */
export interface CallEndPromptOffer {
  id: number;
}
export type CallEndPromptAnswer = 'stopAndSave' | 'keepRecording';

export function CallEndPrompt({
  busy,
  large = false,
  onAnswer,
}: {
  prompt: CallEndPromptOffer;
  busy: boolean;
  large?: boolean;
  onAnswer: (answer: CallEndPromptAnswer) => void;
}) {
  return (
    <section
      className={`call-prompt call-end-prompt${large ? ' is-large' : ''}`}
      aria-labelledby="call-end-prompt-title"
    >
      <div className="call-prompt-head">
        <CalibratedCueMark />
        <p id="call-end-prompt-title" className="call-prompt-title">
          Call ended
        </p>
      </div>
      <p className="call-prompt-detail">Camera and mic look inactive.</p>
      <div className="call-prompt-actions">
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => onAnswer('stopAndSave')}
        >
          Stop &amp; save
        </button>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => onAnswer('keepRecording')}
        >
          Keep recording
        </button>
      </div>
    </section>
  );
}
