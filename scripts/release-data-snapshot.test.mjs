import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compare, record, report } from './release-data-snapshot.mjs';

// A fictional home folder in a temporary directory; no real app data is read.
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  'release-data-snapshot.mjs',
);
const ID = 'org.example.orchard';
const DATA = `Library/Application Support/${ID}`;

function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'orchard-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write(`${DATA}/models/fictional-model.bin`, 'weights '.repeat(1000));
  write(`${DATA}/settings.json`, '{"season":"autumn"}');
  write(`Library/Caches/${ID}/cache.db`, 'cache one');
  write(`Library/Preferences/${ID}.plist`, 'preferences one');
  return { root, write };
}

const snap = (root, appVersion) =>
  record({
    home: root,
    identifier: ID,
    appVersion,
    now: new Date('2030-01-01T09:00:00Z'),
  });

test('a record lists names, sizes and digests without naming the home folder', (t) => {
  const { root } = home(t);
  const snapshot = snap(root, '1.4.2');
  const data = snapshot.roots.find((item) => item.path === `~/${DATA}`);
  assert.equal(data.kept, true);
  assert.deepEqual(Object.keys(data.entries), [
    'models/fictional-model.bin',
    'settings.json',
  ]);
  assert.equal(data.entries['models/fictional-model.bin'].size, 8000);
  assert.match(data.entries['settings.json'].sha256, /^[0-9a-f]{64}$/);
  const preferences = snapshot.roots.find((item) =>
    item.path.endsWith('.plist'),
  );
  assert.deepEqual(Object.keys(preferences.entries), ['.']);
  const absent = snapshot.roots.find((item) => item.path.includes('WebKit'));
  assert.equal(absent.present, false);
  const text = JSON.stringify(snapshot);
  assert.ok(!text.includes(root), 'the home folder path is not stored');
  assert.ok(!text.includes('weights'), 'file contents are not stored');
});

test('an upgrade that leaves the data folder alone is reported as kept', (t) => {
  const { root, write } = home(t);
  const before = snap(root, '1.4.2');
  write(`Library/Caches/${ID}/cache.db`, 'cache two');
  write(`Library/Caches/${ID}/new-cache.db`, 'fresh');
  write(`Library/Preferences/${ID}.plist`, 'preferences two');
  const after = snap(root, '1.5.0');
  const result = compare(before, after);
  assert.equal(result.preserved, true);
  assert.deepEqual(result.lost, []);
  const caches = result.roots.find((item) => item.path.includes('Caches'));
  assert.deepEqual(caches.changed, ['cache.db']);
  assert.deepEqual(caches.added, ['new-cache.db']);
  const text = report(before, after, result);
  assert.match(text, /^org\.example\.orchard: 1\.4\.2 .* -> 1\.5\.0 /);
  assert.match(
    text,
    /\(must be kept\): 2 unchanged, 0 changed, 0 removed, 0 added/,
  );
  assert.match(
    text,
    /Kept: nothing in the data folder was removed or changed\.$/,
  );
});

test('a removed, rewritten or truncated data file is named and fails', (t) => {
  const { root, write } = home(t);
  const before = snap(root, '1.4.2');
  rmSync(join(root, DATA, 'models/fictional-model.bin'));
  write(`${DATA}/settings.json`, '{"season":"winter"}');
  write(`${DATA}/migrated.json`, '{}');
  const after = snap(root, '1.5.0');
  const result = compare(before, after);
  assert.equal(result.preserved, false);
  assert.deepEqual(result.lost, [
    `~/${DATA}/models/fictional-model.bin`,
    `~/${DATA}/settings.json`,
  ]);
  const text = report(before, after, result);
  assert.match(text, /removed: models\/fictional-model\.bin/);
  assert.match(text, /changed: settings\.json/);
  assert.match(text, /added: migrated\.json/);
  assert.match(text, /NOT KEPT: 2 item\(s\)/);
  assert.match(
    report(before, after, result, { allowChanges: true }),
    /Changed \(allowed\): 2 item\(s\)/,
  );
});

test('a whole data folder that disappears is a loss; a new one is not', (t) => {
  const { root } = home(t);
  const before = snap(root, '1.4.2');
  rmSync(join(root, DATA), { recursive: true });
  const gone = compare(before, snap(root, '1.5.0'));
  assert.equal(gone.preserved, false);
  assert.equal(gone.lost.length, 2);
  const created = compare(snap(root, '1.5.0'), before);
  assert.equal(created.preserved, true);
});

test('links are compared by target and records must match', (t) => {
  const { root } = home(t);
  symlinkSync('settings.json', join(root, DATA, 'current'));
  const before = snap(root, '1.4.2');
  assert.deepEqual(before.roots[0].entries.current, { link: 'settings.json' });
  rmSync(join(root, DATA, 'current'));
  symlinkSync('models', join(root, DATA, 'current'));
  assert.deepEqual(compare(before, snap(root, '1.5.0')).lost, [
    `~/${DATA}/current`,
  ]);
  assert.throws(
    () => compare(before, { ...before, identifier: 'org.example.other' }),
    /different apps/,
  );
  assert.throws(() => compare({ files: [] }, before), /format 1/);
});

test('command line: record then compare, with exit codes for kept, lost and misuse', (t) => {
  const { root, write } = home(t);
  const out = (name) => join(root, name);
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const recordArgs = (name) => [
    'record',
    '--home',
    root,
    '--identifier',
    ID,
    '--out',
    out(name),
  ];

  const first = run(...recordArgs('before.json'));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Recorded 4 item\(s\) in 3 of 6 locations/);
  assert.equal(JSON.parse(readFileSync(out('before.json'), 'utf8')).format, 1);

  run(...recordArgs('same.json'));
  const kept = run('compare', out('before.json'), out('same.json'));
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);

  write(`${DATA}/settings.json`, 'rewritten');
  run(...recordArgs('after.json'));
  const lost = run('compare', out('before.json'), out('after.json'));
  assert.equal(lost.status, 1);
  assert.match(lost.stdout, /NOT KEPT: 1 item/);
  assert.equal(
    run('compare', out('before.json'), out('after.json'), '--allow-changes')
      .status,
    0,
  );

  assert.equal(run('record').status, 2);
  assert.equal(run('compare', out('before.json')).status, 2);
  const junk = out('junk.json');
  writeFileSync(junk, 'not json');
  assert.equal(run('compare', out('before.json'), junk).status, 2);
});

test('copied alone to another Mac, it needs the identifier and reads the app version', (t) => {
  const { root, write } = home(t);
  const alone = join(root, 'tools', 'snapshot.mjs');
  mkdirSync(dirname(alone), { recursive: true });
  copyFileSync(SCRIPT, alone);
  const run = (...args) =>
    spawnSync(process.execPath, [alone, ...args], { encoding: 'utf8' });
  const out = join(root, 'record.json');

  const unnamed = run('record', '--home', root, '--out', out);
  assert.equal(unnamed.status, 2);
  assert.match(unnamed.stderr, /pass --identifier ID/);

  write(
    'Applications/Orchard.app/Contents/Info.plist',
    '<plist><dict><key>CFBundleShortVersionString</key>\n<string>1.4.2</string></dict></plist>',
  );
  const named = run(
    'record',
    '--home',
    root,
    '--identifier',
    ID,
    '--app',
    join(root, 'Applications/Orchard.app'),
    '--out',
    out,
  );
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /\(installed app 1\.4\.2\)/);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).appVersion, '1.4.2');
});
