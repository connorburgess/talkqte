// Browser tests only. This replaces the entry point through a Playwright route;
// it never opens a device or ships in the application bundle.
import { fictionalPermissions } from './processing-permissions';
import * as granolaFixture from './native-granola';
import * as contextFixture from './native-context';
import * as providerKeysFixture from './native-provider-keys';
import * as meetingNotesFixture from './native-meeting-notes';
import * as historyFixture from './native-meeting-history';
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import * as preview from '../../src/lib/preview';
import type { MicrophoneSnapshot } from '../../src/lib/microphone';
import type {
  DictationSnapshot,
  DictationTarget,
} from '../../src/lib/dictation';
import type { Commands, LiveStatus, Snapshot } from '../../src/lib/types';
import type {
  AvailableUpdate,
  UpdateHoldReason,
  UpdatePhase,
  UpdateStatus,
} from '../../src/lib/updates';
import type {
  ApplicationAudioAction,
  ApplicationAudioStatus,
  ProcessingSnapshot,
  StopTarget,
} from '../../src/lib/processing';

let microphone: MicrophoneSnapshot = {
  revision: 0,
  status: 'off',
  activity: 'quiet',
  canStart: true,
  message: null,
  deviceName: null,
};
let dictation: DictationSnapshot = {
  revision: 0,
  status: 'off',
  target: null,
  canStart: true,
  message: null,
};
let dictationSeq = 0;
let dictationHoldStart = false;
let dictationRejectStart: string | null = null;
let dictationRejectStop: string | null = null;
const dictationCalls: { command: string; target?: DictationTarget }[] = [];
let session: Snapshot;
let processing: ProcessingSnapshot = {
  revision: 0,
  session: 'fictional-session',
  scopeRevision: 0,
  phase: 'off',
  capture: 'off',
  startup: 'idle',
  stopTarget: { operation: null, microphone: '0' },
  processor: null,
  notes: [],
  approved: null,
  issue: null,
  lastDecision: null,
};
let operation = 0;
let heldStart = new URLSearchParams(location.search).has('hold-start');
let releaseStart: (() => void) | undefined;
let startFailure = '';
let rejectSpeakerRename = new URLSearchParams(location.search).has(
  'reject-speaker-rename',
);
let heldCaptureStop = false;
let releaseCaptureStop: (() => void) | undefined;
let heldDrain = false;
let heldName = false;
let heldFocus = false;
let releaseFocus: (() => void) | undefined;
let completedFocus = 0;
const focusSubmissions: string[][] = [];
const nameSubmissions: (string | null)[] = [];
let heldPermission = false;
let releasePermission: (() => void) | undefined;
let releaseName: (() => void) | undefined;
let failCaptureStop = false;
let failProcessingSnapshot = new URLSearchParams(location.search).has(
  'fail-processing',
);
const initialProcessingSnapshots: ((value: ProcessingSnapshot) => void)[] = [];
let delayProcessingSnapshot = new URLSearchParams(location.search).has(
  'delay-processing',
);
const stopTargets: StopTarget[] = [];
const applicationAudio: unknown[] = [];
/** The arguments of each start_live_session call. */
const liveStarts: unknown[] = [];
// Opt-in macOS Calendar prompt settings and answers.
let calendarSettings = {
  enabled: false,
  status: 'off' as 'off' | 'connected' | 'denied' | 'unavailable',
};
let calendarGrantResult: 'connected' | 'denied' = 'connected';
let calendarSettingsOpened = 0;
const calendarPromptAnswers: unknown[] = [];
/** The settings file, as the stand-in keeps it: set
 * `window.standInSavedSettings` before loading to start from saved values. */
const savedSettings = {
  status: { saving: 'on' } as { saving: string; error?: string },
  panels: { sidebarWidth: null, notesRatio: null } as {
    sidebarWidth: number | null;
    notesRatio: number | null;
  },
  panelWrites: 0,
  resets: 0,
  ...(
    window as typeof window & {
      standInSavedSettings?: Partial<{
        status: { saving: string; error?: string };
        panels: { sidebarWidth: number | null; notesRatio: number | null };
      }>;
    }
  ).standInSavedSettings,
};
// The call-starting prompt's settings and the companion's answers.
let callPrompt = {
  enabled: savedSettings.status.saving !== 'labRun',
  autoStart: false,
  notFor: [] as string[],
};

/** The menu bar item and the system's login item, as the stand-in plays
 * them: set `window.standInPresence` before loading to change them. No
 * login item is registered. */
const presence = {
  menuBar: true,
  keepRunning: false,
  openAtLogin: 'off' as 'off' | 'on' | 'needsApproval' | 'unavailable',
  approval: false,
  loginItemsOpened: 0,
  ...(
    window as typeof window & {
      standInPresence?: Partial<{
        menuBar: boolean;
        openAtLogin: 'off' | 'on' | 'needsApproval' | 'unavailable';
        approval: boolean;
      }>;
    }
  ).standInPresence,
};
const presenceReply = () => ({
  menuBar: presence.menuBar,
  keepRunning: presence.keepRunning,
  openAtLogin: presence.openAtLogin,
});

type StandInUpdatesConfig = {
  currentVersion?: string;
  configured?: boolean;
  labRun?: boolean;
  checkAtLaunch?: boolean;
  available?: AvailableUpdate | null;
  phase?: UpdatePhase;
  nextCheck?: 'upToDate' | { available: AvailableUpdate } | { error: string };
  nextInstall?: 'ok' | { error: string };
};

const initialUpdates = (
  window as typeof window & { standInUpdates?: StandInUpdatesConfig }
).standInUpdates;

const updatesState = {
  currentVersion: initialUpdates?.currentVersion ?? '0.1.0',
  configured: initialUpdates?.configured ?? true,
  labRun:
    initialUpdates?.labRun ?? new URLSearchParams(location.search).has('lab'),
  checkAtLaunch: initialUpdates?.checkAtLaunch ?? true,
  phase: (initialUpdates?.phase ??
    (initialUpdates?.available ? 'available' : 'idle')) as UpdatePhase,
  available: (initialUpdates?.available ?? null) as AvailableUpdate | null,
  downloadedBytes: undefined as number | undefined,
  totalBytes: undefined as number | undefined,
  error: undefined as string | undefined,
  nextCheck: (initialUpdates?.nextCheck ?? 'upToDate') as
    'upToDate' | { available: AvailableUpdate } | { error: string },
  nextInstall: (initialUpdates?.nextInstall ?? 'ok') as
    'ok' | { error: string },
  restarts: 0,
  checks: 0,
};

