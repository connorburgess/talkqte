import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  inputsLine,
  linkedCrates,
  packageOfModule,
  render,
  staleReason,
} from './third-party-notices.mjs';

// Fictional packages only; no registry, cargo or network is used here.
const crate = (name, kinds = ['lib']) => ({
  id: name,
  name,
  version: '1.0.0',
  targets: kinds.map((kind) => ({ kind: [kind] })),
});
const edges = (id, ...deps) => ({
  id,
  deps: deps.map(([pkg, kind = null]) => ({ pkg, dep_kinds: [{ kind }] })),
});

test('only crates linked into the app are listed', () => {
  const metadata = {
    packages: [
      crate('app'),
      crate('orchard'),
      crate('ladder'),
      crate('derive-basket', ['proc-macro']),
      crate('macro-helper'),
      crate('build-shed'),
      crate('test-scale'),
    ],
    resolve: {
      root: 'app',
      nodes: [
        edges(
          'app',
          ['orchard'],
          ['derive-basket'],
          ['build-shed', 'build'],
          ['test-scale', 'dev'],
        ),
        edges('orchard', ['ladder']),
        edges('ladder'),
        edges('derive-basket', ['macro-helper']),
        edges('macro-helper'),
        edges('build-shed'),
        edges('test-scale'),
      ],
    },
  };
  assert.deepEqual(
    linkedCrates(metadata).map((pkg) => pkg.name),
    ['ladder', 'orchard'],
  );
});

test('bundled modules map to their npm package; app code maps to none', () => {
  assert.equal(
    packageOfModule('/work/node_modules/@orchard/tools/dist/index.js'),
    '@orchard/tools',
  );
  assert.equal(
    packageOfModule('/work/node_modules/a/node_modules/ladder/index.js'),
    'ladder',
  );
  assert.equal(
    packageOfModule('C:\\work\\node_modules\\ladder\\index.js'),
    'ladder',
  );
  assert.equal(packageOfModule('/work/src/App.tsx'), null);
});

test('the file lists every component, shares identical texts and flags missing ones', () => {
  const component = (name, license, notices) => ({
    kind: 'Rust crate',
    name,
    version: '1.0.0',
    license,
    source: `https://example.org/${name}`,
    notices,
  });
  const shared = { file: 'LICENSE-APACHE', text: 'Fictional shared licence' };
  const output = render(
    [
      component('ladder', 'MIT OR Apache-2.0', [
        shared,
        { file: 'LICENSE-MIT', text: 'Copyright the fictional ladder makers' },
      ]),
      component('orchard', 'MIT OR Apache-2.0', [shared]),
      component('basket', 'Zlib', []),
    ],
    'Inputs: fictional',
  );
  assert.equal(output.split('Fictional shared licence').length - 1, 1);
  assert.match(output, /used by: ladder 1\.0\.0, orchard 1\.0\.0/);
  assert.match(
    output,
    /Rust crate: 3\n\s+2 {2}MIT OR Apache-2\.0\n\s+1 {2}Zlib/,
  );
  assert.match(
    output,
    /basket 1\.0\.0\n {2}Declared licence: Zlib\n {2}Source: https:\/\/example\.org\/basket\n {2}Notice texts: none shipped in the package/,
  );
  assert.match(
    output,
    /ladder 1\.0\.0\n.*\n.*\n {2}Notice texts: T\d{3} \(LICENSE-APACHE\), T\d{3} \(LICENSE-MIT\)/,
  );
  assert.equal(
    output,
    render(
      [
        component('ladder', 'MIT OR Apache-2.0', [
          shared,
          {
            file: 'LICENSE-MIT',
            text: 'Copyright the fictional ladder makers',
          },
        ]),
        component('orchard', 'MIT OR Apache-2.0', [shared]),
        component('basket', 'Zlib', []),
      ],
      'Inputs: fictional',
    ),
    'the same components always produce the same file',
  );
});

test('a notices file is stale once either lockfile changes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'notices-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src-tauri'));
  writeFileSync(join(root, 'src-tauri/Cargo.lock'), 'fictional lock 1\n');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  const notices = `Notices\n${inputsLine(root)}\nScope: fictional\n`;
  assert.equal(staleReason(notices, root), null);
  writeFileSync(join(root, 'src-tauri/Cargo.lock'), 'fictional lock 2\n');
  assert.equal(
    staleReason(notices, root),
    'a lockfile changed after it was generated',
  );
  assert.equal(
    staleReason('Notices without a digest line\n', root),
    'it records no lockfile digests',
  );
});
