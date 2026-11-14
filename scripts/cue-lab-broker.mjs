// Development-only local transport. The native app remains responsible for
// permission, heard speech, source validation, freshness and cue publication.
import { createServer } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  createLabOperationGate,
  gateFailure,
} from './cue-lab-operation-gate.mjs';
import { systemPromptFor, validateDecision } from './cue-lab.mjs';

const SCHEMA = 'talkqte.lab.v1';
const FRAME = 65536;
const BASE = ['schema', 'type', 'runId', 'sessionId'];
const CODES = new Set([
  'authentication',
  'credentials',
  'usage_limit',
  'deadline',
  'invalid_reply',
  'dispatch_limit',
  'unavailable',
  'protocol',
]);
const CONTROL = new Set([
  'stop',
  'pause',
  'revoke',
  'replace',
  'dismiss',
  'exit',
  'eligibility_change',
  'publication_failed',
  'transport_failed',
]);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys, optional = []) =>
  object(v) &&
  keys.every((k) => Object.hasOwn(v, k)) &&
  Object.keys(v).every((k) => keys.includes(k) || optional.includes(k));
const text = (v, max) =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  [...v].length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const u64 = (v) =>
  typeof v === 'string' &&
  /^(0|[1-9][0-9]{0,19})$/.test(v) &&
  BigInt(v) <= 18446744073709551615n;
const ms = (v) => Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const requireThat = (ok) => {
  if (!ok) throw gateFailure('protocol');
};
const wireCode = (category) =>
  ({
    auth: 'authentication',
    'ambient-credentials': 'credentials',
    'usage-limit': 'usage_limit',
    deadline: 'deadline',
    'dispatch-limit': 'dispatch_limit',
    'call-cap': 'dispatch_limit',
    schema: 'invalid_reply',
    'invalid-reply': 'invalid_reply',
    protocol: 'protocol',
    'unexpected-event': 'protocol',
    cancelled: 'protocol',
    closed: 'protocol',
  })[category] ?? 'unavailable';

export function evaluatorRequest(input) {
  requireThat(
    exact(input, ['events', 'existingCue'], ['userName', 'earlierCues']),
  );
  requireThat(
    Array.isArray(input.events) &&
      input.events.length >= 1 &&
      input.events.length <= 32,
  );
  const ids = new Set();
  let bytes = 0;
  for (const event of input.events) {
    requireThat(
      exact(event, ['id', 'speaker', 'text']) &&
        text(event.id, 160) &&
        !ids.has(event.id) &&
        event.speaker === 'Speaker' &&
        text(event.text, 4096) &&
        Buffer.byteLength(event.text) <= 4096,
    );
    ids.add(event.id);
    bytes += Buffer.byteLength(event.id + event.speaker + event.text);
  }
  if (input.existingCue !== null) {
    const cue = input.existingCue;
    requireThat(
      exact(cue, ['text', 'sourceIds']) &&
        text(cue.text, 240) &&
        Array.isArray(cue.sourceIds) &&
        cue.sourceIds.length >= 1 &&
        cue.sourceIds.length <= 4 &&
        new Set(cue.sourceIds).size === cue.sourceIds.length &&
        cue.sourceIds.every((id) => ids.has(id)),
    );
  }
  if (input.userName !== undefined) {
    requireThat(text(input.userName, 128));
    bytes += Buffer.byteLength(input.userName);
  }
  if (input.earlierCues !== undefined) {
    requireThat(
      Array.isArray(input.earlierCues) && input.earlierCues.length <= 4,
    );
    for (const cue of input.earlierCues) {
      requireThat(
        exact(cue, ['text', 'state']) &&
          text(cue.text, 240) &&
          ['resolved', 'withdrawn', 'expired'].includes(cue.state),
      );
      bytes += Buffer.byteLength(cue.text);
    }
  }
  requireThat(bytes <= 32768);
  return {
    role: 'cue-evaluator',
    instructions: systemPromptFor(input, { compact: true, glance: true }),
    input: structuredClone(input),
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'quiet', 'resolved', 'withdraw'],
        },
        cue: {
          anyOf: [
            { type: 'string', minLength: 1, maxLength: 240 },
            { type: 'null' },
          ],
        },
        sourceIds: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string', enum: [...ids] },
        },
      },
      required: ['action', 'cue', 'sourceIds'],
      additionalProperties: false,
    },
  };
}

