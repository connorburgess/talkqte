import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
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
  // The companion is drawn larger than the labels around it.
  const companion = await page.getByTitle('TalkQTE companion').boundingBox();
  const banner = await label.boundingBox();
  expect(companion!.width).toBeGreaterThan(600);
  expect(banner!.height).toBeLessThan(40);

  // What the labels will say once a replay is loaded.
  const replay = results.conversations[0];
  const data = stageData(results, replay, { origin: baseURL, sound: 'say' });
  expect(data.evaluator).toContain('no model');
  expect(data.timing).toContain('made up');
  expect(data.decisions).toBe('No model');
  expect(data.sound).toBe('Synthetic voices');
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
