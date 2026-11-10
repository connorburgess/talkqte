import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  CircleHelp,
  Crosshair,
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
  type GranolaStatus,
} from './lib/types';

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
import { Question } from './components/Question';
import { MicrophoneControl } from './components/MicrophoneControl';
import { ContextNotes } from './components/ContextNotes';
import { SetupCard, type SetupTarget } from './components/SetupCard';
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
  // The switch returns to the setting it left, so Quiet is not lost.
  const beforeFocused = useRef<'balanced' | 'quiet'>('balanced');
  return (
    <main className="floating-surface" aria-label="Meeting companion">
      <div className="companion-shell">
        {active ? (
          <>
            {/* The bar is the handle: the native window follows a drag on
                it or on its text, and remembers where it was put. */}
            <header className="companion-bar" data-tauri-drag-region>
              <div className="companion-status" data-tauri-drag-region>
                <strong className="companion-title" data-tauri-drag-region>
                  {mic?.status === 'listening' && (
                    <span
                      className={`status-dot ${mic.activity}`}
                      data-tauri-drag-region
                      role="img"
                      aria-label={
                        mic.activity === 'active'
                          ? 'Signal detected'
                          : 'Quiet input'
                      }
                    />
                  )}
                  {microphoneControl
                    ? 'Mic only'
                    : live
                      ? state.cuesPaused
                        ? 'Cues off'
                        : 'Live'
                      : 'TalkQTE'}
                </strong>
                <span role="status" data-tauri-drag-region>
                  {live
                    ? mic?.status === 'listening'
                      ? state.cuesPaused
                        ? 'Mic still on'
                        : 'Mic on · Local'
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
                <>
                  <button
                    className="companion-control"
                    aria-label={state.cuesPaused ? 'Resume cues' : 'Pause cues'}
                    title={
                      state.cuesPaused
                        ? 'Resume cues'
                        : 'Pause cues; microphone and transcript continue'
                    }
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        bridge.command('set_live_cues_paused', {
                          paused: !state.cuesPaused,
                        }),
                      )
                    }
                  >
                    {state.cuesPaused ? (
                      <Play size={16} />
                    ) : (
                      <Pause size={16} />
                    )}
                  </button>
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
                </>
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
              {state && state.status !== 'ended' && (
                <button
                  className="companion-control"
                  aria-label={
                    state.sensitivity === 'focused'
                      ? 'Show all questions'
                      : 'Show only what matters'
                  }
                  title={
                    state.sensitivity === 'focused'
                      ? 'Show all questions'
                      : 'Show only what matters'
                  }
                  aria-pressed={state.sensitivity === 'focused'}
                  disabled={busy}
                  onClick={() => {
                    if (state.sensitivity !== 'focused')
                      beforeFocused.current = state.sensitivity;
                    void run(() =>
                      bridge.command('set_sensitivity', {
                        value:
                          state.sensitivity === 'focused'
                            ? beforeFocused.current
                            : 'focused',
                      }),
                    );
                  }}
                >
                  <Crosshair size={16} />
                </button>
              )}
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
                onKeep={() =>
                  void run(() =>
                    bridge.command('keep_line', { id: state.cue!.id }),
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
  const [focus, setFocus] = useState('');
  // Granola's assistant can propose focus lines; offered only when the
  // connection exists and the server lists that tool.
  const [canSuggest, setCanSuggest] = useState(false);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const granolaChanged = (status: GranolaStatus) =>
    setCanSuggest(
      status.connected && status.tools.includes('query_granola_meetings'),
    );
  useEffect(() => {
    bridge
      .granolaStatus()
      .then(granolaChanged)
      .catch(() => setCanSuggest(false));
  }, []);
  const focusField = useRef<HTMLTextAreaElement>(null);
  // Clear is a mousedown before a click, so the blur that would save the old
  // text is skipped when it heads for Clear; the field keeps the focus.
  const clearButton = useRef<HTMLButtonElement>(null);
  const clearFocus = () => {
    setFocus('');
    setSuggestions(null);
    setTicked([]);
    void run(() => bridge.command('set_focus', { lines: [] }));
    setTimeout(() => focusField.current?.focus(), 0);
  };
  // The focus as it stood when a live session ended, so the box can say the
  // lines are left over from it until they change.
  const [endedFocus, setEndedFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!state) return;
    setEndedFocus(
      state.live && state.status === 'ended' ? state.focus.join('\n') : null,
    );
  }, [state?.live, state?.status]);
  const suggestionList = useRef<HTMLFieldSetElement>(null);
  const currentFocusLines = () =>
    focus
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  // The engine keeps five lines; the ticks are capped to what still fits.
  const roomForSuggestions = Math.max(0, 5 - currentFocusLines().length);
  const suggestFocus = () =>
    void run(async () => {
      const lines = await bridge.suggestGranolaFocus();
      setSuggestions(lines);
      setTicked([]);
      if (lines.length === 0) setNotice('Granola suggested nothing.');
      setTimeout(() => suggestionList.current?.focus(), 0);
    });
  const closeSuggestions = () => {
    setSuggestions(null);
    setTicked([]);
    setTimeout(() => focusField.current?.focus(), 0);
  };
  const acceptSuggestions = () =>
    void run(async () => {
      const lines = currentFocusLines();
      for (const line of ticked)
        if (!lines.some((seen) => seen.toLowerCase() === line.toLowerCase()))
          lines.push(line);
      await bridge.command('set_focus', { lines });
      setFocus(lines.join('\n'));
      closeSuggestions();
    });
  const initialized = useRef(false);
  // Enter followed by leaving a field saves once, not twice.
  const savingName = useRef(false);
  const savingFocus = useRef(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  // The setup card: put away for this app session with Not now, or gone
  // once the required steps are done.
  const [setupDismissed, setSetupDismissed] = useState(false);
  const pendingFocus = useRef<SetupTarget | null>(null);
  const goToSetup = (target: SetupTarget) => {
    if (target === 'focus') {
      // The card only shows in the notebook, so the focus box is already here.
      setTimeout(() => {
        focusField.current?.scrollIntoView({ block: 'center' });
        focusField.current?.focus();
      }, 0);
      return;
    }
    if (target === 'context') {
      // The card only shows in the notebook, so the panel is already here.
      setTab('notes');
      setTimeout(() => {
        const add = document.querySelector<HTMLElement>(
          '[aria-label="Prior context"] button',
        );
        add?.scrollIntoView({ block: 'center' });
        add?.focus();
      }, 0);
      return;
    }
    pendingFocus.current = target;
    setView('settings');
  };
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const element = document.getElementById(
      target === 'name' ? 'user-name' : 'live-transcription',
    );
    element?.scrollIntoView({ block: 'center' });
    element?.focus();
  }, [view, tab]);
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
  // The notes last sent to or published by the engine. The engine changes
  // notes on its own only by appending a kept line, so that is the only
  // change the editor takes from a snapshot; a snapshot that lags typing is
  // ignored, and nothing typed meanwhile is lost.
  const engineNotes = useRef('');
  useEffect(() => {
    if (!state || !initialized.current) return;
    if (state.notes === engineNotes.current) return;
    if (!state.notes.startsWith(engineNotes.current)) return;
    const added = state.notes.slice(engineNotes.current.length);
    if (!/^\n?\[\d{2}:\d{2}\] [^]*”\n$/.test(added)) return;
    engineNotes.current = state.notes;
    setNotes((current) =>
      current === state.notes
        ? current
        : current.length === 0 || current.endsWith('\n')
          ? current + added.replace(/^\n/, '')
          : `${current}\n${added.replace(/^\n/, '')}`,
    );
  }, [state]);
  useEffect(() => {
    if (state && !initialized.current) {
      initialized.current = true;
      engineNotes.current = state.notes;
      setNotes(state.notes);
      setUserName(state.userName ?? '');
      setFocus(state.focus.join('\n'));
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
  // Keeps a quoted line in the notes; the cue then goes like a dismissal.
  const keepLine = () => {
    if (!state.cue) return;
    void run(async () => {
      await bridge.command('keep_line', { id: state.cue!.id });
      setNotice('Line kept in your notes.');
      notesEditor.current?.focus();
    });
  };
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
  const saveFocus = () => {
    const lines = focus
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const current = state.focus;
    if (lines.join('\n') === current.join('\n')) {
      setFocus(current.join('\n'));
      return;
    }
    if (savingFocus.current) return;
    savingFocus.current = true;
    bridge
      .command('set_focus', { lines })
      // The typed text stays as it is either way: a rejected line is fixed
      // in place, and an edit made meanwhile is not overwritten.
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        savingFocus.current = false;
      });
  };
  const prepareExport = () =>
    void run(async () => {
      engineNotes.current = notes;
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
          {state &&
            !setupDismissed &&
            !active &&
            !(
              state.userName &&
              (!model || !['missing', 'downloading'].includes(model.status))
            ) && (
              <>
                <SetupCard
                  name={state.userName}
                  focus={state.focus}
                  model={model}
                  items={contextItems}
                  busy={busy}
                  onGoTo={goToSetup}
                  onDismiss={() => setSetupDismissed(true)}
                />
              </>
            )}
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

            <section
              className="session-strip"
              aria-label={
                state.live ? 'Live session controls' : 'Demo controls'
              }
            >
              <div className="session-state">
                <span className={`status-dot ${state.status}`} />
                <div>
                  <strong>
                    {state.live
                      ? live
                        ? state.cuesPaused
                          ? 'Cues paused · session continues'
                          : 'Live session in progress'
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
                      ? state.cuesPaused && live
                        ? 'Microphone and transcript continue. Stop live session to stop listening.'
                        : 'Your microphone · transcribed on this device · not saved'
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
                  <>
                    <button
                      className="secondary-button"
                      disabled={busy}
                      title={
                        state.cuesPaused
                          ? 'Only new speech can raise a cue after resuming.'
                          : 'Clear the current cue; microphone and transcript continue.'
                      }
                      onClick={() =>
                        void run(() =>
                          bridge.command('set_live_cues_paused', {
                            paused: !state.cuesPaused,
                          }),
                        )
                      }
                    >
                      {state.cuesPaused ? (
                        <Play size={15} />
                      ) : (
                        <Pause size={15} />
                      )}
                      {state.cuesPaused ? 'Resume cues' : 'Pause cues'}
                    </button>
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
                  </>
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

            <section
              className="meeting-focus"
              aria-labelledby="meeting-focus-title"
            >
              <div className="meeting-focus-heading">
                <div>
                  <h2 id="meeting-focus-title">This meeting</h2>
                  <p id="meeting-focus-help" className="small muted">
                    Up to five short lines on what you want to get to, such as
                    “agree the launch plan for the newsletter”. A question about
                    one of them comes through even in the pause after another;
                    when the meeting is wrapping up, the lines never touched are
                    listed once. Word matches, kept until you quit.
                  </p>
                </div>
                {focus.trim().length > 0 && (
                  <button
                    ref={clearButton}
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={clearFocus}
                  >
                    Clear
                  </button>
                )}
              </div>
              {endedFocus !== null &&
                endedFocus.length > 0 &&
                endedFocus === focus.trim() && (
                  <p className="small muted" role="status">
                    Kept from the session that just ended.
                  </p>
                )}
              <div className="setting-control">
                <label htmlFor="meeting-focus">
                  Focus <span className="muted small">· optional</span>
                </label>
                <textarea
                  id="meeting-focus"
                  ref={focusField}
                  aria-describedby="meeting-focus-help"
                  value={focus}
                  rows={3}
                  spellCheck={false}
                  onChange={(e) => setFocus(e.target.value)}
                  onBlur={(e) => {
                    if (e.relatedTarget !== clearButton.current) saveFocus();
                  }}
                />
                {canSuggest && suggestions === null && (
                  <div className="suggest-focus">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={suggestFocus}
                    >
                      Suggest from Granola
                    </button>
                    <p className="small muted">
                      Asks Granola’s assistant one question about your meetings
                      of the last 30 days and shows its answer for you to tick.
                      Granola sees the question; nothing else leaves this Mac.
                    </p>
                  </div>
                )}
                {suggestions !== null && (
                  <fieldset
                    className="suggest-focus"
                    ref={suggestionList}
                    tabIndex={-1}
                  >
                    <legend>
                      Granola suggests
                      {roomForSuggestions < suggestions.length && (
                        <span className="muted small">
                          {' '}
                          · room for {roomForSuggestions} more{' '}
                          {roomForSuggestions === 1 ? 'line' : 'lines'}
                        </span>
                      )}
                    </legend>
                    {suggestions.length === 0 && (
                      <p className="small muted">
                        Nothing came back. Type what matters instead.
                      </p>
                    )}
                    {suggestions.map((line) => (
                      <label key={line} className="suggest-line">
                        <input
                          type="checkbox"
                          checked={ticked.includes(line)}
                          disabled={
                            !ticked.includes(line) &&
                            ticked.length >= roomForSuggestions
                          }
                          onChange={(e) =>
                            setTicked((current) =>
                              e.target.checked
                                ? [...current, line]
                                : current.filter((seen) => seen !== line),
                            )
                          }
                        />
                        <span>{line}</span>
                      </label>
                    ))}
                    <div className="dialog-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={closeSuggestions}
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={busy || ticked.length === 0}
                        onClick={acceptSuggestions}
                      >
                        Add {ticked.length || ''} to the focus
                      </button>
                    </div>
                    <p className="small muted">
                      A suggestion is Granola’s reading of your notes, not a
                      fact; it becomes a focus line only when you add it, and
                      each needs a few specific words.
                    </p>
                  </fieldset>
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
                        engineNotes.current = value;
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
                    onKeep={keepLine}
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
                      {state.cuesPaused
                        ? 'Cues are paused.'
                        : state.status === 'ready'
                          ? 'Room for a good question.'
                          : state.status === 'ended'
                            ? 'Take the useful bits with you.'
                            : 'A little room to think.'}
                    </h3>
                    <p>
                      {state.cuesPaused
                        ? 'Resume cues when you want suggestions again. Speech from the pause will not become a new cue.'
                        : state.status === 'ready'
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
              onGranola={granolaChanged}
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
                  Place the question near your camera if that feels comfortable,
                  or drag the companion by its top bar to wherever suits you; it
                  stays there until you choose a position here. The desktop
                  companion follows the notebook’s display; move the notebook to
                  the display you want to use.
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
                {bridge.desktop && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        bridge.command('set_companion_position', {
                          value: state.companionPosition,
                        }),
                      )
                    }
                  >
                    Move back here
                  </button>
                )}
              </div>
            </section>
            <section className="setting">
              <div>
                <h2>Question timing</h2>
                <p>
                  Balanced leaves at least 10 seconds between questions. Quiet
                  leaves 30 seconds after a question passes. Focused shows only
                  questions about your focus lines (written in the notebook’s
                  This meeting box), questions asked of you by name, and
                  reminders of notes you chose; with no focus lines it shows
                  just the last two.
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
                <option value="focused">Focused · only what matters</option>
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
                A guided first-run setup that offers the speech model, both
                sides of a call rather than the microphone alone, and a notebook
                that remembers your sessions. Integrations with other
                note-takers are planned for later.
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
