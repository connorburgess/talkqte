import { useCallback, useEffect, useRef, useState } from 'react';
import * as qa from '../lib/meetingQa';
import { clockTime, type Snapshot } from '../lib/types';
import './meeting-ask.css';

export function MeetingAsk({
  snapshot,
  onCitation,
}: {
  snapshot: Snapshot;
  onCitation: (id: string) => void;
}) {
  const [scope, setScope] = useState<qa.QaScope | null>(null);
  const [entries, setEntries] = useState<qa.QaEntry[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
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
      const next = await qa.questionScope();
      if (turn === generation.current) {
        setScope(next);
      }
    } catch (e) {
      if (turn === generation.current) setError(String(e));
    } finally {
      if (turn === generation.current) setPreparing(false);
    }
  }, []);
  useEffect(() => {
    generation.current++;
    const turn = generation.current;
    setBusy(false);
    setQuestion('');
    setEntries([]);
    setScope(null);
    void qa
      .questionHistory()
      .then((value) => {
        if (turn === generation.current) setEntries(value);
      })
      .catch(() => {});
    void refresh();
    return () => {
      generation.current++;
      if (active.current)
        void qa.cancelQuestion(active.current).catch(() => {});
      active.current = null;
    };
  }, [snapshot.session, snapshot.status, refresh]);
  async function send() {
    if (!scope || busy || !question.trim()) return;
    const turn = generation.current;
    const sent = question.trim();
    active.current = scope.ticket;
    setBusy(true);
    setError('');
    try {
      const answer = await qa.askQuestion(scope.ticket, sent);
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
  async function cancel() {
    const token = active.current;
    if (!token) return;
    generation.current++;
    active.current = null;
    setBusy(false);
    try {
      await qa.cancelQuestion(token);
      setError('Stopped waiting. A request already sent may still be billed.');
    } catch (e) {
      setError(String(e));
    }
    void refresh();
  }
  const first = scope?.lines[0],
    last = scope?.lines.at(-1);
  return (
    <section className="meeting-ask" aria-labelledby="ask-heading">
      <h2 id="ask-heading">Ask about recent discussion</h2>
      <p className="muted">
        Answers use a limited excerpt of this session, not the whole meeting.
        Model answers can be wrong; check the cited lines.
      </p>
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
        {entries.length === 0 && (
          <p className="muted">
            Ask for a recap, an explanation or what the recent discussion
            supports. Opening Ask sends nothing.
          </p>
        )}
        {entries.map((entry, index) => (
          <article className="ask-entry" key={`${entry.scope.ticket}-${index}`}>
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
                const line = entry.scope.lines.find((value) => value.id === id);
                const available = snapshot.transcript.some(
                  (value) => value.id === id,
                );
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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="ask-question">Your question</label>
        <textarea
          ref={input}
          id="ask-question"
          value={question}
          maxLength={1000}
          rows={3}
          disabled={busy}
          placeholder="What did we agree to do next?"
          onChange={(event) => setQuestion(event.target.value)}
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
        {scope && first && last && (
          <div className="ask-scope" id="ask-scope">
            <p>
              Send to {scope.providerName} · {scope.model}. Uses the latest{' '}
              {scope.lines.length} lines available at {clockTime(last.atMs)}.
            </p>
            <details>
              <summary>Transcript scope and cost</summary>
              <p>
                {clockTime(first.atMs)}–{clockTime(last.atMs)} only. Older
                discussion is excluded when outside this range.{' '}
                {scope.omitted
                  ? 'Earlier discussion is not included.'
                  : 'Only the currently available transcript is included.'}{' '}
                No saved notes, imported context or previous answers are sent.
              </p>
              <p>
                Estimated maximum ${(scope.worstMicroUsd / 1000000).toFixed(3)}{' '}
                for this question, not a billing guarantee. Provider retention
                follows your provider account terms. Sending authorizes this
                question and this excerpt separately from automatic cues.
              </p>
            </details>
          </div>
        )}
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
              {preparing ? 'Updating scope…' : 'Use latest transcript'}
            </button>
          )}
          <span className="muted small">{question.length}/1,000</span>
        </div>
      </form>
      <p className="muted small">
        Questions and answers stay in memory for this session. They are not
        added to the transcript, saved meetings or exports. While running,
        capture and automatic cues continue independently.
      </p>
      <div role="status" aria-live="polite">
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
