// Offline tests for what the meeting emulator and the window-only recorder
// decide before anything plays or records: which runs may be played, how
// people are cast, what a recording is labelled, and what is refused. No
// browser, screen, model or network is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { testFolder } from './lab-test-folders.mjs';
import { castFor } from './cue-sim-cast.mjs';
import { main as emulator, meetingLabels } from './lab-emulator.mjs';
import { assertBrief, loadPlayable } from './lab-playable.mjs';
import {
  MAX_SECONDS,
  barSize,
  commitFromLog,
  cuesFromLog,
  main as recorder,
  windowLabels,
} from './lab-window-record.mjs';

const outside = () => realpathSync.native(testFolder('talkqte-meeting-test-'));

/** A small generated run in the dialogue lane's format, with its brief. */
function generatedRun(edit = (run) => run) {
  const directory = outside();
  const brief = JSON.stringify({
    people: [
      { name: 'Maya', role: 'Organizer' },
      { name: 'Robin', role: 'Engineer' },
    ],
  });
  writeFileSync(join(directory, 'run.briefs.json'), brief);
  const person = (name, voice, portrait) => ({
    name,
    role: 'Fictional role',
    casting: { voice, age: '30-39', portrait },
  });
  const run = edit({
    schema: 'talkqte-cue-dialogue/1',
    fictional: true,
    generated: true,
    brief: {
      file: 'run.briefs.json',
      sha256: createHash('sha256').update(brief).digest('hex'),
    },
    branches: [
      {
        id: 'workshop-a',
        title: 'Fictional planning call',
        setting: 'Two invented people plan a workshop.',
        listener: 'Robin',
        participants: [
          person('Maya', 'feminine', 'Short dark hair, green jumper, kitchen.'),
          person('Robin', 'neutral', 'Curly hair, grey shirt, small study.'),
        ],
        lines: [
          {
            id: 't1',
            speaker: 'Maya',
            text: 'Someone needs to book the room.',
            startMs: 1_000,
            atMs: 3_000,
          },
          {
            id: 't2',
            speaker: 'Robin',
            text: 'I will book it today.',
            startMs: 3_500,
            atMs: 5_000,
          },
        ],
        timeline: [],
      },
    ],
  });
  const file = join(directory, 'run.json');
  writeFileSync(file, JSON.stringify(run));
  return { directory, file, run };
}

test('a generated run plays only with its own unchanged brief, casting for everyone, and lines in order', async () => {
  const { file } = generatedRun();
  const { replays, generated } = await loadPlayable(file);
  assert.equal(generated, true);
  assert.deepEqual(
    replays.map((r) => r.id),
    ['workshop-a'],
  );

  for (const [edit, message] of [
    [
      (run) => ({ ...run, brief: { ...run.brief, sha256: '0'.repeat(64) } }),
      /does not match the hash/,
    ],
    [
      (run) => ({ ...run, brief: { ...run.brief, file: '../elsewhere.json' } }),
      /saved beside it/,
    ],
    [
      (run) => ({ ...run, brief: { ...run.brief, file: 'missing.json' } }),
      /is not beside the results/,
    ],
    [
      (run) => {
        run.branches[0].participants[0].name = 'Priya';
        run.branches[0].lines[0].speaker = 'Priya';
        return run;
      },
      /Priya is not in the brief/,
    ],
    [
      (run) => {
        delete run.branches[0].participants[1].casting;
        return run;
      },
      /Robin has no usable casting/,
    ],
    [
      (run) => {
        run.branches[0].participants[1].casting.voice = 'robotic';
        return run;
      },
      /Robin has no usable casting/,
    ],
    [
      (run) => {
        run.branches[0].participants[1].casting.portrait = 'x'.repeat(201);
        return run;
      },
      /Robin has no usable casting/,
    ],
    [
      (run) => {
        run.branches[0].lines[1].speaker = 'Maya2';
        return run;
      },
      /line t2 is spoken by someone not in the call/,
    ],
    [
      (run) => {
        run.branches[0].lines[1].atMs = 2_000;
        return run;
      },
      /line t2 is out of order/,
    ],
    [
      (run) => ({ ...run, fictional: false }),
      /only plays results marked fictional/,
    ],
    [
      (run) => ({ ...run, schema: 'something-else/1' }),
      /not a results file the lab can play/,
    ],
  ]) {
    const broken = generatedRun(edit);
    await assert.rejects(loadPlayable(broken.file), message);
  }
  assert.throws(
    () => assertBrief({ branches: [] }, file),
    /must name its brief/,
  );
});

