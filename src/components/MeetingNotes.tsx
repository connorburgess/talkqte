import { useEffect, useId, useRef, useState } from 'react';
import {
  cancelMeetingNotes,
  discardMeetingNotes,
  dollars,
  keepMeetingNotes,
  meetingNotesPlan,
  meetingNotesResult,
  planChanged,
  writeMeetingNotes,
  type CheckItem,
  type MeetingNotesDraft,
  type MeetingNotesResult,
} from '../lib/meetingNotes';
import type { Snapshot } from '../lib/types';
import './meeting-notes.css';

const sectionNames: Record<CheckItem['section'], string> = {
  summary: 'Summary',
  decisions: 'Decision',
  actions: 'Action item',
  openQuestions: 'Open question',
};

function message(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

/** After a live session with a transcript has ended: the person may generate
 * meeting notes in one click using their configured cue & notes provider key.
 * Checked notes are editable and join the export when kept. */
export function MeetingNotes({
  snapshot,
  openPlanTrigger = 0,
}: {
  snapshot: Snapshot;
  openPlanTrigger?: number;
}) {
  const id = useId();
  const phase = snapshot.meetingNotes ?? 'none';
  const ended =
    snapshot.live &&
    snapshot.status === 'ended' &&
    snapshot.transcript.length > 0;
  const [includeNotes, setIncludeNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MeetingNotesResult | null>(null);
  const [text, setText] = useState('');
  const sectionRef = useRef<HTMLElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const writeButton = useRef<HTMLButtonElement>(null);
  const session = useRef(phase);
  const handledTrigger = useRef(0);
  // Move focus to the checked notes once they are on screen.
  const focusResult = useRef(false);

  // A new session (phase back to none) clears whatever was on screen.
  useEffect(() => {
    if (phase === 'none' && session.current !== 'none') {
      setResult(null);
      setText('');
      setError('');
      setIncludeNotes(false);
    }
    session.current = phase;
  }, [phase]);

  // Draft, failure and kept notes live in Rust; read them when shown.
  useEffect(() => {
    if (phase !== 'draft' && phase !== 'failed' && phase !== 'kept') return;
    let live = true;
    meetingNotesResult().then(
      (next) => {
        if (!live) return;
        setResult(next);
        if (next.draft) setText(next.draft.markdown);
        else if (next.kept) setText(next.kept);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [phase]);

  // Triggered when the person clicks Write notes from the floating dock.
  useEffect(() => {
    if (!openPlanTrigger || openPlanTrigger <= handledTrigger.current) return;
    if (!ended) return;
    handledTrigger.current = openPlanTrigger;
    sectionRef.current?.scrollIntoView({ block: 'center' });
    if (phase === 'none') {
      requestAnimationFrame(() => writeButton.current?.focus());
    } else if (phase === 'draft') {
      resultHeading.current?.focus();
    }
  }, [openPlanTrigger, ended, phase]);

  useEffect(() => {
    if (focusResult.current && resultHeading.current) {
      focusResult.current = false;
      resultHeading.current.focus();
    }
  });

  const generate = async () => {
    setBusy(true);
    setError('');
    const notes = includeNotes;
    try {
      const plan = await meetingNotesPlan(notes);
      let draft: MeetingNotesDraft;
      try {
        draft = await writeMeetingNotes(notes, plan.fingerprint);
      } catch (failure) {
        const failureText = message(failure, 'No notes were written.');
        if (failureText.startsWith(planChanged)) {
          const refreshed = await meetingNotesPlan(notes);
          draft = await writeMeetingNotes(notes, refreshed.fingerprint);
        } else {
          throw failure;
        }
      }
      setResult({ draft, spentMicroUsd: draft.spentMicroUsd });
      setText(draft.markdown);
      focusResult.current = true;
    } catch (failure) {
      setError(message(failure, 'No notes were written.'));
      requestAnimationFrame(() => writeButton.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const act = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(message(failure, fallback));
    } finally {
      setBusy(false);
    }
  };

  const providerConsole = (providerName?: string) => {
    switch (providerName) {
      case 'OpenAI':
        return 'OpenAI Platform';
      case 'Gemini':
        return 'Google AI Studio';
      default:
        return 'Anthropic Console';
    }
  };
  if (!ended && phase === 'none') return null;
  const resultProvider = result?.providerName ?? result?.draft?.providerName;
  const resultCustom = result?.customModel ?? result?.draft?.customModel;
  const cost =
    result?.spentMicroUsd !== undefined && result?.spentMicroUsd !== null
      ? ` Estimated cost: about ${dollars(result.spentMicroUsd)}.`
      : resultCustom
        ? ` Estimated cost unavailable for custom model; check ${providerConsole(resultProvider)}.`
        : '';

  const chip =
    phase === 'writing'
      ? { label: 'Generating…', tone: 'is-checking' }
      : phase === 'draft'
        ? { label: 'Editable draft', tone: 'is-set' }
        : phase === 'kept'
          ? { label: 'Saved', tone: 'is-set' }
          : phase === 'failed'
            ? { label: 'Failed', tone: 'is-failed' }
            : phase === 'discarded'
              ? { label: 'Discarded', tone: '' }
              : null;

  return (
    <section
      ref={sectionRef}
      className="meeting-notes"
      aria-labelledby={`${id}-title`}
    >
      <div className="meeting-notes-head">
        <h2 id={`${id}-title`}>Meeting notes</h2>
        {chip && (
          <span
            className={`meeting-notes-chip${chip.tone ? ` ${chip.tone}` : ''}`}
            aria-hidden="true"
          >
            {chip.label}
          </span>
        )}
      </div>

      {phase === 'none' && (
        <>
          <p className="meeting-notes-help">
            Summary, decisions, action items, and open questions from this
            transcript, cited to the lines they came from.
          </p>
          <div className="meeting-notes-controls">
            <button
              ref={writeButton}
              className="primary-button"
              disabled={busy}
              onClick={() => void generate()}
            >
              Generate notes
            </button>
            <div className="meeting-notes-choice">
              <input
                id={`${id}-include`}
                type="checkbox"
                checked={includeNotes}
                disabled={busy}
                onChange={(event) => setIncludeNotes(event.target.checked)}
              />
              <label htmlFor={`${id}-include`}>Include my notes</label>
            </div>
          </div>
        </>
      )}

      {phase === 'writing' && (
        <div className="meeting-notes-writing">
          <p role="status">
            Writing meeting notes… This can take a minute or two.
          </p>
          <button
            className="secondary-button"
            onClick={() => void cancelMeetingNotes()}
          >
            Stop waiting
          </button>
        </div>
      )}

      {phase === 'draft' && result?.draft && (
        <div className="meeting-notes-result">
          <h3 ref={resultHeading} tabIndex={-1}>
            Check, edit, then keep or discard
          </h3>
          <p role="status">Model-written — verify against cited lines.{cost}</p>
          <label htmlFor={`${id}-text`}>Notes to keep, editable</label>
          <textarea
            id={`${id}-text`}
            value={text}
            disabled={busy}
            spellCheck
            onChange={(event) => setText(event.target.value)}
          />
          <details className="meeting-notes-sources">
            <summary>Where each item came from</summary>
            <ul>
              {result.draft.items.map((item, index) => (
                <li key={index}>
                  <p>
                    <strong>{sectionNames[item.section]}:</strong> {item.text}
                  </p>
                  <ul>
                    {item.sources.map((source) => (
                      <li key={source.label}>
                        <span className="meeting-notes-at">{source.label}</span>{' '}
                        “{source.text}”
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </details>
          <div className="meeting-notes-actions">
            <button
              className="primary-button"
              disabled={busy || !text.trim()}
              onClick={() =>
                void act(
                  () => keepMeetingNotes(text),
                  'The notes could not be kept.',
                )
              }
            >
              Keep with this meeting
            </button>
            <button
              className="secondary-button meeting-notes-danger"
              disabled={busy}
              onClick={() =>
                void act(
                  discardMeetingNotes,
                  'The notes could not be discarded.',
                )
              }
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {phase === 'kept' && (
        <div className="meeting-notes-result">
          <p role="status">
            Notes kept. Included when you export, after your own notes.
          </p>
          <pre>{result?.kept ?? text}</pre>
          <div className="meeting-notes-actions">
            <button
              className="secondary-button meeting-notes-danger"
              disabled={busy}
              onClick={() =>
                void act(discardMeetingNotes, 'The notes could not be removed.')
              }
            >
              Remove kept notes
            </button>
          </div>
        </div>
      )}

      {phase === 'failed' && result?.failure && !error && (
        <p role="alert" className="meeting-notes-error">
          {result.failure}
        </p>
      )}

      {phase === 'discarded' && (
        <p className="meeting-notes-help" role="status">
          Notes discarded. One request per meeting.
        </p>
      )}

      {error && (
        <p role="alert" className="meeting-notes-error">
          {error}
        </p>
      )}
    </section>
  );
}
