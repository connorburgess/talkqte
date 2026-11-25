import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  AudioLines,
  BookOpen,
  ChevronRight,
  Cloud,
  CloudUpload,
  EyeOff,
  FileText,
  History,
  MessageCircle,
  Mic,
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
  type Segment,
  type Snapshot,
  type GranolaStatus,
} from './lib/types';

import { CueCard, cueAnnouncement } from './components/Question';
import {
  ProcessingControl,
  processingIssueText,
} from './components/ProcessingControl';
import { MicrophoneControl } from './components/MicrophoneControl';
import { ContextNotes } from './components/ContextNotes';
import { SetupCard, type SetupTarget } from './components/SetupCard';
import { isKeysStatus, ProviderKeys } from './components/ProviderKeys';
import { KeepMeetingChoice } from './components/KeepMeetingChoice';
import { KeepInHistory } from './components/KeepInHistory';
import { MeetingHistory } from './components/MeetingHistory';
import { MeetingHistorySettings } from './components/MeetingHistorySettings';
import { MeetingNotes } from './components/MeetingNotes';
import {
  PanelDivider,
  boundWidth,
  useElementWidth,
} from './components/PanelDivider';
import { microphoneLabel, useMicrophone } from './lib/microphone';
import {
  appendDictatedText,
  dictationStatusLabel,
  useDictation,
  type DictationTarget,
} from './lib/dictation';
import { useCaptureControl } from './lib/useCaptureControl';
import { keysStatus, watchKeys, type KeysStatus } from './lib/providerKeys';
import { Onboarding } from './components/Onboarding';
import { notMacos, platformName, usePlatform } from './lib/platform';
import { Diagnostics } from './components/Diagnostics';
import { listen } from '@tauri-apps/api/event';
import { CallPrompt } from './components/CallPrompt';
import { CallPromptSetting } from './components/CallPromptSetting';
import { SavedSettings } from './components/SavedSettings';
import { MenuBarSettings } from './components/MenuBarSettings';
import { savedPanelSizes, savePanelSizes } from './lib/savedSettings';
import {
  SessionSources,
  microphoneOnly,
  ready,
  type SourceChoice,
} from './components/SessionSources';
import {
  type EchoLine,
  applicationEndedText,
  echoText,
  sourcesHeading,
  transcribedWhere,
  transcriptionDropText,
  transcriptionLowText,
  transcriptionReconnectText,
  transcriptionStopText,
} from './lib/transcription';
import {
  microphoneNotCapturing,
  processingApi,
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
  // The bar sits on the window's edge that stays put, so a cue grows out of
  // it without the bar moving on screen: the bottom one for the default
  // bottom-right placement. The native side says which, before each move.
  const [edge, setEdge] = useState<'top' | 'bottom'>('top');
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    bridge
      .watchAnchor(setEdge)
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      // If the page cannot listen at all, the bar stays on top.
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const mic = microphone.state;
  const live = !!state?.live && state.status === 'running';
  // Browser preview and tests only: a replay of a fictional conversation,
  // flagged by the tests' stand-in and never by the desktop engine.
  const simulated = !!state?.simulated && state.status === 'running';
  const microphoneControl =
    !live && (microphone.active || (!mic && !!microphone.error));
  const active =
    state?.overlayEnabled && (live || microphoneControl || simulated);
  // What the bar says about capture, in words: read by assistive technology
  // always, and shown whenever the glyph alone would not say it.
  const listening = mic?.status === 'listening';
  // A session fed by an application alone (macOS builds).
  const appAudio = live && !!state?.sourceSession && !listening;
  // Capture is on and nothing about it is changing or wrong.
  const capturing =
    (listening || appAudio) && !(microphoneControl && microphone.stopPending);
  // Where lines and audio go is said whenever they may leave the device.
  // Paused cues send nothing, so they say only that they are paused.
  const modelProvider = state?.modelProvider ?? 'Claude';
  const modelLinked =
    !state?.cuesPaused && (state?.model === 'on' || state?.model === 'sending');
  // With cloud transcription, audio leaves the device while the session's
  // review holds, paused cues included; before that nothing is transcribed.
  const cloud = state?.transcription;
  const audioSent =
    !!cloud &&
    !cloud.stopped &&
    (state?.model === 'on' || state?.model === 'sending');
  const cloudNote = !cloud
    ? null
    : cloud.stopped
      ? 'transcription stopped'
      : audioSent
        ? null
        : 'not transcribing yet';
  const statusText = !state
    ? ''
    : live
      ? mic?.status === 'listening'
        ? state.cuesPaused
          ? audioSent
            ? `Mic still on · audio to ${cloud.provider}`
            : 'Mic still on'
          : modelLinked
            ? audioSent
              ? `Mic on · to ${cloud.provider} and ${modelProvider}`
              : `Mic on · lines go to ${modelProvider}`
            : cloudNote
              ? `Mic on · ${cloudNote}`
              : 'Mic on'
        : state.sourceSession
          ? state.cuesPaused
            ? audioSent
              ? `App audio still on · audio to ${cloud.provider}`
              : 'App audio still on'
            : modelLinked
              ? audioSent
                ? `App audio · to ${cloud.provider} and ${modelProvider}`
                : `App audio · lines go to ${modelProvider}`
              : cloudNote
                ? `App audio · ${cloudNote}`
                : 'App audio'
          : microphoneLabel(mic)
      : microphoneControl
        ? microphone.stopPending && mic?.status !== 'stopping'
          ? 'Stop requested…'
          : !mic
            ? 'Status unavailable'
            : microphoneLabel(mic)
        : // Only the tests' simulated session reaches here; it has no
          // capture glyph, so the words always show.
          'Simulated session · Fictional';
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
      {/* The window's title for heading navigation; the bar shows none. */}
      <h1 className="visually-hidden">TalkQTE companion</h1>
      <div
        className={`companion-shell${edge === 'bottom' ? ' is-bottom' : ''}`}
      >
        {active ? (
          <>
            {/* The bar is the handle: the native window follows a drag on
                it or on its text, and remembers where it was put. */}
            <header className="companion-bar" data-tauri-drag-region>
              <div className="companion-status" data-tauri-drag-region>
                {/* What is being captured, as a glyph with a dot while it
                    is on. Nothing here when nothing is captured. */}
                {(listening || appAudio || live || microphoneControl) && (
                  <span
                    className={`companion-capture${
                      (listening && mic?.activity === 'active') || appAudio
                        ? ' is-on'
                        : ''
                    }`}
                    title={statusText}
                    data-tauri-drag-region
                  >
                    {appAudio ? (
                      <AudioLines size={16} aria-hidden="true" />
                    ) : (
                      <Mic size={16} aria-hidden="true" />
                    )}
                    {(listening || appAudio) && (
                      <span
                        className={`status-dot ${
                          listening ? (mic?.activity ?? 'quiet') : 'active'
                        }`}
                        data-tauri-drag-region
                        role="img"
                        aria-label={
                          appAudio
                            ? 'Application audio on'
                            : mic?.activity === 'active'
                              ? 'Signal detected'
                              : 'Quiet input'
                        }
                      />
                    )}
                  </span>
                )}
                {/* Conversation lines may leave the device while this
                    shows; the arrow means a request is on its way. */}
                {state?.model === 'stopped' && !state.cuesPaused && (
                  <strong
                    className="companion-title"
                    title={
                      state.modelIssue
                        ? processingIssueText(
                            state.modelIssue,
                            modelProvider,
                            state.modelLab,
                          )
                        : 'Cues off: sending stopped.'
                    }
                    data-tauri-drag-region
                  >
                    Cues off
                    <span className="visually-hidden">
                      {': '}
                      {state.modelIssue
                        ? processingIssueText(
                            state.modelIssue,
                            modelProvider,
                            state.modelLab,
                          )
                        : 'sending stopped.'}
                    </span>
                  </strong>
                )}
                {modelLinked && (
                  <span
                    className={`companion-capture is-on`}
                    title={
                      state.model === 'sending'
                        ? `Sending recent lines to ${modelProvider}`
                        : `Model cues on: recent lines go to ${modelProvider}`
                    }
                    role="img"
                    aria-label={
                      state.model === 'sending'
                        ? `Sending recent lines to ${modelProvider}`
                        : `Model cues on: recent lines go to ${modelProvider}`
                    }
                    data-tauri-drag-region
                  >
                    {state.model === 'sending' ? (
                      <CloudUpload size={16} aria-hidden="true" />
                    ) : (
                      <Cloud size={16} aria-hidden="true" />
                    )}
                  </span>
                )}
                {(microphoneControl || (live && state.cuesPaused)) && (
                  <strong className="companion-title" data-tauri-drag-region>
                    {microphoneControl ? 'Mic only' : 'Cues off'}
                  </strong>
                )}
                {/* Always there for assistive technology. While capture is
                    on and well the glyph and its dot say it for the eye;
                    any other state is spelled out. */}
                <span
                  role="status"
                  className={capturing ? 'visually-hidden' : undefined}
                  data-tauri-drag-region
                >
                  {statusText}
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
                      <Play size={14} fill="currentColor" aria-hidden="true" />
                    ) : (
                      <Pause size={16} aria-hidden="true" />
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
                    <Square size={14} aria-hidden="true" />
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
                  <Square size={14} aria-hidden="true" />
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
                <EyeOff size={16} aria-hidden="true" />
              </button>
            </header>
            {state && (
              <CueCard
                cue={state.cue}
                size={state.questionSize}
                announce={false}
                compact
                busy={busy}
                onHold={() =>
                  void run(() =>
                    bridge.command('inspect_cue', { id: state.cue!.id }),
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
              />
            )}
          </>
        ) : state?.callPrompt && state.overlayEnabled ? (
          <CallPrompt
            offer={state.callPrompt}
            busy={busy}
            large={state.questionSize === 'large'}
            onAnswer={(answer) =>
              void run(() =>
                bridge.command('respond_to_call_prompt', {
                  id: state.callPrompt!.id,
                  answer,
                }),
              )
            }
          />
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

/** The transcript as shown: its lines and any microphone lines suppressed
 * as a likely echo, in time order. */
function transcriptLines(state: Snapshot) {
  const lines: { segment: Segment; echo?: EchoLine }[] = state.transcript.map(
    (segment) => ({ segment }),
  );
  for (const echo of state.sources?.echoes ?? [])
    lines.push({ segment: echo, echo });
  return lines.sort((a, b) => a.segment.atMs - b.segment.atMs);
}

const defaultNotesRatio = 1 / 1.95;

/** Panel sizes as the settings file keeps them: a default is kept as none. */
function panelSizes(sidebarWidth: number | null, notesRatio: number) {
  return {
    sidebarWidth: sidebarWidth === null ? null : Math.round(sidebarWidth),
    notesRatio: notesRatio === defaultNotesRatio ? null : notesRatio,
  };
}

function Notebook() {
  const [measureShell, shellWidth] = useElementWidth();
  const [measureGrid, gridWidth] = useElementWidth();
  // Layout preferences, never meeting data: kept in the settings file.
  const [preferredListWidth, setPreferredListWidth] = useState<number | null>(
    null,
  );
  const [notesRatio, setNotesRatio] = useState(defaultNotesRatio);
  // Saving starts once the saved sizes are in, so the defaults shown while
  // they load never overwrite them.
  const [panelsLoaded, setPanelsLoaded] = useState(false);
  // What the file holds, so only a real change is written.
  const savedPanels = useRef('');
  useEffect(() => {
    let alive = true;
    void savedPanelSizes().then((saved) => {
      if (!alive) return;
      if (saved.sidebarWidth !== null)
        setPreferredListWidth(saved.sidebarWidth);
      if (saved.notesRatio !== null) setNotesRatio(saved.notesRatio);
      savedPanels.current = JSON.stringify(
        panelSizes(saved.sidebarWidth, saved.notesRatio ?? defaultNotesRatio),
      );
      setPanelsLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!panelsLoaded) return;
    const next = panelSizes(preferredListWidth, notesRatio);
    if (JSON.stringify(next) === savedPanels.current) return;
    savedPanels.current = JSON.stringify(next);
    savePanelSizes(next);
  }, [panelsLoaded, preferredListWidth, notesRatio]);
  // Remounts the settings that read their own value after Reset settings.
  const [settingsEpoch, setSettingsEpoch] = useState(0);
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
  const platform = usePlatform();
  const microphone = useMicrophone();
  const capture = useCaptureControl();
  // A session fed by a selected application alone, with the microphone off
  // (macOS builds); null otherwise.
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
  const [sources, setSources] = useState<SourceChoice>(microphoneOnly);
  // Start in the companion's call-starting offer: show the notebook with
  // the microphone and the offered application chosen. Nothing starts here.
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{ name: string; bundleId: string } | null>(
      'call-prompt:start',
      ({ payload }) => {
        setView('notebook');
        setSources({
          mode: payload ? 'both' : 'microphone',
          application: null,
          wanted: payload ?? undefined,
        });
      },
    )
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  // Only a build that can hear an application reports one beside the
  // microphone; any other build starts from the microphone as before.
  const canChooseSources = !!capture.state?.source;
  const startLive = () => {
    focusCancel.current = document.activeElement === startButton.current;
    capture.clearError();
    setStartInstalled(false);
    setStartPending(true);
    const choice = canChooseSources ? sources : microphoneOnly;
    void run(async () => {
      setNotice('');
      if (dictation.active) await dictation.stop();
      try {
        if (choice.mode === 'microphone' || !choice.application) {
          await bridge.command('start_live_session');
          return;
        }
        // Review exactly the chosen application, then start with it: the
        // session declares it, so its one approval names what is sent.
        const review = await processingApi.applicationAudio({
          kind: 'review',
          source: choice.application.id,
        });
        if (!review?.operation)
          throw new Error('The selected application changed. Choose it again.');
        if (choice.mode === 'both')
          await bridge.command('start_live_session', {
            application: review.operation,
          });
        else
          await processingApi.applicationAudio({
            kind: 'startSession',
            review: review.operation,
          });
        setSources((current) => ({ ...current, application: null }));
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
  const [view, setView] = useState<'notebook' | 'meetings' | 'settings'>(
    'notebook',
  );
  const [historyRevision, setHistoryRevision] = useState(0);
  // The menu bar's Start session…: the notebook with its ordinary start in
  // reach. Nothing is chosen, listed or started.
  const [startRequested, setStartRequested] = useState(0);
  useEffect(() => {
    if (!bridge.desktop) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen('menu-bar:start-session', () => {
      setView('notebook');
      setStartRequested((count) => count + 1);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (!startRequested) return;
    const button = startButton.current;
    if (!button) return;
    button.scrollIntoView({ block: 'center' });
    button.focus();
  }, [startRequested, view]);
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
  // Clear and mouse clicks on Focus dictation skip premature blur validation
  // so an incomplete draft can be cleared or extended by voice; keyboard Tab
  // still submits Focus as usual.
  const clearButton = useRef<HTMLButtonElement>(null);
  const skipFocusBlur = useRef(false);
  const focusDictationTouched = useRef(false);
  const lastDictationTarget = useRef<DictationTarget | null>(null);
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
  // The cap's countdown is said when it first appears, not every minute.
  const lowSaid = useRef(false);
  const lowText = transcriptionLowText(state?.transcription);
  useEffect(() => {
    if (!lowText) {
      lowSaid.current = false;
      return;
    }
    if (lowSaid.current) return;
    lowSaid.current = true;
    setNotice(lowText);
  }, [lowText]);
  // Said once each to assistive technology, through regions that stay
  // mounted: a live region added together with its words is often not read.
  // A new cue is read; its countdown, a hold or an answer are not.
  const [cueNotice, setCueNotice] = useState('');
  const announcedCue = useRef<string | null>(null);
  useEffect(() => {
    const cue = state?.cue;
    if (!cue) {
      setCueNotice('');
      return;
    }
    if (announcedCue.current === cue.id) return;
    announcedCue.current = cue.id;
    setCueNotice(cueAnnouncement(cue));
  }, [state?.cue?.id]);
  const sessionWas = useRef<string | null>(null);
  useEffect(() => {
    const now = state?.live ? (state.status ?? null) : null;
    if (sessionWas.current === 'running' && now === 'ended')
      setNotice('Live session ended.');
    sessionWas.current = now;
  }, [state?.live, state?.status]);
  // The echo count changes with every marked line; only the first is said.
  const echoesSaid = useRef(false);
  useEffect(() => {
    const text = echoText(state?.sources);
    if (!text) {
      echoesSaid.current = false;
      return;
    }
    if (echoesSaid.current) return;
    echoesSaid.current = true;
    setNotice(text);
  }, [state?.sources?.echoDropped]);
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
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  // The setup card: put away for this app session with Not now, or gone
  // once the required steps are done.
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [keysAvailable, setKeysAvailable] = useState(false);
  const [initialKeys, setInitialKeys] = useState<KeysStatus | null>(null);
  const [onboardingMode, setOnboardingMode] = useState<
    'idle' | 'auto' | 'manual' | 'skipped' | 'finished'
  >('idle');
  const onboardingChecked = useRef(false);
  const sessionHeading = useRef<HTMLHeadingElement>(null);
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
      target === 'name' ? 'user-name' : 'question-size',
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
  useEffect(() => {
    if (!bridge.desktop) return;
    let live = true;
    let stopWatch: (() => void) | undefined;
    keysStatus().then(
      (next) => {
        if (!live) return;
        if (isKeysStatus(next)) {
          setKeysAvailable(true);
          setInitialKeys(next);
        } else {
          setKeysAvailable(false);
        }
      },
      () => {
        if (live) setKeysAvailable(false);
      },
    );
    void watchKeys((next) => {
      if (!live) return;
      setKeysAvailable(true);
      setInitialKeys(next);
    })
      .then((unlisten) => {
        if (!live) unlisten();
        else stopWatch = unlisten;
      })
      .catch(() => {});
    return () => {
      live = false;
      stopWatch?.();
    };
  }, []);
  const showOnboarding =
    view === 'notebook' &&
    (onboardingMode === 'manual' ||
      (onboardingMode === 'auto' && !state?.live && !preparing && !finishing));
  useEffect(() => {
    if (
      !bridge.desktop ||
      !keysAvailable ||
      !initialKeys ||
      !state ||
      !liveStatus
    )
      return;
    if (onboardingChecked.current) return;
    onboardingChecked.current = true;
    // Auto-open once per launch only when both keys are notSet (an unreadable
    // key is not missing), live transcription is unavailable for that reason
    // (a development or lab launch with its own credentials stays on the
    // notebook) and no session is active.
    if (
      !liveStatus.available &&
      initialKeys.deepgram.state === 'notSet' &&
      initialKeys.anthropic.state === 'notSet' &&
      !preparing &&
      !finishing &&
      !state.live
    ) {
      setOnboardingMode('auto');
    }
  }, [keysAvailable, initialKeys, preparing, finishing, state, liveStatus]);
  const focusSessionHeading = () => {
    setTimeout(() => sessionHeading.current?.focus(), 0);
  };
  const skipOnboarding = () => {
    setOnboardingMode('skipped');
    setNotice(
      'Setup skipped. Add your keys or run setup again any time in Settings.',
    );
    focusSessionHeading();
  };
  const finishOnboarding = () => {
    setOnboardingMode('finished');
    setNotice('Setup complete.');
    focusSessionHeading();
  };
  const startFromOnboarding = () => {
    setOnboardingMode('finished');
    if (
      liveStatus?.available &&
      !busy &&
      !startPending &&
      !microphone.active &&
      !dictation.active
    ) {
      void startLive();
    } else {
      focusSessionHeading();
    }
  };
  const reopenOnboarding = () => {
    setOnboardingMode('manual');
    setView('notebook');
  };

  const modal = useRef<HTMLDialogElement>(null);
  const exportButton = useRef<HTMLButtonElement>(null);
  const notesEditor = useRef<HTMLTextAreaElement>(null);
  const transcriptTab = useRef<HTMLButtonElement>(null);
  // The notes last sent to or published by the engine. The engine changes
  // notes on its own only by appending a kept line, so that is the only
  // change the editor takes from a snapshot; a snapshot that lags typing is
  // ignored, and nothing typed meanwhile is lost.
  const engineNotes = useRef('');
  const dictation = useDictation((event) => {
    if (event.target === 'notes') {
      setNotes((current) => {
        const next = appendDictatedText(current, event.text, 20_000);
        if (next === current) return current;
        engineNotes.current = next;
        void bridge
          .command('update_notes', { notes: next })
          .catch((e: unknown) => setError(String(e)));
        return next;
      });
    } else {
      focusDictationTouched.current = true;
      focusEdit.current++;
      setFocus((current) => appendDictatedText(current, event.text));
    }
  });
  if (dictation.state?.target) {
    lastDictationTarget.current = dictation.state.target;
  }
  const dictationTarget =
    dictation.state?.target ?? lastDictationTarget.current;
  useEffect(() => {
    if (
      focusDictationTouched.current &&
      !dictation.active &&
      dictation.state &&
      (dictation.state.status === 'off' || dictation.state.status === 'error')
    ) {
      focusDictationTouched.current = false;
      if (document.activeElement !== focusField.current) {
        saveFocus();
      }
    }
  }, [dictation.active, dictation.state?.status]);
  const notesFieldVisible =
    view === 'notebook' && !showOnboarding && tab === 'notes';
  const focusFieldVisible =
    view === 'notebook' && !showOnboarding && focusExpanded;
  useEffect(() => {
    if (!dictation.active) return;
    if (
      (dictation.state?.target === 'notes' && !notesFieldVisible) ||
      (dictation.state?.target === 'focus' && !focusFieldVisible)
    ) {
      dictation.stopQuietly();
    }
  }, [
    dictation.active,
    dictation.state?.target,
    notesFieldVisible,
    focusFieldVisible,
  ]);
  const dictationActiveRef = useRef(false);
  dictationActiveRef.current = dictation.active;
  useEffect(
    () => () => {
      if (dictationActiveRef.current) dictation.stopQuietly();
    },
    [],
  );
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
  useEffect(() => {
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
  // The flag comes from the browser tests' stand-in (liveTest.simulate in
  // tests/fixtures/native-microphone.ts); the desktop engine never sends it,
  // so every `simulated` branch is unreachable in the app.
  const simulated = !!state.simulated && state.status === 'running';
  const dictationUnavailableReason = (
    target: DictationTarget,
  ): { reason: string; visibleHint: boolean } | null => {
    if (!bridge.desktop) {
      return {
        reason: 'Dictation is available in the desktop app.',
        visibleHint: false,
      };
    }
    if (live || preparing || finishing || simulated) {
      return {
        reason: 'Stop the live session before dictating.',
        visibleHint: false,
      };
    }
    if (microphone.active) {
      return {
        reason: 'Stop the microphone check before dictating.',
        visibleHint: false,
      };
    }
    const dgState = initialKeys?.deepgram.state;
    if (dgState === 'rejected') {
      return {
        reason:
          'Deepgram rejected your API key. Replace it in Settings to dictate.',
        visibleHint: true,
      };
    }
    if (dgState === 'unreadable') {
      return {
        reason: 'Your Deepgram key could not be read. Check it in Settings.',
        visibleHint: true,
      };
    }
    if (
      (dgState === 'notSet' || (!initialKeys && keysAvailable)) &&
      !liveStatus?.transcription
    ) {
      return {
        reason: 'Add your Deepgram API key in Settings to dictate.',
        visibleHint: true,
      };
    }
    if (
      dictation.state &&
      (dictation.state.status === 'stopping' ||
        (dictation.state.status === 'error' && !dictation.state.canStart))
    ) {
      return { reason: 'Finishing dictation…', visibleHint: false };
    }
    if (dictation.active && dictation.state?.target !== target) {
      return {
        reason: 'Stop dictating before switching fields.',
        visibleHint: false,
      };
    }
    if (dictation.busy) {
      return { reason: 'Updating dictation…', visibleHint: false };
    }
    return null;
  };

  const toggleDictation = (target: DictationTarget) => {
    const activeHere =
      dictation.state?.target === target &&
      (dictation.state.status === 'starting' ||
        dictation.state.status === 'listening');
    if (activeHere) {
      void dictation.stop();
    } else {
      lastDictationTarget.current = target;
      void dictation.start(target);
    }
  };

  const notesDictating =
    dictation.state?.target === 'notes' &&
    (dictation.state.status === 'starting' ||
      dictation.state.status === 'listening');
  const notesDictationBlock = notesDictating
    ? null
    : dictationUnavailableReason('notes');
  const notesDictationFeedback = (() => {
    if (
      notesDictating ||
      (dictation.state?.target === 'notes' &&
        dictation.state.status === 'stopping')
    ) {
      return {
        kind: 'status' as const,
        text: dictationStatusLabel(dictation.state),
      };
    }
    if (dictationTarget === 'notes') {
      if (dictation.error) {
        return { kind: 'error' as const, text: dictation.error };
      }
      if (dictation.state?.status === 'error' && dictation.state.message) {
        return { kind: 'error' as const, text: dictation.state.message };
      }
      if (dictation.state?.status === 'off' && dictation.state.message) {
        return { kind: 'status' as const, text: dictation.state.message };
      }
    }
    return null;
  })();

  const focusDictating =
    dictation.state?.target === 'focus' &&
    (dictation.state.status === 'starting' ||
      dictation.state.status === 'listening');
  const focusDictationBlock = focusDictating
    ? null
    : dictationUnavailableReason('focus');
  const focusDictationFeedback = (() => {
    if (
      focusDictating ||
      (dictation.state?.target === 'focus' &&
        dictation.state.status === 'stopping')
    ) {
      return {
        kind: 'status' as const,
        text: dictationStatusLabel(dictation.state),
      };
    }
    if (dictationTarget === 'focus') {
      if (dictation.error) {
        return { kind: 'error' as const, text: dictation.error };
      }
      if (dictation.state?.status === 'error' && dictation.state.message) {
        return { kind: 'error' as const, text: dictation.state.message };
      }
      if (dictation.state?.status === 'off' && dictation.state.message) {
        return { kind: 'status' as const, text: dictation.state.message };
      }
    }
    return null;
  })();
  const holdCue = () => {
    if (!state.cue) return;
    void run(() => bridge.command('inspect_cue', { id: state.cue!.id }));
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
        <div className="meeting-list-inner">
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
            <button
              className={view === 'meetings' ? 'nav-item selected' : 'nav-item'}
              aria-current={view === 'meetings' ? 'page' : undefined}
              onClick={() => setView('meetings')}
            >
              <History size={19} />
              Meetings
            </button>
          </nav>
          {view === 'notebook' && (
            <div className="meeting-list-content">
              {state &&
                !setupDismissed &&
                !live &&
                !simulated &&
                !state.userName && (
                  <details className="setup-disclosure">
                    <summary>Set up a live session</summary>
                    <SetupCard
                      name={state.userName}
                      focus={state.focus}
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
              TalkQTE <span>0.1 · alpha</span>
            </div>
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
            {view === 'meetings' ? (
              <History size={16} />
            ) : view === 'settings' ? (
              <Settings size={16} />
            ) : (
              <BookOpen size={16} />
            )}
            <span>
              {view === 'notebook'
                ? 'Notebook'
                : view === 'meetings'
                  ? 'Meetings'
                  : 'Settings'}
            </span>
            {view === 'notebook' && state.live && (
              <>
                <ChevronRight size={14} />
                <span>Live session</span>
              </>
            )}
          </div>
          {view === 'notebook' &&
            !showOnboarding &&
            (listResizable || splitContent) && (
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
                      setNotesRatio(defaultNotesRatio);
                    }}
                  >
                    Reset panel sizes
                  </button>
                  <p>
                    TalkQTE remembers these sizes. Narrow windows stack the
                    panels.
                  </p>
                </div>
              </details>
            )}
          {!bridge.desktop && (
            <span className="prototype-label">Browser preview</span>
          )}
        </header>
        {(!showOnboarding ||
          live ||
          preparing ||
          finishing ||
          microphone.active) && (
          <MicrophoneControl
            microphone={microphone}
            live={live || finishing}
            preparing={preparing}
            cancelling={cancelling}
            processingConfigured={!!capture.state?.processor}
            sourceMayBeCapturing={!!capture.state?.source?.mayBeCapturing}
            sourceSession={sourceApp}
            transcription={state?.transcription}
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
        )}
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

        {view === 'notebook' && showOnboarding && (
          <Onboarding
            canStartLive={
              !!liveStatus?.available &&
              !busy &&
              !startPending &&
              !microphone.active
            }
            onSkip={skipOnboarding}
            onFinish={finishOnboarding}
            onStartLive={startFromOnboarding}
          />
        )}

        {view === 'notebook' && !showOnboarding && (
          <div className="notebook-body">
            <section className="session-strip" aria-label="Session">
              <div className="session-state">
                {/* A dot only while something runs; idle and ended have none. */}
                {(live || simulated || preparing || finishing) && (
                  <span
                    className={`status-dot ${
                      preparing
                        ? 'preparing'
                        : state.cuesPaused
                          ? 'paused'
                          : state.status
                    }`}
                  />
                )}
                <div>
                  <h1 ref={sessionHeading} tabIndex={-1}>
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
                      ? 'Starting · capture status shown above'
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
                                ? `Audio from ${sourceApp} · not saved by TalkQTE`
                                : 'Your microphone · not saved by TalkQTE'
                            : 'Nothing was saved. The transcript stays here until you start another session or quit and is never exported; your notes stay until you quit and can be exported.'
                          : simulated
                            ? 'Fictional replay · nothing is captured'
                            : capture.state?.source?.mayBeCapturing
                              ? 'No live session. Audio from a selected application may still be captured; see Cue processing above.'
                              : microphone.active &&
                                  !microphoneNotCapturing(microphone.state)
                                ? microphone.state?.status === 'error'
                                  ? 'No live session. The microphone is still being released; see above.'
                                  : 'No live session. The microphone check above is on; it records and transcribes nothing.'
                                : liveStatus?.available
                                  ? 'Nothing is being captured. Start a live session when your meeting begins.'
                                  : liveStatus?.reason
                                    ? `Nothing is being captured. Cues appear only during a live session. ${liveStatus.reason}`
                                    : 'Nothing is being captured.'}
                  </p>
                  {notMacos(platform) &&
                    !state.live &&
                    !simulated &&
                    !preparing &&
                    !finishing && (
                      <p className="small muted">
                        On {platformName(platform)}, live sessions hear your
                        microphone only: with headphones, that is your side of a
                        call. Hearing another application is not available on{' '}
                        {platformName(platform)} yet.
                      </p>
                    )}
                  {transcriptionStopText(state.transcription) && (
                    <p role="alert">
                      {transcriptionStopText(state.transcription)}
                    </p>
                  )}
                  {applicationEndedText(state.sources) && (
                    <p role="alert">{applicationEndedText(state.sources)}</p>
                  )}
                  {/* Said once through the notice region; the count is
                      not re-read as it grows. */}
                  {echoText(state.sources) && <p>{echoText(state.sources)}</p>}
                  {transcriptionDropText(state.transcription) && (
                    <p role="status">
                      {transcriptionDropText(state.transcription)}
                    </p>
                  )}
                  {/* Changes each minute: said once, through the notice
                      region, when it first appears. */}
                  {transcriptionLowText(state.transcription) && (
                    <p>{transcriptionLowText(state.transcription)}</p>
                  )}
                  {transcriptionReconnectText(state.transcription) && (
                    <p role="status">
                      {transcriptionReconnectText(state.transcription)}
                    </p>
                  )}
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
                  disabled={busy || live || preparing || finishing}
                  title={
                    live || finishing
                      ? 'Stop the live session to export your notes. The transcript is never exported.'
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
                        disabled={
                          busy ||
                          startPending ||
                          microphone.active ||
                          (canChooseSources && !ready(sources))
                        }
                        title={
                          microphone.active
                            ? 'Stop the microphone check first.'
                            : canChooseSources && !ready(sources)
                              ? 'Choose the application first.'
                              : undefined
                        }
                        onClick={startLive}
                      >
                        <Play size={15} />
                        Start live session
                      </button>
                    )}
                  </>
                )}
              </div>
            </section>
            {canChooseSources &&
              liveStatus?.available &&
              !preparing &&
              !finishing &&
              !live &&
              !simulated && (
                <SessionSources
                  value={sources}
                  onChange={setSources}
                  disabled={busy || startPending}
                />
              )}

            <MeetingNotes snapshot={state} />
            <KeepInHistory
              snapshot={state}
              onKept={() => setHistoryRevision((r) => r + 1)}
            />

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
                    <span className="tab-label">Notes</span>
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
                    <span className="tab-label">
                      Transcript{' '}
                      <span className="tab-count">
                        {state.transcript.length}
                      </span>
                    </span>
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
                      <div className="editor-footer-actions">
                        <span>{notes.length.toLocaleString()} / 20,000</span>
                        <button
                          type="button"
                          className={`dictation-button${notesDictating ? ' is-listening' : ''}`}
                          aria-label={
                            notesDictating ? 'Stop dictating' : 'Dictate note'
                          }
                          aria-pressed={notesDictating}
                          aria-describedby={
                            notesDictationBlock?.visibleHint
                              ? 'notes-dictation-hint'
                              : undefined
                          }
                          disabled={
                            notesDictating
                              ? dictation.busy
                              : !!notesDictationBlock
                          }
                          title={
                            notesDictating
                              ? 'Stop dictating'
                              : (notesDictationBlock?.reason ?? 'Dictate note')
                          }
                          onClick={() => toggleDictation('notes')}
                        >
                          {notesDictating ? (
                            <Square size={14} aria-hidden="true" />
                          ) : (
                            <Mic size={16} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </div>
                    {notesDictationFeedback && (
                      <p
                        className={
                          notesDictationFeedback.kind === 'error'
                            ? 'dictation-error'
                            : 'dictation-status'
                        }
                        role={
                          notesDictationFeedback.kind === 'error'
                            ? 'alert'
                            : 'status'
                        }
                      >
                        {notesDictationFeedback.kind === 'status' &&
                          notesDictating && (
                            <span
                              className="dictation-dot"
                              aria-hidden="true"
                            />
                          )}
                        {notesDictationFeedback.text}
                      </p>
                    )}
                    {!notesDictationFeedback &&
                      notesDictationBlock?.visibleHint && (
                        <p
                          id="notes-dictation-hint"
                          className="small muted dictation-hint"
                        >
                          {notesDictationBlock.reason}
                        </p>
                      )}
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
                          ? (sourcesHeading(
                              state.sources,
                              state.transcription,
                            ) ??
                            (sourceApp
                              ? `Audio from ${sourceApp} · ${transcribedWhere(state.transcription)}`
                              : `Your microphone · ${transcribedWhere(state.transcription)}`))
                          : 'Fictional replay · not from microphone audio'}
                      </p>
                    )}
                    {transcriptLines(state).length ? (
                      transcriptLines(state).map(({ segment, echo }) => (
                        <article
                          className={`transcript-segment${echo && !echo.kept ? ' is-echo' : ''}`}
                          key={segment.id}
                        >
                          <div className="transcript-segment-head">
                            <strong>{segment.speaker}</strong>
                            <time>{clockTime(segment.atMs)}</time>
                            {echo && !echo.kept && (
                              <span className="transcript-echo-label">
                                Likely an echo of Them · not used for cues
                              </span>
                            )}
                          </div>
                          <p>{segment.text}</p>
                          {echo && !echo.kept && (
                            <div className="transcript-echo-actions">
                              <button
                                className="secondary-button"
                                disabled={busy}
                                onClick={() =>
                                  void run(() =>
                                    bridge.command('resolve_echo_line', {
                                      id: segment.id,
                                      keep: true,
                                    }),
                                  )
                                }
                              >
                                It was me
                              </button>
                              <button
                                className="secondary-button transcript-echo-remove"
                                disabled={busy}
                                onClick={() =>
                                  void run(() =>
                                    bridge.command('resolve_echo_line', {
                                      id: segment.id,
                                      keep: false,
                                    }),
                                  )
                                }
                              >
                                Remove
                              </button>
                            </div>
                          )}
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
                  <h2>Cues</h2>
                </div>
                <CueCard
                  cue={state.cue}
                  size={state.questionSize}
                  busy={busy}
                  onDismiss={dismiss}
                  onHold={holdCue}
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
                              : 'During a live session, one cue at a time appears here. In this version cues come from simple phrase rules, not AI.'}
                      </p>
                    </div>
                  }
                />
                {(live || simulated) && (
                  <p className="companion-footnote">
                    {state.live && capture.state?.processor
                      ? capture.state.approved
                        ? 'Cues come from the model, using the lines approved for this session. Pause cues or turn the connection off above at any time.'
                        : 'Cues are off until you turn on the model connection in Cue processing above.'
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
                  Cue appearance and timing
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
                  <div className="focus-input-row">
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
                        if (skipFocusBlur.current) {
                          skipFocusBlur.current = false;
                          return;
                        }
                        if (
                          !clearButton.current ||
                          e.relatedTarget !== clearButton.current
                        )
                          saveFocus();
                      }}
                    />
                    <button
                      type="button"
                      className={`dictation-button${focusDictating ? ' is-listening' : ''}`}
                      aria-label={
                        focusDictating ? 'Stop dictating' : 'Dictate focus'
                      }
                      aria-pressed={focusDictating}
                      aria-describedby={
                        focusDictationBlock?.visibleHint
                          ? 'focus-dictation-hint'
                          : undefined
                      }
                      disabled={
                        focusDictating ? dictation.busy : !!focusDictationBlock
                      }
                      title={
                        focusDictating
                          ? 'Stop dictating'
                          : (focusDictationBlock?.reason ?? 'Dictate focus')
                      }
                      onMouseDown={() => {
                        if (!focusDictating && !focusDictationBlock) {
                          skipFocusBlur.current = true;
                        }
                      }}
                      onClick={() => {
                        skipFocusBlur.current = false;
                        toggleDictation('focus');
                      }}
                    >
                      {focusDictating ? (
                        <Square size={14} aria-hidden="true" />
                      ) : (
                        <Mic size={16} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                  {focusDictationFeedback && (
                    <p
                      className={
                        focusDictationFeedback.kind === 'error'
                          ? 'dictation-error'
                          : 'dictation-status'
                      }
                      role={
                        focusDictationFeedback.kind === 'error'
                          ? 'alert'
                          : 'status'
                      }
                    >
                      {focusDictationFeedback.kind === 'status' &&
                        focusDictating && (
                          <span className="dictation-dot" aria-hidden="true" />
                        )}
                      {focusDictationFeedback.text}
                    </p>
                  )}
                  {!focusDictationFeedback &&
                    focusDictationBlock?.visibleHint && (
                      <p
                        id="focus-dictation-hint"
                        className="small muted dictation-hint"
                      >
                        {focusDictationBlock.reason}
                      </p>
                    )}
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
                        leaves{' '}
                        {notMacos(platform) ? 'this computer' : 'this Mac'}.
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
                {live || preparing || finishing
                  ? 'This live session stays in memory while it runs. Nothing is kept unless you choose to keep it after it ends.'
                  : state.live
                    ? 'This session stays in memory until you quit or start another, unless you keep it in your meetings or export it.'
                    : 'Your notes stay in memory until you quit. Export anything you want to keep before closing.'}
              </p>
            </footer>
          </div>
        )}

        {view === 'meetings' && (
          <div className="secondary-page history-page">
            <MeetingHistory refreshKey={historyRevision} />
          </div>
        )}

        {view === 'settings' && (
          <div className="secondary-page settings-page">
            <h1>Make room for your conversation.</h1>
            <p className="page-description">
              A few controls to keep questions on your terms.
            </p>
            <ProviderKeys key={settingsEpoch} />
            {keysAvailable && (
              <section className="setting">
                <div>
                  <h2>Setup walkthrough</h2>
                  <p>
                    Review keys, permissions, and how per-session approval
                    works.
                  </p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={reopenOnboarding}
                >
                  Set up TalkQTE again
                </button>
              </section>
            )}
            <section className="setting">
              <div>
                <h2>Your name</h2>
                <p id="user-name-help">
                  In a live session, when someone asks you something by name,
                  such as “Sam, can you take the draft?”, the question is shown
                  as Asked you and stays while you answer. Questions for other
                  people stay quiet. TalkQTE remembers your name on{' '}
                  {notMacos(platform) ? 'this computer' : 'this Mac'}.
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
                    // Enter that confirms an input-method composition is not
                    // a submission. Safari reports it as keyCode 229 after
                    // compositionend.
                    if (
                      e.key === 'Enter' &&
                      !e.nativeEvent.isComposing &&
                      e.keyCode !== 229
                    )
                      saveName();
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
                  No camera access or video changes. TalkQTE remembers the
                  position you choose here; a place you drag the companion to
                  lasts until you quit.
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
            <CallPromptSetting key={settingsEpoch} />
            <MenuBarSettings key={`menu-bar-${settingsEpoch}`} />
            <section className="setting">
              <div>
                <h2 id="live-transcription" tabIndex={-1}>
                  Live transcription
                </h2>
                <p>
                  Start live session in the notebook to get questions from what
                  your microphone hears and, on a Mac, from one application you
                  choose, such as the app your call is in. TalkQTE does not
                  transcribe on this device: the session’s audio is sent to
                  Deepgram with your key once you enable cue processing for that
                  session. Audio is not recorded by TalkQTE. The transcript
                  stays in memory until you start another session or close the
                  app, unless you choose to keep the meeting and export it.
                </p>
                <p className="small muted" role="status">
                  {!liveStatus
                    ? 'Checking…'
                    : liveStatus.available
                      ? `Ready. Audio goes to ${liveStatus.transcription ?? 'the transcription service'} only after you enable cue processing for a session.`
                      : liveStatus.reason}
                </p>
              </div>
            </section>
            <MeetingHistorySettings
              onDeleted={() => setHistoryRevision((r) => r + 1)}
            />
            <SavedSettings
              onReset={() => {
                setPreferredListWidth(null);
                setNotesRatio(defaultNotesRatio);
                setUserName('');
                confirmedName.current = '';
                setNameError('');
                setSettingsEpoch((epoch) => epoch + 1);
              }}
            />
            <section className="setting">
              <div>
                <h2>Your data</h2>
                <p>
                  The optional microphone check retains no audio and does not
                  transcribe. With cloud transcription or cue processing on,
                  audio goes to the named transcription service and recent lines
                  to the cue provider, for that session only. A live session’s
                  transcript is kept in memory until you quit or start another
                  session, unless you keep that meeting after it ends or export
                  it. Notes exist in memory until you close the app. Exports
                  contain exactly the text you review and are saved to the
                  location you choose.
                </p>
              </div>
              <ShieldCheck size={24} />
            </section>
            <Diagnostics
              current={() => ({
                desktop: bridge.desktop,
                session: state,
                processing: capture.state ?? null,
                microphone: microphone.state,
                liveAvailable: liveStatus?.available ?? null,
              })}
            />
            <section className="coming-next">
              <h2>What comes next</h2>
              <p>
                A guided first-run setup, both sides of a call rather than the
                microphone alone, and a notebook that remembers your sessions.
                Integrations with other note-takers are planned for later.
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
        <div className="visually-hidden" role="status" aria-label="Cue">
          {cueNotice}
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
        <KeepMeetingChoice snapshot={state} onPreview={setPreview} />
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
