import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { checkCommit, checkRange } from './check-contributions.mjs';

let originalDirectory;
let repository;
let base;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}
function commit(message) {
  git(
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    message,
  );
  return git('rev-parse', 'HEAD');
}

before(() => {
  originalDirectory = process.cwd();
  repository = mkdtempSync(join(tmpdir(), 'talkqte-contribution-test-'));
  process.chdir(repository);
  git('init', '--quiet');
  git('config', 'user.name', 'Robin Example');
  git('config', 'user.email', 'robin@example.com');
  git('config', 'core.hooksPath', join(repository, 'no-hooks'));
  base = commit('Initial test fixture');
});

after(() => {
  process.chdir(originalDirectory);
  rmSync(repository, { recursive: true, force: true });
});

test('accepts an author-matching sign-off at the end of a contribution', () => {
  const head = commit(
    'Preserve a saved question\n\nSigned-off-by: Robin Example <robin@example.com>',
  );
  assert.deepEqual(checkRange(base, head), { commits: 1, failures: [] });
});

test('rejects a missing, mismatched, or misplaced sign-off', () => {
  for (const message of [
    'No certification',
    'Wrong identity\n\nSigned-off-by: Alex Example <alex@example.com>',
    'Misplaced certification\n\nSigned-off-by: Robin Example <robin@example.com>\n\nMore prose follows.',
  ]) {
    assert.equal(checkCommit(commit(message)).length, 1);
  }
});

test('rejects attribution credits in commits and PR text', () => {
  const head = commit(
    'Keep a question\n\nGenerated with Codex\n\nSigned-off-by: Robin Example <robin@example.com>',
  );
  assert.match(checkCommit(head)[0], /tool attribution/);
  assert.ok(
    checkRange(base, head, {
      pull_request: { title: 'Keep a question', body: 'Generated with Codex' },
    }).failures.some((failure) => failure.startsWith('The pull request')),
  );
});

test('requires full commit SHAs before running git ranges', () => {
  assert.throws(() => checkRange('--all', 'HEAD'), /full commit SHAs/);
});
