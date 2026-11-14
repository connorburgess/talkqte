import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  CircleHelp,
  Crosshair,
  FileText,
  MessageCircle,
  Pause,
  Play,
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
import { CueCard } from './components/Question';
import { ProcessingControl } from './components/ProcessingControl';
import { MicrophoneControl } from './components/MicrophoneControl';
import { ContextNotes } from './components/ContextNotes';
import { SetupCard, type SetupTarget } from './components/SetupCard';
import {
  PanelDivider,
  boundWidth,
  useElementWidth,
} from './components/PanelDivider';
import { microphoneLabel, useMicrophone } from './lib/microphone';
import { useCaptureControl } from './lib/useCaptureControl';
import {
  microphoneNotCapturing,
  sourceOnlyApplication,
} from './lib/processing';

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
  // Browser preview and tests only: a replay of a fictional conversation.
  const simulated = !!state?.simulated && state.status === 'running';
  const microphoneControl =
    !live && (microphone.active || (!mic && !!microphone.error));
  const active =
    state?.overlayEnabled && (live || microphoneControl || simulated);
  // The switch returns to the setting it left, so Quiet is not lost.
  const beforeFocused = useRef<'balanced' | 'quiet'>('balanced');
  // A dismissal made here removes the focused control. Once the companion's
  // other controls are enabled again, focus goes to the first of them, but
  // only if it was dropped; never from another control or application.
  const dismissed = useRef(false);
  const cueId = state?.cue?.id;
  useEffect(() => {
    if (!dismissed.current || busy) return;
    dismissed.current = false;
    if (
      !cueId &&
      document.hasFocus() &&
      document.activeElement === document.body
    )
      document
        .querySelector<HTMLElement>('.companion-bar button:not(:disabled)')
        ?.focus();
  }, [busy, cueId]);
  return (
    <main className="floating-surface" aria-label="Meeting companion">
      <div className="companion-shell">
        {active ? (
          <>
            {/* The bar is the handle: the native window follows a drag on
                it or on its text, and remembers where it was put. */}
            <header
              className={`companion-bar${live ? ' companion-bar-live' : ''}`}
              data-tauri-drag-region
            >
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
                      : state.sourceSession
                        ? state.cuesPaused
                          ? 'App audio still on'
                          : 'App audio · Local'
                        : microphoneLabel(mic)
                    : microphoneControl
                      ? microphone.stopPending && mic?.status !== 'stopping'
                        ? 'Stop requested…'
                        : !mic
                          ? 'Status unavailable'
                          : microphoneLabel(mic)
                      : 'Simulated session · Fictional'}
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
                        : state.sourceSession && mic?.status !== 'listening'
                          ? 'Pause cues; application audio and transcript continue'
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
            {state && (
              <CueCard
                cue={state.cue}
                size={state.questionSize}
                live={state.live || !!state.simulated}
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
                onDismiss={() => {
                  dismissed.current = true;
                  void run(() =>
                    bridge.command('respond_to_cue', {
                      id: state.cue!.id,
                      response: 'dismiss',
                    }),
                  );
                }}
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
              : 'Start a live session or the microphone check in your notebook.'}
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
  const [measureShell, shellWidth] = useElementWidth();
  const [measureGrid, gridWidth] = useElementWidth();
  // Layout preferences belong to this mounted notebook only, never meeting data.
  const [preferredListWidth, setPreferredListWidth] = useState<number | null>(
    null,
  );
  const [notesRatio, setNotesRatio] = useState(1 / 1.95);
  const listResizable = shellWidth >= 1000;
  const listDefault = shellWidth > 1200 ? 248 : shellWidth > 1150 ? 220 : 205;
  const listMax = Math.max(200, Math.min(400, shellWidth - 480));
  const listWidth = boundWidth(preferredListWidth ?? listDefault, 200, listMax);
  const splitContent = shellWidth > 760 && gridWidth >= 600;
  const notesMax = Math.max(260, gridWidth - 28 - 290);
  const notesWidth = boundWidth((gridWidth - 28) * notesRatio, 260, notesMax);
  const resizeNotes = (value: number) =>
    setNotesRatio(value / (gridWidth - 28));
  const { state, error, setError, busy, run } = useSession<Snapshot>();
  const microphone = useMicrophone();
  const capture = useCaptureControl();
  // A session fed by a selected application alone, with the microphone off
  // (development builds only); null otherwise.
  const sourceApp = sourceOnlyApplication(capture.state, microphone.state);
  const [startPending, setStartPending] = useState(false);
  const [startInstalled, setStartInstalled] = useState(false);
  useEffect(() => {
    if (startPending && state?.live && state.status === 'running')
      setStartInstalled(true);
  }, [startPending, state?.live, state?.status]);
  const startButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  const restoreStartFocus = useRef(false);
  const focusCancel = useRef(false);
  const rememberCancel = useCallback((node: HTMLButtonElement | null) => {
    if (!node && cancelButton.current === document.activeElement)
      restoreStartFocus.current = true;
    cancelButton.current = node;
  }, []);
  const preparing =
    capture.state?.startup === 'loading' ||
    capture.state?.startup === 'cancelling' ||
    (startPending && !startInstalled);
  const cancelling = capture.state?.startup === 'cancelling';
  const finishing = capture.state?.phase === 'stopping';
  const startLive = () => {
    focusCancel.current = document.activeElement === startButton.current;
    capture.clearError();
    setStartInstalled(false);
    setStartPending(true);
    void run(async () => {
      setNotice('');
      try {
        await bridge.command('start_live_session');
      } catch (e) {
        // Native cancellation is an expected result, not a startup failure.
        if (
          (e instanceof Error ? e.message : String(e)) !==
          'Live session start was cancelled.'
        )
          throw e;
      } finally {
        setStartPending(false);
      }
    });
  };
  const [view, setView] = useState<'notebook' | 'settings'>('notebook');
  useEffect(() => {
    if (
      !preparing ||
      capture.state?.startup !== 'loading' ||
      !focusCancel.current
    )
      return;
    focusCancel.current = false;
    if (document.activeElement === document.body) cancelButton.current?.focus();
  }, [preparing, capture.state?.startup]);
  useEffect(() => {
    if (!restoreStartFocus.current || capture.busy) return;
    if (preparing) {
      if (
        !cancelling &&
        capture.state?.startup === 'loading' &&
        document.activeElement === document.body
      )
        cancelButton.current?.focus();
      return;
    }
    if (busy || finishing) return;
    restoreStartFocus.current = false;
    if (view === 'notebook' && document.activeElement === document.body)
      startButton.current?.focus();
  }, [
    preparing,
    cancelling,
    capture.busy,
    capture.state?.startup,
    busy,
    finishing,
    view,
  ]);
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
  const [notes, setNotes] = useState('');
  const [userName, setUserName] = useState('');
  const [nameError, setNameError] = useState('');
  const [focus, setFocus] = useState('');
  const [focusError, setFocusError] = useState('');
  const focusEdit = useRef(0);
  const confirmedFocus = useRef('');
  const pendingFocusSave = useRef<{
    value: string;
    promise: Promise<boolean>;
  } | null>(null);
  // Granola's assistant can propose focus lines; offered only when the
  // connection exists and the server lists that tool.
  const [canSuggest, setCanSuggest] = useState(false);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState('');
  const suggestionRequest = useRef(0);
  const suggestionButton = useRef<HTMLButtonElement>(null);
  const focusSuggestions = useRef(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const granolaChanged = (status: GranolaStatus) => {
    const available =
      status.connected && status.tools.includes('query_granola_meetings');
    setCanSuggest(available);
    if (!available) {
      // A reply already crossing IPC must not outlive this connection.
      suggestionRequest.current++;
      setSuggesting(false);
      setSuggestions(null);
      setSuggestionError('');
      setTicked([]);
      focusSuggestions.current = false;
    }
  };
  const focusField = useRef<HTMLTextAreaElement>(null);
  // Clear is a mousedown before a click, so the blur that would save the old
  // text is skipped when it heads for Clear; the field keeps the focus.
  const clearButton = useRef<HTMLButtonElement>(null);
  // All Focus writes share the command queue and latest-request error state.
  const applyFocus = (lines: string[]): Promise<boolean> => {
    const value = lines.join('\n');
    if (pendingFocusSave.current?.value === value)
      return pendingFocusSave.current.promise;
    if (!pendingFocusSave.current && value === confirmedFocus.current) {
      setFocusError('');
      return Promise.resolve(true);
    }
    const promise = bridge
      .command('set_focus', { lines })
      .then(() => {
        confirmedFocus.current = value;
        if (pendingFocusSave.current?.promise === promise) setFocusError('');
        return true;
      })
      .catch((e: unknown) => {
        if (pendingFocusSave.current?.promise === promise)
          setFocusError(e instanceof Error ? e.message : String(e));
        return false;
      })
      .finally(() => {
        if (pendingFocusSave.current?.promise === promise)
          pendingFocusSave.current = null;
      });
    pendingFocusSave.current = { value, promise };
    return promise;
  };
  const clearFocus = () => {
    focusEdit.current++;
    setFocus('');
    setSuggestions(null);
    setTicked([]);
    void run(() => applyFocus([]));
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
  useEffect(() => {
    if (suggestions === null || !focusSuggestions.current) return;
    focusSuggestions.current = false;
    if (document.hasFocus() && document.activeElement === document.body)
      suggestionList.current?.focus();
  }, [suggestions]);
  const currentFocusLines = () =>
    focus
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  // The engine keeps five lines; the ticks are capped to what still fits.
  const roomForSuggestions = Math.max(0, 5 - currentFocusLines().length);
  const suggestFocus = async () => {
    if (suggesting || busy || !canSuggest) return;
    const current = ++suggestionRequest.current;
    setSuggesting(true);
    setSuggestionError('');
    try {
      const lines = await bridge.suggestGranolaFocus();
      if (current !== suggestionRequest.current) return;
      focusSuggestions.current =
        document.hasFocus() &&
        document.activeElement === suggestionButton.current;
      setSuggestions(lines);
      setTicked([]);
    } catch (e) {
      if (current === suggestionRequest.current)
        setSuggestionError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current === suggestionRequest.current) setSuggesting(false);
    }
  };
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
      const edit = focusEdit.current;
      if (!(await applyFocus(lines)) || focusEdit.current !== edit) return;
      const restoreFocus = suggestionList.current?.contains(
        document.activeElement,
      );
      setFocus(lines.join('\n'));
      setSuggestions(null);
      setTicked([]);
      if (restoreFocus)
        setTimeout(() => {
          if (document.hasFocus() && document.activeElement === document.body)
            focusField.current?.focus();
        }, 0);
    });
  const initialized = useRef(false);
  // Ordered name saves must not replace edits made while a reply is pending.
  const nameEdit = useRef(0);
  const confirmedName = useRef('');
  const pendingName = useRef<{ value: string; edit: number } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  // The setup card: put away for this app session with Not now, or gone
  // once the required steps are done.
  const [setupDismissed, setSetupDismissed] = useState(false);
  const notebookNav = useRef<HTMLButtonElement>(null);
  const [focusExpanded, setFocusExpanded] = useState(false);
  // A failed background save must stay discoverable even after collapsing Focus.
  useEffect(() => {
    if (focusError || suggestionError) setFocusExpanded(true);
  }, [focusError, suggestionError]);
  const pendingFocus = useRef<SetupTarget | 'appearance' | null>(null);
  const goToSetup = (target: SetupTarget) => {
    if (target === 'focus') {
      setFocusExpanded(true);
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
        const panel = document.querySelector<HTMLDetailsElement>(
          '[aria-label="Prior context"] details',
        );
        if (panel) panel.open = true;
        const add = panel?.querySelector<HTMLElement>(
          'button.secondary-button',
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
      target === 'name'
        ? 'user-name'
        : target === 'appearance'
          ? 'question-size'
          : 'live-transcription',
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
      confirmedName.current = state.userName ?? '';
      setFocus(state.focus.join('\n'));
      confirmedFocus.current = state.focus.join('\n');
    }
  }, [state]);
  const modelState = model?.status;
  useEffect(() => {
    // Only the latest model state may determine whether a live session is ready.
    let current = true;
    setLiveStatus(null);
    bridge
      .liveStatus()
      .then((status) => {
        if (current) setLiveStatus(status);
      })
      .catch(() => {
        if (current)
          setLiveStatus({
            available: false,
            reason: 'Live transcription status is unavailable.',
          });
      });
    return () => {
      current = false;
    };
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
  const returnToExport = useRef(false);
  useEffect(() => {
    if (preview !== null) modal.current?.showModal();
    else if (modal.current?.open) {
      modal.current.close();
      exportButton.current?.focus();
      // Saving closes the preview while Export is still disabled, so the
      // return waits for it, unless focus has gone somewhere else meanwhile.
      returnToExport.current = document.activeElement !== exportButton.current;
    } else if (returnToExport.current && !busy) {
      returnToExport.current = false;
      const focused = document.activeElement;
      if (focused === document.body || modal.current?.contains(focused))
        exportButton.current?.focus();
    }
  }, [preview, busy]);

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
  const live = state.live && state.status === 'running';
  // Browser preview and tests only: a replay of a fictional conversation.
  const simulated = !!state.simulated && state.status === 'running';
  const modelNeeded =
    model?.status === 'missing' || model?.status === 'downloading';
  // Keeps a quoted line in the notes; the cue then goes like a dismissal.
  const keepLine = () => {
    if (!state.cue) return;
    void run(async () => {
      await bridge.command('keep_line', { id: state.cue!.id });
      setNotice('Line kept in your notes.');
      notesEditor.current?.focus();
    });
  };
  const inspectCue = (expanded: boolean) => {
    if (!state.cue) return;
    void run(() =>
      bridge.command('inspect_cue', { id: state.cue!.id, expanded }),
    );
  };
  const toggleLiveCues = () =>
    void run(() =>
      bridge.command('set_live_cues_paused', { paused: !state.cuesPaused }),
    );
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
  // Saving the name leaves other controls enabled and focus where it is. Only
  // an untouched rejected submission reverts to the last confirmed name.
  const saveName = () => {
    const next = userName.trim();
    if (!pendingName.current && next === confirmedName.current) {
      setUserName(next);
      setNameError('');
      return;
    }
    // Deduplicate Enter followed by blur, but queue a different submission.
    if (pendingName.current?.value === next) {
      pendingName.current.edit = nameEdit.current;
      return;
    }
    const request = { value: next, edit: nameEdit.current };
    pendingName.current = request;
    bridge
      .command('set_user_name', { name: next || null })
      .then(() => {
        confirmedName.current = next;
        if (pendingName.current === request) setNameError('');
        if (
          pendingName.current === request &&
          nameEdit.current === request.edit
        )
          setUserName(next);
      })
      .catch((e: unknown) => {
        if (pendingName.current !== request) return;
        setNameError(e instanceof Error ? e.message : String(e));
        if (nameEdit.current === request.edit)
          setUserName(confirmedName.current);
      })
      .finally(() => {
        if (pendingName.current === request) pendingName.current = null;
      });
  };
  const saveFocus = () => {
    // Submitting again also retires a delayed suggestion acceptance.
    focusEdit.current++;
    const lines = currentFocusLines();
    if (
      !pendingFocusSave.current &&
      lines.join('\n') === confirmedFocus.current
    )
      setFocus(confirmedFocus.current);
    // Keep rejected lines and newer drafts editable; replies never replace them.
    void applyFocus(lines);
  };
  const prepareExport = () =>
    void run(async () => {
      engineNotes.current = notes;
      await bridge.command('update_notes', { notes });
      setPreview(await bridge.exportPreview());
    });

  return (
    <div className="app-shell" ref={measureShell}>
      <aside
        className="meeting-list"
        id="meeting-list"
        aria-label="Notebook navigation"
        style={listResizable ? { width: listWidth } : undefined}
      >
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
            ref={notebookNav}
            className={view === 'notebook' ? 'nav-item selected' : 'nav-item'}
            aria-current={view === 'notebook' ? 'page' : undefined}
            onClick={() => setView('notebook')}
          >
            <BookOpen size={19} />
            Notebook
          </button>
        </nav>
        {view === 'notebook' && (
          <div className="meeting-list-content">
            {state &&
              !setupDismissed &&
              !live &&
              !simulated &&
              !(
                state.userName &&
                (!model || !['missing', 'downloading'].includes(model.status))
              ) && (
                <details className="setup-disclosure">
                  <summary>Set up a live session</summary>
                  <SetupCard
                    name={state.userName}
                    focus={state.focus}
                    model={model}
                    items={contextItems}
                    busy={busy}
                    onGoTo={goToSetup}
                    onDismiss={() => {
                      setSetupDismissed(true);
                      notebookNav.current?.focus();
                    }}
                  />
                </details>
              )}
          </div>
        )}
        <div className="sidebar-bottom">
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
        {view === 'notebook' && listResizable && (
          <PanelDivider
            label="Sidebar"
            controls="meeting-list"
            className="list-divider"
            value={listWidth}
            min={200}
            max={listMax}
            onChange={setPreferredListWidth}
          />
        )}
      </aside>

      <main
        className={`workspace ${view !== 'notebook' ? 'wide-workspace' : ''}`}
      >
        <header className="toolbar">
          <div className="breadcrumb">
            <BookOpen size={16} />
            <span>{view === 'notebook' ? 'Notebook' : 'Settings'}</span>
            {view === 'notebook' && state.live && (
              <>
                <ChevronRight size={14} />
                <span>Live session</span>
              </>
            )}
          </div>
          {view === 'notebook' && (listResizable || splitContent) && (
            <details
              className="layout-controls"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector('summary')?.focus();
                }
              }}
            >
              <summary>Panel sizes</summary>
              <div className="layout-controls-body">
                {listResizable && (
                  <label>
                    Sidebar width
                    <input
                      type="range"
                      min={200}
                      max={listMax}
                      value={listWidth}
                      aria-valuetext={`${listWidth} pixels wide`}
                      onChange={(event) =>
                        setPreferredListWidth(Number(event.target.value))
                      }
                    />
                  </label>
                )}
                {splitContent && (
                  <label>
                    Notes and transcript width
                    <input
                      type="range"
                      min={260}
                      max={notesMax}
                      value={notesWidth}
                      aria-valuetext={`${notesWidth} pixels wide`}
                      onChange={(event) =>
                        resizeNotes(Number(event.target.value))
                      }
                    />
                  </label>
                )}
                <button
                  className="secondary-button"
                  onClick={() => {
                    setPreferredListWidth(null);
                    setNotesRatio(1 / 1.95);
                  }}
                >
                  Reset panel sizes
                </button>
                <p>
                  Sizes last until you close the app. Narrow windows stack the
                  panels.
                </p>
              </div>
            </details>
          )}
          <span className="prototype-label">
            {bridge.desktop ? 'Desktop prototype' : 'Browser preview'}
          </span>
        </header>
        <MicrophoneControl
          microphone={microphone}
          live={live || finishing}
          preparing={preparing}
          cancelling={cancelling}
          processingConfigured={!!capture.state?.processor}
          sourceMayBeCapturing={!!capture.state?.source?.mayBeCapturing}
          sourceSession={sourceApp}
          action={
            preparing ? (
              <button
                ref={rememberCancel}
                className="secondary-button"
                disabled={
                  capture.busy ||
                  cancelling ||
                  capture.state?.startup !== 'loading'
                }
                onClick={() => {
                  restoreStartFocus.current =
                    document.activeElement === cancelButton.current;
                  void capture.stop();
                }}
              >
                {cancelling ? 'Cancelling…' : 'Cancel start'}
              </button>
            ) : live || finishing ? (
              <button
                className="secondary-button"
                disabled={capture.busy || !capture.state}
                onClick={() => void capture.stop()}
              >
                <Square size={14} />
                Stop live session
              </button>
            ) : undefined
          }
        />
        {(preparing || live || finishing || view === 'settings') &&
          (capture.statusError || capture.error) && (
            <div className="error-banner" role="alert">
              <span>
                {capture.error ||
                  'Capture status is unavailable. Refresh it to use Stop or Cancel start.'}
              </span>
              {capture.statusError && (
                <button
                  className="secondary-button"
                  onClick={capture.retryStatus}
                >
                  Refresh capture status
                </button>
              )}
            </div>
          )}
        {bridge.desktop && (
          <div
            className="notebook-processing"
            hidden={
              view !== 'settings' &&
              !state.live &&
              !capture.state?.source?.mayBeCapturing
            }
          >
            <ProcessingControl
              status={{
                snapshot: capture.state,
                failed: capture.statusError,
                refresh: capture.refresh,
              }}
            />
          </div>
        )}
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
            <section className="session-strip" aria-label="Session">
              <div className="session-state">
                {/* A dot only while something runs; idle and ended have none. */}
                {(live || simulated || preparing || finishing) && (
                  <span className={`status-dot ${state.status}`} />
                )}
                <div>
                  <h1>
                    {preparing
                      ? cancelling
                        ? 'Cancelling start'
                        : 'Preparing live session'
                      : finishing
                        ? 'Finishing live session'
                        : state.live
                          ? live
                            ? state.cuesPaused
                              ? 'Cues paused · session continues'
                              : 'Live session in progress'
                            : 'Live session ended'
                          : simulated
                            ? 'Simulated session'
                            : 'No session yet'}
                  </h1>
                  <p>
                    {preparing
                      ? 'Local speech model · capture status shown above'
                      : finishing
                        ? capture.state?.source?.mayBeCapturing &&
                          microphoneNotCapturing(microphone.state)
                          ? 'Ending the live session. Application audio is shown under Cue processing.'
                          : 'Waiting for microphone release and remaining transcription.'
                        : state.live
                          ? live
                            ? state.cuesPaused
                              ? sourceApp
                                ? 'Application audio and transcript continue. Stop live session to stop listening.'
                                : 'Microphone and transcript continue. Stop live session to stop listening.'
                              : sourceApp
                                ? `Audio from ${sourceApp} · transcribed on this device · not saved`
                                : 'Your microphone · transcribed on this device · not saved'
                            : 'Nothing was saved. The transcript stays here until you start another session or quit; your notes stay until you quit.'
                          : simulated
                            ? 'Fictional replay · nothing is captured'
                            : capture.state?.source?.mayBeCapturing
                              ? 'No live session. Audio from a selected application may still be captured; see Cue processing above.'
                              : microphone.active
                                ? 'No live session. The microphone check above is on; it records and transcribes nothing.'
                                : liveStatus?.available
                                  ? 'Nothing is being captured. Start a live session when your meeting begins.'
                                  : modelNeeded
                                    ? 'Nothing is being captured. A live session needs the speech model first.'
                                    : liveStatus?.reason
                                      ? `Nothing is being captured. Cues appear only during a live session. ${liveStatus.reason}`
                                      : 'Nothing is being captured.'}
                  </p>
                </div>
              </div>
              <div className="session-actions">
                {(state.live || simulated) && !preparing && (
                  <span className="session-clock">
                    {state.live && !live && !finishing ? 'Length ' : ''}
                    {clockTime(state.elapsedMs)}
                  </span>
                )}
                {!preparing &&
                  !finishing &&
                  live &&
                  !capture.state?.processor && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      title={
                        state.cuesPaused
                          ? 'Only new speech can raise a cue after resuming.'
                          : sourceApp
                            ? 'Clear the current cue; application audio and transcript continue.'
                            : 'Clear the current cue; microphone and transcript continue.'
                      }
                      onClick={toggleLiveCues}
                    >
                      {state.cuesPaused ? (
                        <Play size={15} />
                      ) : (
                        <Pause size={15} />
                      )}
                      {state.cuesPaused ? 'Resume cues' : 'Pause cues'}
                    </button>
                  )}
                <button
                  ref={exportButton}
                  className="secondary-button export-button"
                  onClick={prepareExport}
                  disabled={busy || state.live}
                  title={
                    state.live
                      ? 'Live sessions are not saved or exported.'
                      : undefined
                  }
                >
                  <ArrowUpRight size={16} />
                  Export
                </button>
                {!preparing && !finishing && !live && !simulated && (
                  <>
                    {liveStatus?.available && (
                      <button
                        className="primary-button"
                        ref={startButton}
                        disabled={busy || startPending || microphone.active}
                        title={
                          microphone.active
                            ? 'Stop the microphone check first.'
                            : undefined
                        }
                        onClick={startLive}
                      >
                        <Play size={15} />
                        Start live session
                      </button>
                    )}
                    {!liveStatus?.available && modelNeeded && (
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setFocusLiveSetup(true);
                          setView('settings');
                        }}
                      >
                        {model?.status === 'downloading'
                          ? 'View download progress'
                          : 'Set up live session'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </section>

            <div
              className={`notebook-grid${splitContent ? ' is-split' : ''}`}
              ref={measureGrid}
              style={
                splitContent
                  ? {
                      gridTemplateColumns: `${notesWidth}px 28px minmax(0, 1fr)`,
                    }
                  : undefined
              }
            >
              <section className="editor-section" id="meeting-editor">
                <div
                  className="tabs"
                  role="tablist"
                  aria-label="Meeting content"
                  onKeyDown={(e) => {
                    const next =
                      e.key === 'Home'
                        ? 'notes'
                        : e.key === 'End'
                          ? 'transcript'
                          : e.key === 'ArrowRight' || e.key === 'ArrowLeft'
                            ? tab === 'notes'
                              ? 'transcript'
                              : 'notes'
                            : null;
                    if (!next) return;
                    e.preventDefault();
                    setTab(next);
                    document.getElementById(`${next}-tab`)?.focus();
                  }}
                >
                  <button
                    role="tab"
                    aria-selected={tab === 'notes'}
                    aria-controls="notes-panel"
                    id="notes-tab"
                    tabIndex={tab === 'notes' ? 0 : -1}
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
                    {(state.live || simulated) && (
                      <p className="muted small">
                        {state.live
                          ? sourceApp
                            ? `Audio from ${sourceApp} · transcribed on this device`
                            : 'Your microphone · transcribed on this device'
                          : 'Fictional replay · not from microphone audio'}
                      </p>
                    )}
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
                        <h2>
                          {live || simulated
                            ? 'A conversation starts here.'
                            : 'No transcript yet.'}
                        </h2>
                        <p>
                          {live
                            ? sourceApp
                              ? 'Lines from the application appear here a few seconds after they are heard.'
                              : 'Lines from your microphone appear here a few seconds after they are spoken.'
                            : state.live
                              ? 'No lines were transcribed in this session.'
                              : simulated
                                ? 'Lines of the replay appear here.'
                                : 'Lines appear here during a live session.'}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {splitContent && (
                <PanelDivider
                  label="Notes and transcript"
                  controls="meeting-editor"
                  className="content-divider"
                  value={notesWidth}
                  min={260}
                  max={notesMax}
                  onChange={resizeNotes}
                />
              )}
              <aside className="companion" aria-label="Question companion">
                <div className="companion-heading">
                  <h2>A timely question</h2>
                  <CircleHelp size={16} aria-hidden="true" />
                </div>
                <CueCard
                  cue={state.cue}
                  size={state.questionSize}
                  live={state.live || simulated}
                  busy={busy}
                  onDismiss={dismiss}
                  onKeep={keepLine}
                  onInspect={inspectCue}
                  empty={
                    <div className="question-idle">
                      <h3>
                        {state.cuesPaused
                          ? 'Cues are paused.'
                          : live || simulated
                            ? 'A little room to think.'
                            : state.live
                              ? 'Cues have stopped.'
                              : 'No cue yet.'}
                      </h3>
                      <p>
                        {state.cuesPaused
                          ? 'Resume cues when you want suggestions again. Speech from the pause will not become a new cue.'
                          : live || simulated
                            ? 'Cues pass quietly. You can keep listening without responding.'
                            : state.live
                              ? 'Start another session to see cues again.'
                              : 'During a live session, one cue at a time appears here. Cues come from simple phrase rules on what is transcribed, not from AI.'}
                      </p>
                    </div>
                  }
                />
                {(live || simulated) && (
                  <p className="companion-footnote">
                    {state.live && capture.state?.processor
                      ? capture.state.approved
                        ? 'Cues use the sources approved for this session. Pause cues or disable processing above at any time.'
                        : 'Evaluated cues need approval in Cue processing above. You can leave processing off.'
                      : state.live
                        ? 'Suggestions use simple phrase rules on what was transcribed. Use a cue in the conversation or let it pass.'
                        : 'This replay is fictional. Its cues were decided before it was played.'}
                  </p>
                )}
                <button
                  className="text-button companion-settings"
                  onClick={() => {
                    pendingFocus.current = 'appearance';
                    setView('settings');
                  }}
                >
                  <Settings size={14} />
                  Question appearance & timing
                </button>
              </aside>
            </div>
            <section
              className="meeting-focus"
              aria-labelledby="meeting-focus-title"
            >
              <details
                className="focus-disclosure"
                open={focusExpanded}
                onToggle={(event) => setFocusExpanded(event.currentTarget.open)}
              >
                <summary id="meeting-focus-title">
                  This meeting{' '}
                  <span>
                    {suggesting
                      ? 'Waiting for Granola…'
                      : suggestions !== null
                        ? 'Suggestions ready'
                        : focus.trim()
                          ? 'Review focus'
                          : 'Add a focus · optional'}
                  </span>
                </summary>
                <div className="meeting-focus-heading">
                  <div>
                    <p id="meeting-focus-help" className="small muted">
                      Up to five short lines on what you want to get to, such as
                      “agree the launch plan for the newsletter”. A question
                      about one of them comes through even in the pause after
                      another; when the meeting is wrapping up, the lines never
                      touched are listed once. Word matches, kept until you
                      quit.
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
                    aria-describedby={
                      focusError
                        ? 'meeting-focus-help meeting-focus-error'
                        : 'meeting-focus-help'
                    }
                    value={focus}
                    rows={3}
                    spellCheck={false}
                    onChange={(e) => {
                      focusEdit.current++;
                      setFocus(e.target.value);
                    }}
                    onBlur={(e) => {
                      if (
                        !clearButton.current ||
                        e.relatedTarget !== clearButton.current
                      )
                        saveFocus();
                    }}
                  />
                  {focusError && (
                    <p id="meeting-focus-error" role="alert">
                      Focus wasn't applied. {focusError} Edit the lines and
                      leave the field to try again, or Clear.
                    </p>
                  )}
                  {canSuggest && suggestions === null && (
                    <div className="suggest-focus">
                      <button
                        type="button"
                        className="secondary-button"
                        ref={suggestionButton}
                        disabled={busy}
                        // Keep keyboard focus while waiting; the handler guards repeats.
                        aria-disabled={suggesting || undefined}
                        onClick={() => void suggestFocus()}
                      >
                        {suggesting
                          ? 'Asking Granola…'
                          : 'Suggest from Granola'}
                      </button>
                      {suggesting && (
                        <p className="small muted" role="status">
                          Waiting for suggestions. You can keep working or
                          disconnect in Prior context.
                        </p>
                      )}
                      {suggestionError && (
                        <p role="alert">
                          {suggestionError} Ask again, or type your own focus.
                        </p>
                      )}
                      <p className="small muted">
                        Asks Granola’s assistant one question about your
                        meetings of the last 30 days and shows its answer for
                        you to tick. Granola sees the question; nothing else
                        leaves this Mac.
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
              </details>
            </section>
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
                  : 'Your notes stay in memory until you quit. Export anything you want to keep before closing.'}
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
                  aria-describedby={
                    nameError
                      ? 'user-name-help user-name-error'
                      : 'user-name-help'
                  }
                  type="text"
                  value={userName}
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    nameEdit.current++;
                    setUserName(e.target.value);
                  }}
                  onBlur={saveName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName();
                  }}
                />
                {nameError && (
                  <p
                    id="user-name-error"
                    className="setting-error"
                    role="alert"
                  >
                    Name wasn't changed. {nameError} Edit the name to try again.
                  </p>
                )}
              </div>
            </section>
            <section className="setting">
              <div>
                <h2>Glance view</h2>
                <p>
                  One complete cue with where it came from. A line shows how
                  long it stays; Hold keeps it until you dismiss it.
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
                    ? 'Keep a small companion in your chosen position during a live session or microphone check. Stop microphone controls take priority while it is on. Hide only hides the window; it does not stop the microphone. For keyboard controls, use the question in your notebook.'
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
        <p className="visually-hidden" id="panel-resize-help">
          Drag to resize. Left and right arrows adjust width; Home and End use
          the limits. Escape cancels a drag. Panel sizes in the toolbar offers
          sliders and Reset.
        </p>
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
