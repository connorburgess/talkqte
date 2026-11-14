import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type FrameLocator } from '@playwright/test';

// The lab's recorder plays a simulation results file over a mock call with
// the real companion, and saves a video. Everything here is fictional and
// offline: the decisions come from the conversation's own labels after a
// made-up delay, and the "speech" is plain test tones. No model, account,
// network or speech service is used.
//
// Opt-in: `npm run test:lab-record`. It is left out of `npm test` because
// it records video, and it writes only to a temporary directory outside
// the repository.
const simulationPath = '../scripts/cue-sim.mjs';
const recorderPath = '../scripts/cue-sim-record.mjs';

const conversation = {
  id: 'fictional-room-booking',
  context: 'test',
  title: 'Fictional planning call',
  setting: 'Two invented people plan a fictional workshop.',
  listener: 'Robin',
  participants: [
    { name: 'Maya', role: 'Organizer' },
    { name: 'Robin', role: 'Engineer (listener)' },
  ],
  lines: [
    {
      id: 'l1',
      atMs: 600,
      speaker: 'Maya',
      text: 'Somebody needs to book the workshop room.',
      expect: 'show',
      about: 'The workshop room has no one booking it.',
      until: 'l3',
    },
    { id: 'l2', atMs: 2_600, speaker: 'Maya', text: 'Mm.', expect: 'quiet' },
    {
      id: 'l3',
      atMs: 5_000,
      speaker: 'Robin',
      text: 'I will book the room today.',
      expect: 'resolved',
      of: 'l1',
    },
  ],
};

async function simulated(conversations: unknown[] = [conversation]) {
  const simulation = await import(simulationPath);
  return simulation.runSimulation({
    source: 'conversations',
    conversations,
    evaluator: simulation.labelsEvaluator(conversations, { latencyMs: 400 }),
    options: { transcriptDelayMs: 400 },
  });
}
const outside = () =>
  realpathSync.native(mkdtempSync(join(tmpdir(), 'talkqte-lab-record-test-')));
const videos = (directory: string) =>
  readdirSync(directory).filter((name) => /\.(mp4|webm)$/.test(name));
