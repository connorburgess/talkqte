// Records a simulated session as a video: a mock video call as quiet
// background, with the real TalkQTE companion drawn large over it so the
// cue card is easy to watch, fed a recorded simulation results file. With
// --with-notebook a second video shows the real notebook by itself. Cue
// decisions come from the results file (fake, labels, rules, or an approved
// model run); the recorder itself never asks an evaluator anything.
//
//   npm run dev -- --port <port>          (in another terminal)
//   node scripts/cue-sim-record.mjs --results <cue-sim results .json> \
//     --url http://127.0.0.1:<port> --out <directory outside the repository> \
//     [--with-notebook] [--conversations a,b] [--speed 2]
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
import { SETS, loadSet } from './cue-lab-sets.mjs';
import { conversationFromCase, loadConversations } from './cue-sim.mjs';
import { SPEECH_MODEL, voicePlan } from './cue-sim-voices.mjs';
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
export function stageData(
  results,
  replay,
  { origin, speed = 1, view = 'call', sound = null },
) {
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
    view,
    // Shown as a tag for the whole recording when the lines are audible.
    sound: sound === 'tone' ? 'Test tones' : sound ? 'Synthetic voices' : '',
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
    // Said in a tag for the whole recording: whether a model decided.
    decisions:
      kind !== 'model'
        ? 'No model'
        : results.stopped
          ? 'Real model decisions · run stopped early'
          : 'Real model decisions',
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

async function available(command, args = ['-version']) {
  try {
    await run(command, args);
    return true;
  } catch {
    return false;
  }
}
const ffmpegAvailable = () => available('ffmpeg');

// System voices to read the fictional lines aloud, in order of preference.
// Speech is made on this device with macOS `say`; no speech service is used.
const VOICES = ['Samantha', 'Daniel', 'Karen', 'Rishi', 'Moira', 'Tessa'];
const SPEECH_RATE = 185; // words a minute

/** How the lines can be made audible here: macOS `say`, else plain test
 * tones from ffmpeg (so the audio path can be checked anywhere), else none. */
export async function speechEngine() {
  if (!(await ffmpegAvailable()) || !(await available('ffprobe'))) return null;
  if (process.platform === 'darwin' && (await available('say', ['-v', '?'])))
    return 'say';
  return 'tone';
}

async function duration(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Math.round(Number(stdout.trim()) * 1000);
}

/** Gets one clip per line and places each so that it ends when the
 * simulation says the line ends, which is the moment every cue decision is
 * timed from. Nothing in the simulation moves to fit the speech: a clip
 * that cannot fit after the previous speaker ends late, and that is
 * reported. `data.lines[].fromMs` is updated to when each clip starts, so
 * the picture shows who is speaking while they are heard.
 *
 * engine: 'cache' (clips made earlier by the separate voice step),
 * 'say' (macOS system voices) or 'tone' (plain test tones). */
export async function synthesize(
  data,
  directory,
  engine,
  { cache, plan } = {},
) {
  const speakers = [...new Set(data.lines.map((line) => line.speaker))];
  let installed = VOICES;
  if (engine === 'say') {
    const { stdout } = await run('say', ['-v', '?']);
    installed = VOICES.filter((voice) =>
      new RegExp(`^${voice}\\s`, 'm').test(stdout),
    );
    if (!installed.length)
      throw new Error('No listed system voice is installed.');
  }
  const voices =
    engine === 'cache'
      ? plan.voices
      : Object.fromEntries(
          speakers.map((speaker, i) => [
            speaker,
            engine === 'say'
              ? installed[i % installed.length]
              : `test tone ${220 + 70 * (i % 6)} Hz`,
          ]),
        );
  const clips = [];
  let previousEnd = 0;
  for (const [index, line] of data.lines.entries()) {
    // The time this line has: from the previous speaker to its own end.
    const roomMs = line.atMs - previousEnd;
    let file = join(directory, `line-${index + 1}.aiff`);
    let rate = null;
    if (engine === 'cache')
      file = join(cache, plan.lines.find((l) => l.lineId === line.id).file);
    else if (engine === 'say') {
      const speak = (wordsPerMinute) =>
        run('say', [
          '-v',
          voices[line.speaker],
          '-r',
          String(wordsPerMinute),
          '-o',
          file,
          line.text,
        ]);
      rate = SPEECH_RATE;
      await speak(rate);
      const first = await duration(file);
      // Once only: speak a little faster when the line has less room than
      // that, up to a rate that still sounds like speech.
      if (first > roomMs && roomMs > 0) {
        rate = Math.min(240, Math.ceil((SPEECH_RATE * first) / roomMs));
        await speak(rate);
      }
    } else {
      file = join(directory, `line-${index + 1}.wav`);
      await run('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${220 + 70 * (speakers.indexOf(line.speaker) % 6)}:duration=${Math.max(0.2, Math.min(line.atMs - line.fromMs, roomMs - 150) / 1000).toFixed(2)}`,
        file,
      ]);
    }
    const durationMs = await duration(file);
    const startMs = Math.max(
      previousEnd + (index ? 150 : 0),
      line.atMs - durationMs,
    );
    line.fromMs = startMs;
    previousEnd = startMs + durationMs;
    clips.push({
      lineId: line.id,
      speaker: line.speaker,
      file,
      startMs,
      durationMs,
      rate,
      // How long after the simulation's end of the line the clip ends.
      endsLateMs: Math.max(0, previousEnd - line.atMs),
    });
  }
  return { engine, voices, clips };
}

