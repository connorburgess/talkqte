// Checks the shape of the independent cue-rule cases only. It does not run
// the rules and says nothing about whether a label is right.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const independent = read('./fixtures/cue-rules-independent.json');
const heldOut = read('./fixtures/cue-rules-held-out.json');

const ACTIONS = ['show', 'quiet', 'withdraw', 'resolved'];
const RULE_TYPES = ['Owner', 'Timing', 'Decision'];
const CASE_FIELDS = [
  'id',
  'category',
  'events',
  'existingCue',
  'userName',
  'expected',
];
const CATEGORIES = [
  'no-owner',
  'vague-deadline',
  'asked-by-name',
  'another-addressee',
  'uncertain-addressee',
  'answered-later',
  'repeat',
  'topic-change',
  'deferral',
  'correction',
  'plain',
];
const text = (value) =>
  typeof value === 'string' && value !== '' && value.trim() === value;

test('the file says how its labels were written and what each action means', () => {
  assert.match(independent.status, /fictional/i);
  assert.match(independent.status, /had not read the phrase rules/);
  assert.match(independent.status, /awaiting the owner's review/);
  assert.ok(text(independent.authorship));
  assert.ok(text(independent.replay));
  assert.deepEqual(Object.keys(independent.actions), ACTIONS);
});

test('every case has the held-out format', () => {
  assert.ok(independent.cases.length >= 20);
  const ids = new Set();
  for (const item of independent.cases) {
    const where = `case ${item.id}`;
    assert.match(item.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, where);
    assert.ok(!ids.has(item.id), `${where} is listed once`);
    ids.add(item.id);
    for (const key of Object.keys(item))
      assert.ok(CASE_FIELDS.includes(key), `${where} has no field ${key}`);
    assert.ok(CATEGORIES.includes(item.category), where);
    assert.ok(item.events.length >= 1 && item.events.length <= 4, where);
    item.events.forEach((event, i) => {
      assert.deepEqual(Object.keys(event), ['id', 'text'], where);
      assert.equal(event.id, `e${i + 1}`, where);
      assert.ok(text(event.text) && event.text.length <= 200, where);
    });
    assert.deepEqual(Object.keys(item.expected), ['action', 'reason'], where);
    assert.ok(ACTIONS.includes(item.expected.action), where);
    assert.ok(text(item.expected.reason), where);
    assert.ok(!item.expected.reason.includes('\n'), `${where} one-line reason`);
    if ('userName' in item) assert.match(item.userName, /^\p{L}+$/u, where);
    if (item.existingCue) {
      const cue = item.existingCue;
      assert.deepEqual(Object.keys(cue), ['ruleType', 'text', 'sourceIds']);
      assert.ok(RULE_TYPES.includes(cue.ruleType), where);
      assert.ok(text(cue.text) && cue.text.endsWith('?'), where);
      assert.ok(cue.sourceIds.length > 0, where);
      for (const id of cue.sourceIds)
        assert.ok(
          item.events.some((event) => event.id === id),
          `${where} cue cites ${id}`,
        );
    }
    // Only a cue on screen can be withdrawn or resolved.
    if (['withdraw', 'resolved'].includes(item.expected.action))
      assert.ok(item.existingCue, `${where} has a cue on screen`);
    // A cue already on screen is not shown again.
    if (item.expected.action === 'show')
      assert.ok(!item.existingCue, `${where} starts with no cue`);
  }
});

test('the requested situations are covered, with six or more plain quiet cases', () => {
  const categories = new Set(independent.cases.map((item) => item.category));
  for (const category of CATEGORIES)
    assert.ok(categories.has(category), `covers ${category}`);
  const plainQuiet = independent.cases.filter(
    (item) => item.category === 'plain' && item.expected.action === 'quiet',
  );
  assert.ok(plainQuiet.length >= 6);
  for (const action of ACTIONS)
    assert.ok(
      independent.cases.some((item) => item.expected.action === action),
      `uses ${action}`,
    );
});

test('no case reuses an id or a line from the held-out file', () => {
  const ids = new Set(heldOut.cases.map((item) => item.id));
  const lines = new Set(
    heldOut.cases.flatMap((item) => item.events.map((event) => event.text)),
  );
  for (const item of independent.cases) {
    assert.ok(!ids.has(item.id), `${item.id} is a new id`);
    for (const event of item.events)
      assert.ok(!lines.has(event.text), `${item.id} uses new wording`);
  }
});
