import { useEffect, useId, useRef, useState } from 'react';
import { describeCapture, type RealCapture } from './LiveCaptureStatus';
import './live-mock.css';

type MockState =
  'idle' | 'starting' | 'listening' | 'cue' | 'paused' | 'stopped' | 'failed';

const states: { value: MockState; label: string; capture: string }[] = [
  { value: 'idle', label: 'Idle', capture: 'Example not started' },
  {
    value: 'starting',
    label: 'Starting',
    capture: 'Simulated start. This example loads and connects nothing',
  },
  {
    value: 'listening',
    label: 'Listening',
    capture: 'Simulated listening. This example captures no audio',
  },
  {
    value: 'cue',
    label: 'Cue shown',
    capture: 'Simulated listening. This example captures no audio',
  },
  {
    value: 'paused',
    label: 'Paused',
    capture: 'Simulated pause. This example captured no audio',
  },
  {
    value: 'stopped',
    label: 'Stopped',
    capture: 'Simulated stop. This example captured and saved nothing',
  },
  {
    value: 'failed',
    label: 'Failed',
    capture: 'Simulated failure. This example captured nothing',
  },
];

const fictionalNotes = [
  {
    id: 'planning',
    title: 'Fictional planning notes',
    date: '6 November 2026',
    text: 'Robin offered to draft the plan before Friday.',
  },
  {
    id: 'venue',
    title: 'Fictional venue notes',
    date: '30 October 2026',
    text: 'The community hall is free on Thursday afternoons.',
  },
];
/** The example cue quotes this note, so removing the note withdraws the cue. */
const citedNote = fictionalNotes[0];
const spokenLine = 'Who can bring the first draft to the review?';

type View = 'notebook' | 'live-mock';

