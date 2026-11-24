// What "Copy diagnostics" puts on the clipboard for a support request:
// versions, settings, states and fixed error codes. Every field is picked by
// name from a fixed list, so nothing a person said, wrote or chose by name
// can reach it: no transcript, notes, cues, focus, name, application or
// device names, file paths, or keys. Nothing is sent or stored; the person
// reads it, then copies it.
import type { Snapshot } from './types';
import type { ProcessingSnapshot } from './processing';
import type { MicrophoneSnapshot } from './microphone';
import type {
  CueUsage,
  KeysStatus,
  TranscriptionLanguage,
} from './providerKeys';

export const APP_VERSION = '0.1 alpha';

export interface DiagnosticsInput {
  desktop: boolean;
  session: Snapshot | null;
  processing: ProcessingSnapshot | null;
  microphone: MicrophoneSnapshot | null;
  keys: KeysStatus | null;
  usage: CueUsage | null;
  language: TranscriptionLanguage | null;
  /** Whether a live session can start in this launch. */
  liveAvailable: boolean | null;
}

/** A fixed code, or `-`: free text never passes. */
function code(value: unknown): string {
  return typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value)
    ? value
    : value === null || value === undefined
      ? '-'
      : 'other';
}

function count(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(Math.round(value))
    : '-';
}

function flag(value: unknown): string {
  return value === true ? 'yes' : value === false ? 'no' : '-';
}

/** The report as plain lines of `name: value`. */
export function diagnosticsReport(input: DiagnosticsInput): string {
  const { session, processing, microphone, keys, usage } = input;
  const transcription = session?.transcription;
  const sources = session?.sources;
  const key = (provider: 'deepgram' | 'anthropic') => {
    const status = keys?.[provider];
    if (!status) return '-';
    return `${code(status.state)}${status.verified ? ', checked' : ''}`;
  };
  const lines: [string, string][] = [
    ['TalkQTE', APP_VERSION],
    ['Build', input.desktop ? 'desktop' : 'browser preview'],
    ['Live sessions available', flag(input.liveAvailable)],
    ['Deepgram key', key('deepgram')],
    ['Anthropic key', key('anthropic')],
    ['Transcription language', code(input.language)],
    ['Companion shown', flag(session?.overlayEnabled)],
    ['Companion position', code(session?.companionPosition)],
    ['Question size', code(session?.questionSize)],
    ['Sensitivity', code(session?.sensitivity)],
    ['Keep the meeting', flag(session?.keepMeeting)],
    [
      'Session',
      session?.live ? 'live' : session?.simulated ? 'simulated' : 'none',
    ],
    ['Session status', code(session?.status)],
    [
      'Session length (min)',
      session?.live ? count((session.elapsedMs ?? 0) / 60_000) : '-',
    ],
    [
      'Transcript lines shown',
      session?.live ? count(session.transcript.length) : '-',
    ],
    ['Cues paused', flag(session?.cuesPaused)],
    ['Microphone source', flag(sources?.microphone)],
    [
      'Application source',
      flag(sources ? Boolean(sources.application) : undefined),
    ],
    ['Application attached', flag(sources?.applicationAttached)],
    ['Application stopped', code(sources?.applicationEnded)],
    [
      'Echo lines marked',
      count(sources?.echoDropped ?? (sources ? 0 : undefined)),
    ],
    ['Transcription service', code(transcription?.provider)],
    ['Transcription stopped', code(transcription?.stopped)],
    [
      'Transcription reconnects',
      count(transcription?.reconnects ?? (transcription ? 0 : undefined)),
    ],
    [
      'Speech lost to reconnects (s)',
      transcription ? count((transcription.lostMs ?? 0) / 1000) : '-',
    ],
    [
      'Audio dropped',
      flag(transcription ? Boolean(transcription.droppedAudio) : undefined),
    ],
    [
      'Transcription minutes left',
      count(
        (transcription as { minutesLeft?: number } | undefined)?.minutesLeft,
      ),
    ],
    ['Cue processing', code(processing?.phase)],
    ['Cue processor', code(processing?.processor?.id)],
    [
      'Cue processing approved',
      flag(processing ? Boolean(processing.approved) : undefined),
    ],
    ['Cue processing stopped', code(processing?.issue)],
    ['Capture', code(processing?.capture)],
    ['Application capture', code(processing?.source?.phase)],
    ['Application capture problem', code(processing?.source?.problem)],
    ['Microphone', code(microphone?.status)],
    [
      'Cue requests',
      usage ? `${count(usage.requests)} of ${count(usage.requestCap)}` : '-',
    ],
    [
      'Estimated cue spend (USD)',
      usage
        ? `${(usage.spentMicroUsd / 1e6).toFixed(3)} of ${(usage.spendCapMicroUsd / 1e6).toFixed(2)}`
        : '-',
    ],
    ['Meeting notes', code(session?.meetingNotes)],
  ];
  return lines.map(([name, value]) => `${name}: ${value}`).join('\n');
}