function currentUpdateHold(): UpdateHoldReason | null {
  if (
    session?.live &&
    (session.status === 'running' || session.status === 'paused')
  ) {
    return 'liveSession';
  }
  if (
    dictation.status === 'starting' ||
    dictation.status === 'listening' ||
    dictation.status === 'stopping'
  ) {
    return 'dictation';
  }
  if (
    microphone.status === 'starting' ||
    microphone.status === 'listening' ||
    microphone.status === 'stopping'
  ) {
    return 'microphone';
  }
  return null;
}

function currentUpdateStatus(): UpdateStatus {
  const hold = currentUpdateHold();
  if (hold) {
    return {
      currentVersion: updatesState.currentVersion,
      configured: updatesState.configured,
      checkAtLaunch: updatesState.labRun ? false : updatesState.checkAtLaunch,
      labRun: updatesState.labRun,
      phase: updatesState.available ? 'deferred' : 'idle',
      hold,
      available: null,
    };
  }
  const phase =
    updatesState.available && updatesState.phase === 'deferred'
      ? 'available'
      : updatesState.phase;
  return {
    currentVersion: updatesState.currentVersion,
    configured: updatesState.configured,
    checkAtLaunch: updatesState.labRun ? false : updatesState.checkAtLaunch,
    labRun: updatesState.labRun,
    phase,
    hold: null,
    available: updatesState.available,
    downloadedBytes: updatesState.downloadedBytes,
    totalBytes: updatesState.totalBytes,
    error: updatesState.error,
  };
}

let lastEmittedUpdateHold: UpdateHoldReason | null = null;
async function emitUpdates() {
  await emit('updates:changed', structuredClone(currentUpdateStatus()));
}

const callPromptAnswers: unknown[] = [];
const callEndPromptAnswers: unknown[] = [];
// A fictional application-audio host: no OS listing, prompt or capture.
let host: ApplicationAudioStatus | null = null;
let hostRefusal: string | null = null;
let hostReview = 0;
function hostUpdate(value: Partial<ApplicationAudioStatus>) {
  host = { ...host!, ...value, revision: host!.revision + 1 };
  return structuredClone(host);
}
function hostAction(action: ApplicationAudioAction) {
  switch (action.kind) {
    case 'snapshot':
      return structuredClone(host!);
    case 'list':
      return hostUpdate({ phase: 'listing', choices: [], problem: null });
    case 'cancelList':
      return hostUpdate({ phase: 'off' });
    case 'review': {
      const choice = host!.choices.find((item) => item.id === action.source);
      if (!choice) throw 'unknown_source';
      return hostUpdate({
        phase: 'reviewing',
        application: choice.name,
        operation: `fictional-review-${++hostReview}`,
        problem: null,
      });
    }
    case 'startSession':
      if (action.review !== host!.operation) throw 'changed';
      if (hostRefusal) {
        const problem = hostRefusal;
        hostRefusal = null;
        return hostUpdate({ phase: 'off', operation: null, problem });
      }
      return hostUpdate({ phase: 'starting', choices: [] });
    default:
      return structuredClone(host!);
  }
}
/** The notebook's answers about lines marked as a likely echo. */
const echoAnswers: unknown[] = [];
async function sendProcessing(value: Partial<ProcessingSnapshot>) {
  processing = {
    ...processing,
    ...value,
    revision: value.revision ?? processing.revision + 1,
  };
  if (!new URLSearchParams(location.search).has('no-processing-events'))
    await emit('processing:changed', structuredClone(processing));
}
const permissionFixture = fictionalPermissions(
  () => processing,
  async (value) => {
    await sendProcessing(value);
    if (session?.live)
      await publish({ cuesPaused: value.phase === 'paused', cue: null });
  },
);
if (new URLSearchParams(location.search).has('processor'))
  processing = {
    ...processing,
    ...permissionFixture.configuration(
      new URLSearchParams(location.search).has('hosted'),
      new URLSearchParams(location.search).has('audio'),
    ),
  };
async function endLivePublish() {
  const empty =
    session.transcript.length === 0 && session.notes.trim().length === 0;
  await publish(
    empty
      ? {
          live: false,
          status: 'ready',
          elapsedMs: 0,
          durationMs: 0,
          title: '',
          description: '',
          autoStarted: false,
          cuesPaused: false,
          cue: null,
          sources: undefined,
        }
      : { status: 'ended', cue: null, cuesPaused: false },
  );
}
async function completeCaptureStop() {
  await send({
    status: 'off',
    canStart: true,
    activity: 'quiet',
    message: null,
  });
  await endLivePublish();
  await sendProcessing({
    capture: 'off',
    phase: 'ended',
    approved: null,
    scopeRevision: processing.scopeRevision + 1,
  });
}
async function beginStart(meetingTitle?: string) {
  operation += 1;
  const id = operation.toString(16).padStart(64, '0');
  await sendProcessing({
    startup: 'loading',
    stopTarget: { operation: id, microphone: String(operation) },
  });
  if (heldStart) {
    heldStart = false;
    await new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
  }
  const cancelled = processing.startup === 'cancelling';
  await sendProcessing({ startup: 'idle' });
  if (cancelled) throw new Error('Live session start was cancelled.');
  if (startFailure) {
    const failure = startFailure;
    startFailure = '';
    throw new Error(failure);
  }
  await startLive({ meetingTitle });
  if (heldPermission) {
    heldPermission = false;
    await send({
      status: 'starting',
      activity: 'quiet',
      canStart: false,
      message: 'Waiting for microphone permission…',
      deviceName: null,
    });
    await sendProcessing({ capture: 'starting' });
    await new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    if (processing.phase === 'ended')
      throw new Error('Live session start was cancelled.');
  }
}

let resolveSnapshot: ((value: MicrophoneSnapshot) => void) | undefined;
let rejectStop = false;
let rejectCuePause = false;
let delayStop = false;
let releaseStop: (() => void) | undefined;
let delayQuestionResponse = false;
let releaseQuestionResponse: (() => void) | undefined;
const calls: string[] = [];
const delayed = new URLSearchParams(location.search).has('delay-microphone');
// With ?live, the build and launch report live transcription as available.
// (?cloud is the same: every live transcription is cloud transcription.)
const liveAvailable = ['live', 'cloud'].some((key) =>
  new URLSearchParams(location.search).has(key),
);
const liveFromKeys = new URLSearchParams(location.search).has('live-from-keys');
Object.defineProperty(window, 'isTauri', { value: true, configurable: true });