/** The one connected control: it changes which layout is on screen. */
export function LayoutSwitch({
  view,
  live,
  onChange,
}: {
  view: string;
  /** A real session is running in the notebook, so it is not a demo. */
  live: boolean;
  onChange: (view: View) => void;
}) {
  const options: { value: View; label: string }[] = [
    { value: 'notebook', label: live ? 'Session' : 'Demo' },
    { value: 'live-mock', label: 'Layout preview' },
  ];
  return (
    <div className="layout-switch" role="group" aria-label="Layout">
      {options.map(({ value, label }) => (
        <button
          key={value}
          aria-pressed={view === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function LiveSessionMock({
  real,
}: {
  /** The notebook's own microphone and live-session state, shown read-only. */
  real: RealCapture;
}) {
  const actual = describeCapture(real);
  const [state, setState] = useState<MockState>('idle');
  const [noteIds, setNoteIds] = useState(fictionalNotes.map(({ id }) => id));
  // A cue that was showing when the session paused stays until dismissed.
  const [cueKept, setCueKept] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  // Removing the quoted note takes the cue away; say so until the next action.
  const [withdrawn, setWithdrawn] = useState(false);
  const whyId = useId();
  const frame = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<string | null>(null);

  // A simulated action removes the control that was pressed. Focus goes to
  // the control that takes its place, as it would in a connected session.
  useEffect(() => {
    const key = focusNext.current;
    if (!key) return;
    focusNext.current = null;
    (
      frame.current?.querySelector<HTMLElement>(`[data-mock-focus="${key}"]`) ??
      title.current
    )?.focus();
  });

  const go = (next: MockState, focus: string, keepCue = false) => {
    setState(next);
    setCueKept(keepCue);
    if (!keepCue) setWhyOpen(false);
    setWithdrawn(false);
    focusNext.current = focus;
  };

  const current = states.find((item) => item.value === state)!;
  const active = ['starting', 'listening', 'cue', 'paused'].includes(state);
  const inConversation = ['listening', 'cue', 'paused'].includes(state);
  const notes = fictionalNotes.filter(({ id }) => noteIds.includes(id));
  const cueAvailable = noteIds.includes(citedNote.id);
  const cueShown = state === 'cue' || (state === 'paused' && cueKept);

  return (
    <section className="live-mock" aria-labelledby="mock-title">
      <h1 id="mock-title">Live session layout preview</h1>
      <p>
        Source and Capture below show the app’s real microphone and live-session
        state, read-only. Everything else is a fictional example: the preview
        starts and stops nothing, connects to no meeting, and generates no AI
        cues.
      </p>
      {actual.underway && (
        <p className="mock-real-session">
          {actual.underway} Its controls are above; nothing in this preview
          starts or stops it.
        </p>
      )}
      <label className="mock-state-picker">
        Preview a state
        <select
          value={state}
          onChange={(event) => {
            const next = event.target.value as MockState;
            setState(next);
            setCueKept(false);
            setWhyOpen(false);
            setWithdrawn(false);
            // "Cue shown" needs the note the cue quotes.
            if (next === 'cue' && !cueAvailable)
              setNoteIds(fictionalNotes.map(({ id }) => id));
          }}
        >
          {states.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div
        className="mock-session"
        role="group"
        aria-label="Fictional session preview"
        ref={frame}
      >
        <p className="mock-banner">
          Source and Capture are real and read-only · every control here is
          simulated and only changes the example · no control starts or stops
          capture · cues here are not AI-generated
        </p>
        <div className="mock-session-header">
          <div>
            <h2 ref={title} tabIndex={-1}>
              Fictional planning conversation
            </h2>
            <dl className="mock-facts">
              <div>
                <dt>Source</dt>
                <dd>
                  <span className="mock-tag">Real</span> {actual.source}
                </dd>
              </div>
              <div>
                <dt>Capture</dt>
                <dd>
                  <span className="mock-tag">Real</span> {actual.capture}
                  {actual.detail && (
                    <span className="mock-detail"> {actual.detail}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Example</dt>
                <dd>
                  <span className="mock-tag">Simulated</span> Fictional sample
                  conversation. {current.capture}
                </dd>
              </div>
            </dl>
          </div>
          {active && (
            <button
              className="secondary-button mock-stop"
              data-mock-focus="stop"
              onClick={() => go('stopped', 'start')}
            >
              Stop (simulated)
            </button>
          )}
        </div>
        <p role="status" className="mock-status">
          Preview state: {current.label}
          {cueShown && `. Example cue: ${citedNote.text}`}
          {withdrawn &&
            '. The example cue was withdrawn because the fictional note it quotes was removed.'}
        </p>

        <div className="mock-transport">
          {(state === 'idle' || state === 'stopped') && (
            <>
              <p>
                {state === 'idle'
                  ? 'No example session yet. This example captures nothing.'
                  : 'The simulated session has ended. This example captured and saved nothing.'}
              </p>
              <button
                className="secondary-button"
                data-mock-focus="start"
                onClick={() => go('starting', 'stop')}
              >
                {state === 'idle'
                  ? 'Start (simulated)'
                  : 'Start again (simulated)'}
              </button>
            </>
          )}
          {state === 'starting' && (
            <>
              <p>
                Simulated start. This example loads nothing and makes no
                connection. Stop cancels this start.
              </p>
              <button
                className="secondary-button"
                onClick={() => go('listening', 'pause')}
              >
                Finish start (simulated)
              </button>
            </>
          )}
          {state === 'failed' && (
            <>
              <p>
                Simulated failure: the fictional source did not start. This
                example captured nothing, and prior context is unchanged.
              </p>
              <button
                className="secondary-button"
                onClick={() => go('starting', 'stop')}
              >
                Retry (simulated)
              </button>
            </>
          )}
          {(state === 'listening' || state === 'cue') && (
            <button
              className="secondary-button"
              data-mock-focus="pause"
              onClick={() => go('paused', 'resume', state === 'cue')}
            >
              Pause (simulated)
            </button>
          )}
          {state === 'paused' && (
            <>
              <p>Simulated pause. This is not a capture control.</p>
              <button
                className="secondary-button"
                data-mock-focus="resume"
                onClick={() =>
                  go(cueKept ? 'cue' : 'listening', 'pause', cueKept)
                }
              >
                Resume (simulated)
              </button>
            </>
          )}
        </div>

        {inConversation && (
          <section aria-labelledby="mock-cue-area-title">
            <h3 id="mock-cue-area-title">Cue</h3>
            {cueShown ? (
              <div className="question mock-cue">
                <p className="mock-cue-text">{citedNote.text}</p>
                <p className="question-meta">
                  Example cue · written by hand, not generated by AI
                </p>
                <button
                  className="question-disclosure"
                  data-mock-focus="why"
                  aria-expanded={whyOpen}
                  aria-controls={whyId}
                  onClick={() => setWhyOpen(!whyOpen)}
                >
                  {whyOpen ? 'Hide sources (simulated)' : 'Why? (simulated)'}
                </button>
                <div id={whyId} hidden={!whyOpen} className="question-context">
                  <p>Prior notes are not from this conversation.</p>
                  <ul
                    className="evidence-sources"
                    aria-label="Example cue sources"
                    role="list"
                  >
                    <li>
                      <p className="source-title">{citedNote.title}</p>
                      <p className="source-label">
                        Fictional sample · {citedNote.date} · prior note
                      </p>
                      <blockquote className="evidence">
                        “{citedNote.text}”
                      </blockquote>
                    </li>
                    <li>
                      <p className="source-label">
                        This conversation · fictional line · Alex
                      </p>
                      <blockquote className="evidence">
                        “{spokenLine}”
                      </blockquote>
                    </li>
                  </ul>
                </div>
                <button
                  className="text-button"
                  onClick={() =>
                    state === 'paused'
                      ? go('paused', 'resume')
                      : go('listening', 'show-cue')
                  }
                >
                  Dismiss (simulated)
                </button>
              </div>
            ) : (
              <div className="mock-empty">
                <p>
                  {withdrawn
                    ? 'The example cue was withdrawn because the fictional note it quotes was removed.'
                    : 'No cue right now. One cue at a time appears here.'}
                </p>
                {state === 'listening' && cueAvailable && (
                  <button
                    className="secondary-button"
                    data-mock-focus="show-cue"
                    onClick={() => go('cue', 'why')}
                  >
                    Show example cue (simulated)
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {active && (
          <section aria-labelledby="mock-conversation-title">
            <h3 id="mock-conversation-title">Conversation</h3>
            {inConversation ? (
              <p>
                <span className="mock-speaker">Alex (fictional line)</span>{' '}
                {spokenLine}
              </p>
            ) : (
              <p className="mock-empty">
                No conversation text yet. This example adds a fictional line
                once the simulated start finishes.
              </p>
            )}
          </section>
        )}

        <section aria-labelledby="mock-context-title">
          <h3 id="mock-context-title">Prior context</h3>
          {notes.length ? (
            <ul className="mock-notes" role="list">
              {notes.map((note, index) => (
                <li key={note.id}>
                  <div>
                    <p className="mock-note-title">{note.title}</p>
                    <p className="mock-note-meta">
                      Fictional sample · {note.date} · not from this
                      conversation
                    </p>
                    <p>{note.text}</p>
                  </div>
                  <button
                    className="secondary-button"
                    data-mock-focus={`remove-${note.id}`}
                    aria-label={`Remove (simulated): ${note.title}`}
                    onClick={() => {
                      const next = notes[index + 1] ?? notes[index - 1];
                      setNoteIds(noteIds.filter((id) => id !== note.id));
                      if (note.id === citedNote.id && cueShown) {
                        if (state === 'cue') setState('listening');
                        setCueKept(false);
                        setWhyOpen(false);
                        setWithdrawn(true);
                      }
                      focusNext.current = next
                        ? `remove-${next.id}`
                        : 'restore';
                    }}
                  >
                    Remove (simulated)
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mock-empty">
              No prior notes selected. The example cue needs a fictional note to
              quote.
            </p>
          )}
          {notes.length < fictionalNotes.length && (
            <button
              className="secondary-button"
              data-mock-focus="restore"
              onClick={() => {
                setNoteIds(fictionalNotes.map(({ id }) => id));
                setWithdrawn(false);
                focusNext.current = `remove-${fictionalNotes[0].id}`;
              }}
            >
              Restore fictional notes (simulated)
            </button>
          )}
        </section>
      </div>
    </section>
  );
}
