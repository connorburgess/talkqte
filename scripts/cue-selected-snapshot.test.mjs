import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluatorRequest } from './cue-lab-broker.mjs';
import {
  anthropicSchemaFor,
  anthropicSystemPrompt,
  buildAnthropicParams,
} from './cue-lab-anthropic-core.mjs';
import {
  INPUT_BYTES,
  FRAME_BYTES,
  selectedSnapshotInput,
  selectedPriorContextInput,
  selectedSnapshotFrame,
  selectedSnapshotSchema,
  selectedSnapshotReply,
  selectedPriorContextReply,
  buildSelectedSnapshotAnthropicParams,
  SELECTED_SNAPSHOT_RULE,
} from './cue-selected-snapshot.mjs';
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/selected-snapshot-input.json', import.meta.url),
  ),
);
const input = () => structuredClone(fixture);
const rejects = (mutate) => {
  const value = input();
  mutate(value);
  assert.throws(
    () => selectedSnapshotInput(value),
    /invalid_selected_snapshot/,
  );
};

test('versioned snapshots are distinct from legacy input, and preserve exact opaque u64 values', () => {
  for (const revision of [
    '0',
    '1',
    '9007199254740993',
    '18446744073709551615',
  ]) {
    const value = input();
    value.priorNotes[0].snapshotRevision = revision;
    const wire = JSON.parse(selectedSnapshotInput(value));
    assert.equal(wire.priorNotes[0].snapshotRevision, revision);
    assert.equal(wire.priorNotes[0].freshness, 'not_verified');
    assert.deepEqual(wire.events, fixture.events);
    assert.throws(() => evaluatorRequest(value));
  }
  for (const revision of [
    0,
    1,
    '-1',
    '+1',
    '01',
    '1.0',
    '1e2',
    '18446744073709551616',
    '',
  ]) {
    rejects((value) => {
      value.priorNotes[0].snapshotRevision = revision;
    });
  }
});

test('strict namespaces, providers, source classes and collisions fail before parameter capture', () => {
  const cases = [
    (v) => {
      v.inputContract = 'future';
    },
    (v) => {
      v.extra = 'unapproved';
    },
    (v) => {
      v.priorNotes[0].provider = 'tactiq';
    },
    (v) => {
      v.priorNotes[0].id = 'prior:granola:a';
    },
    (v) => {
      v.priorNotes[0].id = 'transcript:current';
    },
    (v) => {
      v.priorNotes[0].id = 'prior:file:';
    },
    (v) => {
      v.events[0].id = 'prior:file:a';
    },
    (v) => {
      v.events.push(v.events[0]);
    },
    (v) => {
      v.priorNotes.push(v.priorNotes[0]);
    },
    (v) => {
      v.priorNotes[0].date = '2026-02-30';
    },
    (v) => {
      v.priorNotes[0].date = '1899-01-01';
    },
    (v) => {
      v.priorNotes[0].freshness = 'current';
    },
    (v) => {
      v.events = [];
    },
    (v) => {
      v.priorNotes = [];
    },
  ];
  let captures = 0;
  for (const change of cases) {
    const value = input();
    change(value);
    assert.throws(() => {
      buildSelectedSnapshotAnthropicParams('claude-opus-5-5', value);
      captures += 1;
    });
  }
  assert.equal(captures, 0);
});

test('fake API parameters preserve model/state grammar and legacy prompt bytes with a separate new policy', () => {
  for (const existingCue of [
    null,
    {
      text: 'Will Wednesday work?',
      sourceIds: ['transcript:current', 'prior:file:a'],
    },
    {
      text: 'Maya, will Wednesday work?',
      sourceIds: ['transcript:current'],
      kind: 'asked',
    },
  ]) {
    const value = input();
    value.existingCue = existingCue;
    const legacy = buildAnthropicParams('claude-opus-5-5', value);
    const captured = buildSelectedSnapshotAnthropicParams(
      'claude-opus-5-5',
      value,
    );
    assert.deepEqual(captured.output_config, legacy.output_config);
    assert.deepEqual(
      captured.output_config.format.schema,
      anthropicSchemaFor(value),
    );
    assert.equal(captured.max_tokens, 2048);
    assert.equal(captured.stream, true);
    assert.equal(captured.tools, undefined);
    assert.equal(legacy.system[0].text, anthropicSystemPrompt());
    assert.equal(
      captured.system[0].text,
      anthropicSystemPrompt() + SELECTED_SNAPSHOT_RULE,
    );
    assert.equal(captured.messages[0].content, selectedSnapshotInput(value));
    assert.equal(JSON.parse(captured.messages[0].content).priorNotes.length, 1);
    assert.deepEqual(
      selectedSnapshotSchema(value).properties.sourceIds.items.enum,
      ['transcript:current', 'prior:file:a'],
    );
  }
});

