import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pause, Play, Square } from 'lucide-react';
import {
  describeSource,
  noteKey,
  processingApi,
  type ProcessingNote,
  type ProcessingReview,
  type ProcessingScope,
  type ProcessingSnapshot,
} from '../lib/processing';
import { ApplicationAudioStart } from './ApplicationAudioStart';
import './processing.css';

/** Present to assistive technology, absent from the visual layout. */
const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
} as const;

export const issueText = {
  labStopped:
    'Cues stopped: this strict development lab run ended. Start a new lab run and session to continue; Resume does not restart it.',
  labUnavailable:
    'Cues are off: the development lab provider, model, effort or local broker settings are unavailable. Correct the launch settings before starting a new run.',
  devSettings:
    'Cues are off: TALKQTE_DEV_MODEL_CONNECTION must be on or absent, and TALKQTE_DEV_MODEL_CALLS must be a whole number from 1 to 100. Correct the launch settings and relaunch.',
  callLimit:
    'Cues stopped: the development model call limit was reached. Nothing more will be sent in this session. Stop the session before starting another run.',
  scopeChanged:
    'Cues stopped: an approved note changed. Turn the model connection on again to continue.',
  inputLimit:
    'Cues stopped: the conversation lines were too long to send. Nothing more will be sent until you turn the model connection on again.',
  misconfigured:
    'Cues are off: TALKQTE_CUE_MODEL or TALKQTE_CUE_EFFORT names an option this build does not have. Nothing can be sent.',
  authentication:
    'Cues are off: Claude Code is not installed, needs updating, or is not signed in to a Claude subscription. Fix that in Claude Code, then turn the model connection on again.',
  credentials:
    'Cues are off: an API key or provider setting is present, and this connection uses only your Claude subscription. Nothing was sent.',
  unreachable:
    'Cues stopped: the model could not be reached. Nothing more will be sent until you turn the model connection on again.',
  timedOut:
    'Cues stopped: the model took too long to reply twice in a row. Nothing more will be sent until you turn the model connection on again.',
  invalidReply:
    "Cues stopped: the model's reply could not be used. Nothing more will be sent until you turn the model connection on again.",
  allowance:
    'Cues stopped: your Claude usage or rate limit was reached. Nothing more will be sent, and no other service will be used.',
  rateLimit:
    "Cues stopped: the model's rate limit was reached. Nothing more will be sent, and it will not retry.",
  worker:
    'Cues stopped: the model connection stopped working. Nothing more will be sent until you turn it on again.',
};
export function processingIssueText(
  issue: keyof typeof issueText,
  provider = 'Claude',
  lab = false,
): string {
  if (!lab) return issueText[issue];
  if (
    issue === 'labStopped' ||
    issue === 'labUnavailable' ||
    issue === 'callLimit' ||
    issue === 'devSettings'
  )
    return issueText[issue];
  const reason =
    issue === 'timedOut'
      ? 'the model exceeded its deadline'
      : issue === 'authentication'
        ? `${provider} subscription sign-in or CLI setup is unavailable`
        : issue === 'credentials'
          ? 'the subscription authentication policy was not met'
          : issue === 'allowance' || issue === 'rateLimit'
            ? `${provider} usage or rate limit was reached`
            : issue === 'invalidReply'
              ? 'the model reply failed validation'
              : 'the development model connection failed';
  return `Cues stopped: ${reason}. Nothing more will be sent in this strict lab run. Start a new lab run and session to continue.`;
}
function NoteLabel({ note }: { note: ProcessingNote }) {
  return (
    <>
      <strong>{note.title}</strong>
      <span>
        {note.provider === 'granola' ? 'Granola' : 'Imported file'} ·{' '}
        {note.sourceDate} · prior note
      </span>
    </>
  );
}
function conversationLabel(scope: ProcessingScope) {
  return scope.conversation === 'newSpeechOnly'
    ? 'New speech only, from approval'
    : 'Recent conversation and new speech';
}

/** The notebook supplies its shared native status and owns capture controls.
 * Standalone mounting is retained for the fictional control-contract tests. */
