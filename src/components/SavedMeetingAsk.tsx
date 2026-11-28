import type { KeptMeeting } from '../lib/meetingHistory';
import { MeetingAsk } from './MeetingAsk';

/** The saved ID/revision owns the citation namespace. Never map an old answer
 * into a newly edited meeting, even if its positional line happens to exist. */
export function SavedMeetingAsk({
  meeting,
  onRevealTranscript,
}: {
  meeting: KeptMeeting;
  onRevealTranscript: () => void;
}) {
  return (
    <MeetingAsk
      key={`${meeting.id}-${meeting.revision}`}
      savedMeeting={meeting}
      onCitation={(id) => {
        if (!/^saved-line-\d+$/.test(id)) return;
        onRevealTranscript();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const line = document.getElementById(
              `saved-transcript-${meeting.id}-${meeting.revision}-${id}`,
            );
            line?.scrollIntoView({ block: 'center' });
            line?.focus({ preventScroll: true });
          }),
        );
      }}
      onViewTranscript={() =>
        document
          .getElementById('saved-meeting-transcript')
          ?.scrollIntoView({ block: 'start' })
      }
    />
  );
}
