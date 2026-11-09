import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  CircleHelp,
  FileText,
  Leaf,
  MessageCircle,
  Pause,
  Play,
  Search,
  Settings,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';
import * as bridge from './lib/bridge';
import {
  clockTime,
  type ContextItem,
  type CueSnapshot,
  type LiveStatus,
  type ModelStatus,
  type Snapshot,
} from './lib/types';

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
import { Question } from './components/Question';
import { MicrophoneControl } from './components/MicrophoneControl';
import { ContextNotes } from './components/ContextNotes';
import { microphoneLabel, useMicrophone } from './lib/microphone';

const floating = new URLSearchParams(location.search).get('window') === 'cue';

function useSession<T extends CueSnapshot>() {
  const [state, setState] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    bridge
      .connect<T>(floating, (incoming) => {
        if (!disposed)
          setState((previous) =>
            !previous || incoming.revision >= previous.revision
              ? incoming
              : previous,
          );
      })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else stop = unsubscribe;
      })
      .catch((e: unknown) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return { state, error, setError, busy, run };
}

function FloatingQuestion() {
  const { state, error, busy, run } = useSession<CueSnapshot>();
  const microphone = useMicrophone();
  const mic = microphone.state;
  const live = !!state?.live && state.status === 'running';
  const microphoneControl =
    !live && (microphone.active || (!mic && !!microphone.error));
  const active =
    state?.overlayEnabled &&
    (live ||
      microphoneControl ||
      state.cue ||
      ['running', 'paused'].includes(state.status));
  const paused = state?.status === 'paused';
  return (
    <main className="floating-surface" aria-label="Meeting companion">
      <div className="companion-shell">
        {active ? (
          <>
            <header className="companion-bar">
              <div className="companion-status">
                <strong className="companion-title">
                  {mic?.status === 'listening' && (
                    <span
                      className={`status-dot ${mic.activity}`}
                      role="img"
                      aria-label={
                        mic.activity === 'active'
                          ? 'Signal detected'
                          : 'Quiet input'
                      }
                    />
                  )}
                  {microphoneControl ? 'Mic only' : live ? 'Live' : 'TalkQTE'}
                </strong>
                <span role="status">
                  {live
                    ? mic?.status === 'listening'
                      ? 'Listening · On this device'
                      : microphoneLabel(mic)
                    : microphoneControl
                      ? microphone.stopPending && mic?.status !== 'stopping'
                        ? 'Stop requested…'
                        : !mic
                          ? 'Status unavailable'
                          : microphoneLabel(mic)
                      : paused
                        ? 'Demo paused · Scripted'
                        : state.status === 'ended'
                          ? state.live
                            ? 'Live session ended'
                            : 'Demo ended · Question kept'
                          : 'Demo running · Scripted'}
                </span>
              </div>
              {live ? (
                <button
                  className="companion-control"
                  aria-label="Stop live session"
                  title="Stop live session"
                  disabled={busy}
                  onClick={() =>
                    void run(() => bridge.command('stop_live_session'))
                  }
                >
                  <span>Stop</span>
                </button>
              ) : microphoneControl ? (
                <button
                  className="companion-control"
                  aria-label="Stop microphone"
                  title="Stop microphone"
                  disabled={
                    microphone.busy ||
                    mic?.status === 'stopping' ||
                    (mic?.status === 'error' && !mic.canStart)
                  }
                  onClick={() => void microphone.stop()}
                >
                  Stop mic
                </button>
              ) : state.status !== 'ended' ? (
                <button
                  className="companion-control"
                  aria-label={paused ? 'Resume demo' : 'Pause demo'}
                  title={paused ? 'Resume demo' : 'Pause demo'}
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      bridge.command(paused ? 'resume_demo' : 'pause_demo'),
                    )
                  }
                >
                  <span>{paused ? 'Resume' : 'Pause'}</span>
                </button>
              ) : null}
              <button
                className="companion-control"
                aria-label="Hide companion"
                title="Hide companion"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    bridge.command('set_overlay', { enabled: false }),
                  )
                }
              >
                <span>Hide</span>
              </button>
            </header>
            {state?.cue && (
              <Question
                key={state.cue.id}
                cue={state.cue}
                size={state.questionSize}
                live={state.live}
                announce={false}
                busy={busy}
                onInspect={(expanded) =>
                  void run(() =>
                    bridge.command('inspect_cue', {
                      id: state.cue!.id,
                      expanded,
                    }),
                  )
                }
                onDismiss={() =>
                  void run(() =>
                    bridge.command('respond_to_cue', {
                      id: state.cue!.id,
                      response: 'dismiss',
                    }),
                  )
                }
              />
            )}
          </>
        ) : (
          <p className="floating-empty">
            {state?.overlayEnabled === false
              ? 'Companion hidden. Show it again in Settings.'
              : 'Start the demo or microphone from your notebook.'}
          </p>
        )}
        {(error || microphone.error) && (
          <p role="alert" className="floating-error">
            {error || microphone.error}
          </p>
        )}
      </div>
    </main>
  );
}

