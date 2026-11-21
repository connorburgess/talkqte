import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { LAB_CHECKOUT, outsideCheckout } from './cue-lab-checkout.mjs';

// Swaps the letter case of a path's final component.
const swapCase = (path) =>
  join(
    dirname(path),
    [...basename(path)]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join(''),
  );

test('a folder inside the checkout spelled in another letter case is not outside it', (t) => {
  const inside = mkdtempSync(join(LAB_CHECKOUT, 'tq-case-'));
  try {
    // Respell the checkout's own folder name, as a TMPDIR typed differently.
    const respelled = join(swapCase(LAB_CHECKOUT), basename(inside));
    if (!existsSync(respelled)) {
      t.skip('case-sensitive volume: the respelled path does not exist');
      return;
    }
    assert.equal(outsideCheckout(inside), false);
    assert.equal(outsideCheckout(respelled), false);
  } finally {
    rmSync(inside, { recursive: true, force: true });
  }
});

test('a temporary folder outside the checkout is outside it', () => {
  const outside = mkdtempSync(join(tmpdir(), 'tq-outside-'));
  try {
    assert.equal(outsideCheckout(outside), true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
