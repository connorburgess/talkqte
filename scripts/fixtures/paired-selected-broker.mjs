// Spawned only by the offline Rust integration test. All external SDK delivery
// is replaced at the real worker's entry; public transport/worker code is real.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as processes from 'node:child_process';
import * as net from 'node:net';
import { access } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const report = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const workerPath = fileURLToPath(
  new URL('../cue-lab-anthropic-worker.mjs', import.meta.url),
);
const preload = fileURLToPath(
  new URL('./paired-selected-sdk.mjs', import.meta.url),
);
let worker,
  nativeRequest,
  workerRequest,
  installed = false,
  constructed = false;
const frames = [];
let confirmSdk;
const sdkReady = new Promise((resolve) => {
  confirmSdk = resolve;
});
const { default: processDefault, ...processNamed } = processes;
mock.module('node:child_process', {
  defaultExport: processDefault,
  namedExports: {
    ...processNamed,
    spawn(command, args, options) {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [workerPath]);
      assert.equal(worker, undefined);
      worker = processes.spawn(
        command,
        [
          '--no-warnings',
          '--experimental-test-module-mocks',
          '--import',
          preload,
          ...args,
        ],
        {
          ...options,
          stdio: [options.stdio[0], options.stdio[1], 'pipe', 'ipc'],
        },
      );
      report({ type: 'worker-started', workerPid: worker.pid });
      worker.stderr.pipe(process.stderr);
      worker.on('message', (frame) => {
        if (frame.type === 'sdk-installed') installed = true;
        else if (frame.type === 'sdk-constructed') {
          assert.ok(installed);
          constructed = true;
          confirmSdk();
        } else {
          assert.ok(installed && constructed);
          if (frame.type === 'sdk-request') {
            assert.ok(nativeRequest);
            assert.deepEqual(frame.input, nativeRequest.input);
            workerRequest = frame.id;
            report({
              ...frame,
              nativeIdentity: {
                sessionId: nativeRequest.sessionId,
                requestId: nativeRequest.requestId,
                contextRevision: nativeRequest.contextRevision,
              },
            });
          } else {
            assert.equal(frame.id, workerRequest);
            report(frame);
          }
        }
      });
      return worker;
    },
  },
});
const { default: netDefault, ...netNamed } = net;
mock.module('node:net', {
  defaultExport: netDefault,
  namedExports: {
    ...netNamed,
    createServer(listener) {
      return net.createServer((socket) => {
        let partial = '';
        socket.on('data', (chunk) => {
          partial += chunk.toString('utf8');
          for (let end; (end = partial.indexOf('\n')) !== -1;) {
            const frame = JSON.parse(partial.slice(0, end));
            partial = partial.slice(end + 1);
            if (['evaluate', 'cancel', 'settled'].includes(frame.type))
              frames.push(frame);
            if (frame.type === 'evaluate') nativeRequest = frame;
          }
        });
        listener(socket);
      });
    },
  },
});
let ownedDescriptor;
process.once('exit', () => {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    try {
      process.kill(-worker.pid, 'SIGKILL');
    } catch {}
  }
  if (ownedDescriptor)
    rmSync(dirname(ownedDescriptor), { recursive: true, force: true });
});
const { openLabBroker } = await import('../cue-lab-broker.mjs');
const { openLabProvider } = await import('../cue-lab-provider.mjs');
const { openAnthropicLab } = await import('../cue-lab-anthropic.mjs');
const { SELECTED_CONTEXT } = await import('../cue-selected-context.mjs');
// History uses the ordinary transcript wire, as cue-lab-run does. This test
// argument selects no native scope; each Rust Engine still requires approval.
const contextPolicy = process.argv[2] ?? SELECTED_CONTEXT;
assert.ok([SELECTED_CONTEXT, 'fresh-only'].includes(contextPolicy));
const provider = await openLabProvider({
  provider: 'anthropic-api',
  model: 'claude-opus-5-5',
  effort: 'low',
  maxCalls: 4,
  deadlineMs: 30000,
  contextPolicy,
  execution: 'offline-stand-in',
  environment: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
  },
  deferOpen: true,
  openers: {
    'anthropic-api': (options) =>
      openAnthropicLab({
        ...options,
        offline: {
          baseUrl: 'http://127.0.0.1:1',
          key: 'sk-ant-api-offline-paired',
        },
      }),
  },
});
// No descriptor is exposed until the real worker confirms fake SDK construction.
try {
  await provider.open();
} catch (e) {
  console.error({ workerSpawned: !!worker, installed, constructed });
  throw e;
}
let mockTimer;
try {
  await Promise.race([
    sdkReady,
    new Promise((_, reject) => {
      mockTimer = setTimeout(
        () => reject(new Error('SDK injection not confirmed')),
        1000,
      );
    }),
  ]);
} finally {
  clearTimeout(mockTimer);
}
assert.ok(installed && constructed);
const broker = await openLabBroker({
  onTerminal: (reason) => {
    if (!['cancelled', 'closed'].includes(reason))
      console.error(JSON.stringify({ reason, frames }));
  },
  provider,
  maxCalls: 4,
  contextPolicy,
});
ownedDescriptor = broker.descriptorPath;
broker.expectSourceSession('1');
// Synthetic source-start marker, established before Rust can send any speech.
// This is not actual playback acceptance. Native can evaluate immediately after
// its clock sample; marking source start after calibration would race that input.
broker.acknowledgePlaybackStart({
  monotonicMs: performance.now(),
  uncertaintyMs: 0,
});

const finish = async () => {
  await broker.close();
  await assert.rejects(access(broker.descriptorPath), { code: 'ENOENT' });
  assert.throws(() => process.kill(-worker.pid, 0), { code: 'ESRCH' });
  report({
    type: 'done',
    resultsSent: broker.evaluationSummary.resultsSent,
    summary: broker.evaluationSummary,
    frames,
    descriptorRemoved: true,
    workerGone: true,
  });
  process.stdout.write('', () => process.exit(0));
};
let buffer = '',
  finishing = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end; (end = buffer.indexOf('\n')) !== -1;) {
    const frame = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (frame.type === 'status') {
      report({
        type: 'status',
        dispatched: broker.evaluationSummary.dispatched,
        evaluations: frames.filter((f) => f.type === 'evaluate').length,
      });
    } else if (frame.type === 'release')
      worker.send({ type: 'release', id: workerRequest });
    else if (frame.type === 'finish' && !finishing) {
      finishing = true;
      finish().catch((e) => {
        console.error(e);
        process.exit(1);
      });
    } else throw new Error('unexpected Rust test control');
  }
});
process.stdin.on('end', () => {
  if (!finishing) {
    finishing = true;
    finish().catch(() => process.exit(1));
  }
});
const watchdog = setTimeout(() => {
  console.error('paired fixture watchdog');
  process.exit(1);
}, 20000);
watchdog.unref();
report({
  type: 'descriptor',
  path: broker.descriptorPath,
  workerPid: worker.pid,
  sdkMocked: true,
});
broker.ready
  .then(async () => {
    await broker.calibrateClock();
    report({ type: 'calibrated' });
  })
  .catch((e) => {
    if (!finishing) {
      console.error(e);
      process.exit(1);
    }
  });
