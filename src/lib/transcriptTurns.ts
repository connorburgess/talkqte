import { clockTime } from './types';

/** Consecutive same-speaker segments separated by at least this silence gap
 * begin a new timestamped turn instead of continuing the previous turn. */
export const TURN_GAP_MS = 30_000;

/** A mid-turn pause at or above this threshold starts a new paragraph inside
 * the same speaker turn without repeating the speaker heading or divider. */
export const PARAGRAPH_PAUSE_MS = 8_000;

/** Preferred character length before breaking a long uninterrupted turn into a
 * new paragraph at a sentence boundary. */
export const PARAGRAPH_TARGET_CHARS = 320;

/** Upper character length for a single paragraph inside a long uninterrupted
 * turn even when segments lack terminal punctuation. */
export const PARAGRAPH_MAX_CHARS = 520;

const UNKNOWN_SPEAKER_RE = /^unknown(\s+speaker)?$/i;
const SENTENCE_END_RE = /[.!?]["'”’)\]]*$/;

export interface GroupableLine {
  id: string;
  atMs: number;
  text: string;
  /** Display speaker label (empty when single-source saved transcript has none). */
  speaker: string;
  /** 0-based remote diarized speaker identifier, when available. */
  speakerId?: number;
  /** Source channel when known (`you`, `them`, or `single` for single-source saved meetings). */
  source?: 'you' | 'them' | 'single';
  /** True when the line is a suppressed/flagged echo that must stay standalone. */
  isEcho?: boolean;
  /** True when the segment is an in-progress live partial transcript update. */
  partial?: boolean;
}

export interface TranscriptTurn<T extends GroupableLine> {
  /** Stable identifier anchored to the first underlying segment in this turn. */
  id: string;
  speaker: string;
  speakerId?: number;
  source?: 'you' | 'them' | 'single';
  isEcho: boolean;
  startAtMs: number;
  endAtMs: number;
  /** All original immutable segments in chronological order. */
  lines: T[];
  /** Deterministic, append-only paragraph groups of the underlying segments. */
  paragraphs: T[][];
}

/**
 * Computes a merge key for consecutive lines. Returns `null` when a segment
 * must never be merged into an adjacent turn (flagged echoes or explicitly
 * unknown speaker/source identity).
 */
export function turnIdentityKey(line: GroupableLine): string | null {
  if (line.isEcho) return null;
  if (line.speakerId !== undefined) return `remote-id:${line.speakerId}`;
  if (line.source === 'you') return 'source:you';
  if (line.source === 'them') return 'source:them';
  if (line.source === 'single') return 'source:single';
  const trimmed = line.speaker.trim();
  if (!trimmed || UNKNOWN_SPEAKER_RE.test(trimmed)) return null;
  if (trimmed === 'You') return 'source:you';
  if (trimmed === 'Them') return 'source:them';
  return `speaker:${trimmed}`;
}

/** Splits one speaker turn's segments into readable paragraphs strictly
 * left-to-right so appending new lines never reflows earlier paragraphs. */
export function splitTurnParagraphs<T extends GroupableLine>(
  lines: T[],
): T[][] {
  if (lines.length === 0) return [];
  const paragraphs: T[][] = [[lines[0]]];
  let currentChars = lines[0].text.trim().length;

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const next = lines[i];
    const gap = next.atMs - prev.atMs;
    const prevTrimmed = prev.text.trim();
    const shouldBreak =
      gap >= PARAGRAPH_PAUSE_MS ||
      (currentChars >= PARAGRAPH_TARGET_CHARS &&
        SENTENCE_END_RE.test(prevTrimmed)) ||
      currentChars >= PARAGRAPH_MAX_CHARS;

    if (shouldBreak) {
      paragraphs.push([next]);
      currentChars = next.text.trim().length;
    } else {
      paragraphs[paragraphs.length - 1].push(next);
      currentChars += 1 + next.text.trim().length;
    }
  }
  return paragraphs;
}

/**
 * Groups consecutive same-source/same-speaker segments into readable turns
 * while preserving every original segment's immutable ID, timestamp, and text.
 *
 * Breaks a new turn on:
 * - flagged echo lines (always standalone),
 * - speaker or source switches,
 * - explicitly unknown speaker/source identity,
 * - silence gaps >= `TURN_GAP_MS` or backward timestamp jumps,
 * - finalized segments arriving after a partial segment from another speaker.
 */
export function groupTranscriptTurns<T extends GroupableLine>(
  lines: readonly T[],
  options?: { turnGapMs?: number },
): TranscriptTurn<T>[] {
  const turnGapMs = options?.turnGapMs ?? TURN_GAP_MS;
  const turns: {
    key: string | null;
    lines: T[];
    isEcho: boolean;
  }[] = [];

  for (const line of lines) {
    const key = turnIdentityKey(line);
    const current = turns.at(-1);
    const prev = current?.lines.at(-1);
    const gap = prev ? line.atMs - prev.atMs : 0;
    const canMerge =
      !!current &&
      !!prev &&
      key !== null &&
      current.key === key &&
      !current.isEcho &&
      !line.isEcho &&
      gap >= 0 &&
      gap < turnGapMs;

    if (canMerge) {
      current.lines.push(line);
    } else {
      turns.push({
        key,
        lines: [line],
        isEcho: !!line.isEcho,
      });
    }
  }

  return turns.map((turn) => {
    const first = turn.lines[0];
    const last = turn.lines[turn.lines.length - 1];
    return {
      id: first.id,
      speaker: first.speaker,
      speakerId: first.speakerId,
      source: first.source,
      isEcho: turn.isEcho,
      startAtMs: first.atMs,
      endAtMs: last.atMs,
      lines: turn.lines,
      paragraphs: turn.isEcho ? [turn.lines] : splitTurnParagraphs(turn.lines),
    };
  });
}

/** Formats a turn header timestamp: single `M:SS` when start and end fall in
 * the same second, or `M:SS–M:SS` when a grouped turn spans multiple seconds. */
export function formatTurnTime(startAtMs: number, endAtMs: number): string {
  const start = clockTime(startAtMs);
  const end = clockTime(endAtMs);
  return start === end ? start : `${start}–${end}`;
}