export function ProcessingControl({
  status,
}: {
  status?: {
    snapshot: ProcessingSnapshot | null;
    failed: boolean;
    refresh: () => Promise<ProcessingSnapshot>;
  };
}) {
  const [snapshot, setSnapshot] = useState<ProcessingSnapshot | null>(null);
  const current = useRef<ProcessingSnapshot | null>(null);
  const [editing, setEditing] = useState(false);
  const [recent, setRecent] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<ProcessingReview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const serial = useRef(0);
  const alive = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const editHeading = useRef<HTMLHeadingElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  const stopRequested = useRef(false);
  const isEditing = useRef(false);
  const panel = useRef<HTMLElement>(null);
  isEditing.current = editing || !!review;

  function receive(next: ProcessingSnapshot) {
    if (
      !alive.current ||
      (current.current && next.revision <= current.current.revision)
    )
      return;
    const old = current.current;
    current.current = next;
    setSnapshot(next);
    if (old && old.stopTarget.operation !== next.stopTarget.operation)
      stopRequested.current = false;
    if (
      stopRequested.current &&
      (next.microphone ?? next.capture) === 'off' &&
      next.startup === 'idle'
    ) {
      stopRequested.current = false;
      restoreFocus.current = true;
    }
    if (
      old &&
      (old.session !== next.session ||
        old.scopeRevision !== next.scopeRevision ||
        next.capture !== 'running')
    ) {
      restoreFocus.current ||=
        isEditing.current &&
        (!status || !!panel.current?.contains(document.activeElement));
      serial.current += 1;
      setBusy(null);
      setEditing(false);
      setReview(null);
      setSelected([]);
      setRecent(false);
      setError('');
    }
  }
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      serial.current += 1;
    };
  }, []);
  useLayoutEffect(() => {
    if (status?.snapshot) receive(status.snapshot);
  }, [status?.snapshot]);
  useEffect(() => {
    if (status) return;
    alive.current = true;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void processingApi
      .listen(receive)
      .then(async (release) => {
        if (disposed) {
          release();
          return;
        }
        unlisten = release;
        const next = await processingApi.snapshot();
        if (!disposed) receive(next);
      })
      .catch(() => {
        if (!disposed)
          setError(
            'The model connection status could not be read. You can still request Stop capture.',
          );
      });
    return () => {
      disposed = true;
      alive.current = false;
      serial.current += 1;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
    else if (editing) editHeading.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      (launcher.current ?? statusHeading.current)?.focus();
    }
  }, [
    review,
    editing,
    snapshot?.capture,
    snapshot?.microphone,
    snapshot?.startup,
    snapshot?.source?.phase,
  ]);

  // Disabling removes the button that was pressed. When that drops focus to
  // the page, it goes to Review processing; focus that has moved to another
  // control or application is left alone.
  const disabled = useRef(false);
  useEffect(() => {
    if (!disabled.current || busy) return;
    disabled.current = false;
    if (document.hasFocus() && document.activeElement === document.body)
      launcher.current?.focus();
  }, [busy, snapshot]);

  async function closeReview() {
    const ticket = ++serial.current;
    restoreFocus.current = true;
    const id = review?.id;
    setReview(null);
    setEditing(false);
    setBusy(null);
    setError('');
    setSelected([]);
    setRecent(false);
    if (id)
      await processingApi.cancel(id).catch(() => {
        if (alive.current && ticket === serial.current)
          setError(
            'The review could not be cleared. It has not been approved.',
          );
      });
  }
  async function prepare() {
    if (!snapshot?.processor) return;
    const scope: ProcessingScope = {
      conversation: recent ? 'recentAndNewSpeech' : 'newSpeechOnly',
      notes: snapshot.notes
        .filter((note) => selected.includes(noteKey(note)))
        .map(({ provider, sourceId, revision }) => ({
          provider,
          sourceId,
          revision,
        })),
    };
    const ticket = ++serial.current;
    setBusy('review');
    setError('');
    try {
      const result = await processingApi.review(snapshot, scope);
      if (!alive.current || ticket !== serial.current) {
        void processingApi.cancel(result.id).catch(() => {});
        return;
      }
      if (
        result.session !== current.current?.session ||
        result.scopeRevision !== current.current?.scopeRevision ||
        result.processor.id !== snapshot.processor.id ||
        result.processor.revision !== snapshot.processor.revision ||
        result.scope.conversation !== scope.conversation ||
        result.scope.notes.map(noteKey).sort().join() !==
          scope.notes.map(noteKey).sort().join() ||
        result.notes.map(noteKey).sort().join() !==
          scope.notes.map(noteKey).sort().join()
      ) {
        void processingApi.cancel(result.id).catch(() => {});
        throw 'scope_changed';
      }
      setReview(result);
    } catch (failure) {
      if (alive.current && ticket === serial.current)
        setError(
          failure === 'input_limit'
            ? 'These notes exceed the processing limit. Choose fewer and review again.'
            : failure === 'scope_changed'
              ? 'Sources changed before review. Choose the current notes and try again.'
              : 'Could not prepare the review. Nothing new was approved. Try again.',
        );
    } finally {
      if (alive.current && ticket === serial.current) setBusy(null);
    }
  }
  async function act(kind: string, action: () => Promise<void>) {
    const ticket = ++serial.current;
    setBusy(kind);
    if (kind === 'stop') stopRequested.current = true;
    setError('');
    restoreFocus.current = isEditing.current;
    if (kind !== 'approve') {
      setReview(null);
      setEditing(false);
    }
    try {
      await action();
      if (alive.current)
        receive(await (status ? status.refresh() : processingApi.snapshot()));
    } catch {
      // A response can fail after the native action applied. Refresh state once;
      // never repeat an approval, stop or provider operation automatically.
      try {
        if (alive.current)
          receive(await (status ? status.refresh() : processingApi.snapshot()));
      } catch {
        /* Keep the last known capture state and explicit Stop control. */
      }
      if (alive.current && ticket === serial.current) {
        if (kind === 'approve') {
          // Native reviews are single-use even if approval fails. Require a
          // fresh review instead of retrying with a potentially consumed ID.
          if (review) void processingApi.cancel(review.id).catch(() => {});
          setReview(null);
        }
        setError(
          kind === 'stop'
            ? 'Stop was not confirmed. Check the current status, then try again.'
            : kind === 'approve'
              ? 'Approval was not confirmed. Check the status and review sources again before enabling.'
              : 'The change was not confirmed. Check the current status and try again.',
        );
      }
    } finally {
      if (alive.current && ticket === serial.current) setBusy(null);
    }
  }
  const capture = snapshot?.capture;
  // The microphone alone. A development build reports it beside a combined
  // capture that includes a selected application; otherwise they are one.
  const microphone = snapshot?.microphone ?? capture;
  const sourceLine = describeSource(snapshot?.source);
  // Offered while the source is starting or capturing and Stop has not yet
  // been asked; afterwards the line says how cleanup is going.
  const sourceOperation =
    snapshot?.source &&
    (snapshot.source.phase === 'starting' ||
      snapshot.source.phase === 'listening')
      ? snapshot.source.operation
      : null;
  const startup = snapshot?.startup;
  const cancelStart =
    microphone === 'off' && (startup === 'loading' || startup === 'cancelling');
  const canReview =
    capture === 'running' &&
    (snapshot?.phase === 'off' || snapshot?.phase === 'unavailable') &&
    !status?.failed &&
    snapshot?.issue !== 'callLimit' &&
    snapshot?.issue !== 'devSettings' &&
    !!snapshot.processor &&
    !snapshot.approved;
  const approved = snapshot?.approved;
  const active = snapshot?.phase === 'active';
  const paused = snapshot?.phase === 'paused';
  const location =
    snapshot?.processor?.location === 'hosted'
      ? `Hosted by ${snapshot.processor.destination}`
      : 'On this device';
  const phase = status?.failed
    ? 'Connection status unknown'
    : !snapshot
      ? 'Checking the model connection…'
      : !snapshot.processor && status
        ? 'No model connection'
        : {
            off: 'Model connection off',
            active: 'Model connection on',
            paused: 'Cues paused',
            unavailable: 'Cues off',
            stopping: 'Finishing session',
            ended: 'Session ended',
          }[snapshot.phase];

  return (
    <section
      ref={panel}
      className="processing-panel"
      aria-labelledby="processing-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && editing && busy !== 'approve') {
          event.preventDefault();
          void closeReview();
        }
      }}
    >
      <div className="processing-heading">
        <h2 id="processing-title" ref={statusHeading} tabIndex={-1}>
          Cue processing
        </h2>
        <span role="status">{phase}</span>
      </div>
      {!status && (
        <p className="processing-capture">
          {microphone === 'running'
            ? 'Microphone is on. Stop capture to stop listening.'
            : microphone === 'stopping'
              ? 'Waiting for the microphone to stop…'
              : microphone === 'starting'
                ? 'Starting microphone… you can stop while it starts.'
                : microphone === 'off'
                  ? 'Microphone is off.'
                  : 'Microphone status is unknown. Use Stop capture to request that it stops.'}
        </p>
      )}
      {snapshot?.source && (
        // Mounted whenever the snapshot reports a source, so its first line
        // is announced as a change. Kept out of the layout while empty.
        <p
          className="processing-capture"
          role="status"
          style={sourceLine ? undefined : visuallyHidden}
        >
          {sourceLine}
        </p>
      )}
      {snapshot?.source &&
        ['off', 'listing', 'reviewing'].includes(snapshot.source.phase) && (
          // Only a native-audio-spike build reports a source at all.
          <ApplicationAudioStart />
        )}
      {sourceOperation && (
        // The source's own Stop: it ends exactly this application source,
        // and a session started for it alone, without touching a microphone.
        <div className="processing-actions">
          <button
            className="secondary-button"
            disabled={busy === 'source'}
            onClick={() =>
              void act('source', async () => {
                // This button goes once Stop is under way, which the status
                // event can report before the command replies. Keep focus in
                // the panel either way; drop the intent if the request fails.
                restoreFocus.current = true;
                try {
                  await processingApi.stopSource(sourceOperation);
                } catch (error) {
                  restoreFocus.current = false;
                  throw error;
                }
              })
            }
          >
            <Square size={17} />
            {busy === 'source' ? 'Stopping…' : 'Stop application audio'}
          </button>
        </div>
      )}
      {!status && startup && startup !== 'idle' && (
        <p role="status" className="processing-muted">
          {startup === 'loading'
            ? 'Preparing the live session… you can cancel before it starts.'
            : startup === 'cancelling'
              ? 'Start cancelled. Waiting for preparation to finish before you can start again.'
              : 'Live startup status is unavailable. You can still request Stop capture.'}
        </p>
      )}
      {snapshot?.processor && (
        <p>
          <strong>{snapshot.processor.name}</strong> · {location}
        </p>
      )}
      {!snapshot?.processor && snapshot && (
        <p>No model cues: this build has no model connection.</p>
      )}
      {status?.failed && (
        <p className="processing-message">
          Refresh capture status above before turning the model connection on or
          off.
        </p>
      )}
      {snapshot?.issue && (
        <p className="processing-message" role="status">
          {processingIssueText(
            snapshot.issue,
            snapshot.processor?.name,
            snapshot.processor?.id === 'lab-subscription',
          )}
        </p>
      )}
      {snapshot?.processor?.id === 'lab-subscription' && (
        <p className="processing-muted">
          Fictional development lab. Pause, Dismiss, Off and Stop end this
          strict run; Resume does not restart it. The lab shares a CLI-dispatch
          budget across roles; underlying provider request count is unobserved.
        </p>
      )}
      {snapshot?.phase === 'off' && snapshot.processor && !snapshot.issue && (
        <p className="processing-muted">
          Cues are off until you turn on the model connection.
        </p>
      )}
      {active && snapshot?.sending && (
        <p className="processing-muted" role="status">
          {snapshot.processor?.name.startsWith('Claude')
            ? 'Sending recent lines to Claude…'
            : snapshot.processor?.name === 'Codex'
              ? 'Sending recent lines to Codex…'
              : 'Sending recent lines to the model…'}
        </p>
      )}
      {active && snapshot?.lastDecision === 'quiet' && (
        <p className="processing-muted">No cue needed for the latest lines.</p>
      )}
      {snapshot?.approvalBySetting && (
        <p className="processing-muted">
          Model connection approved by the TALKQTE_DEV_MODEL_CONNECTION=on
          launch setting for this session. Only recent and new conversation
          lines are approved; no prior notes. Off, Pause cues and Stop remain
          available.
        </p>
      )}
      {approved && (
        <details className="processing-approved">
          <summary>Approved sources for this session</summary>
          <p>{conversationLabel(approved)}</p>
          {approved.notes.length ? (
            <ul>
              {snapshot?.notes
                .filter((note) =>
                  approved.notes.some(
                    (item) => noteKey(item) === noteKey(note),
                  ),
                )
                .map((note) => (
                  <li key={noteKey(note)}>
                    <NoteLabel note={note} />
                  </li>
                ))}
            </ul>
          ) : (
            <p>No prior notes approved.</p>
          )}
        </details>
      )}
      <div className="processing-actions">
        {!editing && canReview && (
          <button
            ref={launcher}
            className="primary-button"
            disabled={!!busy || !!status?.failed}
            onClick={() => {
              setSelected([]);
              setRecent(false);
              setEditing(true);
              setError('');
            }}
          >
            Review processing
          </button>
        )}
        {(active || paused) && (
          <button
            className="secondary-button"
            disabled={!!busy || !!status?.failed}
            onClick={() =>
              void act('pause', () => processingApi.pause(snapshot!, !paused))
            }
          >
            {paused ? <Play size={17} /> : <Pause size={17} />}
            {paused ? 'Resume cues' : 'Pause cues'}
          </button>
        )}
        {approved && (
          <button
            className="secondary-button"
            disabled={
              busy === 'disable' ||
              busy === 'stop' ||
              capture === 'stopping' ||
              !!status?.failed
            }
            onClick={() => {
              disabled.current = true;
              void act('disable', () => processingApi.disable(snapshot!));
            }}
          >
            Disable processing
          </button>
        )}
        {!status && (microphone !== 'off' || startup !== 'idle') && (
          <button
            className="secondary-button"
            disabled={
              busy === 'stop' ||
              microphone === 'stopping' ||
              (cancelStart && startup === 'cancelling')
            }
            onClick={() =>
              void act('stop', async () => {
                const origin = snapshot ?? (await processingApi.snapshot());
                await processingApi.stop(origin.stopTarget);
              })
            }
          >
            <Square size={17} />
            {cancelStart
              ? startup === 'cancelling' || busy === 'stop'
                ? 'Cancelling…'
                : 'Cancel start'
              : busy === 'stop' || microphone === 'stopping'
                ? 'Stopping…'
                : 'Stop capture'}
          </button>
        )}
      </div>
      {approved && (
        <p className="processing-muted">
          Pause and Disable processing leave the microphone on. Disable
          processing before choosing different sources.
          {status && ' Use Stop live session above to release the microphone.'}
        </p>
      )}
      {editing && !review && (
        <form
          className="processing-review"
          onSubmit={(event) => {
            event.preventDefault();
            void prepare();
          }}
        >
          <h3 ref={editHeading} tabIndex={-1}>
            Choose what to process
          </h3>
          <p>{snapshot?.processor?.dataPolicy}</p>
          <fieldset disabled={!!busy || !!status?.failed}>
            <legend>Conversation</legend>
            <p>New speech after approval is included.</p>
            <label className="processing-option">
              <input
                type="checkbox"
                checked={recent}
                onChange={(event) => setRecent(event.target.checked)}
              />
              Also include recent conversation
            </label>
          </fieldset>
          {snapshot?.processor?.acceptsNotes === false ? (
            <p>Prior notes are never sent to this processor.</p>
          ) : (
            <>
              <fieldset disabled={!!busy || !!status?.failed}>
                <legend>Prior notes · optional</legend>
                <p>Importing a note does not approve it for processing.</p>
                {snapshot?.notes.length ? (
                  <div className="processing-notes">
                    {snapshot.notes.map((note) => (
                      <label
                        className="processing-option processing-note"
                        key={noteKey(note)}
                      >
                        <input
                          type="checkbox"
                          checked={selected.includes(noteKey(note))}
                          onChange={(event) =>
                            setSelected((items) =>
                              event.target.checked
                                ? [...items, noteKey(note)]
                                : items.filter((id) => id !== noteKey(note)),
                            )
                          }
                        />
                        <span>
                          <NoteLabel note={note} />
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p>
                    No prior notes imported. You can continue with new speech
                    only.
                  </p>
                )}
              </fieldset>
            </>
          )}
          <div className="processing-actions">
            <button
              className="primary-button"
              disabled={!!busy || !!status?.failed}
              type="submit"
            >
              {busy === 'review'
                ? 'Preparing review…'
                : 'Review selected sources'}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void closeReview()}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {review && (
        <div className="processing-review">
          <h3 ref={reviewHeading} tabIndex={-1}>
            Review before enabling
          </h3>
          <dl>
            <dt>Processor</dt>
            <dd>
              {review.processor.name} · {review.processor.model}
            </dd>
            <dt>Processing location</dt>
            <dd>
              {review.processor.location === 'hosted'
                ? `Sent to ${review.processor.destination}`
                : 'On this device'}
            </dd>
            <dt>Conversation</dt>
            <dd>{conversationLabel(review.scope)}</dd>
            <dt>Prior notes</dt>
            <dd>
              {review.notes.length ? (
                <ul>
                  {review.notes.map((note) => (
                    <li key={noteKey(note)}>
                      <NoteLabel note={note} />
                    </li>
                  ))}
                </ul>
              ) : (
                'None'
              )}
            </dd>
          </dl>
          <p>{review.processor.dataPolicy}</p>
          <p>
            This approval ends with this session. A changed approved note
            requires another review.
          </p>
          <div className="processing-actions">
            <button
              className="primary-button"
              disabled={!!busy || !!status?.failed}
              onClick={() =>
                void act('approve', () => processingApi.approve(review.id))
              }
            >
              {busy === 'approve' ? 'Enabling…' : 'Enable for this session'}
            </button>
            <button
              className="secondary-button"
              disabled={busy === 'approve'}
              onClick={() => void closeReview()}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="processing-message" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
