import { useLayoutEffect, useRef, useState } from 'react';
import type { SessionMode as Mode } from '../lib/types';
import './session-mode.css';

export function SessionMode({
  mode = 'meeting',
  locked,
  busy,
  onChange,
}: {
  mode?: Mode;
  locked: boolean;
  busy: boolean;
  onChange: (mode: Mode) => Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const select = useRef<HTMLSelectElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (saving || !restoreFocus.current) return;
    restoreFocus.current = false;
    // WebKit can move focus to the body when a focused control is disabled.
    // Restore only that lost focus, never focus the user moved elsewhere.
    if (document.activeElement === document.body) select.current?.focus();
  }, [saving]);
  async function choose(value: Mode) {
    restoreFocus.current = document.activeElement === select.current;
    setSaving(true);
    setError('');
    try {
      await onChange(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="session-mode">
      <div className="session-mode-choice">
        <label htmlFor="session-mode">Session type</label>
        <select
          ref={select}
          id="session-mode"
          value={mode}
          disabled={locked || busy || saving}
          aria-describedby="session-mode-help"
          onChange={(event) => void choose(event.target.value as Mode)}
        >
          <option value="meeting">Meeting</option>
          <option value="interview">Interview</option>
        </select>
        {saving && (
          <span role="status" className="small muted">
            Updating…
          </span>
        )}
      </div>
      <p id="session-mode-help" className="small muted">
        {mode === 'interview'
          ? 'Brief, source-backed nudges about examples, reasoning and outcomes. Use your own experience.'
          : 'Context and clarifications for the conversation.'}
        {locked
          ? ' Stop the session to change its type.'
          : ' Session type stays selected until you quit.'}
      </p>
      {mode === 'interview' && !locked && (
        <details className="interview-preparation">
          <summary>Prepare for your interview</summary>
          <p className="small muted">
            Have one concrete example ready: the situation, your contribution,
            the trade-off, and the result. Use the same approach for a human or
            AI interviewer.
          </p>
          <p className="small muted">
            TalkQTE can miss context or offer an unhelpful nudge. Keep
            listening, and use Pause cues whenever you want. Selecting Interview
            does not add or share any past meetings.
          </p>
        </details>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
