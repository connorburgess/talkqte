import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classify, scan } from './scan.mjs';

test('zero findings in an error response never becomes a clean scan', () => {
  const result = classify(
    {
      status: 1,
      stdout: JSON.stringify({
        totalFindings: 0,
        guides: [],
        error: 'missing',
      }),
    },
    'src',
  );
  assert.equal(result.status, 'error');
});

test('truncation, process failure and invalid report are scanner errors', () => {
  for (const result of [
    { status: 0, stdout: '{' },
    { status: 0, stdout: 'null' },
    { status: null, error: new Error('deadline'), stdout: '' },
    { status: 0, stdout: '{"totalFindings":0,"guides":[]}' },
  ])
    assert.equal(classify(result, 'src').status, 'error');
});

test('pinned parser distinguishes no findings from a provisional IME finding, repeatably', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'talkqte-web-scan-'));
  try {
    writeFileSync(
      join(cwd, 'index.html'),
      '<main><p>Fictional fixture</p></main>',
    );
    assert.equal(scan('index.html', { cwd }).status, 'no-findings');
    writeFileSync(
      join(cwd, 'input.js'),
      `document.querySelector('input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') document.querySelector('form').requestSubmit();
    });`,
    );
    const first = scan('input.js', { cwd });
    assert.equal(first.status, 'findings');
    assert.equal(first.report.guides[0].guideId, 'ime-safe-enter-submit');
    assert.deepEqual(scan('input.js', { cwd }), first);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
