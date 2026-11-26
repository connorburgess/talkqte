// Invoked by the Rust test only. The real CloudFeed child writes all STT rows;
// only process launch and the fictional grant are substituted. No app/provider.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareLabFixtureLauncher } from '../cue-lab-launcher.mjs';
import { DEEPGRAM_APP_QUERY } from '../cue-lab-deepgram.mjs';

const native = process.argv[2];
assert.ok(isAbsolute(native));
const selection = {
  provider: 'anthropic-api',
  model: 'claude-opus-5-5',
  effort: 'low',
  maxCalls: 2,
};
const helper = 'transcription::cloud::tests::paired::reconnect_timing_child';
const originalSpawn = childProcess.spawn;
let child;
const watchdog = setTimeout(() => {
  child?.kill('SIGKILL');
  process.exitCode = 1;
}, 30000);
mock.method(childProcess, 'spawn', (executable, args, options) => {
  assert.equal(executable, process.execPath);
  assert.equal(args.length, 1);
  assert.ok(args[0].endsWith('/fixture-child.mjs'));
  // launcher already restricts the environment. Rebuild an allowlist rather
  // than forward ambient credentials or native provider configuration.
  const env = Object.fromEntries(
    [
      'PATH',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'TALKQTE_TIMING_LOG',
      'TALKQTE_DEV_LAB_RUN_ID',
      'TALKQTE_DEV_STT_TOKEN_FILE',
    ]
      .filter((k) => options.env[k] !== undefined)
      .map((k) => [k, options.env[k]]),
  );
  child = originalSpawn(
    native,
    ['--exact', helper, '--ignored', '--nocapture', '--test-threads=1'],
    { ...options, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return child;
});
syncBuiltinESMExports();
const until = async (check, label) => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, label);
    assert.equal(child?.exitCode, null, `native exited: ${label}`);
    assert.equal(child?.signalCode, null, `native signaled: ${label}`);
    await delay(5);
  }
};
const rows = (launcher) =>
  readFileSync(launcher.timingPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
const states = (launcher) =>
  rows(launcher).filter((r) => r.event === 'stt_state');
try {
  for (const scenario of [
    'double-pending',
    'stop-pending',
    'initial-unconfirmed',
  ]) {
    const launcher = prepareLabFixtureLauncher({
      fixtureCase: 'cloud-reconnect-pending',
      selection,
      transcription: {
        backend: 'deepgram',
        minuteCap: 5,
        reconnect: true,
        grant: {
          writeTokenFile(file) {
            writeFileSync(
              file,
              'fictional.offline-reconnect-token.0123456789',
              { mode: 0o600, flag: 'wx' },
            );
          },
        },
      },
    });
    const token = join(launcher.directory, 'stt-token');
    const descriptor = join(launcher.directory, 'descriptor.json');
    writeFileSync(descriptor, '{}', { mode: 0o600 });
    const observed = [];
    let stderr = '',
      frames = [];
    try {
      launcher.launch({
        executable: launcher.executable,
        environment: {
          TALKQTE_DEV_STOP_SIGNAL: 'usr2',
          TALKQTE_DEV_STOP_AFTER_S: '120',
          TALKQTE_DEV_LAB_RUN_ID: 'paired-reconnect',
          TALKQTE_DEV_CUE_BACKEND: 'lab-api',
          TALKQTE_DEV_LAB_DESCRIPTOR: descriptor,
          TALKQTE_DEV_LAB_PROVIDER: selection.provider,
          TALKQTE_DEV_LAB_MODEL: selection.model,
          TALKQTE_DEV_LAB_EFFORT: selection.effort,
          TALKQTE_DEV_LAB_SPEND_CAP_MICRO_USD: '1000000',
        },
        metadata: { ...selection, spendCapMicroUsd: 1_000_000 },
        onTiming: (row) => observed.push(row),
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const at = line.indexOf('PAIR ');
        if (at !== -1) frames.push(JSON.parse(line.slice(at + 5)));
      });
      const step = async (command) => {
        child.stdin.write(command + '\n');
        await until(
          () => frames.some((f) => f.command === command),
          `native stage ${command}: ${stderr}`,
        );
        return frames.find((f) => f.command === command);
      };
      // This review is a synthetic bootstrap, not app approval acceptance.
      await until(
        () => launcher.transcription.reviewedSession === 7,
        'review consumed',
      );
      assert.equal(readFileSync(token).length, 0);
      launcher.releaseTranscriptionToken();
      assert.equal((await step('start')).result, null);
      await until(
        () => launcher.transcription.started,
        'native started consumed',
      );
      if (scenario !== 'initial-unconfirmed') {
        await step('first-connected');
        await until(
          () => launcher.transcription.connectedQuery === DEEPGRAM_APP_QUERY,
          'native first Connected consumed',
        );
      }
      const pending = await step('first-failed');
      assert.deepEqual(pending.callbacks, []);
      assert.equal(pending.opens, 1);
      assert.equal(pending.firstAborted, true);
      if (scenario === 'initial-unconfirmed') {
        await until(
          () => observed.some((r) => r.event === 'dropped'),
          'unconfirmed query refused',
        );
        assert.equal(launcher.transcription.connectedQuery, null);
        assert.equal(launcher.transcription.reconnects, 0);
        assert.equal(
          pending.result,
          null,
          'native allows recovery before first Connected, JS intentionally refuses',
        );
        await step('end');
      } else {
        await until(
          () => launcher.transcription.reconnects === 1,
          'first replacement consumed',
        );
        assert.equal(existsSync(token), true);
        if (scenario === 'stop-pending') {
          const stopped = await step('stop-pending');
          assert.deepEqual(
            stopped.callbacks,
            [],
            'Stop drain must not disclose successful reconnect',
          );
          await until(() => launcher.sourceReleased, 'released consumed');
          assert.equal(existsSync(token), false);
          // Existing production finish() logs the drained Connected row but
          // suppresses the success callback. Do not call that a live recovery.
          assert.equal(
            states(launcher).filter((r) => r.state === 'connected').length,
            2,
          );
        } else {
          const second = await step('pending-failed');
          assert.deepEqual(second.callbacks, []);
          assert.equal(second.pendingAborted, true);
          assert.equal(second.opens, 2);
          await until(
            () => launcher.transcription.reconnects === 2,
            'second pending replacement consumed',
          );
          assert.equal(existsSync(token), true);
          const connected = await step('last-connected');
          assert.deepEqual(connected.callbacks, [200]);
          await until(
            () =>
              states(launcher).filter((r) => r.state === 'connected').length ===
                2 && launcher.userName.changes >= 4,
            'final native rows consumed',
          );
          assert.equal(
            observed.some((r) => r.event === 'dropped'),
            false,
            'actual second pending attempt must be accepted',
          );
          assert.equal(
            launcher.transcription.connectedQuery,
            DEEPGRAM_APP_QUERY,
          );
          assert.deepEqual(
            states(launcher).map((r) => r.state),
            [
              'started',
              'connected',
              'reconnecting',
              'reconnecting',
              'connected',
            ],
          );
          assert.deepEqual(
            states(launcher)
              .filter((r) => r.state === 'reconnecting')
              .map((r) => r.gap_ms),
            [100, 100],
          );
          const exhausted = await step('exhaust-to-cap');
          assert.equal(exhausted.result, null);
          assert.equal(exhausted.opens, 10);
          await until(
            () => launcher.transcription.reconnects === 10,
            'reconnect attempts exhausted to cap',
          );
          const capped = await step('last-failed');
          assert.equal(capped.result, 'network');
          assert.equal(
            capped.opens,
            10,
            'native cap forbids an eleventh opener',
          );
          assert.equal(launcher.transcription.reconnects, 10);
        }
      }
      const exit = once(child, 'exit');
      child.stdin.end('exit\n');
      const [code] = await exit;
      assert.equal(code, 0, stderr);
      launcher.close();
      assert.equal(existsSync(token), false);
      assert.equal(launcher.transcription.tokenRemoved, true);
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
      console.log(
        JSON.stringify({
          scenario,
          nativeStates: states(launcher).map((r) => r.state),
          callbacks: frames.at(-1).callbacks,
          dropped: observed.some((r) => r.event === 'dropped'),
          tokenRemoved: true,
          childGone: true,
        }),
      );
      lines.close();
    } finally {
      launcher.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill('SIGKILL');
        await exit;
      }
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      rmSync(launcher.directory, { recursive: true, force: true });
    }
  }
} finally {
  clearTimeout(watchdog);
  mock.restoreAll();
  syncBuiltinESMExports();
}
