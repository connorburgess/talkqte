// Fictional IPC only: no microphone, provider, credentials or inference.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { ProcessingControl } from '../../src/components/ProcessingControl';
import {
  noteKey,
  type ExpectedScope,
  type StopTarget,
  type ProcessingReview,
  type ProcessingScope,
  type ProcessingSnapshot,
  type ApplicationAudioAction,
  type ApplicationAudioStatus,
} from '../../src/lib/processing';
import '../../src/styles.css';

const hosted = new URLSearchParams(location.search).has('hosted');
let state: ProcessingSnapshot = {
  revision: 1,
  session: 'fictional-garden',
  scopeRevision: 1,
  phase: 'off',
  capture: 'running',
  startup: 'idle',
  stopTarget: { operation: 'fictional-live-1', microphone: '1' },
  approved: null,
  issue: null,
  lastDecision: null,
  processor: {
    id: 'fictional-processor',
    revision: 1,
    name: 'Garden evaluator',
    model: 'Fictional model',
    location: hosted ? 'hosted' : 'onDevice',
    destination: hosted ? 'Example service' : '',
    dataPolicy: hosted
      ? 'Selected context leaves this device for Example service. This fictional policy does not promise immediate deletion by the service.'
      : 'Selected context is processed on this device. Approval is kept in memory for this session.',
  },
  notes: [
    {
      provider: 'granola',
      sourceId: 'garden',
      revision: 2,
      title: 'Garden launch · watering plan',
      sourceDate: '2026-11-01',
    },
    {
      provider: 'file',
      sourceId: 'garden',
      revision: 1,
      title: 'Garden launch · supplier review',
      sourceDate: '2026-11-02',
    },
  ],
};
let liveMicrophone: string | null = '1';
const calls: { command: string; args: unknown }[] = [];
const reviews = new Map<string, ProcessingReview>();
const holds = new Map<string, () => void>();
const delayed = new Set<string>();
const failures = new Map<string, string>();
let reviewNumber = 0;
let delayedSnapshot: (() => void) | undefined;
let mismatchedReview = false;
async function send(value: Partial<ProcessingSnapshot>) {
  if (value.startup === 'loading') liveMicrophone = null;
  state = { ...state, ...value, revision: state.revision + 1 };
  await emit('processing:changed', structuredClone(state));
}
async function boundary(value: Partial<ProcessingSnapshot>) {
  reviews.clear();
  await send({ scopeRevision: state.scopeRevision + 1, ...value });
}
mockIPC(
  async (command, args) => {
    calls.push({ command, args: structuredClone(args) });
    const requireScope = () => {
      const expected = (args as { expected?: ExpectedScope }).expected;
      if (
        expected?.session !== state.session ||
        expected?.scopeRevision !== state.scopeRevision
      )
        throw 'scope_changed';
    };
    // Capture review/snapshot BEFORE the held reply to exercise stale messages.
    let response: ProcessingReview | undefined;
    if (command === 'review_processing_scope') {
      requireScope();
      const scope = (args as { scope: ProcessingScope }).scope;
      response = {
        id: `review-${++reviewNumber}`,
        session: state.session,
        scopeRevision: state.scopeRevision,
        processor: state.processor!,
        scope,
        notes: state.notes.filter((note) =>
          scope.notes.some((item) => noteKey(item) === noteKey(note)),
        ),
      };
      if (mismatchedReview)
        response.scope = { ...scope, conversation: 'recentAndNewSpeech' };
      reviews.set(response.id, structuredClone(response));
    }
    if (
      command === 'processing_snapshot' &&
      new URLSearchParams(location.search).has('delay-snapshot') &&
      !delayedSnapshot
    ) {
      const snapshot = structuredClone(state);
      return new Promise((resolve) => {
        delayedSnapshot = () => resolve(snapshot);
      });
    }
    if (delayed.delete(command))
      await new Promise<void>((resolve) => holds.set(command, resolve));
    if (failures.has(command)) {
      const error = failures.get(command)!;
      failures.delete(command);
      throw error;
    }
    switch (command) {
      case 'processing_snapshot':
        return structuredClone(state);
      case 'review_processing_scope':
        return response;
      case 'cancel_processing_review':
        reviews.delete((args as { id: string }).id);
        return;
      case 'approve_processing_scope': {
        const review = reviews.get((args as { id: string }).id);
        if (
          !review ||
          review.session !== state.session ||
          review.scopeRevision !== state.scopeRevision ||
          state.capture !== 'running'
        )
          throw 'scope_changed';
        await boundary({
          phase: 'active',
          approved: review.scope,
          issue: null,
        });
        return;
      }
      case 'revoke_processing':
        requireScope();
        await boundary({
          phase: 'off',
          approved: null,
          issue: null,
          lastDecision: null,
        });
        return;
      case 'set_processing_paused':
        requireScope();
        if (
          !state.approved ||
          state.capture !== 'running' ||
          !['active', 'paused'].includes(state.phase)
        )
          throw 'scope_changed';
        await boundary({
          phase: (args as { paused: boolean }).paused ? 'paused' : 'active',
          lastDecision: null,
        });
        return;
      case 'stop_capture': {
        const target = (args as { target: StopTarget }).target;
        if (target.operation !== state.stopTarget.operation)
          throw 'capture_changed';
        // A live startup owns the generation it later reserved. A replacement
        // standalone capture is independent and must remain running.
        const ownedMicrophone = liveMicrophone ?? target.microphone;
        liveMicrophone = null;
        await boundary({
          phase: 'ended',
          capture:
            ownedMicrophone !== state.stopTarget.microphone
              ? state.capture
              : state.capture === 'off'
                ? 'off'
                : 'stopping',
          startup: state.startup === 'loading' ? 'cancelling' : state.startup,
          approved: null,
          lastDecision: null,
        });
        return;
      }
      case 'application_audio':
        // Development builds only; recorded in calls. Answered with nothing
        // unless a test has set up the host's own status.
        // A test can have the status event arrive before the reply.
        if (sourceStopEvent) {
          const event = sourceStopEvent;
          sourceStopEvent = null;
          await send(event);
        }
        if (!host) return null;
        return hostAction((args as { action: ApplicationAudioAction }).action);
      default:
        throw `Unexpected fictional command: ${command}`;
    }
  },
  { shouldMockEvents: true },
);

