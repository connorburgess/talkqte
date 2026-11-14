// Harmless launcher fixture: writes synthetic control evidence only. It never
// opens an app, media device, model, credential or network connection.
import { appendFileSync, writeFileSync, renameSync } from 'node:fs';
const path = process.env.TALKQTE_TIMING_LOG;
const run = process.env.TALKQTE_DEV_LAB_RUN_ID;
const mode = process.env.TALKQTE_FIXTURE_CASE;
const frame = (step) =>
  JSON.stringify({
    event: 'dev_stop',
    run_id: run,
    step,
    wall_ms: 1,
    mono_ms: 1,
  }) + '\n';
const put = (step) => appendFileSync(path, frame(step));
process.on('SIGUSR2', () => {
  put('latched');
  put('stopping');
  if (mode !== 'lost-released') put('released');
  setTimeout(() => process.exit(0), 25);
});
if (
  !/^[1-9][0-9]*$/.test(process.env.TALKQTE_DEV_STOP_AFTER_S ?? '') ||
  process.env.TALKQTE_DEV_APPLICATION_SOURCE !== 'QuickTime Player' ||
  process.env.TALKQTE_DEV_STOP_SIGNAL !== 'usr2'
)
  process.exit(2);
if (mode === 'partial') {
  const text = frame('armed');
  appendFileSync(path, text.slice(0, 10));
  setTimeout(() => appendFileSync(path, text.slice(10)), 40);
} else if (mode === 'wrong-run')
  appendFileSync(
    path,
    JSON.stringify({ event: 'dev_stop', run_id: 'foreign', step: 'armed' }) +
      '\n',
  );
else if (mode === 'lost-armed')
  appendFileSync(
    path,
    JSON.stringify({
      event: 'segment',
      text: 'Fictional speech discarded by parser.',
    }) + '\n',
  );
else if (mode === 'duplicate-fields')
  appendFileSync(
    path,
    '{"event":"dev_stop","run_id":"' +
      run +
      '","run_id":"' +
      run +
      '","step":"armed"}\n',
  );
else if (mode === 'frame-oversize')
  appendFileSync(path, 'x'.repeat(65 * 1024) + '\n');
else if (mode === 'bad-utf8') appendFileSync(path, Buffer.from([255, 10]));
else if (mode === 'stall-partial') appendFileSync(path, '{"event":');
else put('armed');
if (mode === 'truncate') setTimeout(() => writeFileSync(path, ''), 80);
if (mode === 'rotate')
  setTimeout(() => {
    renameSync(path, path + '.old');
    writeFileSync(path, frame('armed'), { mode: 0o600 });
  }, 80);
if (mode === 'oversize')
  setTimeout(() => appendFileSync(path, 'x'.repeat(9 * 1024 * 1024)), 80);
if (mode === 'exit') setTimeout(() => process.exit(0), 80);
setTimeout(() => process.exit(0), 1500); // Fixture only; never evidence of release.
