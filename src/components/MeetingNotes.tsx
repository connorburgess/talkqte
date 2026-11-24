import { useEffect, useId, useRef, useState } from 'react';
import {
  cancelMeetingNotes,
  discardMeetingNotes,
  dollars,
  keepMeetingNotes,
  meetingNotesPlan,
  meetingNotesResult,
  notesModels,
  planChanged,
  writeMeetingNotes,
  type CheckItem,
  type MeetingNotesDraft,
  type MeetingNotesPlan,
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

/** After a live session with a transcript has ended: the person may ask,
 * once, for meeting notes written by a model with their own Anthropic key.
 * Nothing is sent until they confirm a plan that says what goes where and
 * roughly what it costs. The checked notes are editable and join the export
 * only if the person keeps them. */
export function MeetingNotes({ snapshot }: { snapshot: Snapshot }) {
  const id = useId();
  const phase = snapshot.meetingNotes ?? 'none';
  const ended =
    snapshot.live &&
    snapshot.status === 'ended' &&
    snapshot.transcript.length > 0;
  const [plan, setPlan] = useState<MeetingNotesPlan | null>(null);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<MeetingNotesResult | null>(null);
  const [text, setText] = useState('');
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const writeButton = useRef<HTMLButtonElement>(null);
  const session = useRef(phase);
  // Move focus to the checked notes once they are on screen.
  const focusResult = useRef(false);

  // A new session (phase back to none) clears whatever was on screen.
  useEffect(() => {
    if (phase === 'none' && session.current !== 'none') {
      setPlan(null);
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

  // Focus the confirmation when it opens, not when it is re-planned.
  const planOpen = plan !== null;
  useEffect(() => {
    if (planOpen) confirmHeading.current?.focus();
  }, [planOpen]);

  // The person's notes changed while they are set to be sent: show the
  // plan for what would now be sent.
  const notesText = snapshot.notes;
  useEffect(() => {
    if (planOpen && includeNotes) void openPlan(true);
  }, [notesText]);

  useEffect(() => {
    if (focusResult.current && resultHeading.current) {
      focusResult.current = false;
      resultHeading.current.focus();
    }
  });

  const openPlan = async (notes: boolean) => {
    setBusy(true);
    setError('');
    try {
      setPlan(await meetingNotesPlan(notes));
    } catch (failure) {
      setPlan(null);
      setError(
        message(
          failure,
          'The request could not be prepared. Nothing was sent.',
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!plan) return;
    setBusy(true);
    setError('');
    const notes = includeNotes;
    const confirmed = plan.fingerprint;
    setPlan(null);
    try {
      const draft: MeetingNotesDraft = await writeMeetingNotes(
        notes,
        confirmed,
      );
      setResult({ draft, spentMicroUsd: draft.spentMicroUsd });
      setText(draft.markdown);
      focusResult.current = true;
    } catch (failure) {
      const text = message(failure, 'No notes were written.');
      setError(text);
      // What would be sent changed: show the new plan to confirm again.
      if (text.startsWith(planChanged)) await openPlan(notes);
      else requestAnimationFrame(() => writeButton.current?.focus());
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

  const care = (id: string) =>
    notesModels.find((model) => model.id === id)?.label ?? 'Custom';
  if (!ended && phase === 'none') return null;
  const cost =
    result?.spentMicroUsd !== undefined
      ? ` Estimated cost of this request: about ${dollars(result.spentMicroUsd)} (an estimate, not your bill).`
      : ' The API did not report what this request cost; your Anthropic Console shows it.';

  return (
    <section className="meeting-notes" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Meeting notes</h2>

      {phase === 'none' && !plan && (
        <>
          <p className="meeting-notes-help">
            A model can write a short summary, decisions, action items and open
            questions from this meeting's transcript, using your Anthropic key.
            You see what will be sent and an estimated cost first; nothing is
            sent until you confirm. Each meeting gets one request.
          </p>
          <button
            ref={writeButton}
            className="secondary-button"
            disabled={busy}
            onClick={() => void openPlan(false)}
          >
            Write meeting notes…
          </button>
        </>
      )}

      {phase === 'none' && plan && (
        <div
          className="meeting-notes-confirm"
          role="group"
          aria-labelledby={`${id}-confirm`}
        >
          <h3 id={`${id}-confirm`} ref={confirmHeading} tabIndex={-1}>
            Send this meeting to Anthropic?
          </h3>
          <p>
            This sends this session's transcript: {plan.transcriptLines}{' '}
            {plan.transcriptLines === 1 ? 'line' : 'lines'}, about{' '}
            {plan.minutes} {plan.minutes === 1 ? 'minute' : 'minutes'} (
            {plan.kilobytes} KB), with each line's time but no speaker labels.{' '}
            {plan.noteLines === undefined
              ? 'Your notes are not sent.'
              : `Your notes are sent too: ${plan.noteLines} ${plan.noteLines === 1 ? 'line' : 'lines'}.`}{' '}
            Your session name, focus lines, imported notes and the cues shown
            are never sent.
          </p>
          <div className="meeting-notes-choice">
            <input
              id={`${id}-include`}
              type="checkbox"
              checked={includeNotes}
              disabled={busy}
              onChange={(event) => {
                setIncludeNotes(event.target.checked);
                void openPlan(event.target.checked);
              }}
            />
            <label htmlFor={`${id}-include`}>Also send my notes</label>
          </div>
          <p>To: {plan.destination}.</p>
          <p>
            Notes setting: {care(plan.model)}, model {plan.model}. Change it in
            Settings before sending.
          </p>
          <p>
            Estimated cost: about {dollars(plan.likelyMicroUsd)}, at most{' '}
            {dollars(plan.worstMicroUsd)}
            {plan.cueSpentMicroUsd
              ? `, on top of about ${dollars(plan.cueSpentMicroUsd)} for this meeting's cues`
              : ''}
            . An estimate, not your bill; one meeting's notes may not be
            estimated above {dollars(plan.spendCapMicroUsd)}.
          </p>
          <p>
            One request, no retry: if it fails, nothing more is sent for this
            meeting. Anthropic handles what is sent under your API account's
            terms, and it cannot be recalled once sent.
          </p>
          <div className="meeting-notes-actions">
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void send()}
            >
              Send and write notes
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setPlan(null);
                setIncludeNotes(false);
                requestAnimationFrame(() => writeButton.current?.focus());
              }}
            >
              Cancel
            </button>
          </div>
        </div>
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
          <p role="status">
            Written by a model, which can still be wrong. Each item ends with
            the transcript times or note lines it came from. An owner or date is
            shown only when those words appear in the lines the item cites; that
            does not show the person agreed to it.
            {cost}
          </p>
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
          <p className="meeting-notes-help">
            Kept notes are added to your export after your own notes; the export
            review shows them. Nothing is saved until you export.
          </p>
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
              className="secondary-button"
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
            Notes kept. They are included when you export, after your own notes.
          </p>
          <pre>{result?.kept ?? text}</pre>
          <div className="meeting-notes-actions">
            <button
              className="secondary-button"
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
          Notes discarded. Each meeting gets one request, so none will be
          written again for this meeting.
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