let sourceStopEvent: Partial<ProcessingSnapshot> | null = null;
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
      return hostUpdate({ phase: 'starting' });
  }
}
const control = {
  calls,
  send,
  /** The next application_audio command publishes this before replying. */
  publishBeforeSourceReply: (value: Partial<ProcessingSnapshot>) => {
    sourceStopEvent = value;
  },
  /** Answer application_audio as a fictional host with this status. */
  host: (value: Partial<ApplicationAudioStatus>) => {
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
    };
  },
  /** The host publishes a change, as when listing finishes. */
  hostChanged: (value: Partial<ApplicationAudioStatus>) =>
    emit('application-audio:changed', hostUpdate(value)),
  /** The next start is refused with this problem. */
  refuseStart: (problem: string) => {
    hostRefusal = problem;
  },
  replaceSources: () =>
    boundary({
      notes: state.notes.map((note) => ({
        ...note,
        revision: note.revision + 1,
      })),
      phase: 'off',
      approved: null,
      issue: 'scopeChanged',
    }),
  newSession: () => {
    liveMicrophone = '3';
    return boundary({
      session: 'fictional-garden-next',
      stopTarget: { operation: 'fictional-live-2', microphone: '3' },
      startup: 'idle',
      phase: 'off',
      capture: 'running',
      approved: null,
      issue: null,
    });
  },
  installCapture: async () => {
    liveMicrophone = '2';
    await send({
      startup: 'idle',
      capture: 'running',
      stopTarget: { operation: state.stopTarget.operation, microphone: '2' },
    });
  },
  hold: (command: string) => delayed.add(command),
  release: (command: string) => {
    holds.get(command)?.();
    holds.delete(command);
  },
  fail: (command: string, error = 'PRIVATE_PROVIDER_ERROR') =>
    failures.set(command, error),
  releaseSnapshot: () => delayedSnapshot?.(),
  mismatch: () => {
    mismatchedReview = true;
  },
  stale: () =>
    emit('processing:changed', {
      ...state,
      revision: 0,
      phase: 'active',
      capture: 'running',
    }),
};
declare global {
  interface Window {
    processingTest: typeof control;
  }
}
window.processingTest = control;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main style={{ padding: '24px 12px', maxWidth: 1000, margin: '0 auto' }}>
      <p style={{ marginBottom: 20 }}>
        Fictional control study · no microphone or model is running
      </p>
      <ProcessingControl />
    </main>
  </StrictMode>,
);
