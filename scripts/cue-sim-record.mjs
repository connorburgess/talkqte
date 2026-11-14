// Records a simulated session as a video: a mock video call in the
// background, with the real TalkQTE companion floating over it and the real
// notebook beside it, both fed a recorded simulation results file. Cue
// decisions come from that file (fake, rules, or a later model run); the
// recorder itself never asks an evaluator anything.
//
//   npm run dev -- --port <port>          (in another terminal)
//   node scripts/cue-sim-record.mjs --results <cue-sim results .json> \
//     --url http://127.0.0.1:<port> --out <directory outside the repository>
//
// Videos and frames are private working files and never go in the checkout.
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import {
  createRunLog,
  outputDirectory,
  parseFlags,
  stamp,
} from './cue-lab-output.mjs';
import { isMain } from './is-main.mjs';

const run = promisify(execFile);
const STAGE = new URL('./lab-stage/stage.html', import.meta.url);
/** The stage page: the mock call, the labels and the two TalkQTE frames. */
export const STAGE_HTML = () => readFileSync(STAGE, 'utf8');
// The test entry point that stands in for the desktop engine in a browser.
const ENTRY = '/tests/fixtures/native-microphone.ts';
const VIEWPORT = { width: 1920, height: 1080 };
const WORD_MS = 360;
// File names come from a results file, which could have been edited by hand.
const safe = (text) => String(text).replace(/[^A-Za-z0-9_-]+/g, '-');

/** What the stage needs to play one replay from a simulation results file. */
export function stageData(results, replay, { origin, speed = 1 }) {
  if (results.schema !== 'talkqte-cue-sim/1' || results.fictional !== true)
    throw new Error(
      'The recorder only plays fictional results written by the cue simulation.',
    );
  const lines = replay.lines.map((line, index) => {
    const spoken = 300 + line.text.split(/\s+/).length * WORD_MS;
    return {
      id: line.id,
      speaker: line.speaker,
      text: line.text,
      atMs: line.atMs,
      arrivesAtMs: line.arrivesAtMs,
      // When the speaker starts: after the previous line, about a line's
      // length before this one ends.
      fromMs: Math.max(
        index ? replay.lines[index - 1].atMs + 100 : 0,
        line.atMs - spoken,
      ),
    };
  });
  const last = lines.at(-1);
  const kind = results.evaluator.kind;
  return {
    origin,
    speed,
    title: replay.title,
    setting: replay.setting,
    listener: replay.listener,
    participants: replay.participants.length
      ? replay.participants
      : [...new Set(lines.map((line) => line.speaker))].map((name) => ({
          name,
          role: '',
        })),
    evaluator: results.evaluator.label,
    timing:
      kind === 'model'
        ? 'decision times measured on isolated requests, replayed here'
        : kind === 'rules'
          ? 'recorded rule outcomes, no decision time'
          : 'decision times made up, not measured',
    lines,
    timeline: replay.timeline,
    // A little past the last line reaching the app, or the last cue change
    // if that is later, so an unread cue's expiry is not waited out in full.
    endsAtMs:
      Math.max(
        last.arrivesAtMs + 2_000,
        ...replay.timeline
          .filter((event) => event.type !== 'cue-cleared')
          .map((event) => event.atMs + 2_500),
      ) + 1_000,
  };
}

async function ffmpegAvailable() {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** Re-encodes the raw capture as a compact MP4 and removes the raw file.
 * Without ffmpeg the raw capture is kept under the final name. */
export async function optimize(raw, target, { ffmpeg } = {}) {
  if (ffmpeg ?? (await ffmpegAvailable())) {
    const output = `${target}.mp4`;
    try {
      await run('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        raw,
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '21',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        output,
      ]);
      if (statSync(output).size > 0) {
        rmSync(raw, { force: true });
        return { file: output, optimized: true };
      }
    } catch {
      // Fall through and keep the raw capture rather than lose the take.
    }
    rmSync(output, { force: true });
  }
  const output = `${target}.webm`;
  renameSync(raw, output);
  return { file: output, optimized: false };
}

