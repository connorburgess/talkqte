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

test('code and literal underscores survive heading formatting', () => {
  assert.deepEqual(
    [
      ...anchors(
        '## `native_audio`\n## __Bold__ and _emphasis_\n## native_audio',
      ),
    ],
    ['native_audio', 'bold-and-emphasis', 'native_audio-1'],
  );
});

test('reference definitions are checked, including unused relative definitions', () => {
  assert.deepEqual(
    links('[guide][ref]\n[ref]: docs/missing.md\n[web]: https://example.com'),
    [{ line: 2, target: 'docs/missing.md' }],
  );
});

test('nested shorter and mismatched fences remain code', () => {
  const markdown =
    '````markdown\n```\n[x](missing.md)\n# hidden\n~~~\n```\n````\n# Visible\n[x](real.md)';
  assert.deepEqual([...anchors(markdown)], ['visible']);
  assert.deepEqual(links(markdown), [{ line: 9, target: 'real.md' }]);
});

test('heading suffixes avoid collisions with explicit numbered headings', () => {
  assert.deepEqual(
    [...anchors('# Same\n# Same-1\n# Same')],
    ['same', 'same-1', 'same-2'],
  );
});