/** Re-encodes the raw capture as a compact MP4 and removes the raw file.
 * Without ffmpeg the raw capture is kept under the final name. */
export async function optimize(raw, target, { ffmpeg, audio } = {}) {
  if (ffmpeg ?? (await ffmpegAvailable())) {
    const output = `${target}.mp4`;
    const clips = audio?.clips ?? [];
    // Each clip is delayed to its own start; nothing is stretched or moved.
    const mix = clips.length
      ? [
          '-filter_complex',
          `${clips
            .map(
              (clip, i) =>
                `[${i + 1}:a]adelay=${Math.max(0, Math.round(audio.offsetMs + clip.startMs))}:all=1[a${i}]`,
            )
            .join(
              ';',
            )};${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[speech]`,
          '-map',
          '0:v',
          '-map',
          '[speech]',
          '-c:a',
          'aac',
          '-b:a',
          '96k',
        ]
      : ['-an'];
    try {
      await run('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        raw,
        ...clips.flatMap((clip) => ['-i', clip.file]),
        ...mix,
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
        return { file: output, optimized: true, sound: clips.length > 0 };
      }
    } catch {
      // Fall through and keep the raw capture rather than lose the take.
    }
    rmSync(output, { force: true });
  }
  const output = `${target}.webm`;
  renameSync(raw, output);
  return { file: output, optimized: false, sound: false };
}

/** Refuses a replay whose words are not the bundled fictional ones: every
 * line, speaker, title and participant must match the fixture it names.
 * A replay may hold fewer lines than its fixture (a run that stopped). */
export async function assertBundled(results, replay) {
  const source = String(results.source ?? '');
  let bundled;
  if (source.startsWith('set:') && Object.hasOwn(SETS, source.slice(4))) {
    const set = await loadSet(source.slice(4));
    bundled = set.cases
      .map((item) => conversationFromCase(item, set.name))
      .find((item) => item.id === replay.id);
  } else bundled = (await loadConversations()).find((c) => c.id === replay.id);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const lines = new Map((bundled?.lines ?? []).map((l) => [l.id, l]));
  const matches =
    bundled &&
    replay.title === bundled.title &&
    replay.setting === bundled.setting &&
    (replay.listener ?? null) === (bundled.listener ?? null) &&
    same(replay.participants, bundled.participants) &&
    replay.lines.length > 0 &&
    replay.lines.every((line) => {
      const known = lines.get(line.id);
      return (
        known &&
        line.speaker === known.speaker &&
        line.text === known.text &&
        line.atMs === known.atMs
      );
    });
  if (!matches)
    throw new Error(
      `The replay "${replay.id}" does not match the bundled fictional conversations. The recorder only plays those.`,
    );
}

/** Plays one replay in the browser and records it: one video of the mock
 * call with the companion, and with `withNotebook` a second of the
 * notebook. Resolves to the take's manifest. A take in which an expected
 * cue never appeared is deleted. */
