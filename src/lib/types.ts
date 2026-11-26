export type Status = 'ready' | 'running' | 'paused' | 'ended';
export interface Segment {
  id: string;
  atMs: number;
  speaker: string;
  speakerId?: number;
  text: string;
}
/** Only the cited sources, not the evaluator's entire selected context. */
export interface CueSource {
  id: string;
  revision: number;
  text: string;
  provenance:
    | { kind: 'transcript'; atMs: number; speaker: string }
    | {
        kind: 'priorNote';
        provider: 'file' | 'granola' | 'history';
        date: string;
        title: string;
      };
}
export interface Cue {
  id: string;
  kind: string;
  question: string;
  evidence: string;
  /** Evaluated cues disclose every cited source separately. */
  sources?: CueSource[];
  sourceId: string;
  remainingMs: number;
  totalMs: number;
  held: boolean;
  resolvedBy: {
    sourceId: string;
    evidence: string;
    sources?: CueSource[];
  } | null;
  /** Set for a context reminder: the imported note it quotes. */
  note: {
    title: string;
    sourceDate: string;
    provider: string;
    /** Set when the last update check could not confirm the quoted copy. */
    unconfirmed?: { lastConfirmedMs: number | null };
  } | null;
  /** The line uses words from a focus line: shown sooner, kept longer. */
  aboutFocus: boolean;
}
export interface CueSnapshot {
  revision: number;
  status: Status;
  /** A live session fed by transcription. */
  live: boolean;
  /** True when the session started automatically when a call began. */
  autoStarted?: boolean;
  /** Browser preview and test stand-in only: a replay of a fictional
   * conversation that captures nothing. The desktop app never sends it. */
  simulated?: boolean;
  /** Suppresses cues while the live microphone and transcript continue. */
  /** A call seems to be starting: the offer, when the person turned the
   * prompt on. */
  callPrompt?: import('../components/CallPrompt').CallPromptOffer;
  /** An upcoming calendar meeting pre-call prompt, when opt-in Calendar
   * prompts are enabled. Narrow metadata only. */
  calendarPrompt?: import('../components/CalendarPrompt').CalendarPromptOffer;
  /** A previously active call went inactive while a live session is running. */
  callEndPrompt?: import('../components/CallEndPrompt').CallEndPromptOffer;
  /** An ended non-empty live session prompt: counts and keep status only. */
  endPrompt?: EndPrompt;
  cuesPaused: boolean;
  cue: Cue | null;
  overlayEnabled: boolean;
  companionPosition: 'bottomRight' | 'topCenter' | 'topLeft' | 'topRight';
  questionSize: 'standard' | 'large';
  sensitivity: 'balanced' | 'quiet' | 'focused';
  /** Present while a model connection may send conversation lines off the
   * device: `sending` while a request is on its way. */
  model?: 'on' | 'sending' | 'stopped';
  /** Why sending stopped, when `model` is `stopped`. */
  modelIssue?: import('./processing').ProcessingIssue;
  modelProvider?: string;
  modelLab?: boolean;
  /** macOS builds: the running session is fed by a selected
   * application alone, with no microphone. */
  sourceSession?: boolean;
  /** Where a live session's audio is transcribed: present for every live
   * session, which only a development build with cloud transcription can
   * start. */
  transcription?: import('./transcription').CloudTranscription;
  /** The capture sources this live session was started with. */
  sources?: import('./transcription').SessionSources;
}
export interface Snapshot extends CueSnapshot {
  session: string;
  title: string;
  description: string;
  elapsedMs: number;
  durationMs: number;
  transcript: Segment[];
  notes: string;
  /** Session-only; used to notice questions asked of the user by name. */
  userName: string | null;
  /** Session-only: what matters in this meeting, one short line each. */
  focus: string[];
  /** Session-only: include the transcript and cues shown in the export. */
  keepMeeting?: boolean;
  /** Session-only: where this session's model-written notes stand. */
  meetingNotes?: import('./meetingNotes').MeetingNotesPhase;
  /** Optional default meeting title from an opt-in calendar match. */
  meetingTitle?: string;
  /** Session-only: custom names for diarized remote speakers (0-based ID -> name). */
  speakerNames?: Record<number, string>;
}
export type EndPromptState = 'ask' | 'saved' | 'kept';
export type EndPromptAction =
  'keep' | 'writeNotes' | 'open' | 'delete' | 'dismiss';
