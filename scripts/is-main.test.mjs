import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { isMain } from './is-main.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/** A temporary folder holding `linked`, a link to the scripts folder, and
 * `empty`, a folder with no programs to use as PATH. */
function linkedScripts(t) {
  const root = mkdtempSync(join(tmpdir(), 'linked-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(SCRIPTS, join(root, 'linked'), 'dir');
  mkdirSync(join(root, 'empty'));
  return root;
}

/** Runs a script through the link. The contribution range is cleared so the
 * outcome does not depend on where the tests themselves run. */
function runLinked(root, name, args = [], env = {}) {
  const base = { ...process.env, ...env };
  delete base.CONTRIBUTION_BASE;
  delete base.CONTRIBUTION_HEAD;
  delete base.GITHUB_EVENT_PATH;
  return spawnSync(
    process.execPath,
    [join(root, 'linked', `${name}.mjs`), ...args],
    { encoding: 'utf8', env: base },
  );
}

test('a script is recognised through a linked path, and an import is not', (t) => {
  const root = linkedScripts(t);
  const module = pathToFileURL(join(SCRIPTS, 'is-main.mjs')).href;
  assert.equal(isMain(module, join(SCRIPTS, 'is-main.mjs')), true);
  assert.equal(isMain(module, join(root, 'linked', 'is-main.mjs')), true);
  assert.equal(isMain(module, join(SCRIPTS, 'check-docs.mjs')), false);
  assert.equal(isMain(module, join(root, 'no-such-file.mjs')), false);
  assert.equal(isMain(module, undefined), false);
});

// Before the real-path comparison each of these exited 0 with no output when
// started through a link: a check that silently passed without checking.
test('the documentation check runs through a linked path', (t) => {
  const result = runLinked(linkedScripts(t), 'check-docs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Checked links in \d+ Markdown files/);
});

test('the contribution check runs, and can fail, through a linked path', (t) => {
  const result = runLinked(linkedScripts(t), 'check-contributions');
  assert.equal(result.status, 1);
  assert.match(
    result.stderr + result.stdout,
    /Contribution base and head must be full commit SHAs/,
  );
});

test('the release pre-flight runs through a linked path', (t) => {
  const result = runLinked(linkedScripts(t), 'release-preflight');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Pre-flight passed/);
});

// These two start by asking cargo for the dependency set. With no programs on
// PATH they must fail saying so; doing nothing would exit 0.
test('the notices check and the release build run through a linked path', (t) => {
  const root = linkedScripts(t);
  const env = { PATH: join(root, 'empty') };
  const notices = runLinked(root, 'third-party-notices', ['--check'], env);
  assert.equal(notices.status, 1);
  assert.match(notices.stderr, /^third-party notices: /);

  const build = runLinked(root, 'release-build', ['--bundles', 'app'], env);
  assert.equal(build.status, 1);
  assert.match(build.stderr, /third-party notices: /);
});

test('the data snapshot script runs through a linked path', (t) => {
  const result = runLinked(linkedScripts(t), 'release-data-snapshot');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /give a command: record or compare/);
});
