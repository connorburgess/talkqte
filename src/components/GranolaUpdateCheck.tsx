import { useEffect, useRef, useState } from 'react';
import * as bridge from '../lib/bridge';
import type {
  ContextItem,
  GranolaStatus,
  NoteFreshness,
  UpdateCheckReport,
} from '../lib/types';

type Outcome =
  | { status: UpdateCheckReport['status']; retryAfterS: number | null }
  | { status: 'failed'; message: string };

/**
 * One explicit check of the Granola notes already selected. Nothing runs on
 * a timer; a result that arrives after Stop, Disconnect or leaving the
 * notebook is ignored here as well as in Rust.
 */
export function useGranolaUpdateCheck() {
  const [freshness, setFreshness] = useState<NoteFreshness[]>([]);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const run = useRef(0);
  const pending = useRef(false);
  /** The run the person stopped, whose answer may already have been applied. */
  const stopped = useRef(0);
  const end = () => {
    run.current++;
    pending.current = false;
    setChecking(false);
  };
  useEffect(
    () => () => {
      // Leaving the notebook stops a pending check instead of orphaning it.
      if (pending.current)
        void bridge.command('stop_granola_update_check').catch(() => {});
      run.current++;
      pending.current = false;
    },
    [],
  );
  return {
    freshness,
    checking,
    outcome,
    /** Drops findings about copies that were removed or imported again. */
    keepOnly(items: ContextItem[]) {
      setFreshness((notes) => {
        const kept = notes.filter((note) =>
          items.some(
            (item) =>
              item.provider === 'granola' &&
              item.sourceId === note.sourceId &&
              item.revision === note.revision,
          ),
        );
        return kept.length === notes.length ? notes : kept;
      });
    },
    /** A new connection result replaces what an earlier connection found. */
    connectionChanged(status: GranolaStatus) {
      end();
      setOutcome(null);
      setFreshness(status.freshness ?? []);
    },
    async start() {
      if (pending.current) return;
      const current = ++run.current;
      pending.current = true;
      setChecking(true);
      setOutcome(null);
      try {
        const report = await bridge.checkGranolaUpdates();
        // Stop can arrive just after the result was applied; say what
        // happened instead of claiming nothing changed.
        const applied = report.status !== 'cancelled';
        if (
          current !== run.current &&
          !(applied && current === stopped.current)
        )
          return;
        if (applied) setFreshness(report.notes);
        setOutcome(report);
      } catch (error) {
        if (current !== run.current) return;
        setOutcome({
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (current === run.current) {
          pending.current = false;
          setChecking(false);
        }
      }
    },
    stop() {
      if (!pending.current) return;
      stopped.current = run.current;
      end();
      setOutcome({ status: 'cancelled', retryAfterS: null });
      void bridge.command('stop_granola_update_check').catch(() => {});
    },
  };
}

const notes = (count: number) =>
  count === 1 ? '1 Granola note' : `${count} Granola notes`;

function summary(outcome: Outcome, freshness: NoteFreshness[]) {
  switch (outcome.status) {
    case 'checked': {
      const of = (state: NoteFreshness['state']) =>
        freshness.filter((note) => note.state === state).length;
      const unverified = of('notVerified');
      return `Checked ${notes(freshness.length)}: ${of('updated')} updated, ${of('current')} unchanged, ${unverified} not verified.${
        unverified
          ? ' Nothing was removed; see each note for what to do next.'
          : ''
      }`;
    }
    case 'cancelled':
      return 'Check stopped. Nothing was changed. A request already sent may still finish at Granola; its answer is discarded.';
    case 'timedOut':
      return 'Granola did not answer in time. Your copies were kept and are not verified. The earlier request must finish before you can check again.';
    case 'workspaceUnverified':
      return 'TalkQTE could not confirm which Granola workspace is active, so it did not ask about your notes. Your copies were kept.';
    case 'workspaceChanged':
      return 'The active Granola workspace changed, so nothing was updated. Disconnect and connect again to check notes in the current workspace.';
    case 'unavailable':
      return 'Granola could not be reached or gave no usable answer; you may be offline. Your copies were kept. Check again when you are connected.';
    case 'expired':
      return 'Granola’s sign-in has expired. Your copies were kept. Disconnect and connect again to check them.';
    case 'revoked':
      return 'Granola withdrew this app’s access. Your copies stay until you remove them. Disconnect, and connect again only if you want to.';
    case 'rateLimited':
      return `Granola asked for a pause${
        outcome.retryAfterS ? ` of about ${outcome.retryAfterS} seconds` : ''
      }. Nothing is retried automatically; check again later.`;
    case 'unsupportedFormat':
      return 'Granola returned a note format TalkQTE cannot read yet. Your copies were kept.';
    case 'failed':
      return outcome.message;
  }
}

export function GranolaUpdateCheck({
  updates,
  count,
}: {
  updates: ReturnType<typeof useGranolaUpdateCheck>;
  count: number;
}) {
  const { checking, outcome, freshness } = updates;
  if (count === 0) return null;
  const quiet =
    !outcome || outcome.status === 'checked' || outcome.status === 'cancelled';
  return (
    <div className="context-updates">
      <button
        className="secondary-button"
        onClick={checking ? updates.stop : () => void updates.start()}
      >
        {checking ? 'Stop check' : 'Check for updates'}
      </button>
      <p className="muted small">
        Asks Granola about the {notes(count)} selected here, only when you press
        this button. Only their identifiers are sent; nothing is written back,
        saved to disk, or repeated automatically.
      </p>
      {/* Mounted before its text changes, so the change can be announced. */}
      <p className="small" role="status">
        {checking
          ? `Checking ${notes(count)}… You can stop, disconnect, or remove a note while you wait.`
          : outcome && quiet
            ? summary(outcome, freshness)
            : ''}
      </p>
      {outcome && !quiet && (
        <p className="small" role="alert">
          {summary(outcome, freshness)}
        </p>
      )}
    </div>
  );
}

function Moment({ ms }: { ms: number }) {
  const date = new Date(ms);
  return (
    <time dateTime={date.toISOString()}>
      {date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })}
    </time>
  );
}