test("people are cast from their brief's fields, never their names, with preset voices only", async () => {
  const { file } = generatedRun();
  const [replay] = (await loadPlayable(file)).replays;
  const cast = castFor(replay);
  assert.deepEqual(Object.keys(cast), ['Maya', 'Robin']);
  assert.equal(cast.Maya.voice, 'marin');
  assert.equal(cast.Robin.voice, 'alloy');
  assert.match(
    cast.Maya.prompt,
    /showing a woman aged 30-39\. Short dark hair, green jumper, kitchen\./,
  );
  assert.match(cast.Robin.prompt, /showing a person aged 30-39\./);
  for (const person of Object.values(cast)) {
    assert.match(person.prompt, /does not exist/);
    assert.ok(!/\bMaya\b|\bRobin\b/.test(person.prompt));
  }
  // The same name cast as someone else follows the brief, not the name.
  const swapped = structuredClone(replay);
  swapped.participants[0].casting.voice = 'masculine';
  assert.equal(castFor(swapped).Maya.voice, 'cedar');
  // Casting for some people and not others is refused.
  const mixed = structuredClone(replay);
  delete mixed.participants[1].casting;
  assert.throws(() => castFor(mixed), /some do not/);
});

test('a real-app recording is labelled with what it is, which app, and where the cues came from', () => {
  const meeting = {
    labels: meetingLabels({ sound: 'cache', portraits: { Maya: {} } }),
    mode: 'prerendered',
  };
  assert.deepEqual(meeting.labels, [
    'Simulated meeting',
    'Fictional',
    'Synthetic voices',
    'Synthetic portraits',
  ]);
  assert.deepEqual(
    windowLabels({
      meeting,
      appCommit: 'd703485abcdef',
      cues: 'cues: unknown',
    }),
    [
      'Simulated meeting',
      'Fictional',
      'Synthetic voices',
      'Synthetic portraits',
      'Pre-rendered meeting',
      'Real TalkQTE app d703485',
      'cues: unknown',
    ],
  );
  assert.ok(
    windowLabels({
      meeting: { ...meeting, mode: 'live' },
      appCommit: 'abc1234',
      cues: 'cues: model, claude-opus-5-5, low effort',
    }).includes('Live meeting'),
  );
  assert.deepEqual(meetingLabels({ sound: 'tone', portraits: null }), [
    'Simulated meeting',
    'Fictional',
    'Test tones',
  ]);
  // The bar is as wide as the picture and an even height.
  assert.deepEqual(barSize({ width: 2881, scale: 2 }), {
    width: 2882,
    height: 60,
  });
  // The app's commit, when its timing log records one.
  assert.equal(
    commitFromLog(
      [
        'not json',
        JSON.stringify({ event: 'audio_received' }),
        JSON.stringify({
          event: 'session',
          state: 'started',
          commit: 'd703485',
        }),
      ].join('\n'),
    ),
    'd703485',
  );
  assert.equal(
    commitFromLog(JSON.stringify({ event: 'session', state: 'started' })),
    null,
  );
});

test('the recorder refuses before building or running anything', async () => {
  const meetingFile = join(outside(), 'meeting.json');
  writeFileSync(
    meetingFile,
    JSON.stringify({
      schema: 'talkqte-meeting-emulator/1',
      fictional: true,
      mode: 'prerendered',
      labels: ['Simulated meeting', 'Fictional'],
      source: { conversation: 'workshop-a', sha256: 'x' },
    }),
  );
  const notMeeting = join(outside(), 'other.json');
  writeFileSync(
    notMeeting,
    JSON.stringify({ schema: 'talkqte-cue-sim/1', fictional: true }),
  );
  let built = 0;
  const helper = async () => {
    built++;
    throw new Error('should not be built');
  };
  const base = [
    '--meeting',
    meetingFile,
    '--out',
    outside(),
    '--app-commit',
    'd703485',
  ];
  const repository = new URL('..', import.meta.url).pathname;
  for (const [args, message] of [
    [['--seconds', '60'], /Use --meeting/],
    // No length given and none in the record.
    [[...base], /Use --seconds <n>/],
    [[...base, '--seconds', '0'], /whole number from 1/],
    [[...base, '--seconds', String(MAX_SECONDS + 1)], /whole number from 1/],
    [[...base, '--seconds', 'ten'], /whole number from 1/],
    [
      [
        '--meeting',
        notMeeting,
        '--out',
        outside(),
        '--app-commit',
        'd703485',
        '--seconds',
        '60',
      ],
      /Only a fictional meeting/,
    ],
    [
      ['--meeting', meetingFile, '--out', outside(), '--seconds', '60'],
      /Say which TalkQTE/,
    ],
    // Where the cues came from is never given by hand: it is read from
    // the app's timing log.
    [
      [...base, '--seconds', '60', '--cues', 'app rules'],
      /Unknown or incomplete argument/,
    ],
    [
      [
        '--meeting',
        meetingFile,
        '--out',
        repository,
        '--app-commit',
        'd703485',
        '--seconds',
        '60',
      ],
      /inside the repository/,
    ],
    [
      [...base, '--seconds', '60', '--display', '1'],
      /Unknown or incomplete argument/,
    ],
  ])
    await assert.rejects(
      recorder(args, { print: () => {}, helper }),
      message,
      args.join(' '),
    );
  assert.equal(built, 0);
});

