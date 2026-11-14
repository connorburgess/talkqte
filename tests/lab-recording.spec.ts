import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The lab's recorder plays a simulation results file over a mock call with
// the real companion and notebook, and saves a video. Everything here is
// fictional and offline: the decisions come from the conversation's own
// labels after a made-up delay. No model, account or network is used.
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

async function simulated() {
  const simulation = await import(simulationPath);
  return simulation.runSimulation({
    source: 'conversations',
    conversations: [conversation],
    evaluator: simulation.labelsEvaluator([conversation], { latencyMs: 400 }),
    options: { transcriptDelayMs: 400 },
  });
}
const videos = (directory: string) =>
  readdirSync(directory).filter((name) => /\.(mp4|webm)$/.test(name));

test('a recorded results file becomes a labelled video in which the cue appears and leaves', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const { recordReplay } = await import(recorderPath);
  const results = await simulated();
  const directory = testInfo.outputPath('recording');
  const manifest = await recordReplay({
    browser,
    baseURL,
    results,
    replay: results.conversations[0],
    directory,
    name: 'take',
    viewport: { width: 1920, height: 1080 },
  });

  // One video, no raw capture left behind, and it is not empty.
  expect(videos(directory)).toEqual([manifest.video]);
  expect(statSync(join(directory, manifest.video)).size).toBeGreaterThan(
    10_000,
  );
  expect(manifest.video).toMatch(manifest.optimized ? /\.mp4$/ : /\.webm$/);
  expect(manifest.fictional).toBe(true);
  expect(manifest.simulated).toBe(true);
  expect(manifest.evaluator).toContain('no model');

  // The cue was seen in the real companion and notebook by its words, no
  // earlier than the results say, and was seen to leave when resolved.
  expect(manifest.cues).toHaveLength(1);
  const [cue] = manifest.cues;
  expect(cue.text).toBe('The workshop room has no one booking it.');
  expect(cue.expectedAtMs).toBe(1_400);
  expect(cue.seenAtMs).toBeGreaterThanOrEqual(cue.expectedAtMs);
  // Generous: a busy machine draws the frame late, never early.
  expect(cue.seenAtMs).toBeLessThan(cue.expectedAtMs + 8_000);
  expect(cue.seenInNotebook).toBe(true);
  expect(cue.expectedGoneAtMs).toBe(5_800);
  expect(cue.goneAtMs).toBeGreaterThanOrEqual(cue.expectedGoneAtMs);
  expect(existsSync(cue.frame)).toBe(true);
  expect(existsSync(join(directory, 'take.json'))).toBe(true);
});

test('the recording says on screen that it is simulated and fictional', async ({
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
  // The source of the decisions is named once the replay is loaded.
  const data = stageData(results, results.conversations[0], {
    origin: baseURL,
  });
  expect(data.evaluator).toContain('no model');
  expect(data.timing).toContain('made up');
});

test('a take that does not show its cue is deleted, and real results are refused', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const { recordReplay, stageData } = await import(recorderPath);
  const results = await simulated();
  const replay = structuredClone(results.conversations[0]);
  // The results claim a cue whose source line does not exist, so the stage
  // cannot show it.
  replay.timeline.find(
    (event: { type: string }) => event.type === 'cue-shown',
  ).sourceIds = ['missing'];
  const directory = testInfo.outputPath('discarded');
  await expect(
    recordReplay({
      browser,
      baseURL,
      results,
      replay,
      directory,
      name: 'take',
      cueTimeoutMs: 1_500,
    }),
  ).rejects.toThrow(/was discarded/);
  expect(readdirSync(directory)).toEqual([]);

  expect(() =>
    stageData({ ...results, fictional: false }, replay, { origin: baseURL }),
  ).toThrow(/only plays fictional results/);
});