test('mixed citations validate but unknown/old/note-only state changes and extra fields do not', () => {
  const value = input();
  const reply = {
    action: 'show',
    cue: 'Will Wednesday leave enough time for review?',
    sourceIds: ['transcript:current', 'prior:file:a'],
  };
  assert.equal(selectedSnapshotReply(reply, value), reply);
  for (const ids of [
    ['prior:file:a'],
    ['prior:file:old'],
    ['transcript:current', 'transcript:current'],
    ['prior:file:a', 'transcript:current', 'a', 'b', 'c'],
  ]) {
    assert.throws(() =>
      selectedSnapshotReply({ ...reply, sourceIds: ids }, value),
    );
  }
  assert.throws(() =>
    selectedSnapshotReply({ ...reply, revision: '7' }, value),
  );
  value.existingCue = { text: reply.cue, sourceIds: reply.sourceIds };
  for (const action of ['resolved', 'withdraw']) {
    assert.throws(() =>
      selectedSnapshotReply(
        { action, cue: null, sourceIds: ['prior:file:a'] },
        value,
      ),
    );
    selectedSnapshotReply(
      { action, cue: null, sourceIds: ['transcript:current', 'prior:file:a'] },
      value,
    );
  }
  value.existingCue.kind = 'asked';
  assert.throws(() =>
    selectedSnapshotReply(
      { action: 'withdraw', cue: null, sourceIds: ['transcript:current'] },
      value,
    ),
  );
});

test('UTF8 bytes and scalar character limits include escaping and complete frame overhead', () => {
  const value = input();
  value.priorNotes[0].title = '🌱'.repeat(200);
  selectedSnapshotInput(value);
  rejects((v) => {
    v.priorNotes[0].title = '🌱'.repeat(201);
  });
  rejects((v) => {
    v.priorNotes[0].title = '\ud800';
  });
  value.priorNotes[0].text = '🌱\\"\n'.repeat(300);
  assert.deepEqual(JSON.parse(selectedSnapshotInput(value)), value);
  const overhead = Buffer.byteLength(
    selectedSnapshotFrame(value, { padding: '' }),
  );
  assert.equal(
    Buffer.byteLength(
      selectedSnapshotFrame(value, {
        padding: 'x'.repeat(FRAME_BYTES - overhead),
      }),
    ),
    FRAME_BYTES,
  );
  assert.throws(() =>
    selectedSnapshotFrame(value, {
      padding: 'x'.repeat(FRAME_BYTES - overhead + 1),
    }),
  );
  assert.throws(() => selectedSnapshotFrame(value, { input: {} }));
  const sized = input();
  sized.priorNotes = Array.from({ length: 8 }, (_, n) => ({
    ...sized.priorNotes[0],
    id: `prior:file:n${n}`,
    text: 'x'.repeat(1500),
  }));
  const gap = INPUT_BYTES - Buffer.byteLength(JSON.stringify(sized));
  // Distribute the remaining bytes without exceeding any 2000-char excerpt.
  let left = gap;
  for (const note of sized.priorNotes) {
    const n = Math.min(left, 500);
    note.text += 'x'.repeat(n);
    left -= n;
  }
  assert.equal(left, 0);
  assert.equal(Buffer.byteLength(selectedSnapshotInput(sized)), INPUT_BYTES);
  sized.priorNotes[7].text += 'x';
  assert.throws(() => selectedSnapshotInput(sized));
});