test('the emulator refuses unknown modes, missing choices and conversations not in the run', async () => {
  const { file } = generatedRun();
  for (const [args, message] of [
    [['play'], /Use render or live/],
    [['render', '--results', file], /Use --conversation/],
    [
      [
        'render',
        '--results',
        file,
        '--conversation',
        'nope',
        '--out',
        outside(),
        '--no-sound',
      ],
      /No conversation "nope"/,
    ],
    [
      [
        'live',
        '--results',
        file,
        '--conversation',
        'workshop-a',
        '--out',
        outside(),
        '--port',
        '80',
      ],
      /--port is a number/,
    ],
  ])
    await assert.rejects(emulator(args, { print: () => {} }), message);
});

test("where the cues came from is read from the app's timing log, never assumed", () => {
  const log = (...events) =>
    events.map((event) => JSON.stringify(event)).join('\n');
  // No log at all: unknown.
  assert.deepEqual(cuesFromLog(undefined), {
    label: 'cues: unknown',
    decisions: null,
    model: null,
    effort: null,
  });
  // The decider field, as the app will write it.
  assert.equal(
    cuesFromLog(
      log(
        { event: 'session', state: 'started' },
        { event: 'cue_decision', decider: 'phrase_rule', cue: 'c1' },
        { event: 'cue_decision', decider: 'phrase_rule', cue: 'c2' },
      ),
    ).label,
    'cues: phrase rules',
  );
  const model = cuesFromLog(
    log(
      {
        event: 'evaluator',
        state: 'on',
        model: 'claude-haiku-5-5',
        effort: 'medium',
      },
      {
        event: 'evaluator',
        state: 'on',
        model: 'claude-opus-5-5',
        effort: 'low',
        backend: 'claude-cli',
      },
      { event: 'cue_decision', decider: 'model', cue: 'c1', request: 3 },
    ),
  );
  assert.equal(model.label, 'cues: model, claude-opus-5-5, low effort');
  assert.deepEqual(model.decisions, { phrase_rule: 0, model: 1, unknown: 0 });
  // A log from before the decider field: its source says the same.
  assert.equal(
    cuesFromLog(
      log(
        { event: 'cue_decision', source: 'line', cue: 'c1' },
        { event: 'cue_decision', source: 'evaluated', cue: 'c2' },
      ),
    ).label,
    'cues: phrase rules and model (not named in the log)',
  );
  // A decider it does not know is reported as unknown, not as either.
  assert.equal(
    cuesFromLog(log({ event: 'cue_decision', decider: 'oracle' })).label,
    'cues: unknown',
  );
  // A run in which no cue was decided says so.
  assert.equal(
    cuesFromLog(log({ event: 'session', state: 'started' })).label,
    'cues: none shown',
  );
  assert.equal(
    cuesFromLog(
      log({ event: 'evaluator', model: 'claude-opus-5-5', effort: 'low' }),
    ).label,
    'cues: model, claude-opus-5-5, low effort, none shown',
  );
});

/** A stand-in capture program: answers --check and --list from a script,
 * and fails if it is ever asked to --capture. */
function fakeHelper({ allowed, windows = [] }) {
  const file = join(outside(), 'capture');
  const list = windows.map((window) =>
    JSON.stringify({ event: 'window', onScreen: true, ...window }),
  );
  writeFileSync(
    file,
    `#!/bin/sh
case "$1" in
  --check) echo '${JSON.stringify({ event: 'check', screenRecording: allowed })}' ;;
  --list) printf '%s\\n' ${list.map((line) => `'${line}'`).join(' ')} ;;
  *) echo '{"event":"error","message":"a dry run must not capture"}'; exit 9 ;;
esac
`,
    { mode: 0o755 },
  );
  return async () => file;
}