const tool = (name: string) => {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const streams = (file: string) =>
  execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');

test('a results file becomes one labelled video of the call and companion, with the lines audible', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { recordReplay } = await import(recorderPath);
  const results = await simulated();
  const directory = outside();
  const canMix = tool('ffmpeg') && tool('ffprobe');
  const manifest = await recordReplay({
    browser,
    baseURL,
    results,
    replay: results.conversations[0],
    directory,
    name: 'take',
    includes: ['913d2df'],
    // Plain tones stand in for speech, so no voice has to be installed.
    speech: canMix ? 'tone' : null,
    // During the take, the app must describe the session in its own words
    // as simulated, and never claim a microphone or a live session.
    whilePlaying: async (companion: FrameLocator) => {
      await expect(companion.getByRole('status').first()).toContainText(
        'Simulated session',
      );
      await expect(companion.getByText(/Mic on|Live/)).toHaveCount(0);
    },
  });

  // One video, no notebook video, no raw capture left, and not empty.
  expect(videos(directory)).toEqual([manifest.video]);
  expect(manifest.notebookVideo).toBeNull();
  const file = join(directory, manifest.video);
  expect(statSync(file).size).toBeGreaterThan(10_000);
  expect(manifest.video).toMatch(manifest.optimized ? /\.mp4$/ : /\.webm$/);
  expect(manifest.fictional).toBe(true);
  expect(manifest.simulated).toBe(true);
  expect(manifest.evaluator).toContain('no model');
  expect(manifest.decisions).toBe('No model');
  // The take names the app it shows.
  expect(manifest.app.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(manifest.app.includes).toEqual(['913d2df']);

  // The cue was seen in the real companion by its words, no earlier than
  // the results say, and was seen to leave when resolved.
  expect(manifest.cues).toHaveLength(1);
  const [cue] = manifest.cues;
  expect(cue.text).toBe('The workshop room has no one booking it.');
  expect(cue.expectedAtMs).toBe(1_400);
  expect(cue.seenAtMs).toBeGreaterThanOrEqual(cue.expectedAtMs);
  // Generous: a busy machine draws the frame late, never early.
  expect(cue.seenAtMs).toBeLessThan(cue.expectedAtMs + 8_000);
  expect(cue.seenInNotebook).toBeNull();
  expect(cue.expectedGoneAtMs).toBe(5_800);
  expect(cue.goneAtMs).toBeGreaterThanOrEqual(cue.expectedGoneAtMs);
  expect(existsSync(cue.frame)).toBe(true);
  expect(existsSync(join(directory, 'take.json'))).toBe(true);

  if (canMix) {
    // The saved file has a sound track, one clip per line, and the cue
    // times above were not moved to fit it.
    expect(streams(file).sort()).toEqual(['audio', 'video']);
    expect(manifest.audio.engine).toBe('tone');
    expect(Object.keys(manifest.audio.voices)).toEqual(['Maya', 'Robin']);
    expect(
      manifest.audio.clips.map((clip: { lineId: string }) => clip.lineId),
    ).toEqual(['l1', 'l2', 'l3']);
    for (const clip of manifest.audio.clips) {
      // Each clip ends when the simulation says its line ends.
      const line = conversation.lines.find((l) => l.id === clip.lineId)!;
      expect(clip.durationMs).toBeGreaterThan(0);
      expect(clip.startMs + clip.durationMs).toBeLessThanOrEqual(
        line.atMs + clip.endsLateMs,
      );
      expect(clip.startMs + clip.durationMs).toBeGreaterThan(line.atMs - 60);
    }
    expect(manifest.audio.endLate).toEqual([]);
    // The finished file was measured against its clips: nothing missing,
    // cut short or overlapping, at one sample rate.
    expect(manifest.audio.check.passed).toBe(true);
    expect(manifest.audio.check.sampleRate).toBe(48_000);
    expect(manifest.audio.check.clips).toBe(3);
  } else expect(manifest.audio).toBeNull();
});

test('the notebook is a separate second video, only when asked for', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { recordReplay } = await import(recorderPath);
  const results = await simulated();
  const directory = outside();
  const manifest = await recordReplay({
    browser,
    baseURL,
    results,
    replay: results.conversations[0],
    directory,
    name: 'take',
    withNotebook: true,
    speech: null,
  });
  expect(videos(directory).sort()).toEqual(
    [manifest.video, manifest.notebookVideo].sort(),
  );
  expect(manifest.notebookVideo).toMatch(/^take-notebook\./);
  expect(manifest.cues[0].seenInNotebook).toBe(true);
  expect(manifest.audio).toBeNull();
});

test('the recording says on screen what it is, and the main view has no notebook', async ({
  page,
  baseURL,
}) => {
  const { stageData, STAGE_HTML } = await import(recorderPath);
  const results = await simulated();
  await page.route('**/__lab-stage', (route) =>
    route.fulfill({ contentType: 'text/html', body: STAGE_HTML() }),
  );
  await page.goto('/__lab-stage');
  const label = page.getByRole('note', { name: 'Recording label' });
  await expect(label).toContainText('Simulated');
  await expect(label).toContainText('Fictional');
  await expect(
    page.getByRole('region', { name: 'Mock video call' }),
  ).toContainText('Mock call. Not a real meeting or meeting app.');
  await expect(page.getByRole('region', { name: 'Lab overlay' })).toContainText(
    'not part of TalkQTE',
  );
  await expect(page.getByTitle('TalkQTE companion')).toBeVisible();
  await expect(page.getByTitle('TalkQTE notebook')).toBeHidden();
  // The companion is its real size, not enlarged, and floats near the top
  // centre of the call; the labels stay small.
  const companion = await page.getByTitle('TalkQTE companion').boundingBox();
  const banner = await label.boundingBox();
  const width = page.viewportSize()!.width;
  expect(companion!.width).toBe(420);
  expect(
    Math.abs(companion!.x + companion!.width / 2 - width / 2),
  ).toBeLessThan(2);
  expect(companion!.y).toBeLessThan(80);
  expect(banner!.height).toBeLessThan(40);

  // What the labels will say once a replay is loaded.
  const replay = results.conversations[0];
  const data = stageData(results, replay, { origin: baseURL, sound: 'say' });
  expect(data.evaluator).toContain('no model');
  expect(data.timing).toContain('made up');
  expect(data.decisions).toBe('No model');
  expect(data.sound).toBe('Synthetic voices');
  // Portraits are labelled when a take has them, and only then.
  expect(data.portraitsLabel).toBe('');
  const withPortraits = stageData(results, replay, {
    origin: baseURL,
    portraits: { Maya: { file: 'a.png' }, Robin: { file: 'b.png' } },
  });
  expect(withPortraits.portraitsLabel).toBe('Synthetic portraits');
  expect(withPortraits.participants[0].portrait).toBe(
    `${baseURL}/__lab-portrait/a.png`,
  );
  expect(stageData(results, replay, { origin: baseURL }).sound).toBe('');
  // A results file from a model run is labelled as one.
  const model = {
    ...results,
    evaluator: { ...results.evaluator, kind: 'model', label: 'A model' },
  };
  expect(stageData(model, replay, { origin: baseURL }).decisions).toBe(
    'Real model decisions',
  );
  expect(stageData(model, replay, { origin: baseURL }).timing).toContain(
    'measured',
  );
  expect(
    stageData({ ...model, stopped: { afterCalls: 1 } }, replay, {
      origin: baseURL,
    }).decisions,
  ).toContain('run stopped early');
});

