import { knownPlatform } from './platform';

/** Where a live session's audio is transcribed, and the fixed code that
 * ended it. Only a development build with cloud transcription has one. */
export interface CloudTranscription {
  provider: string;
  stopped?: string;
  /** Some audio was not sent because the connection fell behind. */
  droppedAudio?: boolean;
  /** Replacement streams opened after connection problems, and the speech
   * (ms) lost with the failed ones. */
  reconnects?: number;
  lostMs?: number;
  /** Minutes of the meeting left before the session's transcription cap,
   * once ten or fewer remain. */
  minutesLeft?: number;
}

/** Said as the session's transcription cap comes near, so a meeting does
 * not end on it unannounced. */
export function transcriptionLowText(
  transcription: CloudTranscription | undefined,
): string | null {
  const left = transcription?.minutesLeft;
  if (left === undefined || transcription?.stopped) return null;
  const when =
    left <= 0
      ? 'Transcription is about to reach'
      : `About ${left} ${left === 1 ? 'minute' : 'minutes'} of transcription ${left === 1 ? 'is' : 'are'} left before`;
  return `${when} this session's 120-minute cap; then the session ends. With your microphone and an application, each minute of the meeting uses two. Stop and start a new session to continue after it.`;
}

const STOP_REASONS: Record<string, string> = {
  auth: 'the service refused the API key or credential. Replace the key in Settings',
  key_unavailable:
    'your transcription key could not be read from the Keychain, or it was removed. Check it in Settings',
  quota:
    'the account cannot pay for more audio. Add credit in your transcription account',
  rate_limited: 'the service is limiting requests. Wait a minute',
  cap_reached: 'the transcription minute limit was reached',
  network: 'the connection failed or was lost. Check your internet connection',
  unavailable: 'the service is having a problem on its side',
  protocol: 'the service sent a reply TalkQTE could not read',
  closed: 'the service closed the connection',
  settings: 'the development transcription settings are not usable',
  withdrawn: 'cue processing was turned off, so audio stopped being sent',
  lab_ended: 'the lab run ended, so audio stopped being sent',
  stalled: 'the connection stopped responding',
};

/** Said while a session continues after a reconnect. Lost speech is not
 * sent again, so the transcript has a gap there. */
export function transcriptionReconnectText(
  transcription: CloudTranscription | undefined,
): string | null {
  if (!transcription?.reconnects || transcription.stopped) return null;
  const lostMs = transcription.lostMs ?? 0;
  const gap =
    lostMs <= 0
      ? 'The amount of speech not transcribed is unknown.'
      : lostMs < 1000
        ? 'Less than 1 s of speech was not transcribed.'
        : `About ${Math.round(lostMs / 1000)} s of speech was not transcribed.`;
  const times =
    transcription.reconnects === 1
      ? 'once'
      : `${transcription.reconnects} times`;
  return `Transcription by ${transcription.provider} reconnected ${times} after a connection problem. ${gap}`;
}

/** Said while a session continues after audio was dropped. */
export function transcriptionDropText(
  transcription: CloudTranscription | undefined,
): string | null {
  return transcription?.droppedAudio && !transcription.stopped
    ? `Some audio was not sent to ${transcription.provider} because the connection fell behind; lines from it are missing.`
    : null;
}

/** What the person is told when cloud transcription ends with a failure. */
export function transcriptionStopText(
  transcription: CloudTranscription | undefined,
): string | null {
  if (!transcription?.stopped) return null;
  let reason = STOP_REASONS[transcription.stopped] ?? 'it stopped unexpectedly';
  if (transcription.stopped === 'key_unavailable') {
    const os = knownPlatform()?.os;
    if (os === 'windows') {
      reason = `your ${transcription.provider} key could not be read from Windows Credential Manager, or it was removed. Check it in Settings`;
    } else if (os === 'linux') {
      reason = `your ${transcription.provider} key could not be read from the keyring, or it was removed. Check it in Settings`;
    } else {
      reason = `your ${transcription.provider} key could not be read from the Keychain, or it was removed. Check it in Settings`;
    }
  } else if (transcription.stopped === 'quota') {
    reason = `the account cannot pay for more audio. Add credit in your ${transcription.provider} account`;
  }
  return `Transcription by ${transcription.provider} stopped: ${reason}. The live session ended; nothing fell back to another transcription service.`;
}

