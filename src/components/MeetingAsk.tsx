import { useCallback, useEffect, useRef, useState } from 'react';
import * as qa from '../lib/meetingQa';
import { clockTime, type Snapshot } from '../lib/types';
import type { KeptMeeting } from '../lib/meetingHistory';
import './meeting-ask.css';

export function MeetingAsk({
  snapshot,
  savedMeeting,
  onCitation,
  onViewTranscript,
}: {
  snapshot?: Snapshot;
  savedMeeting?: KeptMeeting;
  onCitation: (id: string) => void;
  onViewTranscript?: () => void;
}) {
  const savedId = savedMeeting?.id;
  const savedRevision = savedMeeting?.revision;
  const saved =
    savedId !== undefined && savedRevision !== undefined
      ? { id: savedId, revision: savedRevision }
      : undefined;
  const transcript = savedMeeting
    ? savedMeeting.transcript.map((line, index) => ({
        ...line,
        id: `saved-line-${index}`,
      }))
    : (snapshot?.transcript ?? []);
  const identity = savedMeeting
    ? `saved-${savedId}-${savedRevision}`
    : `current-${snapshot?.session}`;
  const latestScope = useRef<string | null>(null);
  const [scope, setScope] = useState<qa.QaScope | null>(null);
  const [entries, setEntries] = useState<qa.QaEntry[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const priorStatus = useRef(snapshot?.status);
  const active = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [entries]);
  const refresh = useCallback(async () => {
    const turn = generation.current;
    setPreparing(true);
    setScope(null);
    try {
      const next = await qa.questionScope(saved);
      if (turn === generation.current) {
        latestScope.current = next.ticket;
        setScope(next);
      }
    } catch (e) {
      if (turn === generation.current) setError(String(e));
    } finally {
      if (turn === generation.current) setPreparing(false);
    }
  }, [savedId, savedRevision]);
  const lineCount = transcript.length;
  useEffect(() => {
    generation.current++;
    const turn = generation.current;
    setBusy(false);
    setQuestion('');
    setEntries([]);
    setScope(null);
    setError('');
    void qa
      .questionHistory(saved)
      .then((value) => {
        if (turn === generation.current) setEntries(value);
      })
      .catch(() => {});
    return () => {
      generation.current++;
      const ticket = active.current ?? latestScope.current;
      if (ticket) void qa.cancelQuestion(ticket, saved, true).catch(() => {});
      latestScope.current = null;
      active.current = null;
    };
  }, [identity]);
  const hasLines = lineCount > 0;
  useEffect(() => {
    if (!hasLines) {
      setScope(null);
      setPreparing(false);
      return;
    }
    void refresh();
  }, [hasLines, identity, refresh]);
  useEffect(() => {
    const previous = priorStatus.current;
    priorStatus.current = snapshot?.status;
    if (
      savedMeeting ||
      previous === snapshot?.status ||
      snapshot?.status !== 'ended'
    )
      return;
    // Stop retires the pending answer, not accepted conversational history.
    generation.current++;
    const ticket = active.current;
    active.current = null;
    setBusy(false);
    if (ticket) void qa.cancelQuestion(ticket).catch(() => {});
    void refresh();
  }, [snapshot?.status, savedId, refresh]);
  async function send() {
    if (!scope || busy || !question.trim()) return;
    const turn = generation.current;
    const sent = question.trim();
    active.current = scope.ticket;
    setBusy(true);
    setError('');
    try {
      const answer = await qa.askQuestion(scope.ticket, sent, saved);
      if (turn !== generation.current) return;
      setEntries((old) =>
        [...old, { question: sent, answer, scope }].slice(-10),
      );
      setQuestion('');
    } catch (e) {
      if (turn === generation.current) setError(String(e));
    } finally {
      if (turn === generation.current) {
        active.current = null;
        setBusy(false);
        void refresh();
      }
    }
  }
  async function clearConversation() {
    if (busy) return;
    generation.current++;
    const turn = generation.current;
    setPreparing(true);
    setScope(null);
    setEntries([]);
    try {
      const next = await qa.questionScope(saved, true);
      if (turn !== generation.current) return;
      setScope(next);
      latestScope.current = next.ticket;
      setError('Conversation cleared. Ask budget allowances are unchanged.');
    } catch (e) {
      if (turn === generation.current) setError(String(e));
    } finally {
      if (turn === generation.current) setPreparing(false);
    }
  }
  async function cancel() {
    const token = active.current;
    if (!token) return;
    generation.current++;
    active.current = null;
    setBusy(false);
    try {
      await qa.cancelQuestion(token, saved);
      setError('Stopped waiting. A request already sent may still be billed.');
    } catch (e) {
      setError(String(e));
    }
    void refresh();
  }
  const first = scope?.lines[0],
    last = scope?.lines.at(-1);
  const scopeCount = scope?.lines.length ?? 0;
  const isLiveRunning = snapshot?.live && snapshot.status === 'running';

  if (lineCount === 0 && entries.length === 0) {
    return (
      <section className="meeting-ask is-empty" aria-labelledby="ask-heading">
        <div className="ask-empty">
          <h2 id="ask-heading">
            {savedMeeting
              ? 'No transcript in this saved meeting'
              : isLiveRunning
                ? 'Waiting for transcript lines'
                : 'Ask after the conversation starts'}
          </h2>
          <p className="muted">
            When a transcript is available, you can ask about the meeting or
            follow up. Opening Ask sends nothing.
          </p>
          {isLiveRunning && onViewTranscript && (
            <button
              type="button"
              className="text-button"
              onClick={onViewTranscript}
            >
              View transcript
            </button>
          )}
        </div>
        <div role="status" aria-live="polite" className="visually-hidden">
          {error}
        </div>
      </section>
    );
  }

  return (
    <section className="meeting-ask" aria-labelledby="ask-heading">
      <div className="ask-header">
        <h2 id="ask-heading">Ask about this meeting</h2>
        {onViewTranscript && (
          <button
            type="button"
            className="text-button"
            onClick={onViewTranscript}
          >
            View transcript
          </button>
        )}
      </div>
      {entries.length > 0 && (
        <div
          className="ask-history"
          aria-label="Question and answer history"
          ref={history}
          onScroll={(event) => {
            const element = event.currentTarget;
            follow.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              24;
          }}
        >
          {entries.map((entry, index) => (
            <article
              className="ask-entry"
              key={`${entry.scope.ticket}-${index}`}
            >
              <h3>{entry.question}</h3>
              <p className="ask-answer-label">
                Model answer
                {entry.answer.insufficient ? ' · insufficient evidence' : ''}
              </p>
              <p className="ask-answer">{entry.answer.answer}</p>
              <div
                className="ask-citations"
                role="group"
                aria-label="Answer sources"
              >
                {entry.answer.citations.map((id) => {
                  const line = entry.scope.lines.find(
                    (value) => value.id === id,
                  );
                  const available = transcript.some((value) => value.id === id);
                  return (
                    line && (
                      <button
                        type="button"
                        className="text-button"
                        key={id}
                        disabled={!available}
                        title={
                          available
                            ? line.text
                            : 'This line is no longer in the current transcript'
                        }
                        onClick={() => onCitation(id)}
                      >
                        Transcript {clockTime(line.atMs)}
                        {!available && ' · unavailable'}
                      </button>
                    )
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="ask-question" className="visually-hidden">
          Your question
        </label>
        <textarea
          ref={input}
          id="ask-question"
          value={question}
          maxLength={2000}
          rows={2}
          disabled={busy}
          placeholder="Ask about this meeting, or follow up…"
          onChange={(event) =>
            setQuestion(Array.from(event.target.value).slice(0, 1000).join(''))
          }
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="ask-actions">
          <button
            className="primary-button"
            type="submit"
            disabled={!scope || preparing || busy || !question.trim()}
            aria-describedby={scope ? 'ask-scope' : undefined}
          >
            {busy ? 'Answering…' : 'Send'}
          </button>
          {busy ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => void cancel()}
            >
              Cancel answer
            </button>
          ) : (
            <button
              className="text-button"
              type="button"
              disabled={preparing}
              onClick={() => void refresh()}
            >
              {preparing ? 'Updating…' : 'Use latest transcript'}
            </button>
          )}
          {entries.length > 0 && !busy && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                void clearConversation().catch((e) => setError(String(e)))
              }
            >
              Clear conversation
            </button>
          )}
          <span className="muted ask-char-count">
            {Array.from(question).length}/1,000
          </span>
        </div>
        {scope && first && last && (
          <div className="ask-scope" id="ask-scope">
            <p>
              Send to {scope.providerName} · {scope.model}. Uses all{' '}
              {scopeCount} available transcript{' '}
              {scopeCount === 1 ? 'line' : 'lines'} from{' '}
              {savedMeeting ? 'this saved meeting' : 'this session'}, plus{' '}
              {scope.priorPairs} prior{' '}
              {scope.priorPairs === 1 ? 'exchange' : 'exchanges'}. Model answers
              can be wrong.
            </p>
            <details>
              <summary>Transcript scope and cost</summary>
              <p>
                Whole available selected transcript: {clockTime(first.atMs)}–
                {clockTime(last.atMs)}. No tail-only fallback. The complete
                serialized request must fit 128 KiB and its cost limit. Missing
                or incorrect transcription is not recovered.
              </p>
              <p>
                The latest three accepted question/answer pairs may be included,
                up to 12 KiB; whole older pairs are omitted.{' '}
                {scope.omittedPairs} earlier{' '}
                {scope.omittedPairs === 1 ? 'exchange is' : 'exchanges are'}{' '}
                excluded. Prior model answers help interpret follow-ups; only
                transcript lines are evidence. No saved notes, imported context
                or other meetings are sent.
              </p>
              <p>
                Estimated maximum ${(scope.worstMicroUsd / 1000000).toFixed(3)}{' '}
                for this question, not a billing guarantee. Provider retention
                follows your provider account terms. Sending authorizes this
                question and this whole transcript and disclosed conversation
                separately from automatic cues. Ask is capped at 20 sends and $1
                in cumulative worst-case estimates.{' '}
                {savedMeeting
                  ? 'The saved-meeting allowance spans all saved meetings until the app restarts.'
                  : 'This session’s allowance resets only with a new session.'}{' '}
                Navigation and clearing chat do not reset it. Questions and
                answers stay in memory and are not added to the transcript,
                saved meetings or exports.
              </p>
            </details>
          </div>
        )}
      </form>
      <div role="status" aria-live="polite" className="ask-status">
        {busy
          ? 'Waiting for a model answer. You can cancel.'
          : error ||
            (entries.length
              ? 'Answer ready. Check the model answer and its sources.'
              : '')}
      </div>
    </section>
  );
}