test('a take that does not show its cue is deleted, and nothing is written inside the repository', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { recordReplay, stageData } = await import(recorderPath);
  const results = await simulated();
  const replay = structuredClone(results.conversations[0]);
  // The results claim a cue whose source line does not exist, so the stage
  // cannot show it.
  replay.timeline.find(
    (event: { type: string }) => event.type === 'cue-shown',
  ).sourceIds = ['missing'];
  const directory = outside();
  const take = {
    browser,
    baseURL,
    results,
    replay,
    name: 'take',
    speech: null,
  };
  await expect(
    recordReplay({ ...take, directory, cueTimeoutMs: 1_500 }),
  ).rejects.toThrow(/was discarded/);
  expect(readdirSync(directory)).toEqual([]);

  // Called directly, the recorder still refuses a folder in the checkout.
  const inside = join(process.cwd(), 'test-results', 'lab-recording');
  await expect(recordReplay({ ...take, directory: inside })).rejects.toThrow(
    /inside the repository/,
  );
  expect(existsSync(inside)).toBe(false);

  expect(() =>
    stageData({ ...results, fictional: false }, replay, { origin: baseURL }),
  ).toThrow(/only plays fictional results/);
});

test('the command plays only bundled fictional conversations from the preview on this device', async () => {
  const { main, assertBundled } = await import(recorderPath);
  const { loadConversations } = await import(simulationPath);
  const [bundled] = await loadConversations();
  const results = await simulated([bundled]);
  const directory = outside();
  const file = join(directory, 'results.json');
  const write = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  const run = (url: string) =>
    main(['--results', file, '--url', url, '--out', directory], {
      print: () => {},
    });

  write(results);
  for (const url of [
    'http://example.invalid:1420',
    'https://127.0.0.1:1420',
    'http://192.168.1.20:1420',
  ])
    await expect(run(url)).rejects.toThrow(/preview on this device/);

  // The bundled conversation is accepted, in full or cut short.
  await assertBundled(results, results.conversations[0]);
  await assertBundled(results, {
    ...results.conversations[0],
    lines: results.conversations[0].lines.slice(0, 3),
  });
  // Changed words, a changed speaker, title or participant, or a
  // conversation that is not bundled at all, are refused before a browser
  // is started.
  type Replay = (typeof results.conversations)[number];
  const changed = (edit: (replay: Replay) => void) => {
    const copy = structuredClone(results);
    edit(copy.conversations[0]);
    return copy;
  };
  for (const edited of [
    changed((replay) => (replay.lines[0].text = 'Words that are not bundled.')),
    changed((replay) => (replay.lines[0].speaker = 'Someone Else')),
    changed((replay) => (replay.title = 'Another title')),
    changed((replay) => (replay.participants[0].name = 'Someone Else')),
    changed((replay) => (replay.id = 'not-a-bundled-conversation')),
    await simulated(),
  ]) {
    write(edited);
    await expect(run('http://127.0.0.1:1420')).rejects.toThrow(
      /does not match the bundled fictional conversations/,
    );
  }
  expect(videos(directory)).toEqual([]);
});

