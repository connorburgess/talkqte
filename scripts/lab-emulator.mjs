// The meeting emulator: a mock video call that plays a fictional
// conversation aloud, with invented portraits, the current speaker and
// optional captions, and nothing of TalkQTE in it. It exists so the real
// TalkQTE desktop app can hear a meeting through its application source.
//
// Two ways to run it:
//
//   render  makes one meeting video (picture and 48 kHz sound in one MP4)
//           to play in QuickTime Player. Picture and sound are one file, so
//           they cannot drift apart. For conversations written in full
//           beforehand.
//
//     node scripts/lab-emulator.mjs render [--results <results .json>] \
//       --conversation <id> --out <directory outside the repository> \
//       [--voices-cache <dir>] [--portraits-cache <dir>] [--no-captions]
//
//   live    serves the meeting from this device, to open in its own
//           browser window, playing each line's sound as it starts. Lines
//           can be added while it plays (POST /append), for conversations
//           that react to the app. Every line's start and end is logged
//           with the wall-clock time, to line up with the app's timing log.
//
//     node scripts/lab-emulator.mjs live [--results <results .json>] \
//       --conversation <id> --out <directory outside the repository> \
//       [--port 1445] [--voices-cache <dir>] [--portraits-cache <dir>] \
//       [--no-captions] [--start-delay <seconds, default 3>] [--open]
//
// Without --results it plays one of the bundled fictional conversations.
// It plays only fictional conversations that pass the lab's checks, sends
// nothing anywhere, and makes no speech or images: those come from the
// caches the separate voice and portrait steps fill, or from the device's
// own voices.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { outputDirectory, parseFlags, stamp } from './cue-lab-output.mjs';
import {
  STAGE_HTML,
  addSound,
  duration,
  optimize,
  safe,
  speechEngine,
  stageData,
  synthesize,
} from './cue-sim-record.mjs';
import { IMAGE_MODEL, portraitPlan } from './cue-sim-portraits.mjs';
import { SPEECH_MODEL, voicePlan } from './cue-sim-voices.mjs';
import { SIM_SCHEMA, loadPlayable } from './lab-playable.mjs';
import { loadConversations } from './cue-sim.mjs';

/** The bundled fictional conversations, played without a results file. */
export const BUNDLED = new URL(
  './fixtures/cue-sim-conversations.json',
  import.meta.url,
).pathname;

/** What a meeting can be played from: a results file the lab may play, or,
 * with no file, the bundled conversations themselves. */
async function loadSource(file) {
  if (file) return loadPlayable(file);
  return {
    results: { schema: SIM_SCHEMA, fictional: true },
    // A bundled conversation has no recorded run, so nothing happened in it.
    replays: (await loadConversations()).map((replay) => ({
      ...replay,
      timeline: [],
    })),
    generated: false,
  };
}
import { isMain } from './is-main.mjs';

/** The size of the emulator's window, and of the meeting video. */
export const MEETING_SIZE = { width: 1280, height: 800 };
const RENDER_ORIGIN = 'http://emulator.invalid';
const WORD_MS = 360;

/** The labels every emulated meeting carries, on screen and in its record. */
export function meetingLabels({ sound, portraits }) {
  return [
    'Simulated meeting',
    'Fictional',
    ...(sound === 'tone' ? ['Test tones'] : sound ? ['Synthetic voices'] : []),
    ...(portraits ? ['Synthetic portraits'] : []),
  ];
}

/** Everything a meeting needs before it plays: the conversation, checked;
 * its portraits and voices if the caches hold all of them; and the stage's
 * data, with each line placed where its sound ends. */
