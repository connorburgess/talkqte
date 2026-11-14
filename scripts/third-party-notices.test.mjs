import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  inputsLine,
  linkedCrates,
  nestedNotices,
  packageOfModule,
  parseTree,
  render,
  staleReason,
  undecidedNotices,
} from './third-party-notices.mjs';

// Fictional packages only; no registry, cargo or network is used here.
test('the linked set is what cargo tree prints, without the app itself', () => {
  const linked = parseTree(
    [
      'orchard-app v0.1.0 (/work/checkout/src-tauri)',
      'ladder v1.0.0',
      'basket v2.1.0 (*)',
      'basket v2.1.0',
      'orchard-app v0.1.0 (/work/checkout/src-tauri) (*)',
      '',
    ].join('\n'),
  );
  assert.deepEqual([...linked].sort(), ['basket 2.1.0', 'ladder 1.0.0']);

  // cargo metadata also reports build-time and other-platform crates.
  const pkg = (name, version) => ({ name, version });
  const metadata = {
    packages: [
      pkg('ladder', '1.0.0'),
      pkg('basket', '2.1.0'),
      pkg('basket', '1.0.0'),
      pkg('build-shed', '1.0.0'),
    ],
  };
  assert.deepEqual(
    linkedCrates(metadata, linked).map(
      (item) => `${item.name} ${item.version}`,
    ),
    ['basket 2.1.0', 'ladder 1.0.0'],
  );
  assert.throws(
    () => linkedCrates(metadata, new Set(['wheelbarrow 3.0.0'])),
    /cargo tree lists crates cargo metadata does not: wheelbarrow 3\.0\.0/,
  );
});

test("a notice below a package's top level needs a decision", (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nested-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    'LICENSE-MIT',
    'src/lib.rs',
    'src/copying.rs',
    'third_party/seed/LICENSE',
    'vendor/roots/COPYING.txt',
    'target/debug/LICENSE',
  ]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'fictional');
  }
  const nested = nestedNotices(root);
  assert.deepEqual(nested, [
    'third_party/seed/LICENSE',
    'vendor/roots/COPYING.txt',
  ]);
  assert.deepEqual(undecidedNotices('a-fictional-crate', nested), nested);
  // Listed notices for a real entry are decided; an unlisted one is not.
  assert.deepEqual(
    undecidedNotices('ring', [
      'third_party/fiat/LICENSE',
      'third_party/new/LICENSE',
    ]),
    ['third_party/new/LICENSE'],
  );
  assert.deepEqual(
    undecidedNotices('rfd', [
      'src/backend/xdg_desktop_portal/window_identifier/LICENSE',
    ]),
    [],
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
