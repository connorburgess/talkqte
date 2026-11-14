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
const frames = 4919040;
const prepared = () =>
  emit('prepared', {
    pid: process.pid + (mode === 'wrong-pid' ? 1 : 0),
    windowId: 123,
    application: 'TalkQTE Lab Player',
    bundleId: 'com.talkqte.lab-player',
    processStart: { seconds: '1', microseconds: 0 },
    sampleRate: 48000,
    channels: 2,
    totalFrames: frames,
    durationMs: 102480,
    videoOnly: true,
  });
prepared();
if (mode === 'duplicate') prepared();
let partial = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  partial += chunk;
  for (let end; (end = partial.indexOf('\n')) !== -1;) {
    const f = JSON.parse(partial.slice(0, end));
    partial = partial.slice(end + 1);
    if (f.type === 'clock_probe')
      emit('clock_sample', {
        probeId: f.probeId,
        hostTicks: String(process.hrtime.bigint()),
        timebaseNumer: 1,
        timebaseDenom: 1,
      });
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
          emit('completed', {
            framesPlayed: frames,
            observedSampleTime: String(frames),
            callbackType: 'dataPlayedBack',
            engineRunning: false,
          }),
        5,
      );
    }
    if (f.type === 'stop')
      emit('stopped', { engineRunning: false, completed: true });
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
