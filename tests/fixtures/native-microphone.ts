// Browser tests only. This replaces the entry point through a Playwright route;
// it never opens a device or ships in the application bundle.
import { fictionalPermissions } from './processing-permissions';
import * as granolaFixture from './native-granola';
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import * as preview from '../../src/lib/preview';
import type { MicrophoneSnapshot } from '../../src/lib/microphone';
import type {
  Commands,
  LiveStatus,
  ModelStatus,
  Snapshot,
} from '../../src/lib/types';
import type { ProcessingSnapshot, StopTarget } from '../../src/lib/processing';

let microphone: MicrophoneSnapshot = {
  revision: 0,
  status: 'off',
  activity: 'quiet',
  canStart: true,
  message: null,
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
// With ?live, the build reports local transcription as available.
const liveAvailable = new URLSearchParams(location.search).has('live');
// With ?model, the build has local transcription but no model yet.
const modelBuild = new URLSearchParams(location.search).has('model');
let model: ModelStatus = {
  revision: 0,
  status: modelBuild ? 'missing' : 'unavailable',
  name: 'tiny.en',
  sizeBytes: 77_704_715,
  neededBytes: 77_704_715 + 512 * 1024 * 1024,
  received: 0,
  message: null,
};
let releaseDownload: ((outcome: 'done' | 'cancelled') => void) | undefined;
let holdLiveStatus = false;
const heldLiveStatuses: {
  value: LiveStatus;
  resolve: (value: LiveStatus) => void;
  reject: (error: Error) => void;
}[] = [];
async function sendModel(value: Partial<ModelStatus>) {
  model = { ...model, revision: model.revision + 1, ...value };
  await emit('model:changed', model);
}
Object.defineProperty(window, 'isTauri', { value: true, configurable: true });

async function send(value: Partial<MicrophoneSnapshot>) {
  microphone = { ...microphone, revision: microphone.revision + 1, ...value };
  await emit('microphone:changed', microphone);
}

// Stands in for the Rust live session: no device, model, or transcription.
async function publish(value: Partial<Snapshot>) {
  session = {
    ...session,
    ...value,
    revision: Math.max(session.revision, 1_000) + 1,
  };
  await emit('session:changed', session);
  await emit('cue:changed', session);
}
async function startLive() {
  await publish({
    live: true,
    cuesPaused: false,
    status: 'running',
    title: 'Live session',
    description: 'Transcript lines from a local transcription source.',
    elapsedMs: 0,
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
            expanded: false,
            resolvedBy: null,
            note: null,
            aboutFocus: false,
          }
        : session.cue,
  });
}

mockIPC(
  async (command, args) => {
    calls.push(command);
    if (
      new URLSearchParams(location.search).has('granola') &&
      granolaFixture.commands.includes(command)
    ) {
      return granolaFixture.command(command, args);
    }
    if (permissionFixture.commands.includes(command))
      return permissionFixture.command(command, args);
    switch (command) {
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
      case 'set_user_name': {
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
      case 'keep_line':
        return preview.command('keep_line', args as Commands['keep_line']);
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
      case 'model_status':
        return structuredClone(model);
      case 'download_model':
        // Stands in for the Rust download: no network or file.
        await sendModel({ status: 'downloading', received: 0, message: null });
        await sendModel({ received: 30_000_000 });
        void new Promise<'done' | 'cancelled'>((resolve) => {
          releaseDownload = resolve;
        }).then((outcome) =>
          sendModel(
            outcome === 'done'
              ? { status: 'installed', received: 0 }
              : {
                  status: 'missing',
                  received: 0,
                  message: 'Download cancelled. Nothing was installed.',
                },
          ),
        );
        return;
      case 'cancel_model_download':
        releaseDownload?.('cancelled');
        return;
      case 'remove_model':
        await sendModel({ status: 'missing', message: null });
        return;
      case 'live_status': {
        const value: LiveStatus =
          liveAvailable || model.status === 'installed'
            ? { available: true, reason: null }
            : {
                available: false,
                reason: modelBuild
                  ? 'The local speech model is not installed.'
                  : 'This build does not include local transcription.',
              };
        if (holdLiveStatus) {
          holdLiveStatus = false;
          return new Promise<LiveStatus>((resolve, reject) => {
            heldLiveStatuses.push({ value, resolve, reject });
          });
        }
        return value;
      }
      case 'start_live_session':
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
      case 'export_preview':
        if (session.live)
          throw new Error('Live sessions are not saved or exported.');
        return preview.exportPreview();
      case 'export_markdown':
        return true;
      case 'inspect_cue': {
        if (!session.live)
          return preview.command(command, args as Commands['inspect_cue']);
        const { id, expanded } = args as Commands['inspect_cue'];
        if (session.cue?.id !== id)
          throw new Error('That question has already passed.');
        await publish({ cue: { ...session.cue, expanded, held: true } });
        return;
      }
      case 'respond_to_cue':
        if (session.live) {
          if (session.cue?.id !== (args as Commands['respond_to_cue']).id)
            throw new Error('That question has already passed.');
          await publish({ cue: null });
          return;
        }
        preview.command(command, args as Commands['respond_to_cue']);
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
  session = value;
  void emit('session:changed', value);
  void emit('cue:changed', value);
});

declare global {
  interface Window {
    permissionTest: typeof permissionFixture;
    captureTest: {
      send: typeof sendProcessing;
      state: () => ProcessingSnapshot;
      targets: StopTarget[];
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
      say: typeof say;
      setCue: (cue: Snapshot['cue']) => Promise<void>;
      setQuestionSize: (size: Snapshot['questionSize']) => Promise<void>;
      rejectNextPause: () => void;
    };
    modelTest: {
      finish: () => void;
      holdNextStatus: () => void;
      pendingStatuses: () => number;
      releaseStatus: (fail?: boolean) => void;
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
window.captureTest = {
  send: sendProcessing,
  state: () => structuredClone(processing),
  targets: stopTargets,
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
window.liveTest = {
  start: startLive,
  say,
  setCue: (cue) => publish({ cue }),
  setQuestionSize: (questionSize) => publish({ questionSize }),
  rejectNextPause: () => {
    rejectCuePause = true;
  },
};
window.modelTest = {
  finish: () => releaseDownload?.('done'),
  holdNextStatus: () => {
    holdLiveStatus = true;
  },
  pendingStatuses: () => heldLiveStatuses.length,
  releaseStatus: (fail = false) => {
    const pending = heldLiveStatuses.shift();
    if (fail) pending?.reject(new Error('Status unavailable.'));
    else if (pending) pending.resolve(pending.value);
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
