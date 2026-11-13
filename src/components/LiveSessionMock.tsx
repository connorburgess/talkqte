import { useRef, useState } from 'react';
import './live-mock.css';

type MockState =
  'idle' | 'starting' | 'listening' | 'cue' | 'paused' | 'stopped' | 'failed';

const states: { value: MockState; label: string }[] = [
  { value: 'idle', label: 'Idle' },
  { value: 'starting', label: 'Starting' },
  { value: 'listening', label: 'Listening' },
  { value: 'cue', label: 'Cue shown' },
  { value: 'paused', label: 'Paused' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'failed', label: 'Failed' },
];

export function LiveSessionMock() {
  const [state, setState] = useState<MockState>('idle');
  const selector = useRef<HTMLSelectElement>(null);
  const returnToSelector = (next: MockState) => {
    setState(next);
    selector.current?.focus();
  };
  const active = ['starting', 'listening', 'cue', 'paused'].includes(state);
  return (
    <section className="live-mock" aria-labelledby="mock-title">
      <h1 id="mock-title">Live session layout preview</h1>
      <p>
        This is a fictional, interactive layout preview. It does not capture
        audio, connect to a meeting, or generate AI cues.
      </p>
      <label className="mock-state-picker">
        Preview a state
        <select
          ref={selector}
          value={state}
          onChange={(event) => setState(event.target.value as MockState)}
        >
          {states.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="mock-session" aria-label="Fictional session preview">
        <div className="mock-session-header">
          <div>
            <h2>Fictional planning conversation</h2>
            <p>Preview source: fictional sample · Preview captures no audio</p>
          </div>
          {active && (
            <button
              className="secondary-button"
              onClick={() => returnToSelector('stopped')}
            >
              Stop preview
            </button>
          )}
        </div>
        <p role="status">
          Preview state: {states.find((item) => item.value === state)?.label}
        </p>
        {(state === 'idle' || state === 'stopped') && (
          <button
            className="secondary-button"
            onClick={() => returnToSelector('starting')}
          >
            Start preview
          </button>
        )}
        {state === 'failed' && (
          <>
            <p>Fictional connection failed. Retry the preview to continue.</p>
            <button
              className="secondary-button"
              onClick={() => returnToSelector('starting')}
            >
              Retry preview
            </button>
          </>
        )}
        {state === 'starting' && (
          <>
            <p>Example: preparing a session. No connection is being made.</p>
            <button
              className="secondary-button"
              onClick={() => returnToSelector('listening')}
            >
              Show listening example
            </button>
          </>
        )}
        {(state === 'listening' || state === 'cue' || state === 'paused') && (
          <div className="mock-conversation">
            {(state === 'listening' || state === 'cue') && (
              <button
                className="secondary-button"
                onClick={() => returnToSelector('paused')}
              >
                Pause preview
              </button>
            )}
            {state === 'paused' && (
              <button
                className="secondary-button"
                onClick={() => returnToSelector('listening')}
              >
                Resume preview
              </button>
            )}
            <section aria-labelledby="mock-context-title">
              <h3 id="mock-context-title">Prior context</h3>
              <p>
                Fictional note: Robin offered to draft the plan before Friday.
              </p>
            </section>
            <section aria-labelledby="mock-conversation-title">
              <h3 id="mock-conversation-title">Conversation</h3>
              <p>Alex: Who can bring the first draft to the review?</p>
            </section>
            {state === 'cue' && (
              <section aria-labelledby="mock-cue-title">
                <h3 id="mock-cue-title">Example context reminder</h3>
                <p>Robin offered to draft the plan before Friday.</p>
                <details>
                  <summary>Why this example?</summary>
                  <p>
                    It refers to the fictional prior note and Alex’s example
                    question above.
                  </p>
                </details>
                <button
                  className="text-button"
                  onClick={() => returnToSelector('listening')}
                >
                  Dismiss example
                </button>
              </section>
            )}
            {state === 'paused' && (
              <p>Preview paused. This is not a capture control.</p>
            )}
          </div>
        )}
        {(state === 'idle' || state === 'stopped') && (
          <p>
            Start the preview or choose a state above to inspect the layout.
          </p>
        )}
      </div>
    </section>
  );
}