export async function recordReplay({
  browser,
  baseURL,
  results,
  replay,
  directory,
  name,
  speed = 1,
  viewport = VIEWPORT,
  withNotebook = false,
  // 'say', 'tone' or null; by default whatever this device can do.
  speech,
  // A folder of clips made earlier by the separate voice step. Used when
  // it holds a clip for every line; otherwise the device's own voices are.
  voicesCache,
  ffmpeg,
  cueTimeoutMs = 10_000,
  log = createRunLog(null),
}) {
  // Wherever this is called from, takes are written outside the checkout.
  directory = outputDirectory(directory, {});
  // Speech is only laid under a replay at its own speed.
  const plan = voicesCache ? voicePlan(replay) : null;
  const cached =
    plan &&
    plan.lines.every((line) => existsSync(join(voicesCache, line.file)));
  const engine =
    speed !== 1 || ffmpeg === false
      ? null
      : speech !== undefined
        ? speech
        : cached && (await available('ffprobe')) && (await ffmpegAvailable())
          ? 'cache'
          : await speechEngine();
  const data = stageData(results, replay, {
    origin: baseURL,
    speed,
    sound: engine,
  });
  name = safe(name);
  const rawDirectory = mkdtempSync(join(tmpdir(), 'talkqte-lab-take-'));
  const frames = join(directory, `${name}-frames`);
  mkdirSync(frames, { recursive: true });
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: rawDirectory, size: viewport },
  });
  const cues = [];
  const videos = {};
  let failure = null;
  let audio = null;
  let videoStartedAt = null;
  let playStartedAt = null;
  log.write('take-start', {
    conversation: replay.id,
    evaluator: results.evaluator.label,
    speed,
    viewport,
    withNotebook,
  });
  try {
    // The TalkQTE frame loads the app through the browser test entry point,
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
    if (engine) {
      audio = await synthesize(data, rawDirectory, engine, {
        cache: voicesCache,
        plan,
      });
      log.write('speech-ready', {
        conversation: replay.id,
        engine,
        voices: audio.voices,
        endLate: audio.clips.filter((clip) => clip.endsLateMs > 0).length,
      });
    }
    const open = async (view) => {
      const page = await context.newPage();
      // The page's video starts with the page.
      if (view === 'call') videoStartedAt = Date.now();
      videos[view] = page.video();
      await page.goto(`${baseURL}/__lab-stage`);
      await page.evaluate((value) => window.stage.prepare(value), {
        ...data,
        view,
      });
      return page;
    };
    const page = await open('call');
    const companion = page.frameLocator('#companion');
    let notebook = null;
    let notebookPage = null;
    if (withNotebook) {
      notebookPage = await open('notebook');
      notebook = notebookPage.frameLocator('#notebook');
      // Show the transcript if the notebook offers the tab.
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
        await tab.first().evaluate((element) => {
          const top = element.getBoundingClientRect().top + window.scrollY;
          window.scrollTo(0, Math.max(0, top - 150));
        });
      }
    }
    await page.waitForTimeout(2_500); // Leave the title card readable.
    const pages = [page, notebookPage].filter(Boolean);
    playStartedAt = Date.now();
    const playing = Promise.all(
      pages.map((each) => each.evaluate(() => window.stage.play())),
    );
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
        // Only checked when the notebook is recorded too.
        seenInNotebook: null,
        expectedGoneAtMs: cleared?.atMs ?? null,
        goneAtMs: null,
        frame: null,
      };
      cues.push(record);
      record.seenAtMs = Math.round(await wait('visible', event.atMs));
      if (notebook) {
        const copy = notebook.getByText(event.text, { exact: true }).first();
        await copy.waitFor({ state: 'visible', timeout: cueTimeoutMs });
        record.seenInNotebook = true;
      }
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
  // Closing the context finishes the video files.
  await context.close().catch((error) => {
    failure ??= error.message.split('\n')[0];
  });
  const raw = {};
  for (const [view, video] of Object.entries(videos))
    raw[view] = await video.path().catch(() => null);
  const wanted = withNotebook ? ['call', 'notebook'] : ['call'];
  if (failure || !wanted.every((view) => raw[view] && existsSync(raw[view]))) {
    // A take that did not show what the results say is not kept.
    rmSync(rawDirectory, { recursive: true, force: true });
    rmSync(frames, { recursive: true, force: true });
    log.write('take-discarded', { conversation: replay.id, reason: failure });
    throw new Error(
      `Recording of ${replay.id} was discarded: ${failure ?? 'no video was produced'}`,
    );
  }
  const rawBytes = statSync(raw.call).size;
  const saved = await optimize(raw.call, join(directory, name), {
    ffmpeg,
    audio: audio && {
      clips: audio.clips,
      // Where the replay's clock starts within the video.
      offsetMs: playStartedAt - videoStartedAt,
    },
  });
  const savedNotebook = withNotebook
    ? await optimize(raw.notebook, join(directory, `${name}-notebook`), {
        ffmpeg,
      })
    : null;
  rmSync(rawDirectory, { recursive: true, force: true });
  const manifest = {
    schema: 'talkqte-cue-recording/1',
    fictional: true,
    simulated: true,
    conversation: replay.id,
    title: replay.title,
    evaluator: results.evaluator.label,
    decisions: data.decisions,
    settings: results.settings,
    speed,
    viewport,
    video: basename(saved.file),
    notebookVideo: savedNotebook ? basename(savedNotebook.file) : null,
    // The spoken lines: how they were made, by which voice, and every clip
    // that ran past the next speaker's start. Cue timing is never moved.
    audio:
      audio && saved.sound
        ? {
            engine: audio.engine,
            note:
              audio.engine === 'cache'
                ? `Synthetic preset voices from OpenAI text-to-speech (${SPEECH_MODEL}), made in a separate step and cached. Only the fictional lines of this bundled conversation were sent to that provider. No voice was cloned.`
                : audio.engine === 'say'
                  ? 'Synthetic voices made on this device with macOS say. No speech service was used.'
                  : 'Plain test tones, not speech.',
            placement:
              'Each clip ends when the simulation says its line ends; cue timing is unchanged. A clip listed under endLate could not fit after the previous speaker and ends that much later.',
            voices: audio.voices,
            startsInVideoAtMs: playStartedAt - videoStartedAt,
            clips: audio.clips.map(({ file: _file, ...clip }) => clip),
            endLate: audio.clips
              .filter((clip) => clip.endsLateMs > 0)
              .map(({ lineId, endsLateMs }) => ({ lineId, endsLateMs })),
          }
        : null,
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
      '--voices-cache',
    ],
    switches: ['--with-notebook', '--no-sound'],
  });
  if (!flags['--results'] || !flags['--url'])
    throw new Error(
      'Use --results <cue-sim results .json> --url <running browser preview, such as http://127.0.0.1:1420> --out <directory outside the repository>.',
    );
  const url = new URL(flags['--url']);
  // The preview on this device only: nothing is loaded from elsewhere.
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new Error(
      '--url must be the browser preview on this device: http://127.0.0.1, http://localhost or http://[::1], with its port.',
    );
  const baseURL = url.origin;
  const results = JSON.parse(readFileSync(flags['--results'], 'utf8'));
  const ids = flags['--conversations']?.split(',');
  const replays = results.conversations.filter(
    (replay) => !ids || ids.includes(replay.id),
  );
  if (!replays.length) throw new Error('No matching conversation to record.');
  // Only the bundled fictional conversations are ever put on screen.
  for (const replay of replays) await assertBundled(results, replay);
  const speed = Number(flags['--speed'] ?? 1);
  if (!(speed >= 0.25 && speed <= 16))
    throw new Error('--speed is a number from 0.25 to 16.');
  const directory = outputDirectory(flags['--out']);
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
          withNotebook: Boolean(flags['--with-notebook']),
          ...(flags['--no-sound'] ? { speech: null } : {}),
          ...(flags['--voices-cache']
            ? { voicesCache: outputDirectory(flags['--voices-cache'], {}) }
            : {}),
          log,
        });
        saved.push(manifest);
        print(
          `saved      ${manifest.video}${manifest.notebookVideo ? ` and ${manifest.notebookVideo}` : ''}${manifest.audio ? ` [sound: ${manifest.audio.engine}, ${manifest.audio.endLate.length} lines end late]` : ' [no sound]'} (${(manifest.bytes / 1e6).toFixed(1)} MB${manifest.optimized ? ', optimized' : ', raw capture: ffmpeg not found'}; ${manifest.cues.length} cues seen)`,
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
