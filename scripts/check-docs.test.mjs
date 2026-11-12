import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchors, links, slug } from './check-docs.mjs';

test('heading anchors follow GitHub: punctuation dropped, repeats numbered, code ignored', () => {
  assert.equal(
    slug('Bounded component measurement — 12 November 2026'),
    'bounded-component-measurement--12-november-2026',
  );
  const found = anchors(
    '# Voiced **demo**\n## Checks\n## Checks\n```\n# not a heading\n```\n### See [the plan](plan.md)',
  );
  assert.deepEqual(
    [...found],
    ['voiced-demo', 'checks', 'checks-1', 'see-the-plan'],
  );
});

test('only relative links outside code are checked', () => {
  const found = links(
    'See [a](docs/a.md#part) and [site](https://example.com) and `[code](missing.md)`.\n```\n[fenced](missing.md)\n```\n[b](#here)',
  );
  assert.deepEqual(found, [
    { line: 1, target: 'docs/a.md#part' },
    { line: 5, target: '#here' },
  ]);
});