const unverified: Partial<
  Record<NonNullable<NoteFreshness['reason']>, string>
> = {
  missing:
    'Granola did not return this note. It may have moved or no longer be shared with you; that is not proof it was deleted. This copy was kept: remove it, or check again.',
  older: 'Granola returned an older version. This copy was kept.',
  unversioned:
    'Granola gave no update time for this note, so it cannot be compared. This copy was kept.',
  unreadable:
    'Granola’s reply had no readable date or text. This copy was kept.',
};

/** The per-note result of the last check, in words rather than color. */
export function GranolaNoteFreshness({
  freshness,
}: {
  freshness: NoteFreshness | undefined;
}) {
  if (!freshness) return null;
  const { state, reason, verifiedAtMs, providerUpdatedAtMs } = freshness;
  return (
    <span className="muted small context-freshness">
      {state === 'notVerified' ? (
        <>
          Not verified.{' '}
          {(reason && unverified[reason]) ||
            'The last check could not confirm this copy; it was kept.'}
          {verifiedAtMs !== null && (
            <>
              {' '}
              Last confirmed <Moment ms={verifiedAtMs} />.
            </>
          )}
        </>
      ) : (
        verifiedAtMs !== null && (
          <>
            {state === 'updated'
              ? 'Updated from Granola when checked '
              : 'Matched Granola when checked '}
            <Moment ms={verifiedAtMs} />.
          </>
        )
      )}
      {providerUpdatedAtMs !== null && (
        <>
          {' '}
          Granola’s update time: <Moment ms={providerUpdatedAtMs} />.
        </>
      )}
    </span>
  );
}