/** The short description of where speech is transcribed. */
export function transcribedWhere(
  transcription: CloudTranscription | undefined,
): string {
  return `transcribed by ${transcription?.provider ?? 'the transcription service'} once cue processing is enabled`;
}

/** The capture sources a live session was started with, and how they are
 * doing. Metadata only. */
export interface SessionSources {
  microphone: boolean;
  /** The selected application's name, as listed. */
  application?: string;
  /** The application began feeding the session. */
  applicationAttached?: boolean;
  /** Why the application is no longer heard while the microphone runs on. */
  applicationEnded?: string;
  /** Microphone lines suppressed as likely repeats of the application. */
  echoDropped?: number;
  /** Those lines, shown marked until the person keeps or removes each. */
  echoes?: EchoLine[];
}

/** A microphone line suppressed as a likely echo of the application. */
export interface EchoLine {
  id: string;
  atMs: number;
  speaker: string;
  text: string;
  /** The person said it was theirs. */
  kept?: boolean;
}

/** Both the microphone and an application feed the session. */
export function bothSources(sources: SessionSources | undefined): boolean {
  return Boolean(sources?.microphone && sources.application);
}

/** The transcript's first line: where its audio comes from. */
export function sourcesHeading(
  sources: SessionSources | undefined,
  transcription: CloudTranscription | undefined,
): string | null {
  if (!sources || !bothSources(sources)) return null;
  const remote =
    sources.application === 'System audio'
      ? 'system audio'
      : `audio from ${sources.application}`;
  return `You: your microphone · Them: ${remote} · ${transcribedWhere(transcription)}. The labels say where a line was heard, not who said it.`;
}

/** Said while a two-source session runs on without its application or system audio. */
export function applicationEndedText(
  sources: SessionSources | undefined,
): string | null {
  if (!sources || !bothSources(sources) || !sources.applicationEnded)
    return null;
  const isSystemAudio = sources.application === 'System audio';
  if (isSystemAudio) {
    if (sources.applicationEnded === 'unsupported') {
      return 'System audio requires macOS 14.2 or later. Only your microphone is heard now.';
    }
    if (sources.applicationEnded === 'permission_denied') {
      return 'System audio permission was not allowed. Check System Audio Recording Only for TalkQTE in System Settings → Privacy & Security. Only your microphone is heard now.';
    }
  }
  const what =
    sources.applicationEnded === 'not_started'
      ? 'did not start'
      : sources.applicationEnded === 'ended'
        ? 'stopped'
        : `stopped: ${STOP_REASONS[sources.applicationEnded] ?? 'it stopped unexpectedly'}`;
  if (isSystemAudio) {
    return `System audio ${what}. Only your microphone is heard now.`;
  }
  return `Audio from ${sources.application} ${what}. Only your microphone is heard now; Cue processing says why. Stop and start again to hear both.`;
}

/** Said once the echo guard has marked microphone lines. */
export function echoText(sources: SessionSources | undefined): string | null {
  const dropped = sources?.echoDropped ?? 0;
  if (!dropped) return null;
  const remote =
    sources?.application === 'System audio'
      ? 'system audio'
      : `${sources?.application ?? 'the application'}'s sound`;
  return `${dropped === 1 ? '1 microphone line looks' : `${dropped} microphone lines look`} like a repeat of ${remote} through your speakers. They are marked in the transcript, not used for cues; keep or remove each there. Headphones avoid this.`;
}
