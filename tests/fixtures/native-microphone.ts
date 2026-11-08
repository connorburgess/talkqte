// Browser tests only. This replaces the entry point through a Playwright route;
// it never opens a device or ships in the application bundle.
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import * as preview from '../../src/lib/preview';
import type { MicrophoneSnapshot } from '../../src/lib/microphone';
import type { Commands, Snapshot } from '../../src/lib/types';

let microphone: MicrophoneSnapshot = {
  revision: 0,
  status: 'off',
  activity: 'quiet',
  canStart: true,
  message: null,
};
let session: Snapshot;
let resolveSnapshot: ((value: MicrophoneSnapshot) => void) | undefined;
let rejectStop = false;
let delayStop = false;
let releaseStop: (() => void) | undefined;
let delayQuestionResponse = false;
let releaseQuestionResponse: (() => void) | undefined;
const calls: string[] = [];
const delayed = new URLSearchParams(location.search).has('delay-microphone');
// With ?live, the build reports local transcription as available.
const liveAvailable = new URLSearchParams(location.search).has('live');
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
}
async function say(text: string, question?: string) {
  const id = `t1-0-${session.transcript.length}`;
  const atMs = session.elapsedMs + 1_000;
  await publish({
    elapsedMs: atMs,
    transcript: [...session.transcript, { id, atMs, speaker: 'Speaker', text }],
    cue: question
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
        }
      : session.cue,
  });
}

mockIPC(
  async (command, args) => {
    calls.push(command);
    switch (command) {
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
        // Stands in for the engine's validation of a session-only name.
        const { name } = args as Commands['set_user_name'];
        if (name && !/^[\p{L}' -]{1,40}$/u.test(name))
          throw new Error(
            'Use letters, spaces, apostrophes, or hyphens, up to 40 characters.',
          );
        return preview.command('set_user_name', { name });
      }
      case 'live_status':
        return liveAvailable
          ? { available: true, reason: null }
          : {
              available: false,
              reason: 'This build does not include local transcription.',
            };
      case 'start_live_session':
        await startLive();
        return;
      case 'stop_live_session':
        await send({ status: 'stopping', canStart: false, activity: 'quiet' });
        await publish({ status: 'ended', cue: null });
        return;
      case 'export_preview':
        if (session.live)
          throw new Error('Live sessions are not saved or exported.');
        return preview.exportPreview();
      case 'export_markdown':
        return true;
      case 'respond_to_cue':
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
    questionTest: {
      holdNextResponse: () => void;
      releaseResponse: () => void;
    };
    liveTest: { start: typeof startLive; say: typeof say };
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
window.questionTest = {
  holdNextResponse: () => {
    delayQuestionResponse = true;
  },
  releaseResponse: () => releaseQuestionResponse?.(),
};
window.liveTest = { start: startLive, say };
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
