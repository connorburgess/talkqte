import { desktop } from '../lib/bridge';
import { microphoneLabel, type Microphone } from '../lib/microphone';
import type { Segment, Snapshot } from '../lib/types';
import { describeSource, type SourceCapture } from '../lib/processing';

/** What the notebook already knows about the microphone and live session. */
export interface RealCapture {
  microphone: Pick<Microphone, 'state' | 'error'>;
  preparing: boolean;
  cancelling: boolean;
  live: boolean;
  finishing: boolean;
  session: RealSession;
  /** Development builds only: a selected-application source. */
  source?: SourceCapture | null;
}

/**
 * Words for the real source and capture state. Read-only: it describes the
 * snapshots the notebook holds and sends no command. Where the state is not
 * known to be off, the text never says that nothing is captured.
 */
export function describeCapture(
  real: RealCapture,
  onDesktop = desktop,
): {
  source: string;
  capture: string;
  detail: string | null;
  underway: string | null;
  /** A line of its own for a selected-application source, or null. */
  application: string | null;
} {
  if (!onDesktop)
    return {
      source: 'None. This browser preview cannot open a microphone.',
      capture: 'Off. This browser preview captures nothing.',
      detail: null,
      underway: null,
      application: null,
    };
  const described = describeMicrophone(real);
  const application = describeSource(real.source);
  if (!real.source?.mayBeCapturing) return { ...described, application };
  // The application may still be captured, so no line about the microphone
  // may say or imply that nothing is.
  return {
    ...described,
    source:
      described.source === 'None open.'
        ? 'No microphone open.'
        : described.source,
    capture:
      real.source.sourceSession &&
      real.live &&
      !real.finishing &&
      real.microphone.state?.status === 'off'
        ? 'Live session running from application audio. The microphone is not used.'
        : described.capture === 'Off. Nothing is being captured.'
          ? 'The microphone is off.'
          : described.capture,
    application,
  };
}

function describeMicrophone({
  microphone,
  preparing,
  cancelling,
  live,
  finishing,
}: RealCapture) {
  const { state, error } = microphone;
  const underway = finishing
    ? 'A real live session is stopping.'
    : preparing
      ? 'A real live session is being prepared.'
      : live
        ? 'A real live session is running.'
        : !state || state.status === 'off'
          ? null
          : state.status === 'starting'
            ? 'The real microphone is starting.'
            : state.status !== 'error'
              ? 'The real microphone is in use.'
              : state.canStart
                ? null
                : 'The real microphone is being released after a failure.';
  if (!state)
    return {
      source: 'Unknown.',
      // The hook's own message, shown as the detail, says it is unavailable.
      capture: error
        ? 'Unknown. The microphone may be open.'
        : 'Checking microphone status…',
      detail: error || null,
      underway,
    };
  const opened = ['starting', 'listening', 'stopping'].includes(state.status);
  // After a failure the device stays held until cleanup allows a new start.
  const releasing = state.status === 'error' && !state.canStart;
  const source = opened
    ? `Microphone${
        state.deviceName || state.status === 'listening'
          ? `: ${state.deviceName || 'name unavailable'}`
          : ''
      }`
    : releasing
      ? 'Microphone, being released.'
      : 'None open.';
  const session = `Microphone: ${microphoneLabel(state).replace(/…$/, '')}`;
  let capture: string;
  // A session in progress is named first, with the microphone's own status,
  // so an earlier failure cannot stand in for it.
  if (finishing)
    capture =
      state.status === 'stopping'
        ? 'Stopping the live session. The microphone is being released.'
        : `Stopping the live session. ${session}.`;
  else if (preparing)
    capture = cancelling
      ? `Start cancelled. Waiting for preparation to finish. ${session}.`
      : `Preparing a live session. ${session}.`;
  else if (live)
    capture =
      state.status === 'listening'
        ? 'Listening. A live session is transcribing this microphone on this device.'
        : `Live session running. ${session}.`;
  else if (state.status === 'error')
    capture = releasing
      ? 'Failed. The microphone is still being released.'
      : 'Failed. The microphone is not open.';
  else if (state.status === 'stopping')
    capture = 'Stopping. The microphone is being released.';
  else if (state.status === 'starting') capture = 'Starting the microphone.';
  else if (state.status === 'listening')
    capture = 'Listening for an activity check only. Nothing is transcribed.';
  else capture = 'Off. Nothing is being captured.';
  // Native sends "Stopping microphone…" with the stopping status, which the
  // sentence above already says.
  const detail = error || (state.status === 'stopping' ? null : state.message);
  return { source, capture, detail, underway };
}

/** The session snapshot fields the transcript view reads. */
export interface RealSession {
  live: boolean;
  status: Snapshot['status'];
  transcript: Segment[];
}

/** How many recent real lines the compact layout shows. */
export const realLinesShown = 5;

/**
 * Words for the real transcript. Only a live session's lines are real; the
 * scripted demo's lines are fictional and never shown as real. A running
 * session is not the same as a listening microphone: the session starts
 * before permission is granted and keeps running while it stops.
 */
export function describeTranscript(
  {
    session,
    preparing,
    cancelling,
    finishing,
    microphone,
    source: application,
  }: RealCapture,
  onDesktop = desktop,
) {
  if (!onDesktop)
    return {
      note: 'This browser preview has no live session, so there is no real transcript.',
      lines: [],
    };
  const lines = session.live ? session.transcript.slice(-realLinesShown) : [];
  const source =
    session.status === 'ended'
      ? 'From the live session that has ended, transcribed on this device.'
      : 'From the live session, transcribed on this device.';
  const count =
    lines.length && session.transcript.length > lines.length
      ? ` Showing the latest ${lines.length} of ${session.transcript.length}; the notebook’s Transcript tab has all of them.`
      : '';
  let note: string;
  if (!session.live)
    note =
      preparing && cancelling
        ? 'The start was cancelled, so no lines will appear.'
        : preparing
          ? 'A live session is being prepared. Its lines appear here once it is transcribing.'
          : session.status === 'running' || session.status === 'paused'
            ? 'No live session. The demo’s scripted lines are fictional and are not shown here.'
            : 'No live session, so there is no real transcript.';
  else if (session.status === 'ended')
    note = lines.length
      ? source + count
      : 'The live session ended without transcribed lines.';
  else if (finishing)
    note =
      (lines.length ? source + count + ' ' : '') +
      'Stopping. Lines from audio already captured may still appear.';
  else if (lines.length) note = source + count;
  else
    note =
      application?.sourceSession && application.phase === 'listening'
        ? 'No lines yet. Lines from the application appear a few seconds after they are heard.'
        : application?.sourceSession && application.phase === 'starting'
          ? 'No lines yet. Application audio is starting.'
          : microphone.state?.status === 'listening'
            ? 'No lines yet. Lines from the microphone appear a few seconds after they are spoken.'
            : microphone.state?.status === 'starting'
              ? 'No lines yet. The microphone is not listening yet.'
              : 'No lines. The microphone is not listening.';
  return { note, lines };
}
