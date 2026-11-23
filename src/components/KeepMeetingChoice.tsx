import { useId, useState } from 'react';
import * as bridge from '../lib/bridge';
import type { Snapshot } from '../lib/types';
import './keep-meeting.css';

/** In the export review, after a session with a transcript has ended: the
 * person's choice, for this session only and off by default, to keep the
 * meeting by including its transcript and the cues shown. Changing it asks
 * Rust for a new preview, so the text on screen is always what is saved. */
export function KeepMeetingChoice({
  snapshot,
  onPreview,
}: {
  snapshot: Snapshot;
  onPreview: (markdown: string) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ended =
    snapshot.transcript.length > 0 &&
    snapshot.status !== 'running' &&
    snapshot.status !== 'paused';
  if (!ended) return null;
  const keep = snapshot.keepMeeting === true;

  const choose = async (next: boolean) => {
    setBusy(true);
    setError('');
    try {
      await bridge.command('set_keep_meeting', { keep: next });
      onPreview(await bridge.exportPreview());
    } catch {
      setError('The export could not be updated. Nothing was saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="keep-meeting">
      <input
        id={`${id}-keep`}
        type="checkbox"
        checked={keep}
        disabled={busy}
        aria-describedby={`${id}-help`}
        onChange={(event) => void choose(event.target.checked)}
      />
      <div>
        <label htmlFor={`${id}-keep`}>
          Also keep this meeting: its transcript and the cues shown
        </label>
        <p id={`${id}-help`}>
          For this session only. Note reminders and the Still open list are left
          out. The text below changes to show exactly what will be saved;
          nothing is written until you choose a destination.
        </p>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