export interface EndPrompt {
  session: number;
  state: EndPromptState;
  transcriptLines: number;
  hasNotes: boolean;
  error?: string;
}
export type Commands = {
  set_live_cues_paused: { paused: boolean };
  respond_to_cue: { id: string; response: 'dismiss' };
  /** Holds the cue until it is dismissed. */
  inspect_cue: { id: string };
  set_companion_position: { value: CueSnapshot['companionPosition'] };
  set_question_size: { value: CueSnapshot['questionSize'] };
  update_notes: { notes: string };
  set_sensitivity: { value: Snapshot['sensitivity'] };
  set_user_name: { name: string | null };
  set_focus: { lines: string[] };
  set_overlay: { enabled: boolean };
  /** Include this session's transcript and cues shown in the export. */
  set_keep_meeting: { keep: boolean };
  /** Keep a line marked as a likely echo as the person's own, or remove it. */
  resolve_echo_line: { id: string; keep: boolean };
  /** Rename a diarized remote speaker across this session's transcript. */
  rename_speaker: { session: string; speakerId: number; name: string };
  /** `application`: the review of an application to hear beside the
   * microphone; the session declares it, and its review names both. */
  start_live_session: { application?: string; title?: string } | undefined;
  stop_live_session: undefined;
  turn_off_processing: undefined;
  respond_to_call_prompt: {
    id: number;
    answer: import('../components/CallPrompt').CallPromptAnswer;
  };
  respond_to_calendar_prompt: {
    id: number;
    answer: import('../components/CalendarPrompt').CalendarPromptAnswer;
  };
  respond_to_call_end_prompt: {
    id: number;
    answer: import('../components/CallEndPrompt').CallEndPromptAnswer;
  };
  respond_to_end_prompt: {
    session: number;
    action: EndPromptAction;
  };
  cancel_context_import: undefined;
  remove_context_item: { provider: ContextItem['provider']; sourceId: string };
  cancel_granola_sign_in: undefined;
  stop_granola_update_check: undefined;
};
/** What the notebook may know about the Granola connection; never identity. */
export interface GranolaStatus {
  connected: boolean;
  tools: string[];
  /** Whether this connection can verify its workspace for an update check. */
  updateCheck?: boolean;
  freshness?: NoteFreshness[];
}
/** What the last explicit update check found for one imported Granola note. */
export interface NoteFreshness {
  sourceId: string;
  /** The revision of the kept copy this finding is about. */
  revision: number;
  state: 'current' | 'updated' | 'notVerified';
  reason:
    | 'missing'
    | 'withdrawn'
    | 'unversioned'
    | 'older'
    | 'unreadable'
    | 'unavailable'
    | 'expired'
    | 'revoked'
    | 'rateLimited'
    | 'unsupportedFormat'
    | 'workspace'
    | 'timedOut'
    | null;
  /** When a check last confirmed or updated the copy, by this device's clock. */
  verifiedAtMs: number | null;
  /** Granola's own update time for the kept copy, if it gave one. */
  providerUpdatedAtMs: number | null;
}
export interface UpdateCheckReport {
  status:
    | 'checked'
    | 'cancelled'
    | 'reimported'
    | 'removed'
    | 'removedOrReimported'
    | 'timedOut'
    | 'workspaceUnverified'
    | 'workspaceChanged'
    | 'unavailable'
    | 'expired'
    | 'revoked'
    | 'rateLimited'
    | 'unsupportedFormat';
  retryAfterS: number | null;
  notes: NoteFreshness[];
}
/** One prior note the user imported; never mistaken for the conversation. */
export interface ContextItem {
  provider: 'granola' | 'file' | 'history';
  sourceId: string;
  title: string;
  sourceDate: string;
  excerpt: string;
  revision: number;
  /** True when TalkQTE pre-selected this kept meeting for the session. */
  autoSelected?: boolean;
}
export interface NoteSummary {
  sourceId: string;
  title: string;
  /** Empty when a Markdown or plain-text file gives no date. */
  sourceDate: string;
  preview: string;
}
export interface PickedNotes {
  fileName: string;
  notes: NoteSummary[];
  /** Notes in the file not listed: beyond the limit of 200, or repeated. */
  skipped: number;
  /** A Markdown or plain-text file: a note without a date asks for one. */
  asksForDates?: boolean;
}
export interface MergeOutcome {
  added: number;
  updated: number;
  unchanged: number;
  overLimit: number;
  rejected: number;
}
export interface LiveStatus {
  available: boolean;
  reason: string | null;
  /** The cloud service this launch transcribes with, when one is selected. */
  transcription?: string;
  /** The cue provider configured for live sessions, when available. */
  cueProvider?: string | null;
}
export function clockTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