test('the dry run reports every step without recording, and the length comes from the meeting', async () => {
  const directory = outside();
  writeFileSync(join(directory, 'meeting.mp4'), 'fictional');
  const meetingFile = join(directory, 'meeting.json');
  writeFileSync(
    meetingFile,
    JSON.stringify({
      schema: 'talkqte-meeting-emulator/1',
      fictional: true,
      mode: 'prerendered',
      video: 'meeting.mp4',
      labels: ['Simulated meeting', 'Fictional'],
      source: { conversation: 'workshop-a', sha256: 'x' },
      timing: { lines: [{ lineId: 't1', endsAtMs: 70_200 }] },
    }),
  );
  const log = join(outside(), 'run.jsonl');
  const out = outside();
  const dry = (helper, extra = []) =>
    recorder(
      [
        '--meeting',
        meetingFile,
        '--out',
        out,
        '--timing-log',
        log,
        '--dry-run',
        ...extra,
      ],
      { print: () => {}, helper },
    );

  // Before TalkQTE has written its log, and without the permission.
  const before = await dry(fakeHelper({ allowed: false }));
  assert.equal(before.ready, false);
  const text = (result) =>
    result.steps
      .map((item) => `${item.ok ? 'ready' : 'to do'} ${item.text}`)
      .join('\n');
  assert.match(text(before), /ready Recording length: 86 s\./);
  assert.match(
    text(before),
    /to do TalkQTE commit: the timing log does not exist yet/,
  );
  assert.match(text(before), /ready Cues label so far: "cues: unknown"/);
  assert.match(
    text(before),
    /to do Screen & System Audio Recording: not allowed/,
  );
  assert.match(text(before), /to do Windows: not checked/);

  // With the session started, the permission, and both windows open.
  writeFileSync(
    log,
    [
      { event: 'session', state: 'started', commit: '12ed6ba0', elapsed_ms: 0 },
      { event: 'cue_decision', source: 'line', cue: 'c1' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n'),
  );
  const after = await dry(
    fakeHelper({
      allowed: true,
      windows: [
        { app: 'QuickTime Player', title: 'meeting.mp4' },
        { app: 'TalkQTE', title: 'TalkQTE companion' },
        { app: 'TalkQTE', title: 'TalkQTE' },
      ],
    }),
    ['--seconds', '120'],
  );
  assert.equal(after.ready, true, text(after));
  assert.match(text(after), /ready Recording length: 120 s\./);
  assert.match(
    text(after),
    /ready TalkQTE commit: 12ed6ba \(from the timing log\)/,
  );
  assert.match(text(after), /ready Cues label so far: "cues: phrase rules"/);
  assert.match(text(after), /ready QuickTime Player: 1 window on screen/);
  assert.match(text(after), /ready TalkQTE companion: found by its title/);

  // A companion whose title cannot be read is pointed out, not assumed.
  const untitled = await dry(
    fakeHelper({
      allowed: true,
      windows: [
        { app: 'QuickTime Player', title: 'm' },
        { app: 'TalkQTE', title: '' },
      ],
    }),
  );
  assert.match(
    text(untitled),
    /its title is not visible; the smallest TalkQTE window would be used/,
  );

  // A live meeting has no known length, so it must be given.
  const live = join(outside(), 'live.json');
  writeFileSync(
    live,
    JSON.stringify({
      schema: 'talkqte-meeting-emulator/1',
      fictional: true,
      mode: 'live',
      labels: [],
      source: { conversation: 'w' },
    }),
  );
  await assert.rejects(
    recorder(
      ['--meeting', live, '--out', outside(), '--app-commit', 'abc1234'],
      {
        print: () => {},
        helper: fakeHelper({ allowed: true }),
      },
    ),
    /Use --seconds <n>/,
  );
});

test('a bundled conversation needs no results file, and an unknown one is refused before a browser starts', async () => {
  await assert.rejects(
    emulator(
      ['render', '--conversation', 'no-such-meeting', '--out', outside()],
      { print: () => {} },
    ),
    /No conversation "no-such-meeting" among the bundled ones\. It has: standup-flaky-test/,
  );
  await assert.rejects(
    emulator(['render', '--out', outside()], { print: () => {} }),
    /Use --conversation/,
  );
});
