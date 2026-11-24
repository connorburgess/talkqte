// Browser tests only. This replaces the entry point through a Playwright route;
// it never opens a device or ships in the application bundle.
import { fictionalPermissions } from './processing-permissions';
import * as granolaFixture from './native-granola';
import * as contextFixture from './native-context';
import * as providerKeysFixture from './native-provider-keys';
import * as meetingNotesFixture from './native-meeting-notes';
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import * as preview from '../../src/lib/preview';
import type { MicrophoneSnapshot } from '../../src/lib/microphone';
import type { Commands, LiveStatus, Snapshot } from '../../src/lib/types';
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
// The call-starting prompt's settings and the companion's answers.
let callPrompt = { enabled: false, notFor: [] as string[] };
const callPromptAnswers: unknown[] = [];
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
async function completeCaptureStop() {
  await send({
    status: 'off',
    canStart: true,
    activity: 'quiet',
    message: null,
  });
  await publish({ status: 'ended', cue: null, cuesPaused: false });
  await sendProcessing({
    capture: 'off',
    phase: 'ended',
    approved: null,
    scopeRevision: processing.scopeRevision + 1,
  });
}
async function beginStart() {
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
  await startLive();
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
Object.defineProperty(window, 'isTauri', { value: true, configurable: true });

async function send(value: Partial<MicrophoneSnapshot>) {
  microphone = { ...microphone, revision: microphone.revision + 1, ...value };
  await emit('microphone:changed', microphone);
}

// Stands in for the Rust live session: no device, stream, or transcription.
async function publish(value: Partial<Snapshot>) {
  session = {
    ...session,
    ...value,
    revision: Math.max(session.revision, 1_000) + 1,
  };
  await emit('session:changed', session);
  await emit('cue:changed', session);
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
async function startLive() {
  await publish({
    live: true,
    simulated: false,
    cuesPaused: false,
    status: 'running',
    title: 'Live session',
    description: "Transcript lines from this session's transcription.",
    elapsedMs: 0,
    // Every live session is transcribed by the launch's cloud provider,
    // which sends nothing until cue processing is enabled.
    transcription: { provider: 'Deepgram' },
    // Rust sends u64::MAX for a live session, which has no end.
    durationMs: 18_446_744_073_709_552_000,
    transcript: [],
    cue: null,
  });
  await send({ status: 'listening', activity: 'active', canStart: false });
  await sendProcessing({
    capture: 'running',
    phase: 'off',
    startup: 'idle',
    session: `fictional-session-${operation}`,
    approved: null,
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
          return preview.command('set_focus', { lines });
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
        return [];
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
      case 'import_context_notes': {
        const { ids } = args as { ids: string[] };
        const outcome = preview.importContextNotes(ids);
        await emit('context:changed', await preview.contextItemsNow());
        return outcome;
      }
      case 'remove_context_from': {
        const removed = preview.removeAllContext();
        await emit('context:changed', await preview.contextItemsNow());
        return removed;
      }
      case 'remove_context_item':
        preview.command(
          'remove_context_item',
          args as Commands['remove_context_item'],
        );
        await emit('context:changed', await preview.contextItemsNow());
        return;
      case 'live_status': {
        const value: LiveStatus = liveAvailable
          ? { available: true, reason: null, transcription: 'Deepgram' }
          : {
              available: false,
              reason: 'This build has no live transcription.',
            };
        return value;
      }
      case 'call_prompt_settings':
        return structuredClone(callPrompt);
      case 'set_call_prompt':
        callPrompt = {
          ...callPrompt,
          enabled: (args as { enabled: boolean }).enabled,
        };
        return structuredClone(callPrompt);
      case 'clear_call_prompt_apps':
        callPrompt = { ...callPrompt, notFor: [] };
        return structuredClone(callPrompt);
      case 'respond_to_call_prompt':
        callPromptAnswers.push(structuredClone(args));
        return;
      case 'start_live_session':
        liveStarts.push(structuredClone(args ?? null));
        await beginStart();
        return;
      case 'stop_live_session':
        await send({ status: 'stopping', canStart: false, activity: 'quiet' });
        await publish({ status: 'ended', cue: null, cuesPaused: false });
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
    captureTest: {
      send: typeof sendProcessing;
      state: () => ProcessingSnapshot;
      targets: StopTarget[];
      applicationAudio: unknown[];
      liveStarts: unknown[];
      callPromptAnswers: unknown[];
      callPrompt: () => { enabled: boolean; notFor: string[] };
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
  }
}
window.permissionTest = permissionFixture;
window.providerKeysTest = providerKeysFixture.providerKeysTest;
window.captureTest = {
  send: sendProcessing,
  state: () => structuredClone(processing),
  targets: stopTargets,
  applicationAudio,
  liveStarts,
  callPromptAnswers,
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