test('shared selected-mode string domain rejects all Cc except LF/TAB, with stricter IDs', () => {
  const strings = JSON.parse(
    readFileSync(
      new URL('./fixtures/selected-snapshot-strings.json', import.meta.url),
    ),
  );
  const fields = [
    (v, text) => {
      v.events[0].text = text;
    },
    (v, text) => {
      v.priorNotes[0].text = text;
    },
    (v, text) => {
      v.priorNotes[0].title = text;
    },
    (v, text) => {
      v.userName = text;
    },
    (v, text) => {
      v.earlierCues = [{ text, state: 'expired' }];
    },
    (v, text) => {
      v.existingCue = { text, sourceIds: ['transcript:current'] };
    },
  ];
  for (const set of fields) {
    for (const text of strings.positive) {
      const v = input();
      set(v, text);
      assert.deepEqual(JSON.parse(selectedSnapshotInput(v)), v);
    }
    for (const text of strings.negative) {
      rejects((v) => set(v, text));
      const value = input();
      set(value, text);
      let captures = 0;
      assert.throws(() => {
        buildSelectedSnapshotAnthropicParams('claude-opus-5-5', value);
        captures += 1;
      });
      assert.equal(captures, 0);
    }
  }
  for (const id of strings.idNegative) {
    rejects((v) => {
      v.events[0].id = 'transcript:' + id;
    });
    rejects((v) => {
      v.priorNotes[0].id = 'prior:file:' + id;
    });
  }
});

test('selected-prior-context-v2 accepts optional sessionMode:"interview" while inert v1 and invalid values fail closed', () => {
  const v2Base = () => ({
    ...input(),
    inputContract: 'selected-prior-context-v2',
  });

  // Inert v1 stays unchanged and rejects sessionMode.
  rejects((v) => {
    v.sessionMode = 'interview';
  });

  // v2 accepts optional sessionMode:"interview" for both populated and 0-note controls.
  for (const priorNotes of [v2Base().priorNotes, []]) {
    const valid = { ...v2Base(), priorNotes, sessionMode: 'interview' };
    const wire = JSON.parse(selectedPriorContextInput(valid));
    assert.equal(wire.sessionMode, 'interview');
    assert.deepEqual(wire.priorNotes, priorNotes);
    assert.deepEqual(wire.events, valid.events);
  }

  // Meeting mode omits sessionMode; invalid values and extra fields fail closed.
  for (const bad of [
    'meeting',
    'Interview',
    'coaching',
    '',
    null,
    false,
    true,
    0,
    123,
    {},
    [],
  ]) {
    assert.throws(
      () => selectedPriorContextInput({ ...v2Base(), sessionMode: bad }),
      /invalid_selected_snapshot/,
    );
  }
  assert.throws(
    () =>
      selectedPriorContextInput({
        ...v2Base(),
        sessionMode: 'interview',
        extra: 'unexpected',
      }),
    /invalid_selected_snapshot/,
  );

  // Reply validation still requires a current speech anchor and <= 10 words in interview mode.
  const interviewWithNote = { ...v2Base(), sessionMode: 'interview' };
  const speechId = interviewWithNote.events[0].id;
  const noteId = interviewWithNote.priorNotes[0].id;
  assert.deepEqual(
    selectedPriorContextReply(
      {
        action: 'show',
        cue: 'Note: pack ships Friday.',
        sourceIds: [speechId, noteId],
      },
      interviewWithNote,
    ).sourceIds,
    [speechId, noteId],
  );
  assert.throws(
    () =>
      selectedPriorContextReply(
        {
          action: 'show',
          cue: 'Note: pack ships Friday.',
          sourceIds: [noteId],
        },
        interviewWithNote,
      ),
    /invalid_selected_snapshot/,
  );

  // Exact 16 KiB serialized byte boundary includes sessionMode:"interview".
  const padded = { ...v2Base(), sessionMode: 'interview' };
  const template = structuredClone(padded.priorNotes[0]);
  padded.priorNotes[0].text = 'b';
  for (let n = 0; n < 8; n++) {
    padded.priorNotes.push({
      ...template,
      id: `prior:file:pad-${n}`,
      text: 'a'.repeat(1800),
    });
  }
  const baseBytes = Buffer.byteLength(selectedPriorContextInput(padded));
  const remaining = INPUT_BYTES - baseBytes;
  padded.priorNotes[0].text = 'b'.repeat(1 + remaining);
  assert.equal(
    Buffer.byteLength(selectedPriorContextInput(padded)),
    INPUT_BYTES,
  );
  padded.priorNotes[0].text += 'b';
  assert.throws(
    () => selectedPriorContextInput(padded),
    /invalid_selected_snapshot/,
  );
});
