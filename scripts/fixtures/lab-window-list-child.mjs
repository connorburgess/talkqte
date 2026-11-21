// Harmless protocol rows only; never enumerates windows or opens a device.
import { spawn } from 'node:child_process';
const [mode, ...args] = process.argv.slice(2);
const get = (key) => args[args.indexOf(key) + 1];
const player = Number(get('--emulator-pid')),
  native = Number(get('--companion-pid'));
const rows = [
  {
    event: 'window',
    pid: player,
    windowId: 51,
    app: 'TalkQTE Lab Player',
    title: 'Fictional meeting',
    onScreen: true,
    frame: { width: 960, height: 540 },
  },
  {
    event: 'window',
    pid: mode === 'foreign' ? native + 1 : native,
    windowId: 52,
    app: 'TalkQTE Development',
    title: 'TalkQTE companion',
    onScreen: true,
    frame: { width: 400, height: 80 },
  },
];
if (mode === 'duplicate') rows.push({ ...rows[1] });
let output = rows.map((row) => JSON.stringify(row) + '\n').join('');
if (mode === 'oversize') output = 'x'.repeat(70000);
if (mode === 'malformed') output = '{not-json}\n';
if (mode === 'partial') {
  process.stdout.write(output.slice(0, 13));
  setTimeout(() => process.stdout.write(output.slice(13)), 10);
} else process.stdout.write(output);
if (mode === 'held-pipes')
  spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: ['ignore', process.stdout, process.stderr],
  });
