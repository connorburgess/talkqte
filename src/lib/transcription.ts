/** Where a live session's audio is transcribed, and the fixed code that
 * ended it. Only a development build with cloud transcription has one. */
export interface CloudTranscription {
  provider: string;
  stopped?: string;
  /** Some audio was not sent because the connection fell behind. */
  droppedAudio?: boolean;
}

const STOP_REASONS: Record<string, string> = {
  auth: 'the service refused the lab credential',
  quota: 'the account cannot pay for more audio',
  rate_limited: 'the service is limiting requests',
  cap_reached: "this launch's transcription minute limit was reached",
  network: 'the connection was lost',
  protocol: 'the service sent a reply TalkQTE could not read',
  closed: 'the service closed the connection',
  settings: 'the development transcription settings are not usable',
  withdrawn: 'cue processing was turned off, so audio stopped being sent',
  lab_ended: 'the lab run ended, so audio stopped being sent',
};

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
  const reason =
    STOP_REASONS[transcription.stopped] ?? 'it stopped unexpectedly';
  return `Transcription by ${transcription.provider} stopped: ${reason}. The live session ended; nothing fell back to another transcription service.`;
}

/** The short description of where speech is transcribed. */
export function transcribedWhere(
  transcription: CloudTranscription | undefined,
): string {
  return `transcribed by ${transcription?.provider ?? 'the transcription service'} once cue processing is enabled`;
}