// The meeting emulator and the window-only recorder. A small generated run
// in the dialogue lane's format, with its brief beside it.
function generatedRun() {
  const directory = outside();
  const brief = JSON.stringify({ people: ['Maya', 'Robin'] });
  writeFileSync(join(directory, 'run.briefs.json'), brief);
  const run = {
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
          {
            name: 'Maya',
            role: 'Organizer',
            casting: {
              voice: 'feminine',
              age: '30-39',
              portrait: 'Dark hair.',
            },
          },
          {
            name: 'Robin',
            role: 'Engineer',
            casting: { voice: 'neutral', age: '40-49', portrait: 'Grey hair.' },
          },
        ],
        lines: [
          {
            id: 't1',
            speaker: 'Maya',
            text: 'Somebody needs to book the room.',
            startMs: 600,
            atMs: 2_200,
          },
          {
            id: 't2',
            speaker: 'Robin',
            text: 'I will book it today.',
            startMs: 2_700,
            atMs: 3_900,
          },
        ],
        timeline: [],
      },
    ],
  };
  const file = join(directory, 'run.json');
  writeFileSync(file, JSON.stringify(run));
  return { directory, file };
}
const emulatorPath = '../scripts/lab-emulator.mjs';
const windowRecordPath = '../scripts/lab-window-record.mjs';

test('the emulator renders a labelled meeting with its sound and no TalkQTE in it', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  test.skip(!(tool('ffmpeg') && tool('ffprobe')), 'needs ffmpeg');
  const { renderMeeting } = await import(emulatorPath);
  const { file } = generatedRun();
  const directory = outside();
  const manifest = await renderMeeting({
    browser,
    file,
    id: 'workshop-a',
    directory,
    speech: 'tone',
  });
  expect(manifest.mode).toBe('prerendered');
  expect(manifest.fictional).toBe(true);
  expect(manifest.labels).toEqual([
    'Simulated meeting',
    'Fictional',
    'Test tones',
  ]);
  expect(manifest.source).toMatchObject({
    generated: true,
    conversation: 'workshop-a',
  });
  const video = join(directory, manifest.video);
  expect(streams(video).sort()).toEqual(['audio', 'video']);
  expect(manifest.sound.check.passed).toBe(true);
  // Where each line is in the video, to line up with the app's log.
  expect(
    manifest.timing.lines.map((line: { lineId: string }) => line.lineId),
  ).toEqual(['t1', 't2']);
  for (const line of manifest.timing.lines)
    expect(line.endsAtMs).toBeGreaterThan(line.startsAtMs);
  expect(videos(directory)).toEqual([manifest.video]);
});

test('the meeting view shows the call and its labels, and nothing of TalkQTE', async ({
  page,
}) => {
  const { STAGE_HTML } = await import(recorderPath);
  await page.route('**/__lab-stage', (route) =>
    route.fulfill({ contentType: 'text/html', body: STAGE_HTML() }),
  );
  await page.goto('/__lab-stage');
  await page.evaluate(() =>
    (
      window as unknown as {
        stage: { prepare: (value: unknown) => Promise<void> };
      }
    ).stage.prepare({
      view: 'meeting',
      captions: false,
      title: 'Fictional planning call',
      setting: 'Two invented people.',
      listener: 'Robin',
      participants: [
        { name: 'Maya', role: 'Organizer' },
        { name: 'Robin', role: 'Engineer' },
      ],
      lines: [],
      timeline: [],
      decisions: 'No model',
      sound: 'Synthetic voices',
      portraitsLabel: '',
      endsAtMs: 1_000,
      speed: 1,
    }),
  );
  const label = page.getByRole('note', { name: 'Recording label' });
  await expect(label).toContainText('Simulated meeting');
  await expect(label).toContainText('Fictional');
  await expect(label).toContainText('Synthetic voices');
  await expect(label).not.toContainText('No model');
  await expect(page.getByTitle('TalkQTE companion')).toBeHidden();
  await expect(page.getByTitle('TalkQTE notebook')).toBeHidden();
  await expect(page.getByRole('region', { name: 'Lab overlay' })).toBeHidden();
  await expect(
    page.getByRole('region', { name: 'Mock video call' }),
  ).toBeVisible();
});

