import { Play } from 'lucide-react';

/** Narrow pre-call prompt from opt-in local Calendar awareness. */
export interface CalendarPromptOffer {
  id: number;
  title: string;
  minutesUntilStart: number;
}

export type CalendarPromptAnswer = 'start' | 'dismiss';

function headingText(offer: CalendarPromptOffer): string {
  if (offer.minutesUntilStart > 0) {
    return `${offer.title} starts in ${offer.minutesUntilStart} min`;
  }
  if (offer.minutesUntilStart === 0) {
    return `${offer.title} starting now`;
  }
  const ago = Math.abs(offer.minutesUntilStart);
  return `${offer.title} started ${ago} min ago`;
}

/** Calm floating dock card for an upcoming or just-started calendar meeting.
 * Never takes focus or starts capture on its own. */
export function CalendarPrompt({
  offer,
  busy,
  large = false,
  onAnswer,
}: {
  offer: CalendarPromptOffer;
  busy: boolean;
  large?: boolean;
  onAnswer: (answer: CalendarPromptAnswer) => void;
}) {
  return (
    <section
      className={`call-prompt calendar-prompt${large ? ' is-large' : ''}`}
      aria-labelledby="calendar-prompt-title"
    >
      <p id="calendar-prompt-title" className="call-prompt-title" role="status">
        {headingText(offer)}
      </p>
      <p className="call-prompt-detail">
        Start listening with this meeting’s title, or dismiss.
      </p>
      <div className="call-prompt-actions">
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => onAnswer('start')}
        >
          <Play size={13} fill="currentColor" aria-hidden="true" />
          Start listening
        </button>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => onAnswer('dismiss')}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
