import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { desktop } from './bridge';
import {
  historyStatus,
  keptMeetings,
  type HistoryStatus,
  type KeptListing,
} from './meetingHistory';

export type PriorContextAvailability =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; listing: KeptListing; status: HistoryStatus };

/** Reads only existing history metadata when the empty disclosure is opened.
 * It neither opens a meeting nor imports notes or changes processing scope. */
export function usePriorContextAvailability(enabled: boolean) {
  const [state, setState] = useState<PriorContextAvailability>({
    phase: 'loading',
  });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled || !desktop) return;
    let active = true;
    setState({ phase: 'loading' });
    void Promise.all([keptMeetings(), historyStatus()]).then(
      ([listing, status]) => {
        if (active) setState({ phase: 'ready', listing, status });
      },
      () => {
        if (active) setState({ phase: 'error' });
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, revision]);
  useEffect(() => {
    if (!enabled || !desktop) return;
    let active = true;
    let stop: (() => void) | undefined;
    void listen('meeting-history:changed', refresh)
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch(() => {});
    return () => {
      active = false;
      stop?.();
    };
  }, [enabled, refresh]);
  return { state, refresh };
}

export function savedNotesExplanation(state: PriorContextAvailability): {
  title: string;
  detail: string;
  review?: 'meetings' | 'settings';
} {
  if (state.phase === 'loading')
    return {
      title: 'Checking saved notes…',
      detail: 'Checking availability, not importing notes.',
    };
  if (state.phase === 'error')
    return {
      title: 'Saved notes could not be checked.',
      detail:
        'Retry, choose kept meetings directly, or add notes from a file or Granola. Nothing was imported.',
    };
  const { listing, status } = state;
  switch (listing.availability) {
    case 'labRun':
      return {
        title: 'Saved meeting context is off in this lab run.',
        detail:
          'Lab runs do not read saved meetings. You can still choose a notes file for this session.',
      };
    case 'newer':
      return {
        title: 'Saved meetings need a newer version of TalkQTE.',
        detail:
          'They were left untouched. Use a compatible version, or add notes from a file or Granola.',
      };
    case 'unavailable':
      return {
        title: 'Saved meeting context is unavailable.',
        detail:
          'Nothing was imported. Add notes from a file or Granola, or review Meetings for the availability message.',
        review: 'meetings',
      };
  }
  const total = listing.meetings.length;
  if (total === 0)
    return listing.unreadable > 0
      ? {
          title: 'Saved meetings could not be read.',
          detail:
            'This is not an empty history. Review Meetings for the unreadable entries, or add notes from a file or Granola.',
          review: 'meetings',
        }
      : {
          title: 'No saved meetings yet.',
          detail:
            'Add notes from a file or Granola now. For future meetings, save your written notes or explicitly generate and keep meeting notes after the session.' +
            (status.afterSessionKeep === 'off'
              ? ' Automatic meeting saving is off in Settings → Meetings.'
              : ''),
          review: status.afterSessionKeep === 'off' ? 'settings' : undefined,
        };
  // A prior app/fixture without the new metadata cannot establish that saved
  // meetings have no notes. Do not infer emptiness from model-note flags.
  if (
    !listing.meetings.every(
      (meeting) =>
        'hasNotes' in meeting && typeof meeting.hasNotes === 'boolean',
    )
  )
    return {
      title: 'No prior notes selected.',
      detail:
        'Choose kept meetings to check which have written notes or kept meeting notes. Transcripts are not used as prior context.',
      review: 'meetings',
    };
  const withNotes = listing.meetings.filter(
    (meeting) => 'hasNotes' in meeting && meeting.hasNotes === true,
  );
  const available = withNotes.filter((meeting) => !meeting.archived).length;
  if (withNotes.length === 0)
    return {
      title: 'Saved meetings have no reusable notes yet.',
      detail: `${total === 1 ? 'Your saved meeting has' : `Your ${total} saved meetings have`} no written notes or kept meeting notes. Transcripts are not used as prior context. Add notes from a file or Granola; saving a transcript alone does not add prior notes.`,
      review: 'meetings',
    };
  if (available === 0)
    return {
      title: 'Saved notes are archived.',
      detail:
        'Archived meetings are not auto-selected. Choose kept meetings to select their notes manually, or review Meetings to unarchive them.',
      review: 'meetings',
    };
  if (!status.autoPriorContext)
    return {
      title: 'Automatic prior context is off.',
      detail:
        'Saved notes are available. Choose kept meetings to review and add them yourself, or change automatic selection in Settings → Meetings.',
      review: 'settings',
    };
  return {
    title: 'No notes selected for this session.',
    detail:
      'Saved notes are available. Choose kept meetings to review and add them. Notes removed for this session stay removed unless you choose them again.',
    review: 'meetings',
  };
}