test('the live meeting plays in real time, takes added lines and logs when each was heard', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { serveMeeting } = await import(emulatorPath);
  const { file } = generatedRun();
  const live = await serveMeeting({
    file,
    id: 'workshop-a',
    directory: outside(),
    speech: null,
    startDelayMs: 200,
  });
  const post = (lines: unknown) =>
    fetch(live.address.replace('/?live', '/append'), {
      method: 'POST',
      body: JSON.stringify({ lines }),
    });
  try {
    expect(
      (await post([{ speaker: 'Robin', text: 'Too early.' }])).status,
    ).toBe(409);
    await page.goto(live.address);
    await expect(
      page.getByRole('note', { name: 'Recording label' }),
    ).toContainText('Simulated meeting');
    await expect(page.locator('#intro')).toBeHidden();
    const added = await post([
      {
        speaker: 'Robin',
        text: 'Actually, I can take the badges too.',
        startMs: 1_000,
      },
    ]);
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual([
      expect.objectContaining({
        lineId: 'x3',
        startsAtMs: 1_000,
        sound: false,
      }),
    ]);
    await expect(page.locator('#caption')).toContainText('the badges too', {
      timeout: 10_000,
    });
    const refused = await post([{ speaker: 'Someone Else', text: 'Hello.' }]);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('not in this meeting');
    await expect
      .poll(() =>
        readFileSync(live.log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).type),
      )
      .toEqual(
        expect.arrayContaining(['served', 'start', 'appended', 'speak']),
      );
    for (const event of readFileSync(live.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)))
      expect(typeof event.wallMs).toBe('number');
  } finally {
    live.server.closeAllConnections();
    live.server.close();
  }
});

test('the label bar goes above the recorded picture, not over it, and the sound is kept', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  test.skip(!(tool('ffmpeg') && tool('ffprobe')), 'needs ffmpeg');
  const { labelBar, burnLabels, barSize, windowLabels } = await import(
    windowRecordPath
  );
  const directory = outside();
  const raw = join(directory, 'raw.mov');
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x400:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    raw,
  ]);
  const labels = windowLabels({
    meeting: {
      labels: ['Simulated meeting', 'Fictional'],
      mode: 'prerendered',
    },
    appCommit: 'd703485',
    cues: 'app rules',
  });
  const picture = { width: 640, scale: 2 };
  const bar = await labelBar(browser, labels, picture);
  const out = await burnLabels(
    raw,
    bar,
    join(directory, 'take'),
    barSize(picture),
  );
  const size = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      out,
    ],
    { encoding: 'utf8' },
  ).trim();
  expect(size).toBe(`640,${400 + barSize(picture).height}`);
  expect(streams(out).sort()).toEqual(['audio', 'video']);
});

test('the capture program builds on a Mac and reports the recording permission without asking', async () => {
  test.setTimeout(240_000);
  test.skip(
    process.platform !== 'darwin' || !tool('swiftc'),
    'macOS with swiftc only',
  );
  const { ensureHelper, main } = await import(windowRecordPath);
  const binary = await ensureHelper();
  const check = JSON.parse(
    execFileSync(binary, ['--check'], { encoding: 'utf8' }).trim(),
  );
  expect(check.event).toBe('check');
  expect(typeof check.screenRecording).toBe('boolean');
  // Arguments it does not know are refused before it looks at the screen.
  let refused = '';
  try {
    execFileSync(binary, ['--whole-screen'], { encoding: 'utf8' });
  } catch (error) {
    refused = String((error as { stdout?: string }).stdout);
  }
  expect(refused).toContain('Unknown argument --whole-screen');

  // Where the permission is missing, the recorder stops before recording.
  const fake = join(outside(), 'capture');
  writeFileSync(
    fake,
    '#!/bin/sh\necho \'{"event":"check","screenRecording":false}\'\n',
    { mode: 0o755 },
  );
  const meeting = join(outside(), 'meeting.json');
  writeFileSync(
    meeting,
    JSON.stringify({
      schema: 'talkqte-meeting-emulator/1',
      fictional: true,
      mode: 'prerendered',
      labels: ['Simulated meeting', 'Fictional'],
      source: { conversation: 'workshop-a', sha256: 'x' },
    }),
  );
  const directory = outside();
  await expect(
    main(
      [
        '--meeting',
        meeting,
        '--seconds',
        '5',
        '--out',
        directory,
        '--app-commit',
        'd703485',
      ],
      { print: () => {}, helper: async () => fake },
    ),
  ).rejects.toThrow(/Screen & System Audio Recording is not allowed/);
  expect(readdirSync(directory)).toEqual([]);
});