function Notebook() {
  const { state, error, setError, busy, run } = useSession<Snapshot>();
  const microphone = useMicrophone();
  const [view, setView] = useState<'notebook' | 'settings'>('notebook');
  // Set when a link opens Settings at the live transcription section.
  const [focusLiveSetup, setFocusLiveSetup] = useState(false);
  useEffect(() => {
    if (view !== 'settings' || !focusLiveSetup) return;
    const heading = document.getElementById('live-transcription');
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus();
    setFocusLiveSetup(false);
  }, [view, focusLiveSetup]);
  const [tab, setTab] = useState<'notes' | 'transcript'>('notes');
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState('');
  const [userName, setUserName] = useState('');
  const [goal, setGoal] = useState('');
  const initialized = useRef(false);
  // Enter followed by leaving a field saves once, not twice.
  const savingName = useRef(false);
  const savingGoal = useRef(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    bridge
      .watchContext((items) => {
        if (!disposed) setContextItems(Array.isArray(items) ? items : []);
      })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else stop = unsubscribe;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const modal = useRef<HTMLDialogElement>(null);
  const exportButton = useRef<HTMLButtonElement>(null);
  const notesEditor = useRef<HTMLTextAreaElement>(null);
  const transcriptTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state && !initialized.current) {
      initialized.current = true;
      setNotes(state.notes);
      setUserName(state.userName ?? '');
      setGoal(state.goal ?? '');
    }
  }, [state]);
  const modelState = model?.status;
  useEffect(() => {
    // Rechecked whenever the model is installed or removed.
    bridge
      .liveStatus()
      .then(setLiveStatus)
      .catch(() =>
        setLiveStatus({
          available: false,
          reason: 'Live transcription status is unavailable.',
        }),
      );
  }, [modelState]);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    bridge
      .watchModel((incoming) => {
        if (!disposed)
          setModel((previous) =>
            !previous || incoming.revision >= previous.revision
              ? incoming
              : previous,
          );
      })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else stop = unsubscribe;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (preview !== null) modal.current?.showModal();
    else if (modal.current?.open) {
      modal.current.close();
      exportButton.current?.focus();
    }
  }, [preview]);

  if (!state)
    return (
      <main className="loading">
        <img src="/mark.svg" width="44" height="44" alt="" />
        <h1>TalkQTE</h1>
        <p role={error ? 'alert' : 'status'}>
          {error || 'Opening your notebook…'}
        </p>
        {error && <button onClick={() => location.reload()}>Try again</button>}
      </main>
    );
  const active = state.status === 'running' || state.status === 'paused';
  const live = state.live && state.status === 'running';
  const matches = `${state.title} ${state.description} demo`
    .toLowerCase()
    .includes(search.toLowerCase().trim());
  const dismiss = () => {
    if (!state.cue) return;
    const actionFocus = document.activeElement;
    void run(async () => {
      await bridge.command('respond_to_cue', {
        id: state.cue!.id,
        response: 'dismiss',
      });
      setNotice('Question dismissed.');
      // Only this notebook's explicit dismissal restores focus. Passive expiry
      // and companion events must not move it, nor a reply after the user has
      // already moved to another control or application.
      if (
        document.hasFocus() &&
        (document.activeElement === actionFocus ||
          document.activeElement === document.body)
      ) {
        (notesEditor.current ?? transcriptTab.current)?.focus();
      }
    });
  };
  // Saving the name leaves other controls enabled and focus where it is. A
  // rejected name puts the field back to the name in effect.
  const saveName = () => {
    const next = userName.trim();
    const current = state.userName ?? '';
    if (next === current) {
      setUserName(current);
      return;
    }
    if (savingName.current) return;
    savingName.current = true;
    bridge
      .command('set_user_name', { name: next || null })
      .then(() => setUserName(next))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setUserName(current);
      })
      .finally(() => {
        savingName.current = false;
      });
  };
  const saveGoal = () => {
    const next = goal.trim();
    const current = state.goal ?? '';
    if (next === current) {
      setGoal(current);
      return;
    }
    if (savingGoal.current) return;
    savingGoal.current = true;
    bridge
      .command('set_goal', { goal: next || null })
      .then(() => setGoal(next))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setGoal(current);
      })
      .finally(() => {
        savingGoal.current = false;
      });
  };
  const prepareExport = () =>
    void run(async () => {
      await bridge.command('update_notes', { notes });
      setPreview(await bridge.exportPreview());
    });

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#notebook"
          onClick={(e) => {
            e.preventDefault();
            setView('notebook');
          }}
        >
          <img src="/mark.svg" alt="" />
          TalkQTE
        </a>
        <nav aria-label="Main navigation">
          <button
            className={view === 'notebook' ? 'nav-item selected' : 'nav-item'}
            aria-current={view === 'notebook' ? 'page' : undefined}
            onClick={() => setView('notebook')}
          >
            <BookOpen size={19} />
            Notebook
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <ShieldCheck size={20} />
            <p>
              A space to think.
              <br />
              <span>Microphone starts only when you choose.</span>
            </p>
          </div>
          <button
            className={view === 'settings' ? 'nav-item selected' : 'nav-item'}
            aria-current={view === 'settings' ? 'page' : undefined}
            onClick={() => setView('settings')}
          >
            <Settings size={19} />
            Settings
          </button>
          <div className="version">
            TalkQTE <span>Prototype 0.1</span>
          </div>
        </div>
      </aside>

      {view === 'notebook' && (
        <aside className="meeting-list" aria-label="Meeting list">
          <div className="list-heading">
            <h1>Notebook</h1>
            <span>1</span>
          </div>
          <label className="search">
            <Search size={17} />
            <input
              aria-label="Search meetings"
              placeholder="Search meetings"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                className="icon-button"
                aria-label="Clear search"
                onClick={() => setSearch('')}
              >
                <X size={15} />
              </button>
            )}
          </label>
          <p className="list-label">Start here</p>
          {matches ? (
            <button
              className="meeting selected-meeting"
              aria-current="true"
              onClick={() => {
                setTab('notes');
              }}
            >
              <div className="meeting-line">
                <span className="demo-tag">
                  {state.live ? 'Live session' : 'Demo meeting'}
                </span>
                <ChevronRight size={15} />
              </div>
              <strong>{state.title}</strong>
              {state.live ? (
                <p>Your microphone, transcribed on this device</p>
              ) : (
                <>
                  <p>A welcome guide for the garden</p>
                  <span className="meeting-meta">
                    Robin & Alex <span>1m 44s</span>
                  </span>
                </>
              )}
            </button>
          ) : (
            <div className="search-empty">
              <Search size={22} />
              <p>No matching meetings.</p>
              <button className="text-button" onClick={() => setSearch('')}>
                Clear search
              </button>
            </div>
          )}
          <div className="list-foot">
            <Leaf size={18} />
            <p>
              Try a conversation.
              <br />
              Get a feel for the timing.
            </p>
          </div>
        </aside>
      )}

      <main
        className={`workspace ${view !== 'notebook' ? 'wide-workspace' : ''}`}
      >
        <header className="toolbar">
          <div className="breadcrumb">
            <BookOpen size={16} />
            <span>{view === 'notebook' ? 'Notebook' : 'Settings'}</span>
            {view === 'notebook' && (
              <>
                <ChevronRight size={14} />
                <span>Demo</span>
              </>
            )}
          </div>
          <span className="prototype-label">
            {bridge.desktop ? 'Desktop prototype' : 'Browser preview'}
          </span>
        </header>
        <MicrophoneControl microphone={microphone} live={live} />
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError('')}
            >
              <X size={17} />
            </button>
          </div>
        )}

        {view === 'notebook' && (
          <div className="notebook-body">
            <div className="meeting-header">
              <div>
                <div className="meeting-icon">
                  <Leaf size={27} />
                </div>
                <h1>{state.title}</h1>
                <p>{state.description}</p>
                {state.live ? (
                  <div className="participants">
                    <span>Your microphone</span>
                    <span className="meta-divider" />
                    <span>Not saved</span>
                  </div>
                ) : (
                  <div className="participants">
                    <span className="avatar">R</span>
                    <span className="avatar second">A</span>
                    <span>Robin & Alex</span>
                    <span className="meta-divider" />
                    <span>Fictional demo</span>
                  </div>
                )}
              </div>
              <button
                ref={exportButton}
                className="secondary-button export-button"
                onClick={prepareExport}
                disabled={busy || live}
                title={
                  state.live
                    ? 'Live sessions are not saved or exported.'
                    : undefined
                }
              >
                <ArrowUpRight size={16} />
                Export
              </button>
            </div>

            <section className="session-strip" aria-label="Demo controls">
              <div className="session-state">
                <span className={`status-dot ${state.status}`} />
                <div>
                  <strong>
                    {state.live
                      ? live
                        ? 'Live session in progress'
                        : 'Live session ended'
                      : state.status === 'running'
                        ? 'Demo in progress'
                        : state.status === 'paused'
                          ? 'Demo paused'
                          : state.status === 'ended'
                            ? 'Demo finished'
                            : 'Ready when you are'}
                  </strong>
                  <span>
                    {state.live
                      ? 'Your microphone · transcribed on this device · not saved'
                      : 'Scripted conversation · separate from microphone'}
                  </span>
                </div>
              </div>
              <div className="session-actions">
                <span className="session-clock">
                  {clockTime(state.elapsedMs)}
                  {!state.live && <span> / {clockTime(state.durationMs)}</span>}
                </span>
                {live ? (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => bridge.command('stop_live_session'))
                    }
                  >
                    <Square size={14} />
                    Stop live session
                  </button>
                ) : active ? (
                  <>
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          bridge.command(
                            state.status === 'paused'
                              ? 'resume_demo'
                              : 'pause_demo',
                          ),
                        )
                      }
                    >
                      {state.status === 'paused' ? (
                        <Play size={15} />
                      ) : (
                        <Pause size={15} />
                      )}
                      {state.status === 'paused' ? 'Resume' : 'Pause'}
                    </button>
                    <button
                      className="icon-button end-button"
                      title="End demo"
                      aria-label="End demo"
                      disabled={busy}
                      onClick={() => void run(() => bridge.command('end_demo'))}
                    >
                      <Square size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    {liveStatus?.available && (
                      <button
                        className="secondary-button"
                        disabled={busy || microphone.active}
                        title={
                          microphone.active
                            ? 'Stop the microphone check first.'
                            : undefined
                        }
                        onClick={() =>
                          void run(() => {
                            setNotice('');
                            return bridge.command('start_live_session');
                          })
                        }
                      >
                        Start live session
                      </button>
                    )}
                    {!liveStatus?.available &&
                      (model?.status === 'missing' ||
                        model?.status === 'downloading') && (
                        <button
                          className="text-button"
                          onClick={() => {
                            setFocusLiveSetup(true);
                            setView('settings');
                          }}
                        >
                          {model.status === 'downloading'
                            ? 'View download progress'
                            : 'Set up live session'}
                        </button>
                      )}
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() =>
                        void run(() => {
                          setNotice('');
                          return bridge.command('start_demo');
                        })
                      }
                    >
                      <Play size={15} />
                      {state.status === 'ended' && !state.live
                        ? 'Replay demo'
                        : 'Try demo'}
                    </button>
                  </>
                )}
              </div>
            </section>

            <div className="notebook-grid">
              <section className="editor-section">
                <div
                  className="tabs"
                  role="tablist"
                  aria-label="Meeting content"
                >
                  <button
                    role="tab"
                    aria-selected={tab === 'notes'}
                    aria-controls="notes-panel"
                    id="notes-tab"
                    tabIndex={tab === 'notes' ? 0 : -1}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                        e.preventDefault();
                        setTab('transcript');
                        document.getElementById('transcript-tab')?.focus();
                      }
                    }}
                    onClick={() => setTab('notes')}
                  >
                    <FileText size={16} />
                    Notes
                  </button>
                  <button
                    ref={transcriptTab}
                    role="tab"
                    aria-selected={tab === 'transcript'}
                    aria-controls="transcript-panel"
                    id="transcript-tab"
                    tabIndex={tab === 'transcript' ? 0 : -1}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                        e.preventDefault();
                        setTab('notes');
                        document.getElementById('notes-tab')?.focus();
                      }
                    }}
                    onClick={() => setTab('transcript')}
                  >
                    <MessageCircle size={16} />
                    Transcript <span>{state.transcript.length}</span>
                  </button>
                </div>
                {tab === 'notes' ? (
                  <div
                    id="notes-panel"
                    role="tabpanel"
                    aria-labelledby="notes-tab"
                  >
                    <div className="note-intro">
                      <h2>Leave with a little more clarity.</h2>
                      <p>Jot down what matters, if you need to.</p>
                    </div>
                    <label className="visually-hidden" htmlFor="meeting-notes">
                      Meeting notes
                    </label>
                    <textarea
                      ref={notesEditor}
                      id="meeting-notes"
                      className="note-editor"
                      placeholder="What would you like to remember?"
                      value={notes}
                      maxLength={20_000}
                      onChange={(e) => {
                        const value = e.target.value;
                        setNotes(value);
                        void bridge
                          .command('update_notes', { notes: value })
                          .catch((e: unknown) => setError(String(e)));
                      }}
                    />
                    <div className="editor-footer">
                      <span>Kept in memory for this session</span>
                      <span>{notes.length.toLocaleString()} / 20,000</span>
                    </div>
                  </div>
                ) : (
                  <div
                    id="transcript-panel"
                    role="tabpanel"
                    aria-labelledby="transcript-tab"
                    className="transcript"
                  >
                    <p className="muted small">
                      {state.live
                        ? 'Your microphone · transcribed on this device'
                        : 'Scripted conversation · not from microphone audio'}
                    </p>
                    {state.transcript.length ? (
                      state.transcript.map((segment) => (
                        <article
                          className="transcript-segment"
                          key={segment.id}
                        >
                          <div>
                            <strong>{segment.speaker}</strong>
                            <time>{clockTime(segment.atMs)}</time>
                          </div>
                          <p>{segment.text}</p>
                        </article>
                      ))
                    ) : (
                      <div className="empty-inline">
                        <MessageCircle size={25} />
                        <h2>A conversation starts here.</h2>
                        <p>
                          {state.live
                            ? 'Lines from your microphone appear here a few seconds after they are spoken.'
                            : 'Try the demo to watch the fictional transcript arrive.'}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </section>

              <aside className="companion" aria-label="Question companion">
                <div className="companion-heading">
                  <h2>A timely question</h2>
                  <CircleHelp size={16} aria-hidden="true" />
                </div>
                {state.cue ? (
                  <Question
                    key={state.cue.id}
                    cue={state.cue}
                    size={state.questionSize}
                    live={state.live}
                    busy={busy}
                    onDismiss={dismiss}
                    onInspect={(expanded) =>
                      void run(() =>
                        bridge.command('inspect_cue', {
                          id: state.cue!.id,
                          expanded,
                        }),
                      )
                    }
                  />
                ) : (
                  <div className="question-idle">
                    <div className="idle-mark">
                      <MessageCircle size={28} />
                    </div>
                    <h3>
                      {state.status === 'ready'
                        ? 'Room for a good question.'
                        : state.status === 'ended'
                          ? 'Take the useful bits with you.'
                          : 'A little room to think.'}
                    </h3>
                    <p>
                      {state.status === 'ready'
                        ? 'When something could use a little clarity, a question will appear here.'
                        : state.status === 'ended'
                          ? state.live
                            ? 'Your notes stay here until you close the app.'
                            : 'Your notes are still here. Export them before closing the app.'
                          : 'Questions pass quietly. You can keep listening without responding.'}
                    </p>
                    {state.status === 'ready' && (
                      <div className="cue-example">
                        <span>For example</span>
                        <p>“Who will take the first draft?”</p>
                      </div>
                    )}
                  </div>
                )}
                <p className="companion-footnote">
                  {state.live
                    ? 'Suggestions use simple phrase rules on what was transcribed. Use a cue in the conversation or let it pass.'
                    : 'Suggestions in this demo use simple phrase rules. Use a cue in the conversation or let it pass.'}
                </p>
                <button
                  className="text-button companion-settings"
                  onClick={() => setView('settings')}
                >
                  <Settings size={14} />
                  Question appearance & timing
                </button>
              </aside>
            </div>
            <ContextNotes
              items={contextItems}
              busy={busy}
              onError={setError}
              onNotice={setNotice}
            />
            <footer className="notebook-footer">
              <ShieldCheck size={15} />
              <p>
                {state.live
                  ? 'This live session stays in memory and is never saved or exported.'
                  : 'This demo stays in memory. Export anything you want to keep before closing.'}
              </p>
            </footer>
          </div>
        )}

        {view === 'settings' && (
          <div className="secondary-page settings-page">
            <h1>Make room for your conversation.</h1>
            <p className="page-description">
              A few controls to keep questions on your terms.
            </p>
            <section className="setting">
              <div>
                <h2>Your name</h2>
                <p id="user-name-help">
                  In a live session, when someone asks you something by name,
                  such as “Sam, can you take the draft?”, the question is shown
                  as Asked you and stays while you answer. Questions for other
                  people stay quiet. Your name is kept only until you close the
                  app.
                </p>
              </div>
              <div className="setting-control">
                <label htmlFor="user-name">Name</label>
                <input
                  id="user-name"
                  aria-describedby="user-name-help"
                  type="text"
                  value={userName}
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setUserName(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName();
                  }}
                />
              </div>
            </section>
            <section className="setting">
              <div>
                <h2>Meeting goal</h2>
                <p id="meeting-goal-help">
                  One line on what you want from this meeting, such as “agree
                  the launch plan for the newsletter”. When a line in the
                  conversation uses its words, a question about it comes through
                  even during the pause after another question, with either
                  timing setting, and stays 45 seconds, the length of a question
                  asked of you by name. It is a word match, not understanding,
                  and is kept only until you close the app.
                </p>
              </div>
              <div className="setting-control">
                <label htmlFor="meeting-goal">Goal</label>
                <input
                  id="meeting-goal"
                  aria-describedby="meeting-goal-help"
                  type="text"
                  value={goal}
                  maxLength={80}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setGoal(e.target.value)}
                  onBlur={saveGoal}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveGoal();
                  }}
                />
              </div>
            </section>
            <section className="setting">
              <div>
                <h2>Glance view</h2>
                <p>
                  One complete question, with context tucked away. Open “Why?”
                  to see the source and keep the question until you dismiss it.
                </p>
                <p
                  className={`appearance-example question-${state.questionSize}`}
                >
                  Who will take the first draft?
                </p>
              </div>
              <div className="setting-control">
                <label htmlFor="question-size">Question text</label>
                <select
                  id="question-size"
                  value={state.questionSize}
                  disabled={busy}
                  onChange={(e) =>
                    void run(() =>
                      bridge.command('set_question_size', {
                        value: e.target.value as Snapshot['questionSize'],
                      }),
                    )
                  }
                >
                  <option value="standard">Standard</option>
                  <option value="large">Larger</option>
                </select>
              </div>
            </section>
            <section className="setting">
              <div>
                <h2>Companion position</h2>
                <p>
                  Place the question near your camera if that feels comfortable.
                  The desktop companion follows the notebook’s display; move the
                  notebook to the display you want to use.
                </p>
                <p className="small">
                  No camera access or video changes. Appearance choices last
                  until you quit.
                  {!bridge.desktop && ' Position applies in the desktop app.'}
                </p>
              </div>
              <div className="setting-control">
                <label htmlFor="companion-position">Position</label>
                <select
                  id="companion-position"
                  value={state.companionPosition}
                  disabled={busy}
                  onChange={(e) =>
                    void run(() =>
                      bridge.command('set_companion_position', {
                        value: e.target.value as Snapshot['companionPosition'],
                      }),
                    )
                  }
                >
                  <option value="bottomRight">Bottom right</option>
                  <option value="topCenter">Top center · near camera</option>
                  <option value="topLeft">Top left</option>
                  <option value="topRight">Top right</option>
                </select>
              </div>
            </section>
            <section className="setting">
              <div>
                <h2>Question timing</h2>
                <p>
                  Balanced leaves at least 10 seconds between questions. Quiet
                  leaves 30 seconds after a question passes.
                </p>
              </div>
              <label className="visually-hidden" htmlFor="sensitivity">
                Question timing
              </label>
              <select
                id="sensitivity"
                value={state.sensitivity}
                onChange={(e) =>
                  void run(() =>
                    bridge.command('set_sensitivity', {
                      value: e.target.value as Snapshot['sensitivity'],
                    }),
                  )
                }
              >
                <option value="balanced">Balanced</option>
                <option value="quiet">Quiet</option>
              </select>
            </section>
            <section className="setting">
              <div>
                <h2>Floating question window</h2>
                <p>
                  {bridge.desktop
                    ? 'Keep a small companion in your chosen position during the demo or microphone check. Stop microphone controls take priority while it is on. Hide only hides the window; it does not stop the microphone. For keyboard controls, use the question in your notebook.'
                    : 'Available in the desktop app. The browser preview shows questions inside the notebook.'}
                </p>
                <p className="small">
                  The window may be visible when you share your screen.
                </p>
              </div>
              <input
                type="checkbox"
                role="switch"
                aria-label="Floating question window"
                checked={state.overlayEnabled}
                disabled={!bridge.desktop || busy}
                onChange={(e) =>
                  void run(() =>
                    bridge.command('set_overlay', {
                      enabled: e.target.checked,
                    }),
                  )
                }
              />
            </section>
            <section className="setting">
              <div>
                <h2 id="live-transcription" tabIndex={-1}>
                  Live transcription
                </h2>
                <p>
                  Start live session in the notebook to get questions from what
                  your microphone hears. A speech model transcribes on this
                  device. Audio is not recorded, and other apps’ audio is not
                  captured. The transcript stays in memory until you start
                  another session or close the app; it is never saved, exported,
                  or sent.
                </p>
                <p className="small muted" role="status">
                  {!liveStatus
                    ? 'Checking…'
                    : liveStatus.available
                      ? 'Ready on this device.'
                      : liveStatus.reason}
                </p>
                {model &&
                  ['missing', 'downloading', 'installed'].includes(
                    model.status,
                  ) && (
                    <div className="model-download">
                      <h3>Speech model</h3>
                      <p>
                        {model.status === 'installed'
                          ? `${model.name} is installed on this device (${megabytes(model.sizeBytes)}).`
                          : `Download ${model.name} (${megabytes(model.sizeBytes)}) over HTTPS from the whisper.cpp repository on Hugging Face (MIT license). It needs about ${megabytes(model.neededBytes)} free. Hugging Face and its download network see your IP address and a file request from TalkQTE; no account, audio, transcript, or notes are sent. The file is checked against a pinned checksum before use.`}
                      </p>
                      {model.status === 'downloading' && (
                        <progress
                          aria-label="Model download"
                          value={model.received}
                          max={model.sizeBytes}
                        />
                      )}
                      {model.message && (
                        <p className="microphone-message" role="alert">
                          {model.message}
                        </p>
                      )}
                      {model.status === 'missing' && (
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() =>
                            void run(() => bridge.command('download_model'))
                          }
                        >
                          Download speech model
                        </button>
                      )}
                      {model.status === 'downloading' && (
                        <button
                          className="secondary-button"
                          onClick={() =>
                            void run(() =>
                              bridge.command('cancel_model_download'),
                            )
                          }
                        >
                          Cancel download
                        </button>
                      )}
                      {model.status === 'installed' && (
                        <button
                          className="secondary-button"
                          disabled={busy || live}
                          onClick={() =>
                            void run(() => bridge.command('remove_model'))
                          }
                        >
                          Remove model
                        </button>
                      )}
                    </div>
                  )}
              </div>
            </section>
            <section className="setting">
              <div>
                <h2>Your data in this prototype</h2>
                <p>
                  The optional microphone check retains no audio and does not
                  transcribe. A live session’s transcript is kept in memory only
                  and cannot be exported. Notes exist in memory until you close
                  the app. Exports contain exactly the text you review and are
                  saved to the location you choose.
                </p>
              </div>
              <ShieldCheck size={24} />
            </section>
            <section className="coming-next">
              <h2>What comes next</h2>
              <p>
                Downloading the speech model during setup, full meeting audio,
                and a notebook that remembers your sessions. Integrations with
                other note-takers are planned for later.
              </p>
              <p className="small muted">
                These features are not available in this prototype.
              </p>
            </section>
          </div>
        )}
        <div className="visually-hidden" role="status">
          {notice}
        </div>
      </main>
      <dialog
        ref={modal}
        className="export-dialog"
        onCancel={() => setPreview(null)}
        aria-labelledby="export-title"
      >
        <div className="dialog-heading">
          <h2 id="export-title">Review your export</h2>
          <button
            className="icon-button"
            aria-label="Close export preview"
            onClick={() => setPreview(null)}
          >
            <X size={20} />
          </button>
        </div>
        <p>
          This is the exact text that will be saved as Markdown. Review it
          before choosing a destination.
        </p>
        <pre>{preview}</pre>
        {error && (
          <p role="alert" className="export-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="secondary-button" onClick={() => setPreview(null)}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (await bridge.exportMarkdown()) {
                  setPreview(null);
                  setNotice('Export saved.');
                }
              })
            }
          >
            <ArrowDownToLine size={16} />
            {bridge.desktop ? 'Choose destination' : 'Download Markdown'}
          </button>
        </div>
      </dialog>
    </div>
  );
}

export default function App() {
  return floating ? <FloatingQuestion /> : <Notebook />;
}