async function send(value: Partial<MicrophoneSnapshot>) {
  microphone = { ...microphone, revision: microphone.revision + 1, ...value };
  await emit('microphone:changed', microphone);
  const hold = currentUpdateHold();
  if (hold !== lastEmittedUpdateHold) {
    lastEmittedUpdateHold = hold;
    await emitUpdates();
  }
}

async function sendDictation(value: Partial<DictationSnapshot>) {
  dictation = { ...dictation, revision: dictation.revision + 1, ...value };
  await emit('dictation:changed', structuredClone(dictation));
  const hold = currentUpdateHold();
  if (hold !== lastEmittedUpdateHold) {
    lastEmittedUpdateHold = hold;
    await emitUpdates();
  }
}

// Stands in for the Rust live session: no device, stream, or transcription.
/** Counts sessions, as Rust's session number does, for kept meetings. */
let historySession = 0;
async function publish(value: Partial<Snapshot>, forceSave = false) {
  const wasRunning = session?.status === 'running';
  if (value.status === 'running' && session?.status !== 'running') {
    historySession += 1;
    historyFixture.clearEndPrompt();
  }
  const next: Snapshot = {
    ...session,
    ...value,
    revision: Math.max(session.revision, 1_000) + 1,
    session: String(historySession),
  };
  let historyChanged = false;
  if (value.status === 'running') {
    delete next.endPrompt;
  } else if (
    wasRunning &&
    next.live &&
    next.status === 'ended' &&
    !('endPrompt' in value)
  ) {
    delete next.callEndPrompt;
    const ended = historyFixture.onSessionEnded(
      next,
      historySession,
      forceSave,
    );
    if (ended.endPrompt) next.endPrompt = ended.endPrompt;
    else delete next.endPrompt;
    historyChanged = ended.changed;
  }
  session = next;
  await emit('session:changed', session);
  await emit('cue:changed', session);
  if (historyChanged) await emit('meeting-history:changed');
  const hold = currentUpdateHold();
  if (hold !== lastEmittedUpdateHold) {
    lastEmittedUpdateHold = hold;
    await emitUpdates();
  }
}
/** A replay of a fictional conversation: no microphone, nothing captured.
 * The app labels it as simulated in its own words. Used by the lab recorder. */
async function simulate(value: Partial<Snapshot> = {}) {
  await publish({
    title: 'Simulated session',
    description: 'Simulated replay of a fictional conversation.',
    durationMs: 0,
    ...value,
    live: false,
    simulated: true,
    cuesPaused: false,
    status: 'running',
    elapsedMs: 0,
    transcript: [],
    cue: null,
  });
}
async function startLive(options?: {
  autoStarted?: boolean;
  meetingTitle?: string;
}) {
  const labRun = new URLSearchParams(location.search).has('lab');
  const autoApprove = !!processing.processor && !labRun;
  const cleanTitle = options?.meetingTitle?.trim() || undefined;
  await publish({
    live: true,
    simulated: false,
    cuesPaused: false,
    autoStarted: !!options?.autoStarted,
    status: 'running',
    title: 'Live session',
    meetingTitle: cleanTitle,
    description: "Transcript lines from this session's transcription.",
    elapsedMs: 0,
    transcription: { provider: 'Deepgram' },
    model: autoApprove ? 'on' : undefined,
    // Rust sends u64::MAX for a live session, which has no end.
    durationMs: 18_446_744_073_709_552_000,
    transcript: [],
    cue: null,
  });
  await send({ status: 'listening', activity: 'active', canStart: false });
  await sendProcessing({
    capture: 'running',
    phase: autoApprove ? 'active' : 'off',
    startup: 'idle',
    session: `fictional-session-${operation}`,
    approved: autoApprove ? { conversation: 'newSpeechOnly', notes: [] } : null,
    scopeRevision: processing.scopeRevision + 1,
  });
}
async function say(text: string, question?: string) {
  const id = `t1-0-${session.transcript.length}`;
  const atMs = session.elapsedMs + 1_000;
  await publish({
    elapsedMs: atMs,
    transcript: [...session.transcript, { id, atMs, speaker: 'Speaker', text }],
    cue:
      question && !session.cuesPaused
        ? {
            id: `live:${id}`,
            kind: 'Owner',
            question,
            evidence: text,
            sourceId: id,
            remainingMs: 18_000,
            totalMs: 18_000,
            held: false,
            resolvedBy: null,
            note: null,
            aboutFocus: false,
          }
        : session.cue,
  });
}

/** The edge the native companion keeps; a test may set it before loading
 * with `window.standInEdge`. */
let companionEdge: 'top' | 'bottom' =
  (window as typeof window & { standInEdge?: 'top' | 'bottom' }).standInEdge ??
  'top';
/** How the native side answers the page's read of that edge: at once, held
 * until a test releases it, or with an error. Set with
 * `window.standInEdgeReply` before loading. */
