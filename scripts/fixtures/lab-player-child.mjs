// Harmless deterministic protocol fixture, never a media/audio implementation.
import { spawn } from 'node:child_process';
const [runId, mode] = process.argv.slice(2);
const hash = '1faf1c404249bed069065f51262abfce6956fa8a31f237e68bb6e9d06cb893e2';
const base = {
  schema: 'talkqte.lab.player.v1',
  runId: mode === 'wrong-run' ? 'other' : runId,
  generation: '1',
  mediaSha256: hash,
};
const emit = (type, fields = {}) =>
  process.stdout.write(JSON.stringify({ ...base, type, ...fields }) + '\n');
const frames = mode === 'video-tail' ? 4848912 : 4919040;
const progress = (stage) =>
  emit('preparation_progress', {
    stage,
    decodedFrames: 0,
    audioTrackDurationMs: 0,
    assetDurationMs: 0,
  });
const prepared = () => {
  for (const stage of [
    'launch',
    'media-identity',
    'track-timeline',
    'audio-decode',
    'audio-duration',
    'pcm-buffer',
    'video-composition',
    'engine-connect',
    'engine-prepare',
    'window-prepare',
    'video-seek',
    'window-visible',
  ]) {
    progress(stage);
    if (mode === 'progress-deadline' && stage === 'engine-connect') return;
    if (mode === 'progress-duplicate') {
      progress(stage);
      return;
    }
    if (mode === 'progress-unknown') {
      progress('arbitrary-untrusted-text');
      return;
    }
  }
  emit('prepared', {
    pid: process.pid + (mode === 'wrong-pid' ? 1 : 0),
    windowId: 123,
    application: 'TalkQTE Lab Player',
    bundleId: 'com.talkqte.lab-player',
    processStart: { seconds: '1', microseconds: 0 },
    sampleRate: 48000,
    channels: 2,
    totalFrames: frames,
    durationMs: frames / 48,
    audioTrackDurationMs: frames / 48,
    assetDurationMs: 102480,
    videoOnly: true,
    pcmFormat:
      mode === 'wrong-pcm-format' ? 'float32-interleaved' : 'float32-planar',
  });
};
if (mode === 'exit-prepare') process.exit(7);
if (mode === 'signal-prepare') process.kill(process.pid, 'SIGTERM');
if (mode === 'prepare-failed') {
  progress('launch');
  emit('failed', {
    code: 'player_failed',
    stage: 'audio-duration',
    decodedFrames: 4848912,
    audioTrackDurationMs: 101019,
    assetDurationMs: 102480,
  });
} else prepared();
if (mode === 'duplicate') prepared();
let partial = '',
  inputBytes = 0,
  commandIndex = 0,
  reportedRead = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  partial += chunk;
  inputBytes += Buffer.byteLength(chunk);
  if (!reportedRead) {
    emit('transport_progress', {
      step: 'read',
      command: 'none',
      commandIndex: 0,
      bytesRead: inputBytes,
    });
    reportedRead = true;
  }
  for (let end; (end = partial.indexOf('\n')) !== -1;) {
    const f = JSON.parse(partial.slice(0, end));
    partial = partial.slice(end + 1);
    commandIndex++;
    const diagnostic = {
      command: f.type,
      commandIndex: mode === 'bad-transport' ? 5 : commandIndex,
      bytesRead: inputBytes,
    };
    emit('transport_progress', { ...diagnostic, step: 'parsed' });
    emit('transport_progress', { ...diagnostic, step: 'applied' });
    if (f.type === 'clock_probe') {
      if (mode === 'no-clock') continue;
      const clockTicks = process.hrtime.bigint();
      emit('clock_sample', {
        probeId: f.probeId,
        hostTicks: String(clockTicks),
        absoluteBeforeTicks: String(clockTicks),
        absoluteAfterTicks: String(clockTicks),
        timebaseNumer: 1,
        timebaseDenom: 1,
      });
    }
    if (f.type === 'start') {
      if (mode === 'no-start') continue;
      if (mode === 'oversize') {
        process.stdout.write('x'.repeat(17000));
        continue;
      }
      if (mode !== 'early-complete') {
        const ticks = process.hrtime.bigint();
        emit('started', {
          sampleRate: 48000,
          totalFrames: frames,
          timebaseNumer: 1,
          timebaseDenom: 1,
          clockPair: {
            absoluteBeforeTicks: String(ticks + 10000000n),
            continuousTicks: String(ticks + 10000000n),
            absoluteAfterTicks: String(ticks + 10000000n),
          },
          observations: [
            {
              hostTicks: String(ticks),
              sampleTime: '480',
              hostTimeValid: true,
              sampleTimeValid: true,
            },
            {
              hostTicks: String(ticks + 10000000n),
              sampleTime: '960',
              hostTimeValid: true,
              sampleTimeValid: true,
            },
          ],
          outputLatencyEstimateMs: 12,
          outputSampleRate: 48000,
          outputChannels: 2,
          outputDeviceId: 42,
          hostTimeValid: true,
          sampleTimeValid: true,
        });
      }
      setTimeout(
        () =>
          emit('audio_completed', {
            framesPlayed: frames,
            observedSampleTime: String(frames),
            callbackType: 'dataPlayedBack',
            engineRunning: false,
          }),
        5,
      );
      setTimeout(
        () => {
          if (mode === 'missing-video') return;
          emit('video_completed', {
            videoTimeMs: 102480,
            assetDurationMs: 102480,
          });
          emit('completed', {
            audioCompleted: true,
            videoCompleted: true,
            engineRunning: false,
          });
        },
        mode === 'video-tail' ? 60 : 10,
      );
    }
    if (f.type === 'stop') {
      // A failure reported after the caller's cancellation, before Stop.
      if (mode === 'fail-after-cancel')
        emit('failed', {
          code: 'player_failed',
          stage: 'engine-connect',
          decodedFrames: 0,
          audioTrackDurationMs: 0,
          assetDurationMs: 0,
        });
      // Never acknowledges Stop.
      if (mode !== 'stop-silent')
        emit('stopped', { engineRunning: false, completed: true });
    }
    if (f.type === 'retire') {
      if (mode === 'held-pipes')
        spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
          stdio: ['ignore', process.stdout, process.stderr],
        });
      process.exit(0);
    }
  }
});
process.stdin.on('end', () => process.exit(1));