export async function prepareMeeting(
  file,
  id,
  { voicesCache, portraitsCache, speech, captions = true, origin, workDir },
) {
  const { results, replays, generated } = await loadSource(file);
  const replay = replays.find((item) => item.id === id);
  if (!replay)
    throw new Error(
      `No conversation "${id}" in that results file. It has: ${replays.map((item) => item.id).join(', ')}.`,
    );
  const portraitFiles = portraitsCache ? portraitPlan(replay) : null;
  const portraits =
    portraitFiles &&
    replay.participants.every(
      (person) =>
        portraitFiles[person.name] &&
        existsSync(join(portraitsCache, portraitFiles[person.name].file)),
    )
      ? portraitFiles
      : null;
  const plan = voicesCache ? voicePlan(replay) : null;
  const cached =
    plan &&
    plan.lines.every((line) => existsSync(join(voicesCache, line.file)));
  const engine =
    speech !== undefined ? speech : cached ? 'cache' : await speechEngine();
  const data = stageData(results, replay, {
    origin,
    view: 'meeting',
    sound: engine,
    portraits,
  });
  data.captions = captions;
  data.timeline = [];
  const audio = engine
    ? await synthesize(data, workDir, engine, { cache: voicesCache, plan })
    : null;
  data.endsAtMs = Math.max(...data.lines.map((line) => line.atMs)) + 2_500;
  return { results, replay, generated, portraits, plan, engine, audio, data };
}

function soundNote(engine) {
  return engine === 'cache'
    ? `Synthetic preset voices from OpenAI text-to-speech (${SPEECH_MODEL}), made beforehand by the separate voice step. No voice was cloned.`
    : engine === 'say'
      ? 'Synthetic voices made on this device with macOS say.'
      : engine === 'tone'
        ? 'Plain test tones, not speech.'
        : 'No sound.';
}

function baseManifest(prepared, file, mode) {
  const { replay, generated, portraits, engine } = prepared;
  return {
    schema: 'talkqte-meeting-emulator/1',
    fictional: true,
    simulated: true,
    mode,
    labels: meetingLabels({ sound: engine, portraits }),
    source: {
      file: basename(file ?? BUNDLED),
      sha256: createHash('sha256')
        .update(readFileSync(file ?? BUNDLED))
        .digest('hex'),
      generated,
      conversation: replay.id,
      title: replay.title,
    },
    size: MEETING_SIZE,
    sound: { engine, note: soundNote(engine) },
    portraits: portraits
      ? {
          note: `Invented portraits from OpenAI image generation (${IMAGE_MODEL}), made beforehand by the separate portrait step. Each was asked for as a person who does not exist.`,
          people: Object.keys(portraits),
        }
      : null,
    note: 'A simulated meeting with fictional people for the real TalkQTE app to hear. Private: not for the repository, README, website or any promotion.',
  };
}