/** provider is the ONE explicitly selected openLabProvider session. No
 * inference occurs at broker creation/listen/hello/calibration. */
export async function openLabBroker({
  provider,
  maxCalls,
  signal,
  runId = randomUUID(),
  onTerminal = () => {},
} = {}) {
  requireThat(
    provider &&
      typeof provider.request === 'function' &&
      typeof provider.close === 'function' &&
      ['codex', 'claude-code'].includes(provider.metadata?.provider) &&
      text(provider.metadata.model, 100) &&
      text(provider.metadata.effort, 20) &&
      /^[A-Za-z0-9_-]{1,64}$/.test(runId) &&
      typeof onTerminal === 'function',
  );
  requireThat(
    Number.isSafeInteger(maxCalls) && maxCalls >= 1 && maxCalls <= 100,
  );
  requireThat(!signal?.aborted);
  const directory = await mkdtemp(join(tmpdir(), 'tq-lab-'));
  const checkoutRelation = relative(
    await realpath(process.cwd()),
    await realpath(directory),
  );
  if (
    !isAbsolute(directory) ||
    (!checkoutRelation.startsWith('..') && !isAbsolute(checkoutRelation))
  ) {
    await rm(directory, { recursive: true, force: true });
    throw gateFailure('protocol');
  }
  await chmod(directory, 0o700);
  const socketPath = join(directory, 'broker.sock');
  const descriptorPath = join(directory, 'descriptor.json');
  const nonce = randomBytes(32).toString('hex');
  let socket = null,
    sessionId = null,
    authenticated = false,
    connected = false,
    closing = null;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {});
  let evaluation = null,
    probe = null,
    clock = null,
    playback = null,
    observation = null,
    snapshotRevision = null;
  const seenRequests = new Set();
  const seenRequestIds = new Set();
  const clearedCueIds = new Set();
  const send = (type, fields = {}) => {
    requireThat(socket && !socket.destroyed && sessionId !== null);
    const raw = Buffer.from(
      JSON.stringify({ schema: SCHEMA, type, runId, sessionId, ...fields }) +
        '\n',
    );
    requireThat(
      raw.length <= FRAME && socket.writableLength + raw.length <= FRAME,
    );
    socket.write(raw);
  };
  const gate = createLabOperationGate({
    provider,
    maxCalls,
    signal,
    onTerminal: (category) => {
      observation = null;
      onTerminal(category);
      readyReject(gateFailure(category));
      probe?.reject(gateFailure(category));
      evaluation?.rejectAck(gateFailure(category));
      if (authenticated && socket && !socket.destroyed) {
        try {
          send('terminal', { reason: wireCode(category) });
        } catch {
          socket.destroy();
        }
      }
    },
  });
  const fail = (category = 'protocol') => {
    gate.stop(category);
    if (!authenticated) socket?.destroy();
  };
  const base = (frame) =>
    requireThat(
      frame.schema === SCHEMA &&
        frame.runId === runId &&
        frame.sessionId === sessionId,
    );
  const identity = (frame) => {
    requireThat(u64(frame.requestId) && u64(frame.contextRevision));
    return `${frame.requestId}:${frame.contextRevision}`;
  };
  const beginEvaluate = (frame) => {
    requireThat(
      clock &&
        playback &&
        !evaluation &&
        exact(frame, [
          ...BASE,
          'requestId',
          'contextRevision',
          'budgetMs',
          'input',
        ]),
    );
    const key = identity(frame);
    requireThat(
      !seenRequests.has(key) &&
        !seenRequestIds.has(frame.requestId) &&
        seenRequests.size < 100 &&
        Number.isSafeInteger(frame.budgetMs) &&
        frame.budgetMs >= 1 &&
        frame.budgetMs <= 10000,
    );
    const request = evaluatorRequest(frame.input);
    seenRequests.add(key);
    seenRequestIds.add(frame.requestId);
    let resolveAck, rejectAck;
    const ack = new Promise((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    ack.catch(() => {});
    const operation = {
      key,
      requestId: frame.requestId,
      contextRevision: frame.contextRevision,
      resolveAck,
      rejectAck,
      resultSent: false,
      ackReceived: false,
      done: null,
    };
    evaluation = operation;
    const started = performance.now();
    operation.done = gate
      .run(
        async () => {
          const result = await gate.request(request);
          try {
            validateDecision(result.value, frame.input, { compact: true });
            requireThat(
              Buffer.byteLength(JSON.stringify(result.value)) <= 4096,
            );
            if (result.value.action === 'show')
              requireThat(result.value.cue.trim().split(/\s+/u).length <= 10);
          } catch {
            throw gateFailure('invalid-reply');
          }
          const elapsedMs = Math.ceil(performance.now() - started);
          if (elapsedMs > frame.budgetMs) throw gateFailure('deadline');
          const usage = Object.fromEntries(
            [
              'input_tokens',
              'output_tokens',
              'cached_input_tokens',
              'cache_read_input_tokens',
              'cache_creation_input_tokens',
            ]
              .filter(
                (key) =>
                  Number.isSafeInteger(result.usage?.[key]) &&
                  result.usage[key] >= 0,
              )
              .map((key) => [key, result.usage[key]]),
          );
          send('result', {
            requestId: frame.requestId,
            contextRevision: frame.contextRevision,
            value: result.value,
            elapsedMs,
            usage,
          });
          operation.resultSent = true;
          await gate.settle(() => ack, { deadlineMs: 1000 });
          return result;
        },
        { role: 'cue-evaluator', deadlineMs: frame.budgetMs },
      )
      .catch((error) => {
        if (authenticated && socket && !socket.destroyed) {
          try {
            send('failed', {
              requestId: frame.requestId,
              contextRevision: frame.contextRevision,
              code: wireCode(error.category),
            });
          } catch {
            socket.destroy();
          }
        }
        fail(error.category);
      })
      .finally(() => {
        if (evaluation === operation) evaluation = null;
      });
  };
  const observe = (frame) => {
    requireThat(exact(frame, [...BASE, 'observation']));
    const value = frame.observation;
    requireThat(
      exact(value, [
        'snapshotRevision',
        'nativeSessionElapsedMs',
        'publicationSucceeded',
        'currentCue',
        'cleared',
      ]) &&
        u64(value.snapshotRevision) &&
        ms(value.nativeSessionElapsedMs) &&
        value.publicationSucceeded === true &&
        Array.isArray(value.cleared) &&
        value.cleared.length <= 16,
    );
    requireThat(
      snapshotRevision === null ||
        BigInt(value.snapshotRevision) > BigInt(snapshotRevision),
    );
    requireThat(
      !observation ||
        value.nativeSessionElapsedMs >= observation.nativeSessionElapsedMs,
    );
    if (value.currentCue !== null) {
      const cue = value.currentCue;
      requireThat(
        exact(cue, [
          'cueId',
          'text',
          'kind',
          'held',
          'resolved',
          'decider',
          'requestId',
          'decisionAtNativeMs',
          'publishedAtNativeMs',
        ]) &&
          text(cue.cueId, 128) &&
          !clearedCueIds.has(cue.cueId) &&
          text(cue.text, 240) &&
          text(cue.kind, 40) &&
          typeof cue.held === 'boolean' &&
          typeof cue.resolved === 'boolean' &&
          cue.decider === 'model' &&
          u64(cue.requestId) &&
          [...seenRequests].some((key) =>
            key.startsWith(cue.requestId + ':'),
          ) &&
          ms(cue.decisionAtNativeMs) &&
          ms(cue.publishedAtNativeMs) &&
          cue.decisionAtNativeMs <= cue.publishedAtNativeMs &&
          cue.publishedAtNativeMs <= value.nativeSessionElapsedMs,
      );
      const prior = observation?.currentCue;
      if (prior?.cueId === cue.cueId)
        requireThat(
          prior.text === cue.text &&
            prior.publishedAtNativeMs === cue.publishedAtNativeMs &&
            prior.requestId === cue.requestId &&
            prior.kind === cue.kind &&
            prior.decisionAtNativeMs === cue.decisionAtNativeMs &&
            (!prior.resolved || cue.resolved),
        );
    }
    for (const clear of value.cleared) {
      requireThat(
        exact(clear, ['cueId', 'clearedAtNativeMs']) &&
          text(clear.cueId, 128) &&
          clear.cueId !== value.currentCue?.cueId &&
          ms(clear.clearedAtNativeMs) &&
          clear.clearedAtNativeMs <= value.nativeSessionElapsedMs,
      );
      clearedCueIds.add(clear.cueId);
      requireThat(clearedCueIds.size <= 100);
    }
    snapshotRevision = value.snapshotRevision;
    observation = structuredClone(value);
  };
  const receive = async (frame) => {
    requireThat(object(frame));
    if (!authenticated) {
      requireThat(
        exact(frame, [
          ...BASE,
          'nonce',
          'expectedProvider',
          'expectedModel',
          'expectedEffort',
        ]) &&
          frame.type === 'hello' &&
          frame.schema === SCHEMA &&
          frame.runId === runId &&
          u64(frame.sessionId) &&
          /^[a-f0-9]{64}$/.test(frame.nonce) &&
          timingSafeEqual(
            Buffer.from(frame.nonce, 'hex'),
            Buffer.from(nonce, 'hex'),
          ) &&
          frame.expectedProvider === provider.metadata.provider &&
          frame.expectedModel === provider.metadata.model &&
          frame.expectedEffort === provider.metadata.effort,
      );
      sessionId = frame.sessionId;
      authenticated = true;
      send('ready', {
        provider: provider.metadata.provider,
        model: provider.metadata.model,
        effort: provider.metadata.effort,
        dispatchBudgetKind: 'cliDispatchAttempts',
        dispatchLimit: maxCalls,
        dispatchesUsed: gate.dispatchesUsed,
      });
      readyResolve();
      return;
    }
    base(frame);
    if (frame.type === 'cancel') {
      requireThat(
        exact(frame, [...BASE, 'reason'], ['requestId', 'contextRevision']) &&
          CONTROL.has(frame.reason),
      );
      if (
        frame.requestId !== undefined ||
        frame.contextRevision !== undefined
      ) {
        identity(frame);
        if (!gate.terminal)
          requireThat(evaluation && identity(frame) === evaluation.key);
      }
      if (!gate.terminal) fail('cancelled');
      return;
    }
    if (gate.terminal) throw gateFailure(gate.terminal);
    if (frame.type === 'evaluate') {
      beginEvaluate(frame);
      return;
    }
    if (frame.type === 'settled') {
      requireThat(
        exact(
          frame,
          [...BASE, 'requestId', 'contextRevision', 'verdict'],
          ['code'],
        ) &&
          evaluation &&
          identity(frame) === evaluation.key &&
          evaluation.resultSent &&
          !evaluation.ackReceived &&
          ['current', 'staleSuccess', 'failed'].includes(frame.verdict) &&
          (frame.code === undefined ||
            (frame.verdict === 'failed' && CODES.has(frame.code))),
      );
      evaluation.ackReceived = true;
      const current = evaluation;
      if (frame.verdict === 'failed')
        current.rejectAck(gateFailure('invalid-reply'));
      else current.resolveAck();
      // Preserve sender order: a valid next request can follow its settled
      // frame in the same socket chunk, after the old lease has retired.
      await current.done;
      return;
    }
    if (frame.type === 'cue_state') {
      observe(frame);
      return;
    }
    if (frame.type === 'clock_sample') {
      requireThat(
        exact(frame, [...BASE, 'probeId', 'nativeSessionElapsedMs']) &&
          probe &&
          frame.probeId === probe.id &&
          ms(frame.nativeSessionElapsedMs),
      );
      probe.resolve({
        nativeMs: frame.nativeSessionElapsedMs,
        receivedMs: performance.now(),
      });
      return;
    }
    throw gateFailure('protocol');
  };
  const server = createServer((client) => {
    if (connected || gate.terminal) {
      client.destroy();
      fail();
      return;
    }
    connected = true;
    socket = client;
    let partial = Buffer.alloc(0),
      partialTimer = null,
      processing = false;
    const frames = [];
    const processFrames = async () => {
      if (processing) return;
      processing = true;
      try {
        while (frames.length) {
          await receive(frames.shift());
        }
      } catch (error) {
        fail(error.category);
        client.destroy();
      } finally {
        processing = false;
      }
    };
    const enqueue = (raw) => {
      requireThat(raw.length > 0 && raw.length <= FRAME && frames.length < 16);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      const frame = JSON.parse(decoded);
      frames.push(frame);
      void processFrames();
    };
    client.on('data', (chunk) => {
      try {
        let offset = 0;
        for (
          let end;
          (end = chunk.indexOf(10, offset)) !== -1;
          offset = end + 1
        ) {
          requireThat(partial.length + end - offset <= FRAME);
          const line = Buffer.concat([partial, chunk.subarray(offset, end)]);
          partial = Buffer.alloc(0);
          clearTimeout(partialTimer);
          partialTimer = null;
          enqueue(line);
        }
        requireThat(partial.length + chunk.length - offset <= FRAME);
        partial = Buffer.concat([partial, chunk.subarray(offset)]);
        if (partial.length && !partialTimer)
          partialTimer = setTimeout(() => {
            fail();
            client.destroy();
          }, 1000);
      } catch {
        fail();
        client.destroy();
      }
    });
    client.once('error', () => fail());
    client.once('close', () => {
      clearTimeout(partialTimer);
      if (!closing) fail();
    });
    client.setTimeout(5000, () => {
      if (!authenticated) {
        fail();
        client.destroy();
      }
    });
  });
  server.on('error', () => fail());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await writeFile(
      descriptorPath,
      JSON.stringify({
        schema: 'talkqte.lab.descriptor.v1',
        runId,
        socketPath,
        nonce,
      }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
  } catch {
    socket?.destroy();
    server.close();
    await gate.close();
    await rm(directory, { recursive: true, force: true });
    throw gateFailure('protocol');
  }
  return Object.freeze({
    descriptorPath,
    ready,
    gate,
    get observation() {
      return observation === null ? null : structuredClone(observation);
    },
    async calibrateClock() {
      requireThat(authenticated && !probe && !clock && !gate.terminal);
      const id = randomUUID();
      const sentMs = performance.now();
      let resolve, reject;
      const done = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      probe = { id, resolve, reject };
      const timer = setTimeout(() => reject(gateFailure('deadline')), 100);
      try {
        send('clock_probe', { probeId: id });
        const sample = await done;
        const rttMs = sample.receivedMs - sentMs;
        requireThat(rttMs <= 100);
        clock = {
          nativeMs: sample.nativeMs,
          monotonicMs: (sentMs + sample.receivedMs) / 2,
          uncertaintyMs: rttMs / 2,
        };
        requireThat(
          !playback || clock.uncertaintyMs + playback.uncertaintyMs <= 100,
        );
        return { ...clock };
      } catch (error) {
        fail(error.category);
        throw gateFailure(gate.terminal ?? 'protocol');
      } finally {
        clearTimeout(timer);
        probe = null;
      }
    },
    acknowledgePlaybackStart({ monotonicMs, uncertaintyMs }) {
      requireThat(
        !playback &&
          ms(monotonicMs) &&
          monotonicMs <= performance.now() &&
          ms(uncertaintyMs) &&
          uncertaintyMs <= 100 &&
          (!clock || clock.uncertaintyMs + uncertaintyMs <= 100),
      );
      playback = { monotonicMs, uncertaintyMs };
    },
    cuesAt(nowMs) {
      requireThat(!gate.terminal && !closing && clock && playback && ms(nowMs));
      const cue = observation?.currentCue;
      if (!cue || cue.resolved) return [];
      const atMs =
        cue.publishedAtNativeMs -
        clock.nativeMs +
        clock.monotonicMs -
        playback.monotonicMs;
      requireThat(atMs >= 0);
      if (atMs + clock.uncertaintyMs + playback.uncertaintyMs > nowMs)
        return [];
      return [
        {
          cueId: cue.cueId,
          atMs,
          text: cue.text,
          source: 'native-publication',
          decider: 'model',
        },
      ];
    },
    close() {
      if (!closing)
        closing = (async () => {
          gate.stop('closed');
          socket?.destroy();
          await new Promise((resolve) => server.close(resolve));
          let failed = false;
          try {
            await gate.close();
          } catch {
            failed = true;
          }
          try {
            await rm(directory, { recursive: true, force: true });
          } catch {
            failed = true;
          }
          if (failed) throw gateFailure('cleanup');
        })();
      return closing;
    },
  });
}
