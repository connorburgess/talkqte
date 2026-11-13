import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const context = read('../src/demo-context.json');
const demo = read('../src/demo.json');

test('each fictional cue opportunity names existing prior and spoken sources', () => {
  const notes = new Map(context.notes.map((note) => [note.id, note]));
  const segments = new Map(
    demo.segments.map((segment) => [segment.id, segment]),
  );
  assert.equal(notes.size, context.notes.length);
  assert.equal(
    new Set(context.opportunities.map((cue) => cue.id)).size,
    context.opportunities.length,
  );
  for (const cue of context.opportunities) {
    const segment = segments.get(cue.segmentId);
    assert.ok(segment, `missing segment for ${cue.id}`);
    assert.ok(
      segment.text.includes(cue.trigger),
      `missing spoken trigger for ${cue.id}`,
    );
    // These estimates are not proof of synchronization with the voice clip.
    assert.ok(cue.estimatedSpokenEndMs >= 0);
    assert.ok(cue.notBeforeMs >= cue.estimatedSpokenEndMs);
    assert.ok(
      cue.notBeforeMs >= segment.atMs && cue.notBeforeMs < demo.durationMs,
    );
    assert.ok(
      cue.noteIds.length > 0 && cue.noteIds.length === cue.support.length,
    );
    cue.noteIds.forEach((id, index) => {
      const note = notes.get(id);
      assert.ok(note, `missing note ${id}`);
      assert.ok(
        note.text.includes(cue.support[index]),
        `missing supporting text for ${cue.id}`,
      );
    });
  }
});

test('fictional sources have distinct dated identities and opportunities are ordered', () => {
  assert.ok(
    context.notes.every(
      (note) =>
        /^\d{4}-\d{2}-\d{2}$/.test(note.date) && note.title && note.text,
    ),
  );
  assert.ok(
    context.opportunities.every(
      (cue, index, all) =>
        index === 0 || all[index - 1].notBeforeMs < cue.notBeforeMs,
    ),
  );
});
