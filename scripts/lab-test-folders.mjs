// Temporary folders for the lab's offline tests. Every folder made here,
// including any fictional timing log written into it, is removed when the
// test file finishes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const made = [];
after(() => {
  for (const directory of made)
    rmSync(directory, { recursive: true, force: true });
});

/** A new empty folder outside the checkout, removed after the tests. */
export function testFolder(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  made.push(directory);
  return directory;
}
