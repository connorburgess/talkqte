import * as bridge from '../lib/bridge';
import {
  savedNotesExplanation,
  type PriorContextAvailability as Availability,
} from '../lib/priorContextAvailability';

export function PriorContextAvailability({
  state,
  busy,
  refresh,
  onOpenMeetings,
  onOpenSettings,
}: {
  state: Availability;
  busy: boolean;
  refresh: () => void;
  onOpenMeetings?: () => void;
  onOpenSettings?: () => void;
}) {
  if (!bridge.desktop)
    return (
      <p className="context-empty">
        No prior notes selected. You can add a Markdown (.md), text (.txt), or
        TalkQTE JSON notes file to review and import. Saved meetings and Granola
        connections are available in the desktop app.
      </p>
    );
  const explanation = savedNotesExplanation(state);
  return (
    <div className="context-availability">
      <p className="context-empty" role="status">
        <strong>{explanation.title}</strong>
        <br />
        {explanation.detail}
      </p>
      {state.phase === 'ready' && state.listing.unreadable > 0 && (
        <p className="small muted">
          {state.listing.unreadable === 1
            ? '1 saved meeting could not be read.'
            : `${state.listing.unreadable} saved meetings could not be read.`}{' '}
          The availability above covers readable meetings only. Nothing was
          changed.
        </p>
      )}
      <div className="context-actions">
        {state.phase === 'error' && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={refresh}
          >
            Retry saved notes check
          </button>
        )}
        {explanation.review === 'meetings' && onOpenMeetings && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={onOpenMeetings}
          >
            Review saved meetings
          </button>
        )}
        {explanation.review === 'settings' && onOpenSettings && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={onOpenSettings}
          >
            Review meeting settings
          </button>
        )}
      </div>
    </div>
  );
}