const edgeReply = (
  window as typeof window & { standInEdgeReply?: 'hold' | 'fail' }
).standInEdgeReply;
let releaseEdge: ((edge: 'top' | 'bottom') => void) | null = null;
let edgeAsked = false;
mockIPC(
  async (command, args) => {
    calls.push(command);
    if (
      new URLSearchParams(location.search).has('context-ordering') &&
      contextFixture.commands.includes(command)
    ) {
      return contextFixture.command(command, args);
    }
    if (
      new URLSearchParams(location.search).has('granola') &&
      granolaFixture.commands.includes(command)
    ) {
      return granolaFixture.command(command, args);
    }
    if (permissionFixture.commands.includes(command))
      return permissionFixture.command(command, args);
    if (providerKeysFixture.commands.includes(command))
      return providerKeysFixture.command(command, args);
    if (meetingNotesFixture.commands.includes(command))
      return meetingNotesFixture.command(command, args, publish, () => session);
    if (historyFixture.commands.includes(command)) {
      const hadPrompt = !!session.endPrompt;
      const result = historyFixture.command(
        command,
        args,
        () => session,
        () => historySession,
      );
      if (
        command === 'keep_meeting_in_history' ||
        command === 'set_kept_meeting_archived' ||
        command === 'delete_kept_meeting' ||
        command === 'delete_all_kept_meetings'
      ) {
        if (hadPrompt) {
          const updated = historyFixture.currentEndPrompt(historySession);
          await publish({ endPrompt: updated ?? undefined });
        }
        await emit('meeting-history:changed');
      }
      if (
        command === 'set_auto_prior_context' ||
        command === 'set_kept_meeting_archived' ||
        command === 'delete_kept_meeting' ||
        command === 'delete_all_kept_meetings'
      ) {
        if (
          command === 'set_auto_prior_context' ||
          command === 'set_kept_meeting_archived'
        ) {
          historyFixture.refreshAutoContext(
            session.focus,
            session.title || null,
            session.status,
            session.live,
          );
        }
        await emit('context:changed', [
          ...(await preview.contextItemsNow()),
          ...historyFixture.selectedContextItems(),
        ]);
      }
      return result;
    }
    switch (command) {
      case 'platform_capabilities': {
        // The macOS build unless a test names Windows or Linux.
        const os = new URLSearchParams(location.search).get('platform');
        const other = os === 'windows' || os === 'linux';
        return {
          os: other ? os : 'macos',
          microphone: true,
          applicationAudio: !other,
          callPrompt: !other,
          calendarPrompts: !other,
          companionOverFullScreen: !other,
        };
      }
      case 'application_audio':
        // Record what the notebook asked for; answer as the fictional host
        // when a test has set one up.
        applicationAudio.push(structuredClone(args));
        if (!host) return null;
        return hostAction((args as { action: ApplicationAudioAction }).action);
      case 'processing_snapshot':
        if (delayProcessingSnapshot)
          return new Promise<ProcessingSnapshot>((resolve) =>
            initialProcessingSnapshots.push(resolve),
          );
        if (failProcessingSnapshot) {
          failProcessingSnapshot = false;
          throw new Error('unavailable');
        }
        return structuredClone(processing);
      case 'stop_capture': {
        const { target } = args as { target: StopTarget };
        stopTargets.push(structuredClone(target));
        if (heldCaptureStop) {
          heldCaptureStop = false;
          await new Promise<void>((resolve) => {
            releaseCaptureStop = resolve;
          });
        }
        if (
          target.operation !== processing.stopTarget.operation ||
          target.microphone !== processing.stopTarget.microphone
        )
          throw new Error('capture_changed');
        if (failCaptureStop) {
          failCaptureStop = false;
          throw new Error('unavailable');
        }
        if (
          processing.startup === 'loading' ||
          processing.startup === 'cancelling'
        ) {
          await sendProcessing({ startup: 'cancelling' });
          return;
        }
        await send({ status: 'stopping', canStart: false, activity: 'quiet' });
        await sendProcessing({ phase: 'stopping', capture: 'stopping' });
        if (!heldDrain) await completeCaptureStop();
        return;
      }
      case 'snapshot':
        return structuredClone(session);
      case 'companion_anchor':
        edgeAsked = true;
        if (edgeReply === 'fail')
          throw new Error('The session is unavailable.');
        if (edgeReply === 'hold')
          return new Promise((resolve) => {
            releaseEdge = resolve;
          });
        return companionEdge;
      case 'microphone_snapshot':
        return delayed
          ? new Promise<MicrophoneSnapshot>((resolve) => {
              resolveSnapshot = resolve;
            })
          : structuredClone(microphone);
      case 'start_microphone':
        await send({
          status: 'starting',
          canStart: false,
          message: 'Waiting for microphone permission…',
          deviceName: null,
        });
        return;
      case 'stop_microphone':
        if (delayStop) {
          delayStop = false;
          await new Promise<void>((resolve) => {
            releaseStop = resolve;
          });
        }
        if (rejectStop) {
          rejectStop = false;
          throw new Error(
            'Microphone controls are unavailable. Try Stop microphone again.',
          );
        }
        await send({
          status: 'stopping',
          canStart: false,
          activity: 'quiet',
          message: null,
        });
        return;
      case 'note_dictation_snapshot':
        return structuredClone(dictation);
      case 'start_note_dictation': {
        const { target } = args as { target: DictationTarget };
        dictationCalls.push({ command: 'start_note_dictation', target });
        if (dictationRejectStart) {
          const msg = dictationRejectStart;
          dictationRejectStart = null;
          throw new Error(msg);
        }
        if (session?.live && session.status === 'running') {
          throw new Error('Stop the live session before dictating.');
        }
        if (
          microphone.status !== 'off' &&
          !(microphone.status === 'error' && microphone.canStart)
        ) {
          throw new Error('Stop the microphone check before dictating.');
        }
        dictationSeq = 0;
        await sendDictation({
          status: 'starting',
          target,
          canStart: false,
          message: 'Checking microphone access…',
        });
        if (!dictationHoldStart) {
          await sendDictation({
            status: 'listening',
            target,
            canStart: false,
            message: null,
          });
        }
        dictationHoldStart = false;
        return;
      }
      case 'stop_note_dictation':
        dictationCalls.push({ command: 'stop_note_dictation' });
        if (dictationRejectStop) {
          const msg = dictationRejectStop;
          dictationRejectStop = null;
          throw new Error(msg);
        }
        await sendDictation({
          status: 'off',
          target: null,
          canStart: true,
          message: null,
        });
        return;
      case 'set_focus': {
        const { lines } = args as Commands['set_focus'];
        focusSubmissions.push([...lines]);
        if (heldFocus) {
          heldFocus = false;
          await new Promise<void>((resolve) => {
            releaseFocus = resolve;
          });
        }
        try {
          const out = preview.command('set_focus', { lines });
          if (
            historyFixture.refreshAutoContext(
              lines,
              session.title || null,
              session.status,
              session.live,
            )
          ) {
            await emit('context:changed', [
              ...(await preview.contextItemsNow()),
              ...historyFixture.selectedContextItems(),
            ]);
          }
          return out;
        } finally {
          completedFocus++;
        }
      }
      case 'set_user_name': {
        nameSubmissions.push((args as Commands['set_user_name']).name);
        if (heldName) {
          heldName = false;
          await new Promise<void>((resolve) => {
            releaseName = resolve;
          });
        }
        // Stands in for the engine's validation of a session-only name.
        const { name } = args as Commands['set_user_name'];
        if (name && !/^[\p{L}' -]{1,40}$/u.test(name))
          throw new Error(
            'Use letters, spaces, apostrophes, or hyphens, up to 40 characters.',
          );
        return preview.command('set_user_name', { name });
      }
      case 'context_items':
        return [
          ...(await preview.contextItemsNow()),
          ...historyFixture.selectedContextItems(),
        ];
      case 'granola_status':
        return preview.granolaStatus();
      case 'connect_granola':
        return preview.connectGranola();
      case 'list_granola_notes':
        return preview.listGranolaNotes();
      case 'disconnect_granola':
        return preview.disconnectGranola();
      case 'suggest_granola_focus':
        return preview.suggestGranolaFocus();
      case 'pick_context_file':
        return preview.pickContextFile();
      case 'list_kept_meetings_for_context':
        return historyFixture.listForContext();
      case 'cancel_context_import':
        historyFixture.cancelPendingContext();
        return;
      case 'import_context_notes': {
        const { ids } = args as { ids: string[] };
        if (historyFixture.hasPendingContext()) {
          const { outcome, items } = historyFixture.importPendingContext(ids);
          const merged = [
            ...(await preview.contextItemsNow()),
            ...historyFixture.selectedContextItems(),
          ];
          const noteMap = new Map(
            processing.notes.map((note) => [
              `${note.provider}:${note.sourceId}`,
              note,
            ]),
          );
          for (const item of items) {
            noteMap.set(`${item.provider}:${item.sourceId}`, {
              provider: item.provider,
              sourceId: item.sourceId,
              revision: item.revision,
              title: item.title,
              sourceDate: item.sourceDate,
            });
          }
          processing = {
            ...processing,
            revision: processing.revision + 1,
            scopeRevision: processing.scopeRevision + 1,
            notes: [...noteMap.values()],
          };
          await emit('processing:changed', structuredClone(processing));
          await emit('context:changed', merged);
          return outcome;
        }
        const outcome = preview.importContextNotes(ids);
        await emit('context:changed', [
          ...(await preview.contextItemsNow()),
          ...historyFixture.selectedContextItems(),
        ]);
        return outcome;
      }
      case 'remove_context_from': {
        const removed =
          preview.removeAllContext() + historyFixture.removeAllHistoryContext();
        await emit('context:changed', [
          ...(await preview.contextItemsNow()),
          ...historyFixture.selectedContextItems(),
        ]);
        return removed;
      }
      case 'remove_context_item': {
        const target = args as Commands['remove_context_item'];
        if (target.provider === 'history') {
          historyFixture.removeHistoryContextItem(target.sourceId);
        } else {
          preview.command('remove_context_item', target);
        }
        await emit('context:changed', [
          ...(await preview.contextItemsNow()),
          ...historyFixture.selectedContextItems(),
        ]);
        return;
      }
      case 'live_status': {
        const stt = providerKeysFixture.providerKeysTest.provider();
        const provider = stt === 'elevenlabs' ? 'ElevenLabs' : 'Deepgram';
        const keyStatus = providerKeysFixture.providerKeysTest.status();
        const available =
          liveAvailable ||
          (liveFromKeys &&
            keyStatus[stt]?.state === 'set' &&
            keyStatus.anthropic.state === 'set');
        const value: LiveStatus = available
          ? {
              available: true,
              reason: null,
              transcription: provider,
              cueProvider: 'Anthropic',
            }
          : {
              available: false,
              reason: 'This build has no live transcription.',
            };
        return value;
      }
      case 'presence_settings':
        return presenceReply();
      case 'set_keep_running_in_menu_bar':
        presence.keepRunning = (args as { enabled: boolean }).enabled;
        return presenceReply();
      case 'set_open_at_login': {
        const on = (args as { enabled: boolean }).enabled;
        presence.openAtLogin = on
          ? presence.approval
            ? 'needsApproval'
            : 'on'
          : 'off';
        return presenceReply();
      }
      case 'open_login_items':
        presence.loginItemsOpened++;
        return;
      case 'settings_status':
        return structuredClone(savedSettings.status);
      case 'panel_sizes':
        return structuredClone(savedSettings.panels);
      case 'set_panel_sizes':
        savedSettings.panels = structuredClone(
          (args as { panels: typeof savedSettings.panels }).panels,
        );
        savedSettings.panelWrites++;
        return structuredClone(savedSettings.panels);
      case 'reset_settings':
        savedSettings.resets++;
        savedSettings.panels = { sidebarWidth: null, notesRatio: null };
        callPrompt = {
          enabled: savedSettings.status.saving !== 'labRun',
          autoStart: false,
          notFor: [],
        };
        updatesState.checkAtLaunch = true;
        calendarSettings = { enabled: false, status: 'off' };
        historyFixture.resetAfterSessionKeep();
        if (
          historyFixture.refreshAutoContext(
            session.focus,
            session.title || null,
            session.status,
            session.live,
          )
        ) {
          await emit('context:changed', [
            ...(await preview.contextItemsNow()),
            ...historyFixture.selectedContextItems(),
          ]);
        }
        await emitUpdates();
        return;
      case 'update_status':
        return structuredClone(currentUpdateStatus());
      case 'set_check_for_updates_at_launch': {
        if (updatesState.labRun) {
          throw new Error('Lab runs do not save update settings.');
        }
        const { enabled } = args as { enabled: boolean };
        updatesState.checkAtLaunch = enabled;
        const reply = currentUpdateStatus();
        await emitUpdates();
        return structuredClone(reply);
      }
      case 'check_for_updates': {
        if (updatesState.labRun) {
          throw new Error('Lab runs do not check for updates.');
        }
        if (!updatesState.configured) {
          throw new Error('Updates are not configured in this build');
        }
        if (currentUpdateHold() !== null) {
          throw new Error('Update paused until this session ends.');
        }
        updatesState.checks += 1;
        updatesState.phase = 'checking';
        updatesState.error = undefined;
        await emitUpdates();
        await new Promise((r) => setTimeout(r, 20));
        if (currentUpdateHold() !== null) {
          if (
            typeof updatesState.nextCheck === 'object' &&
            'available' in updatesState.nextCheck
          ) {
            updatesState.available = updatesState.nextCheck.available;
            updatesState.phase = 'deferred';
          }
          await emitUpdates();
          return structuredClone(currentUpdateStatus());
        }
        if (updatesState.nextCheck === 'upToDate') {
          updatesState.available = null;
          updatesState.phase = 'upToDate';
          updatesState.error = undefined;
        } else if ('available' in updatesState.nextCheck) {
          updatesState.available = updatesState.nextCheck.available;
          updatesState.phase = 'available';
          updatesState.error = undefined;
        } else {
          updatesState.phase = 'error';
          updatesState.error = updatesState.nextCheck.error;
          await emitUpdates();
          throw new Error(updatesState.nextCheck.error);
        }
        await emitUpdates();
        return structuredClone(currentUpdateStatus());
      }
      case 'download_and_install_update': {
        if (updatesState.labRun) {
          throw new Error('Lab runs do not install updates.');
        }
        if (!updatesState.configured) {
          throw new Error('Updates are not configured in this build');
        }
        if (currentUpdateHold() !== null) {
          throw new Error('Update paused until this session ends.');
        }
        if (!updatesState.available) {
          throw new Error('No update is ready to install.');
        }
        updatesState.phase = 'downloading';
        updatesState.downloadedBytes = 500;
        updatesState.totalBytes = 1000;
        updatesState.error = undefined;
        await emitUpdates();
        await new Promise((r) => setTimeout(r, 30));
        if (typeof updatesState.nextInstall === 'object') {
          updatesState.phase = 'error';
          updatesState.downloadedBytes = undefined;
          updatesState.totalBytes = undefined;
          updatesState.error = updatesState.nextInstall.error;
          await emitUpdates();
          throw new Error(updatesState.nextInstall.error);
        }
        if (currentUpdateHold() !== null) {
          updatesState.phase = 'deferred';
          updatesState.downloadedBytes = undefined;
          updatesState.totalBytes = undefined;
          await emitUpdates();
          throw new Error('Update paused until this session ends.');
        }
        updatesState.downloadedBytes = 1000;
        updatesState.phase = 'installing';
        await emitUpdates();
        await new Promise((r) => setTimeout(r, 20));
        updatesState.phase = 'restarting';
        updatesState.restarts += 1;
        await emitUpdates();
        return structuredClone(currentUpdateStatus());
      }
      case 'respond_to_end_prompt': {
        const { session: targetSession, action } =
          args as Commands['respond_to_end_prompt'];
        const res = historyFixture.respondToEndPrompt(
          action,
          targetSession,
          session,
          historySession,
        );
        await publish({ endPrompt: res.endPrompt ?? undefined });
        if (res.changed) await emit('meeting-history:changed');
        if (res.writeNotes) await emit('end-prompt:write-notes');
        if (res.openId)
          await emit('end-prompt:open-meeting', { id: res.openId });
        return;
      }
      case 'calendar_settings': {
        const os = new URLSearchParams(location.search).get('platform');
        if (os === 'windows' || os === 'linux') {
          return { enabled: false, status: 'unavailable' };
        }
        return structuredClone(calendarSettings);
      }
      case 'set_calendar_prompts': {
        const os = new URLSearchParams(location.search).get('platform');
        if (os === 'windows' || os === 'linux') {
          return {
            enabled: false,
            status: 'unavailable',
            error: 'Calendar prompts are not available on this platform yet.',
          };
        }
        const enabled = (args as { enabled: boolean }).enabled;
        calendarSettings = {
          enabled,
          status: enabled ? calendarGrantResult : 'off',
        };
        return structuredClone(calendarSettings);
      }
      case 'open_calendar_settings':
        calendarSettingsOpened++;
        return;
      case 'respond_to_calendar_prompt':
        calendarPromptAnswers.push(structuredClone(args));
        return;
      case 'call_prompt_settings':
        return structuredClone(callPrompt);
      case 'set_call_prompt': {
        const update = args as { enabled?: boolean; autoStart?: boolean };
        callPrompt = {
          ...callPrompt,
          ...(typeof update.enabled === 'boolean'
            ? { enabled: update.enabled }
            : {}),
          ...(typeof update.autoStart === 'boolean'
            ? { autoStart: update.autoStart }
            : {}),
        };
        return structuredClone(callPrompt);
      }
      case 'turn_off_processing': {
        await sendProcessing({
          phase: 'off',
          approved: null,
          scopeRevision: processing.scopeRevision + 1,
        });
        await publish({ model: undefined, cue: null });
        return;
      }
      case 'clear_call_prompt_apps':
        callPrompt = { ...callPrompt, notFor: [] };
        return structuredClone(callPrompt);
      case 'respond_to_call_prompt':
        callPromptAnswers.push(structuredClone(args));
        return;
      case 'respond_to_call_end_prompt': {
        const { id, answer } = args as Commands['respond_to_call_end_prompt'];
        callEndPromptAnswers.push(structuredClone(args));
        if (session.callEndPrompt?.id !== id) return;
        await publish({ callEndPrompt: undefined });
        if (answer === 'stopAndSave') {
          await send({
            status: 'stopping',
            canStart: false,
            activity: 'quiet',
          });
          await send({
            status: 'off',
            canStart: true,
            activity: 'quiet',
          });
          await publish(
            { status: 'ended', cue: null, cuesPaused: false },
            true,
          );
        }
        return;
      }
      case 'start_live_session':
        liveStarts.push(structuredClone(args ?? null));
        await beginStart((args as { title?: string } | undefined)?.title);
        return;
      case 'stop_live_session':
        await send({ status: 'stopping', canStart: false, activity: 'quiet' });
        await endLivePublish();
        return;
      case 'set_live_cues_paused':
        if (rejectCuePause) {
          rejectCuePause = false;
          throw new Error('Could not pause cues. Try again.');
        }
        await publish({
          cuesPaused: (args as { paused: boolean }).paused,
          cue: null,
        });
        return;
      case 'export_preview': {
        if (session.live && session.status === 'running')
          throw new Error('Live sessions are not saved or exported.');
        const kept = meetingNotesFixture.keptNotes();
        // Stands in for the engine adding kept meeting notes after the notes.
        const notes = kept
          ? `${preview.exportPreview()}\n${kept}\n`
          : preview.exportPreview();
        // Stands in for the engine's kept-meeting export.
        return session.keepMeeting
          ? `${notes}\n## Transcript\n\n${session.transcript
              .map((line) => `- ${line.text}`)
              .join('\n')}\n`
          : notes;
      }
      case 'resolve_echo_line':
        echoAnswers.push(structuredClone(args));
        return;
      case 'rename_speaker': {
        if (rejectSpeakerRename) {
          rejectSpeakerRename = false;
          throw new Error('The speaker could not be renamed. Try again.');
        }
        const {
          session: expectedSession,
          speakerId,
          name,
        } = args as Commands['rename_speaker'];
        if (expectedSession !== session.session)
          throw new Error(
            'This meeting has changed. Open its transcript and try again.',
          );
        const normalized = name.trim().replace(/\s+/g, ' ');
        if ([...normalized].length > 80 || /[\p{Cc}]/u.test(name)) {
          throw new Error('Give the speaker a name of up to 80 characters.');
        }
        const fallback = `Speaker ${speakerId + 1}`;
        const nextNames = { ...(session.speakerNames ?? {}) };
        if (!normalized || normalized === fallback) {
          delete nextNames[speakerId];
        } else {
          nextNames[speakerId] = normalized;
        }
        const resolved = nextNames[speakerId] ?? fallback;
        await publish({
          speakerNames: nextNames,
          transcript: session.transcript.map((segment) =>
            segment.speakerId === speakerId
              ? { ...segment, speaker: resolved }
              : segment,
          ),
        });
        return;
      }
      case 'set_keep_meeting':
        await publish({
          keepMeeting: (args as Commands['set_keep_meeting']).keep,
        });
        return;
      case 'export_markdown':
        return true;
      case 'inspect_cue': {
        const { id } = args as Commands['inspect_cue'];
        if (session.cue?.id !== id)
          throw new Error('That question has already passed.');
        await publish({ cue: { ...session.cue, held: true } });
        return;
      }
      case 'respond_to_cue':
        if (session.cue?.id !== (args as Commands['respond_to_cue']).id)
          throw new Error('That question has already passed.');
        await publish({ cue: null });
        if (delayQuestionResponse) {
          delayQuestionResponse = false;
          await new Promise<void>((resolve) => {
            releaseQuestionResponse = resolve;
          });
        }
        return;
      case 'update_notes':
      case 'save_notes':
        if (session && session.revision >= 1_000) {
          session = { ...session, notes: (args as { notes: string }).notes };
        }
        return preview.command(
          command as keyof Commands,
          args as Commands[keyof Commands],
        );
      default:
        return preview.command(
          command as keyof Commands,
          args as Commands[keyof Commands],
        );
    }
  },
  { shouldMockEvents: true },
);

preview.connect((value) => {
  // Once this stand-in runs a session, the adapter's idle state must not
  // replace it; the app already ignores those older revisions.
  if (session && session.revision >= 1_000) {
    // Settings changed during the session still reach it.
    void publish({
      sensitivity: value.sensitivity,
      overlayEnabled: value.overlayEnabled,
      companionPosition: value.companionPosition,
      questionSize: value.questionSize,
      userName: value.userName,
      focus: value.focus,
    });
    return;
  }
  session = value;
  void emit('session:changed', value);
  void emit('cue:changed', value);
});

declare global {
  interface Window {
    providerKeysTest: typeof providerKeysFixture.providerKeysTest;
    focusTest: {
      submissions: string[][];
      current: () => string[];
      completed: () => number;
      hold: () => void;
      release: () => void;
    };
    nameTest: {
      submissions: (string | null)[];
      current: () => string | null;
    };
    permissionTest: typeof permissionFixture;
    calendarTest: {
      settings: () => {
        enabled: boolean;
        status: 'off' | 'connected' | 'denied' | 'unavailable';
      };
      answers: () => unknown[];
      setGrantResult: (next: 'connected' | 'denied') => void;
      setSettings: (next: {
        enabled: boolean;
        status: 'off' | 'connected' | 'denied' | 'unavailable';
      }) => void;
      settingsOpened: () => number;
      triggerStart: (title: string) => Promise<void>;
    };
    captureTest: {
      send: typeof sendProcessing;
      state: () => ProcessingSnapshot;
      targets: StopTarget[];
      applicationAudio: unknown[];
      liveStarts: unknown[];
      callPromptAnswers: unknown[];
      callEndPromptAnswers: unknown[];
      callPrompt: () => {
        enabled: boolean;
        autoStart: boolean;
        notFor: string[];
      };
      savedSettings: () => typeof savedSettings;
      presence: () => typeof presence;
      /** The menu bar's Start session…, as the native side relays it. */
      menuBarStart: () => Promise<void>;
      /** The menu bar's call-starting switch. */
      menuBarOffer: (enabled: boolean) => Promise<void>;
      /** The companion's Start on an offer, as the native side relays it. */
      callPromptStart: (
        application: { name: string; bundleId: string } | null,
      ) => Promise<void>;
      /** Answer application_audio as a fictional host with this status. */
      host: (value: Partial<ApplicationAudioStatus>) => void;
      /** The host publishes a change, as when listing finishes. */
      hostChanged: (value: Partial<ApplicationAudioStatus>) => Promise<void>;
      refuseStart: (problem: string) => void;
      echoAnswers: unknown[];
      releaseStart: () => void;
      holdStart: () => void;
      failStart: (message: string) => void;
      holdStop: () => void;
      releaseStop: () => void;
      failStop: () => void;
      failSnapshot: () => void;
      holdDrain: () => void;
      holdName: () => void;
      holdPermission: () => void;
      releasePermission: () => void;
      releaseName: () => void;
      finishStop: typeof completeCaptureStop;
      resolveSnapshots: (value: ProcessingSnapshot) => void;
    };
    questionTest: {
      holdNextResponse: () => void;
      releaseResponse: () => void;
    };
    liveTest: {
      start: typeof startLive;
      /** The stand-in's current session, for assertions. */
      session: () => Snapshot;
      /** A fictional replay the app labels as simulated; captures nothing. */
      simulate: typeof simulate;
      say: typeof say;
      /** Lab recordings replay a whole session state at its own times. */
      publish: typeof publish;
      setCue: (cue: Snapshot['cue']) => Promise<void>;
      setQuestionSize: (size: Snapshot['questionSize']) => Promise<void>;
      /** The edge the native companion window keeps when it grows. */
      anchor: (edge: 'top' | 'bottom') => Promise<void>;
      /** Whether the page has asked for the edge; it listens first. */
      edgeAsked: () => boolean;
      /** Whether the page's read of the edge is waiting for an answer. */
      edgePending: () => boolean;
      /** Answers a held read with this edge. */
      releaseEdge: (edge: 'top' | 'bottom') => void;
      setSourceSession: (sourceSession: boolean) => Promise<void>;
      rejectNextPause: () => void;
    };
    microphoneTest: {
      send: typeof send;
      calls: string[];
      resolveSnapshot: (value: MicrophoneSnapshot) => void;
      rejectNextStop: () => void;
      holdNextStop: () => void;
      releaseStop: () => void;
    };
    dictationTest: {
      send: typeof sendDictation;
      deliverText: (target: DictationTarget, text: string) => Promise<void>;
      state: () => DictationSnapshot;
      calls: () => { command: string; target?: DictationTarget }[];
      holdStart: () => void;
      rejectNextStart: (message: string) => void;
      rejectNextStop: (message: string) => void;
    };
    updatesTest: {
      state: () => typeof updatesState;
      setNextCheck: (
        next: 'upToDate' | { available: AvailableUpdate } | { error: string },
      ) => void;
      setNextInstall: (next: 'ok' | { error: string }) => void;
      setAvailable: (offer: AvailableUpdate | null) => Promise<void>;
    };
  }
}
window.permissionTest = permissionFixture;
window.providerKeysTest = providerKeysFixture.providerKeysTest;
window.calendarTest = {
  settings: () => structuredClone(calendarSettings),
  answers: () => structuredClone(calendarPromptAnswers),
  setGrantResult: (next) => {
    calendarGrantResult = next;
  },
  setSettings: (next) => {
    calendarSettings = structuredClone(next);
  },
  settingsOpened: () => calendarSettingsOpened,
  triggerStart: (title: string) => emit('calendar-prompt:start', { title }),
};
window.captureTest = {
  presence: () => structuredClone(presence),
  menuBarStart: () => emit('menu-bar:start-session'),
  menuBarOffer: (enabled: boolean) => {
    callPrompt = { ...callPrompt, enabled };
    return emit('call-prompt:settings', structuredClone(callPrompt));
  },
  savedSettings: () => structuredClone(savedSettings),
  send: sendProcessing,
  state: () => structuredClone(processing),
  targets: stopTargets,
  applicationAudio,
  liveStarts,
  callPromptAnswers,
  callEndPromptAnswers,
  callPrompt: () => structuredClone(callPrompt),
  callPromptStart: (application) => emit('call-prompt:start', application),
  host: (value) => {
    host = {
      revision: 1,
      phase: 'off',
      application: null,
      operation: null,
      choices: [],
      problem: null,
      scopeNotice:
        'Audio from all windows of this application may be included.',
      ...value,
    } as ApplicationAudioStatus;
  },
  hostChanged: async (value) => {
    await emit('application-audio:changed', hostUpdate(value));
  },
  refuseStart: (problem) => {
    hostRefusal = problem;
  },
  echoAnswers,
  holdStart: () => {
    heldStart = true;
  },
  releaseStart: () => releaseStart?.(),
  failStart: (message) => {
    startFailure = message;
  },
  holdStop: () => {
    heldCaptureStop = true;
  },
  releaseStop: () => releaseCaptureStop?.(),
  failSnapshot: () => {
    failProcessingSnapshot = true;
  },
  failStop: () => {
    failCaptureStop = true;
  },
  holdDrain: () => {
    heldDrain = true;
  },
  holdName: () => {
    heldName = true;
  },
  releaseName: () => releaseName?.(),
  holdPermission: () => {
    heldPermission = true;
  },
  releasePermission: () => releasePermission?.(),
  finishStop: completeCaptureStop,
  resolveSnapshots: (value) => {
    delayProcessingSnapshot = false;
    initialProcessingSnapshots.splice(0).forEach((resolve) => resolve(value));
  },
};
window.questionTest = {
  holdNextResponse: () => {
    delayQuestionResponse = true;
  },
  releaseResponse: () => releaseQuestionResponse?.(),
};
window.focusTest = {
  submissions: focusSubmissions,
  current: () => session.focus,
  completed: () => completedFocus,
  hold: () => {
    heldFocus = true;
  },
  release: () => releaseFocus?.(),
};
window.nameTest = {
  submissions: nameSubmissions,
  current: () => session.userName,
};
window.liveTest = {
  start: startLive,
  session: () => structuredClone(session),
  simulate,
  say,
  publish,
  setCue: (cue) => publish({ cue }),
  setQuestionSize: (questionSize) => publish({ questionSize }),
  anchor: (edge) => {
    companionEdge = edge;
    return emit('companion:anchor', edge);
  },
  edgeAsked: () => edgeAsked,
  edgePending: () => !!releaseEdge,
  releaseEdge: (edge) => {
    releaseEdge?.(edge);
    releaseEdge = null;
  },
  // Development builds only: the cue snapshot marks a session fed by an
  // application alone.
  setSourceSession: (sourceSession: boolean) =>
    publish({ sourceSession } as Partial<Snapshot>),
  rejectNextPause: () => {
    rejectCuePause = true;
  },
};
window.microphoneTest = {
  send,
  calls,
  resolveSnapshot: (value) => resolveSnapshot?.(value),
  rejectNextStop: () => {
    rejectStop = true;
  },
  holdNextStop: () => {
    delayStop = true;
  },
  releaseStop: () => releaseStop?.(),
};
window.dictationTest = {
  send: sendDictation,
  deliverText: async (target, text) => {
    dictationSeq += 1;
    await emit('dictation:text', { target, seq: dictationSeq, text });
  },
  state: () => structuredClone(dictation),
  calls: () => structuredClone(dictationCalls),
  holdStart: () => {
    dictationHoldStart = true;
  },
  rejectNextStart: (message) => {
    dictationRejectStart = message;
  },
  rejectNextStop: (message) => {
    dictationRejectStop = message;
  },
};
window.updatesTest = {
  state: () => structuredClone(updatesState),
  setNextCheck: (next) => {
    updatesState.nextCheck = next;
  },
  setNextInstall: (next) => {
    updatesState.nextInstall = next;
  },
  setAvailable: async (offer) => {
    updatesState.available = offer;
    updatesState.phase = offer ? 'available' : 'idle';
    await emitUpdates();
  },
};
await import('../../src/main');

/** How much of each side of a card its clip covers, in CSS px: top, right,
 * bottom, left. Reads the computed `inset()` however the browser shortens
 * it, so a check can tell what is drawn at a moment of an animation. */
function cueInset(card: Element): [number, number, number, number] {
  const box = card.getBoundingClientRect();
  const found = getComputedStyle(card).clipPath.match(/inset\(([^)]*)\)/);
  if (!found) return [0, 0, 0, 0];
  const values = found[1].split(' round ')[0].trim().split(/\s+/);
  const [top, right = top, bottom = top, left = right] = values;
  const px = (value: string, across: number) =>
    value.endsWith('%')
      ? (parseFloat(value) / 100) * across
      : parseFloat(value);
  return [
    px(top, box.height),
    px(right, box.width),
    px(bottom, box.height),
    px(left, box.width),
  ];
}
declare global {
  interface Window {
    cueInset: typeof cueInset;
  }
}
window.cueInset = cueInset;