/** Renders the meeting to one video with its sound, for QuickTime Player. */
export async function renderMeeting({
  browser,
  file,
  id,
  directory,
  voicesCache,
  portraitsCache,
  speech,
  captions = true,
  ffmpeg,
}) {
  directory = outputDirectory(directory, {});
  const workDir = mkdtempSync(join(tmpdir(), 'talkqte-meeting-'));
  try {
    const prepared = await prepareMeeting(file, id, {
      voicesCache,
      portraitsCache,
      speech,
      captions,
      origin: RENDER_ORIGIN,
      workDir,
    });
    const { data, audio, portraits } = prepared;
    const context = await browser.newContext({
      viewport: MEETING_SIZE,
      recordVideo: { dir: workDir, size: MEETING_SIZE },
    });
    let videoStartedAt;
    let playStartedAt;
    let video;
    try {
      await context.route(`${RENDER_ORIGIN}/**`, (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/__lab-stage')
          return route.fulfill({
            contentType: 'text/html',
            body: STAGE_HTML(),
          });
        const name = basename(url.pathname);
        const known =
          url.pathname.startsWith('/__lab-portrait/') &&
          portraits &&
          Object.values(portraits).some((portrait) => portrait.file === name);
        return known
          ? route.fulfill({
              contentType: 'image/png',
              body: readFileSync(join(portraitsCache, name)),
            })
          : route.abort();
      });
      const page = await context.newPage();
      videoStartedAt = Date.now();
      video = page.video();
      await page.goto(`${RENDER_ORIGIN}/__lab-stage`);
      await page.evaluate((value) => window.stage.prepare(value), data);
      await page.waitForTimeout(2_500); // The title card.
      playStartedAt = Date.now();
      await page.evaluate(() => window.stage.play());
      await page.waitForTimeout(500);
    } finally {
      await context.close();
    }
    const raw = await video.path();
    const name = `${safe(prepared.replay.id)}-meeting-${stamp()}`;
    const saved = await optimize(raw, join(directory, name), { ffmpeg });
    if (!saved.optimized)
      throw new Error('The meeting video needs ffmpeg to be encoded.');
    const offsetMs = playStartedAt - videoStartedAt;
    const check = audio
      ? await addSound(
          saved.file,
          audio.clips,
          offsetMs,
          offsetMs + data.endsAtMs,
          workDir,
        )
      : null;
    const manifest = {
      ...baseManifest(prepared, file, 'prerendered'),
      video: basename(saved.file),
      bytes: statSync(saved.file).size,
      sound: {
        engine: prepared.engine,
        note: soundNote(prepared.engine),
        voices: audio?.voices ?? null,
        check,
      },
      // Where each line is in the video, to line up with the app's timing
      // log when the video is played from its start.
      timing: {
        conversationStartsAtMs: offsetMs,
        lines: data.lines.map((line) => ({
          lineId: line.id,
          speaker: line.speaker,
          startsAtMs: offsetMs + line.fromMs,
          endsAtMs: offsetMs + line.atMs,
        })),
      },
    };
    writeFileSync(
      join(directory, `${name}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Serves a live meeting on this device. Resolves to the server, its
 * address and the log path; close the server to end it. */
export async function serveMeeting({
  file,
  id,
  directory,
  port = 0,
  voicesCache,
  portraitsCache,
  speech,
  captions = true,
  startDelayMs = 3_000,
}) {
  directory = outputDirectory(directory, {});
  const workDir = mkdtempSync(join(tmpdir(), 'talkqte-meeting-'));
  const server = createServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const prepared = await prepareMeeting(file, id, {
    voicesCache,
    portraitsCache,
    speech,
    captions,
    origin,
    workDir,
  });
  const { data, audio, portraits, replay } = prepared;
  // Only these files are ever served, by name.
  const clips = new Map();
  data.clips = {};
  for (const clip of audio?.clips ?? []) {
    const name = `${safe(clip.lineId)}-${basename(clip.file)}`;
    clips.set(name, clip.file);
    data.clips[clip.lineId] = `/clip/${name}`;
  }
  data.startDelayMs = startDelayMs;
  const name = `${safe(replay.id)}-live-${stamp()}`;
  const logPath = join(directory, `${name}.played.jsonl`);
  const log = (event) => appendFileSync(logPath, `${JSON.stringify(event)}\n`);
  writeFileSync(
    join(directory, `${name}.json`),
    `${JSON.stringify(
      {
        ...baseManifest(prepared, file, 'live'),
        address: `${origin}/?live`,
        played: basename(logPath),
        sound: {
          engine: prepared.engine,
          note: soundNote(prepared.engine),
          voices: audio?.voices ?? null,
        },
      },
      null,
      2,
    )}\n`,
  );
  log({ type: 'served', wallMs: Date.now(), address: `${origin}/?live` });
  const listeners = new Set();
  let started = false;
  const speakers = new Set(replay.participants.map((person) => person.name));
  const plan = voicesCache ? voicePlan(replay) : null;
  const send = (type, value) => {
    for (const response of listeners)
      response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  /** Adds lines to the meeting as it plays. Each is placed after the last
   * line unless it gives its own start; its sound comes from the voice
   * cache when a clip of those words in that voice is there, otherwise it
   * is shown without sound and logged as silent. */
  const append = async (lines) => {
    const added = [];
    for (const input of lines) {
      if (!speakers.has(input.speaker))
        throw new Error(`${input.speaker} is not in this meeting.`);
      if (typeof input.text !== 'string' || !input.text.trim())
        throw new Error('A line needs words.');
      if (input.text.length > 600) throw new Error('A line is too long.');
      const lineId = input.id ?? `x${data.lines.length + added.length + 1}`;
      if ([...data.lines, ...added].some((line) => line.id === lineId))
        throw new Error(`There is already a line ${lineId}.`);
      // The clip a voice step would have made for these words.
      const planned =
        plan &&
        voicePlan({
          ...replay,
          lines: [{ id: lineId, speaker: input.speaker, text: input.text }],
        }).lines[0];
      const clipFile =
        planned && existsSync(join(voicesCache, planned.file))
          ? join(voicesCache, planned.file)
          : null;
      const spokenMs = clipFile
        ? await duration(clipFile)
        : 300 + input.text.split(/\s+/).length * WORD_MS;
      const previous = [...data.lines, ...added].at(-1);
      const fromMs = Number.isFinite(input.startMs)
        ? input.startMs
        : previous.atMs + 400;
      const line = {
        id: lineId,
        speaker: input.speaker,
        text: input.text,
        fromMs,
        atMs: fromMs + spokenMs,
        arrivesAtMs: fromMs + spokenMs,
      };
      if (clipFile) {
        const served = `${safe(lineId)}-${basename(clipFile)}`;
        clips.set(served, clipFile);
        line.clip = `/clip/${served}`;
      }
      added.push(line);
    }
    data.lines.push(...added);
    log({
      type: 'appended',
      wallMs: Date.now(),
      lines: added.map(({ id: lineId, speaker, fromMs, clip }) => ({
        lineId,
        speaker,
        startsAtMs: fromMs,
        sound: Boolean(clip),
      })),
    });
    send('append', added);
    return added;
  };
  const body = (request) =>
    new Promise((resolve, reject) => {
      let text = '';
      request.on('data', (chunk) => {
        text += chunk;
        if (text.length > 64 * 1024) reject(new Error('Too large.'));
      });
      request.on('end', () => {
        try {
          resolve(JSON.parse(text || '{}'));
        } catch {
          reject(new Error('Not JSON.'));
        }
      });
    });
  server.on('request', async (request, response) => {
    const url = new URL(request.url, origin);
    const reply = (status, type, content) => {
      response.writeHead(status, { 'content-type': type });
      response.end(content);
    };
    try {
      if (request.method === 'GET' && url.pathname === '/')
        return reply(200, 'text/html', STAGE_HTML());
      if (request.method === 'GET' && url.pathname === '/data.json')
        return reply(200, 'application/json', JSON.stringify(data));
      if (request.method === 'GET' && url.pathname === '/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        response.write(': connected\n\n');
        listeners.add(response);
        request.on('close', () => listeners.delete(response));
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/clip/')) {
        const path = clips.get(basename(url.pathname));
        return path
          ? reply(
              200,
              path.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
              readFileSync(path),
            )
          : reply(404, 'text/plain', 'Not found.');
      }
      if (
        request.method === 'GET' &&
        url.pathname.startsWith('/__lab-portrait/')
      ) {
        const fileName = basename(url.pathname);
        const known =
          portraits &&
          Object.values(portraits).some((item) => item.file === fileName);
        return known
          ? reply(
              200,
              'image/png',
              readFileSync(join(portraitsCache, fileName)),
            )
          : reply(404, 'text/plain', 'Not found.');
      }
      if (request.method === 'POST' && url.pathname === '/played') {
        const event = await body(request);
        if (event.type === 'start') started = true;
        log(event);
        return reply(204, 'text/plain', '');
      }
      if (request.method === 'POST' && url.pathname === '/append') {
        if (!started)
          return reply(409, 'text/plain', 'The meeting has not started yet.');
        const { lines } = await body(request);
        if (!Array.isArray(lines) || !lines.length)
          return reply(400, 'text/plain', 'Send { "lines": [...] }.');
        const added = await append(lines);
        return reply(
          200,
          'application/json',
          JSON.stringify(
            added.map(({ id: lineId, fromMs, atMs, clip }) => ({
              lineId,
              startsAtMs: fromMs,
              endsAtMs: atMs,
              sound: Boolean(clip),
            })),
          ),
        );
      }
      reply(404, 'text/plain', 'Not found.');
    } catch (error) {
      reply(400, 'text/plain', error.message);
    }
  });
  server.on('close', () => rmSync(workDir, { recursive: true, force: true }));
  return {
    server,
    address: `${origin}/?live`,
    log: logPath,
    manifest: join(directory, `${name}.json`),
  };
}

/** How to open the live meeting as one plain window, with sound allowed to
 * start without a click. */
export function windowCommand(executable, address, profile) {
  return [
    executable,
    [
      `--app=${address}`,
      `--window-size=${MEETING_SIZE.width},${MEETING_SIZE.height}`,
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  ];
}

export async function main(args, { print = console.log } = {}) {
  const [mode, ...rest] = args;
  if (!['render', 'live'].includes(mode))
    throw new Error(
      'Use render or live. See the top of scripts/lab-emulator.mjs.',
    );
  const flags = parseFlags(rest, {
    values: [
      '--results',
      '--conversation',
      '--out',
      '--voices-cache',
      '--portraits-cache',
      '--port',
      '--start-delay',
    ],
    switches: ['--no-captions', '--no-sound', '--open'],
  });
  if (!flags['--conversation'] || !flags['--out'])
    throw new Error(
      'Use --conversation <id> --out <directory outside the repository>, and --results <results .json> for a conversation that is not bundled.',
    );
  const shared = {
    file: flags['--results'],
    id: flags['--conversation'],
    directory: flags['--out'],
    voicesCache: flags['--voices-cache']
      ? outputDirectory(flags['--voices-cache'], {})
      : undefined,
    portraitsCache: flags['--portraits-cache']
      ? outputDirectory(flags['--portraits-cache'], {})
      : undefined,
    captions: !flags['--no-captions'],
    ...(flags['--no-sound'] ? { speech: null } : {}),
  };
  // The run and the conversation are checked before anything is started.
  const { replays } = await loadSource(shared.file);
  if (!replays.some((item) => item.id === shared.id))
    throw new Error(
      `No conversation "${shared.id}" ${shared.file ? 'in that results file' : 'among the bundled ones'}. It has: ${replays.map((item) => item.id).join(', ')}.`,
    );
  // Seconds the live meeting waits after its window opens before the first
  // line, so the app's capture can start first.
  const startDelay = Number(flags['--start-delay'] ?? 3);
  if (mode === 'live') {
    const port = Number(flags['--port'] ?? 1445);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error('--port is a number from 1024 to 65535.');
    if (!Number.isInteger(startDelay) || startDelay < 0 || startDelay > 600)
      throw new Error(
        '--start-delay is a whole number of seconds from 0 to 600.',
      );
  }
  outputDirectory(shared.directory, {});
  const { chromium } = await import('@playwright/test');
  if (mode === 'render') {
    const browser = await chromium.launch();
    try {
      const manifest = await renderMeeting({ ...shared, browser });
      print(
        `saved      ${manifest.video} (${(manifest.bytes / 1e6).toFixed(1)} MB; sound ${manifest.sound.engine ?? 'none'}${manifest.sound.check ? `, check ${manifest.sound.check.passed ? 'passed' : 'FAILED'}` : ''})`,
      );
      print(
        'Open it in QuickTime Player, and select QuickTime Player as the application source in TalkQTE. Nothing else should play in QuickTime Player while it runs.',
      );
      return manifest;
    } finally {
      await browser.close();
    }
  }
  const live = await serveMeeting({
    ...shared,
    port: Number(flags['--port'] ?? 1445),
    startDelayMs: startDelay * 1000,
  });
  const profile = mkdtempSync(join(tmpdir(), 'talkqte-meeting-window-'));
  const [executable, windowArgs] = windowCommand(
    chromium.executablePath(),
    live.address,
    profile,
  );
  print(`Live meeting at ${live.address}`);
  print(`Lines started and ended: ${live.log}`);
  print(
    'Open it as one window, then select "Google Chrome for Testing" as the application source in TalkQTE. Nothing else should play in that browser while it runs.',
  );
  print(`  "${executable}" ${windowArgs.map((arg) => `"${arg}"`).join(' ')}`);
  if (flags['--open'])
    spawn(executable, windowArgs, { stdio: 'ignore', detached: true }).unref();
  print('Press Ctrl-C to end the meeting.');
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  live.server.closeAllConnections?.();
  live.server.close();
  rmSync(profile, { recursive: true, force: true });
  return live;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
