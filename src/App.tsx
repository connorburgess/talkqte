import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  Check,
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
import { clockTime, type CueSnapshot, type Snapshot } from './lib/types';
import { Question } from './components/Question';

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
  return (
    <main className="floating-surface">
      {state?.cue ? (
        <Question
          cue={state.cue}
          paused={state.status !== 'running'}
          busy={busy}
          onRespond={(response) =>
            void run(() =>
              bridge.command('respond_to_cue', { id: state.cue!.id, response }),
            )
          }
        />
      ) : (
        <p className="floating-empty">A little room to think.</p>
      )}
      {error && (
        <p role="alert" className="floating-error">
          {error}
        </p>
      )}
    </main>
  );
}

function Notebook() {
  const { state, error, setError, busy, run } = useSession<Snapshot>();
  const [view, setView] = useState<'notebook' | 'saved' | 'settings'>(
    'notebook',
  );
  const [tab, setTab] = useState<'notes' | 'transcript'>('notes');
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState('');
  const initialized = useRef(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const modal = useRef<HTMLDialogElement>(null);
  const exportButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state && !initialized.current) {
      initialized.current = true;
      setNotes(state.notes);
    }
  }, [state]);
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
  const matches = `${state.title} ${state.description} demo`
    .toLowerCase()
    .includes(search.toLowerCase().trim());
  const respond = (response: 'save' | 'dismiss') => {
    if (!state.cue) return;
    void run(async () => {
      await bridge.command('respond_to_cue', { id: state.cue!.id, response });
      setNotice(
        response === 'save'
          ? 'Question saved to your notebook.'
          : 'Question dismissed.',
      );
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
          <button
            className={view === 'saved' ? 'nav-item selected' : 'nav-item'}
            aria-current={view === 'saved' ? 'page' : undefined}
            onClick={() => setView('saved')}
          >
            <Bookmark size={19} />
            Saved questions
            <span className="nav-count">{state.saved.length}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <ShieldCheck size={20} />
            <p>
              A space to think.
              <br />
              <span>This prototype captures no audio.</span>
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
                <span className="demo-tag">Demo meeting</span>
                <ChevronRight size={15} />
              </div>
              <strong>{state.title}</strong>
              <p>A welcome guide for the garden</p>
              <span className="meeting-meta">
                Robin & Alex <span>1m 44s</span>
              </span>
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
            <span>
              {view === 'notebook'
                ? 'Notebook'
                : view === 'saved'
                  ? 'Saved questions'
                  : 'Settings'}
            </span>
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
                <div className="participants">
                  <span className="avatar">R</span>
                  <span className="avatar second">A</span>
                  <span>Robin & Alex</span>
                  <span className="meta-divider" />
                  <span>Fictional demo</span>
                </div>
              </div>
              <button
                ref={exportButton}
                className="secondary-button export-button"
                onClick={prepareExport}
                disabled={busy}
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
                    {state.status === 'running'
                      ? 'Demo in progress'
                      : state.status === 'paused'
                        ? 'Demo paused'
                        : state.status === 'ended'
                          ? 'Demo finished'
                          : 'Ready when you are'}
                  </strong>
                  <span>No audio captured</span>
                </div>
              </div>
              <div className="session-actions">
                <span className="session-clock">
                  {clockTime(state.elapsedMs)}
                  <span> / {clockTime(state.durationMs)}</span>
                </span>
                {active ? (
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
                    {state.status === 'ended' ? 'Replay demo' : 'Try demo'}
                  </button>
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
                      <p>
                        Jot down what matters. Save a question when you want to
                        come back to it.
                      </p>
                    </div>
                    <label className="visually-hidden" htmlFor="meeting-notes">
                      Meeting notes
                    </label>
                    <textarea
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
                    <SavedQuestions saved={state.saved} compact />
                  </div>
                ) : (
                  <div
                    id="transcript-panel"
                    role="tabpanel"
                    aria-labelledby="transcript-tab"
                    className="transcript"
                  >
                    <p className="muted small">
                      Scripted conversation · no microphone or system audio
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
                          Try the demo to watch the fictional transcript arrive.
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
                    cue={state.cue}
                    paused={state.status === 'paused'}
                    busy={busy}
                    onRespond={respond}
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
                          ? 'Your saved questions and notes are still here. Export them before closing the app.'
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
                  Suggestions in this demo use simple phrase rules. Save what
                  helps; let the rest pass.
                </p>
                <button
                  className="text-button companion-settings"
                  onClick={() => setView('settings')}
                >
                  <Settings size={14} />
                  Adjust question timing
                </button>
              </aside>
            </div>
            <footer className="notebook-footer">
              <ShieldCheck size={15} />
              <p>
                This demo stays in memory. Export anything you want to keep
                before closing.
              </p>
            </footer>
          </div>
        )}

        {view === 'saved' && (
          <div className="secondary-page">
            <h1>Saved questions</h1>
            <p className="page-description">
              A place for the things worth coming back to.
            </p>
            <SavedQuestions saved={state.saved} />
            {state.saved.length > 0 && (
              <button
                className="secondary-button"
                onClick={prepareExport}
                disabled={busy}
              >
                <ArrowUpRight size={16} />
                Review export
              </button>
            )}
            <button
              className="text-button back-link"
              onClick={() => setView('notebook')}
            >
              Back to the notebook
              <ChevronRight size={15} />
            </button>
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
                    ? 'Show a small window above the notebook while a question is active. You can always respond from the notebook.'
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
                <h2>Your data in this prototype</h2>
                <p>
                  No audio is captured. Notes and saved questions exist in
                  memory until you close the app. Exports contain exactly the
                  text you review and are saved to the location you choose.
                </p>
              </div>
              <ShieldCheck size={24} />
            </section>
            <section className="coming-next">
              <h2>What comes next</h2>
              <p>
                Local Whisper transcription, microphone and meeting audio, and a
                notebook that remembers your sessions. Integrations with other
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

function SavedQuestions({
  saved,
  compact = false,
}: {
  saved: Snapshot['saved'];
  compact?: boolean;
}) {
  return (
    <section
      className={compact ? 'saved-questions compact' : 'saved-questions'}
      aria-label="Saved questions"
    >
      {compact && (
        <h2>
          <Bookmark size={16} />
          Saved questions <span>{saved.length}</span>
        </h2>
      )}
      {saved.length ? (
        saved.map((cue) => (
          <article className="saved-question" key={cue.sourceId}>
            <Check size={17} />
            <div>
              <h3>{cue.question}</h3>
              <p>{cue.evidence}</p>
            </div>
          </article>
        ))
      ) : compact ? (
        <p className="muted small">
          Useful questions will land here when you save them.
        </p>
      ) : (
        <div className="empty-inline">
          <Bookmark size={28} />
          <h2>Keep a question for later.</h2>
          <p>
            Try the demo and save a suggestion. It will stay here even after the
            moment passes.
          </p>
        </div>
      )}
    </section>
  );
}

export default function App() {
  return floating ? <FloatingQuestion /> : <Notebook />;
}
