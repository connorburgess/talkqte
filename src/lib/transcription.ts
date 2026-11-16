/** Development builds that selected cloud transcription only: where a live
 * session's audio is transcribed, and the fixed code that ended it. */
export interface CloudTranscription {
  provider: string;
  stopped?: string;
}

const STOP_REASONS: Record<string, string> = {
  auth: 'the service refused the lab credential',
  quota: 'the account cannot pay for more audio',
  rate_limited: 'the service is limiting requests',
  cap_reached: "this run's transcription minute limit was reached",
  network: 'the connection was lost',
  protocol: 'the service sent a reply TalkQTE could not read',
  closed: 'the service closed the connection',
  settings: 'the development transcription settings are not usable',
  withdrawn: 'cue processing was turned off, so audio stopped being sent',
};

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
  return transcription
    ? `transcribed by ${transcription.provider} once cue processing is enabled`
    : 'transcribed on this device';
}