/** Plays one replay in the browser and records it. Resolves to the take's
 * manifest. A take in which an expected cue never appeared is deleted. */
export async function recordReplay({
  browser,
  baseURL,
  results,
  replay,
  directory,
  name,
  speed = 1,
  viewport = VIEWPORT,
  ffmpeg,
  cueTimeoutMs = 10_000,
  log = createRunLog(null),
}) {
  const data = stageData(results, replay, { origin: baseURL, speed });
  name = safe(name);
  const rawDirectory = mkdtempSync(join(tmpdir(), 'talkqte-lab-take-'));
  const frames = join(directory, `${name}-frames`);
  mkdirSync(frames, { recursive: true });
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: rawDirectory, size: viewport },
  });
  const cues = [];
  let failure = null;
  let video;
  log.write('take-start', {
    conversation: replay.id,
    evaluator: results.evaluator.label,
    speed,
    viewport,
  });
  try {
    // Both TalkQTE frames load the app through the browser test entry point,
    // which stands in for the desktop engine; the stage page is served here.
    await context.route(
      (url) => url.origin === baseURL && url.pathname === '/' && !url.hash,
      async (route) => {
        if (route.request().resourceType() !== 'document')
          return route.continue();
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: (await response.text()).replace('/src/main.tsx', ENTRY),
        });
      },
    );
    await context.route(`${baseURL}/__lab-stage`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: STAGE_HTML(),
      }),
    );
    const page = await context.newPage();
    video = page.video();
    await page.goto(`${baseURL}/__lab-stage`);
    await page.evaluate((value) => window.stage.prepare(value), data);
    const companion = page.frameLocator('#companion');
    const notebook = page.frameLocator('#notebook');
    // Show the transcript beside the call if the notebook offers the tab.
    const tab = notebook.getByRole('tab', { name: 'Transcript' });
    const offered = await tab
      .first()
      .waitFor({ timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    if (offered) {
      await tab.first().click();
      // Bring the transcript and the notebook's own cue into view.
      await tab.first().evaluate((element) => {
        const top = element.getBoundingClientRect().top + window.scrollY;
        window.scrollTo(0, Math.max(0, top - 150));
      });
    }
    await page.waitForTimeout(2_500); // Leave the title card readable.
    const playing = page.evaluate(() => window.stage.play());
    // A failed playback must not be reported as an unhandled rejection
    // while the cue checks below are still waiting.
    playing.catch(() => {});

    // Watch each expected cue arrive and leave, by its words alone, so the
    // check holds for any card design that shows the cue's text.
    const shown = replay.timeline.filter((e) => e.type === 'cue-shown');
    for (const [index, event] of shown.entries()) {
      const cleared = replay.timeline.find(
        (e) => e.type === 'cue-cleared' && e.cueId === event.cueId,
      );
      const text = companion.getByText(event.text, { exact: true }).first();
      const wait = async (state, atMs) => {
        const clock = await page.evaluate(() => window.stage.clock());
        await text.waitFor({
          state,
          timeout: Math.max(0, atMs - clock) / speed + cueTimeoutMs,
        });
        return page.evaluate(() => window.stage.clock());
      };
      const record = {
        cueId: event.cueId,
        text: event.text,
        expectedAtMs: event.atMs,
        seenAtMs: null,
        seenInNotebook: null,
        expectedGoneAtMs: cleared?.atMs ?? null,
        goneAtMs: null,
        frame: null,
      };
      cues.push(record);
      record.seenAtMs = Math.round(await wait('visible', event.atMs));
      record.seenInNotebook = await notebook
        .getByText(event.text, { exact: true })
        .first()
        .isVisible();
      record.frame = join(frames, `cue-${index + 1}.png`);
      await page.screenshot({ path: record.frame });
      log.write('cue-seen', { conversation: replay.id, ...record });
      if (cleared && cleared.atMs < data.endsAtMs) {
        record.goneAtMs = Math.round(await wait('hidden', cleared.atMs));
        log.write('cue-gone', { conversation: replay.id, ...record });
      }
    }
    await playing;
    await page.screenshot({ path: join(frames, 'end.png') });
    await page.waitForTimeout(800);
  } catch (error) {
    failure = error.message.split('\n')[0];
  }
  // Closing the context finishes the video file.
  await context.close().catch((error) => {
    failure ??= error.message.split('\n')[0];
  });
  const raw = video ? await video.path().catch(() => null) : null;
  if (failure || !raw || !existsSync(raw)) {
    // A take that did not show what the results say is not kept.
    rmSync(rawDirectory, { recursive: true, force: true });
    rmSync(frames, { recursive: true, force: true });
    log.write('take-discarded', { conversation: replay.id, reason: failure });
    throw new Error(
      `Recording of ${replay.id} was discarded: ${failure ?? 'no video was produced'}`,
    );
  }
  const rawBytes = statSync(raw).size;
  const saved = await optimize(raw, join(directory, name), { ffmpeg });
  rmSync(rawDirectory, { recursive: true, force: true });
  const manifest = {
    schema: 'talkqte-cue-recording/1',
    fictional: true,
    simulated: true,
    conversation: replay.id,
    title: replay.title,
    evaluator: results.evaluator.label,
    settings: results.settings,
    speed,
    viewport,
    video: basename(saved.file),
    optimized: saved.optimized,
    bytes: statSync(saved.file).size,
    rawBytes,
    durationMs: Math.round(data.endsAtMs / speed),
    cues,
    note: 'Simulated replay of a fictional conversation over a mock call. Private: not for the repository, README, website or any promotion.',
  };
  writeFileSync(
    join(directory, `${name}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  log.write('take-saved', manifest);
  return manifest;
}

export async function main(args, { print = console.log } = {}) {
  const flags = parseFlags(args, {
    values: [
      '--results',
      '--url',
      '--out',
      '--conversations',
      '--speed',
      '--browser',
    ],
  });
  if (!flags['--results'] || !flags['--url'])
    throw new Error(
      'Use --results <cue-sim results .json> --url <running browser preview, such as http://127.0.0.1:1420> --out <directory outside the repository>.',
    );
  const results = JSON.parse(readFileSync(flags['--results'], 'utf8'));
  const ids = flags['--conversations']?.split(',');
  const replays = results.conversations.filter(
    (replay) => !ids || ids.includes(replay.id),
  );
  if (!replays.length) throw new Error('No matching conversation to record.');
  const speed = Number(flags['--speed'] ?? 1);
  if (!(speed >= 0.25 && speed <= 16))
    throw new Error('--speed is a number from 0.25 to 16.');
  const directory = outputDirectory(flags['--out']);
  const baseURL = new URL(flags['--url']).origin;
  const { chromium, webkit } = await import('@playwright/test');
  const browser = await (
    flags['--browser'] === 'webkit' ? webkit : chromium
  ).launch();
  const log = createRunLog(
    join(directory, `cue-recording-${stamp()}.log.jsonl`),
  );
  const saved = [];
  const discarded = [];
  try {
    for (const replay of replays) {
      const name = safe(`${replay.id}-${results.evaluator.id}-${stamp()}`);
      try {
        const manifest = await recordReplay({
          browser,
          baseURL,
          results,
          replay,
          directory,
          name,
          speed,
          log,
        });
        saved.push(manifest);
        print(
          `saved      ${manifest.video} (${(manifest.bytes / 1e6).toFixed(1)} MB${manifest.optimized ? ', optimized' : ', raw capture: ffmpeg not found'}; ${manifest.cues.length} cues seen)`,
        );
      } catch (error) {
        discarded.push(replay.id);
        print(`discarded  ${error.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  print(
    `${saved.length} recording${saved.length === 1 ? '' : 's'} in ${directory}${discarded.length ? `; ${discarded.length} discarded` : ''}. Simulated and fictional; keep them private.`,
  );
  if (discarded.length) process.exitCode = 1;
  return { saved, discarded };
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
