// Harmless subprocess protocol fixture. No screen/audio/model/window APIs.
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2),
  value = (key) => args[args.indexOf(key) + 1];
const mode = process.env.TALKQTE_RECORDER_FIXTURE;
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const matched = {
  event: 'matched',
  emulator: {
    app: value('--emulator-app'),
    pid: Number(value('--emulator-pid')),
    windowId: Number(value('--emulator-window-id')),
    frame: { x: 100, y: 80, width: 960, height: 568 },
  },
  companion: {
    app: value('--companion-app'),
    pid: Number(value('--companion-pid')),
    windowId: Number(value('--companion-window-id')),
    rule: 'exact pid/window',
    frame: { x: 700, y: 620, width: 320, height: 76 },
  },
  picture: { width: 1840, height: 1272, scale: 2 },
};
if (mode === 'wrong') matched.companion.pid++;
process.on('SIGTERM', () => {
  if (mode === 'ignore-stop') return;
  if (mode !== 'no-artifact')
    writeFileSync(value('--out'), 'fictional fixture, not a movie', {
      mode: 0o600,
    });
  emit({
    event: 'stopped',
    frames: 1,
    audioBuffers: mode === 'no-audio' ? 0 : 1,
    status: mode === 'bad-final' ? 'failed' : 'completed',
    problem: '',
    windowsMoved: mode === 'moved',
    windowsResized: false,
  });
  setTimeout(() => process.exit(mode === 'exit1' ? 1 : 0), 5);
});
if (mode === 'early') process.exit(0);
else if (mode === 'oversize') process.stdout.write('x'.repeat(270000));
else if (mode === 'bad-utf8') process.stdout.write(Buffer.from([255, 10]));
else if (mode === 'duplicate')
  process.stdout.write('{"event":"matched","event":"matched"}\n');
else if (mode === 'stderr') process.stderr.write('x'.repeat(270000));
else if (mode === 'truncated') {
  process.stdout.write('{"event":');
  setTimeout(() => process.exit(0), 20);
} else {
  emit(matched);
  if (mode === 'partial') {
    const data =
      JSON.stringify({ event: 'frame_accepted', frames: 1, wallMs: 1 }) + '\n';
    process.stdout.write(data.slice(0, 10));
    setTimeout(() => process.stdout.write(data.slice(10)), 10);
  } else if (mode !== 'spawn-only')
    emit({ event: 'frame_accepted', frames: 1, wallMs: 1 });
}
setTimeout(() => process.exit(2), 2000);
