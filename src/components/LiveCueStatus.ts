import { desktop } from '../lib/bridge';
import type { ProcessingSnapshot, ProcessorSummary } from '../lib/processing';
import type { Cue, CueSource, Snapshot } from '../lib/types';

/** The notebook state the real cue view reads. */
export interface RealCueInput {
  live: boolean;
  status: Snapshot['status'];
  cuesPaused: boolean;
  cue: Cue | null;
  /** The processor approved for this session, as the review screen shows it. */
  processor: ProcessorSummary | null;
  /** The processing phase; its panel offers Pause cues only while on. */
  processingPhase: ProcessingSnapshot['phase'] | null;
  /** A live session is being prepared or is stopping. */
  preparing: boolean;
  finishing: boolean;
  /** Development builds only: the session runs from an application alone. */
  sourceSession?: boolean;
}

const where = 'in the notebook, and in the companion when it is shown';

/**
 * Where a cue came from, in plain words. Every kind except Suggestion comes
 * from a fixed word or phrase rule in the Rust engine; a Suggestion comes
 * from the processor the person approved, named the way the processing
 * review names it. The sentences describe what each rule matches, not what
 * the conversation meant.
 */
export function cueOrigin(cue: Cue, processor: ProcessorSummary | null) {
  const focus = cue.aboutFocus
    ? cue.kind === 'Suggestion'
      ? ' A cited line used words from your focus list.'
      : ' The line also used words from your focus list.'
    : '';
  switch (cue.kind) {
    case 'Owner':
      return `Phrase rule: the line said “someone can”, “someone should” or “someone could”.${focus}`;
    case 'Timing':
      return `Phrase rule: the line used the word “soon”.${focus}`;
    case 'Decision':
      return `Phrase rule: the line said “either” and later “or”.${focus}`;
    case 'Open question':
      return `Phrase rule: the line asked the group a question in a set form, such as “Does anyone…?”${focus}`;
    case 'Asked you':
      return `Phrase rule: the line put a question to you by the name you entered, such as “Sam, can you…?”${focus}`;
    case 'Said':
      return `Phrase rule: the line named a time together with a commitment word, such as “ready by Friday”, so it is quoted word for word.${focus}`;
    case 'Still open':
      return 'Phrase rule: a line began with a wrap-up phrase such as “before we go”, and no line so far had used enough words from these focus lines.';
    case 'Context':
      return `Note title match: the line used distinctive words from the title of an imported note.${focus}`;
    case 'Suggestion': {
      const by = processor
        ? `Proposed by ${processor.name} · ${processor.model}, the cue processing approved for this session, ${
            processor.location === 'hosted'
              ? `hosted by ${processor.destination}`
              : 'which runs on this device'
          }.`
        : 'Proposed by a model through the cue processing approved for this session; its details are not available here.';
      return `${by} TalkQTE checks only that the cited sources were supplied, not that the proposal is right.${focus}`;
    }
    default:
      return `Cue kind “${cue.kind}”; its origin is not described here.`;
  }
}

const hasPriorNotes = (sources?: CueSource[]) =>
  !!sources?.some((source) => source.provenance.kind === 'priorNote');

/**
 * The real cue, read-only. Only a live session's cue is real; the demo's
 * cues come from a fictional script and are never shown as real.
 */
export function describeCue(input: RealCueInput, onDesktop = desktop) {
  // The notebook offers its own Pause cues only for a running live session
  // without cue processing; with processing, the processing panel owns it.
  const running =
    onDesktop &&
    input.live &&
    input.status === 'running' &&
    !input.preparing &&
    !input.finishing;
  const pause: 'available' | 'processor' | null = !running
    ? null
    : !input.processor
      ? 'available'
      : input.processingPhase === 'active' || input.processingPhase === 'paused'
        ? 'processor'
        : null;
  const none = (reason = '') => ({
    note: reason ? `None. ${reason}` : 'None.',
    cue: null,
    origin: null,
    status: null,
    resolution: null,
    pause,
  });
  if (!onDesktop) return none('This browser preview has no live session.');
  if (!input.live)
    return none(
      input.status === 'running' || input.status === 'paused'
        ? 'The demo’s cues come from a fictional script and are not shown here.'
        : '',
    );
  const { cue } = input;
  if (!cue)
    return none(
      input.cuesPaused
        ? input.sourceSession
          ? 'Cues are paused; the application audio and transcript continue.'
          : 'Cues are paused; the microphone and transcript continue.'
        : '',
    );
  const kept = 'Kept until you dismiss it.';
  const resolution = cue.resolvedBy
    ? hasPriorNotes(cue.resolvedBy.sources)
      ? `Marked resolved from these sources. ${kept}`
      : `Answered later in the conversation. ${kept}`
    : null;
  return {
    note: null,
    cue,
    origin: cueOrigin(cue, input.processor),
    status: [
      resolution ? null : cue.held ? kept : null,
      // Keep this line stays in the notebook and companion for now.
      cue.kind === 'Said' ? `Keep this line is ${where}.` : null,
    ]
      .filter(Boolean)
      .join(' '),
    resolution,
    pause,
  };
}

/** The real controls the layout shows now, by their visible names. */
export function realControlNames(input: RealCueInput, onDesktop = desktop) {
  const { cue, pause } = describeCue(input, onDesktop);
  return [
    ...(cue ? [cue.expanded ? 'Hide sources' : 'Why?', 'Dismiss'] : []),
    ...(pause === 'available'
      ? [input.cuesPaused ? 'Resume cues' : 'Pause cues']
      : []),
  ];
}

/** Joins names as “A”, “A and B” or “A, B and C”. */
export function listNames(names: string[]) {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
