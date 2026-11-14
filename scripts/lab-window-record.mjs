// Records a real-app lab run: only the meeting emulator's window and the
// real TalkQTE companion's window, with the emulator's sound, never the
// whole screen. A labelled bar is added above the picture, and a record
// is written beside the video.
//
//   node scripts/lab-window-record.mjs --meeting <emulator record .json> \
//     --seconds 120 --out <directory outside the repository> \
//     (--app-commit <sha> | --timing-log <TalkQTE timing log .jsonl>) \
//     [--emulator-app "QuickTime Player"] [--emulator-title <text>] \
//     [--cues "app rules"] [--keep-silent]
//
// It needs the Screen & System Audio Recording permission for the app that
// starts it (Terminal, for example). It checks that first, without asking,
// and records nothing if it is not allowed. The capture itself is a small
// ScreenCaptureKit program, scripts/lab-window-capture.swift, built on
// first use with the Xcode command line tools into a temporary folder.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { outputDirectory, parseFlags, stamp } from './cue-lab-output.mjs';
import { safe } from './cue-sim-record.mjs';
import { isMain } from './is-main.mjs';

const run = promisify(execFile);
const SOURCE = new URL('./lab-window-capture.swift', import.meta.url);
/** The longest recording one invocation may make. */
export const MAX_SECONDS = 1_800;
const BAR_HEIGHT = 30; // In points, before the display's scale.

/** The labels a real-app recording carries, on screen and in its record. */
export function windowLabels({ meeting, appCommit, cues }) {
  return [
    ...meeting.labels,
    meeting.mode === 'live' ? 'Live meeting' : 'Pre-rendered meeting',
    `Real TalkQTE app ${appCommit.slice(0, 7)}`,
    `cues: ${cues}`,
  ];
}

/** The app's commit from its timing log's first session start, if the log
 * records one. */
export function commitFromLog(text) {
  for (const line of text.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event.event === 'session' &&
      event.state === 'started' &&
      /^[0-9a-f]{7,40}$/.test(event.commit ?? '')
    )
      return event.commit;
  }
  return null;
}

/** Builds the capture program once per version of its source. */
export async function ensureHelper() {
  const source = readFileSync(SOURCE);
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const directory = join(tmpdir(), 'talkqte-lab-window-capture', hash);
  const binary = join(directory, 'lab-window-capture');
  if (existsSync(binary)) return binary;
  // Built under its own name and moved into place, so two builds at once
  // never leave half a program behind.
  const building = `${binary}.${process.pid}`;
  mkdirSync(join(directory, 'module-cache'), { recursive: true });
  try {
    await run(
      'swiftc',
      [
        '-O',
        '-parse-as-library',
        '-swift-version',
        '5',
        '-module-cache-path',
        join(directory, 'module-cache'),
        '-o',
        building,
        SOURCE.pathname,
        '-framework',
        'ScreenCaptureKit',
        '-framework',
        'AVFoundation',
        '-framework',
        'CoreMedia',
        '-framework',
        'CoreGraphics',
      ],
      {
        env: {
          ...process.env,
          CLANG_MODULE_CACHE_PATH: join(directory, 'module-cache'),
        },
      },
    );
  } catch {
    throw new Error(
      'Could not build the window capture program. It needs macOS 14 or later and the Xcode command line tools (xcode-select --install).',
    );
  }
  renameSync(building, binary);
  return binary;
}

const events = (stdout) =>
  stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** The bar's size in pixels for a picture of this width and scale: as wide
 * as the picture, and an even height for H.264. */
export function barSize({ width, scale }) {
  return {
    width: Math.round(width / 2) * 2,
    height: Math.round((BAR_HEIGHT * scale) / 2) * 2,
  };
}

/** Draws the label bar as an image at the picture's width and scale. */
export async function labelBar(browser, labels, { width, scale }) {
  const page = await browser.newPage({
    viewport: { width: Math.round(width / scale), height: BAR_HEIGHT },
    deviceScaleFactor: scale,
  });
  try {
    await page.setContent(`<!doctype html><html><body style="margin:0">
      <div role="note" aria-label="Recording label" style="height:${BAR_HEIGHT}px;display:flex;align-items:center;gap:8px;padding:0 10px;background:#f3c94b;font:600 11px system-ui,-apple-system,sans-serif;color:#1c1500;overflow:hidden;white-space:nowrap"></div>
    </body></html>`);
    await page.evaluate((items) => {
      const bar = document.querySelector('[role=note]');
      for (const text of items) {
        const tag = document.createElement('span');
        tag.textContent = text;
        tag.style.cssText =
          'background:#1c1500;color:#f3c94b;border-radius:4px;padding:2px 7px;text-transform:uppercase;letter-spacing:.05em';
        bar.append(tag);
      }
      // Every label must show: the text shrinks until the bar fits.
      for (let size = 11; bar.scrollWidth > bar.clientWidth && size > 6; size--)
        bar.style.fontSize = `${size - 1}px`;
    }, labels);
    return await page.screenshot({ type: 'png' });
  } finally {
    await page.close();
  }
}

/** Puts the bar above the recorded picture, never over it, and encodes the
 * result as a compact MP4 with the recorded sound. */
export async function burnLabels(raw, bar, target, { width, height }) {
  const barFile = `${target}.bar.png`;
  writeFileSync(barFile, bar);
  try {
    await run('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      raw,
      '-i',
      barFile,
      '-filter_complex',
      // The picture at an even size, room above it for the bar, and the
      // bar in that room: nothing of the picture is covered.
      `[0:v]scale=${width}:trunc(ih*${width}/iw/2)*2,pad=iw:ih+${height}:0:${height}:color=0x1c1500[p];[1:v]scale=${width}:${height}[b];[p][b]overlay=0:0[v]`,
      '-map',
      '[v]',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      `${target}.mp4`,
    ]);
  } finally {
    rmSync(barFile, { force: true });
  }
  return `${target}.mp4`;
}

export async function main(
  args,
  { print = console.log, helper = ensureHelper } = {},
) {
  const flags = parseFlags(args, {
    values: [
      '--meeting',
      '--seconds',
      '--out',
      '--app-commit',
      '--timing-log',
      '--emulator-app',
      '--emulator-title',
      '--cues',
    ],
    switches: ['--keep-silent'],
  });
  // Everything that can refuse does so before anything is built or run.
  if (!flags['--meeting'] || !flags['--seconds'] || !flags['--out'])
    throw new Error(
      'Use --meeting <emulator record .json> --seconds <n> --out <directory outside the repository>, with --app-commit <sha> or --timing-log <file>.',
    );
  const seconds = Number(flags['--seconds']);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS)
    throw new Error(`--seconds is a whole number from 1 to ${MAX_SECONDS}.`);
  let meeting;
  try {
    meeting = JSON.parse(readFileSync(flags['--meeting'], 'utf8'));
  } catch {
    throw new Error('That emulator record cannot be read.');
  }
  if (
    meeting.schema !== 'talkqte-meeting-emulator/1' ||
    meeting.fictional !== true
  )
    throw new Error(
      'Only a fictional meeting from the lab emulator can be recorded.',
    );
  const appCommit =
    flags['--app-commit'] ??
    (flags['--timing-log']
      ? commitFromLog(readFileSync(flags['--timing-log'], 'utf8'))
      : null);
  if (!/^[0-9a-f]{7,40}$/.test(appCommit ?? ''))
    throw new Error(
      "Say which TalkQTE the recording shows: --app-commit <sha>, or --timing-log <file> from a build that records its commit. The recording's label names it.",
    );
  const cues = flags['--cues'] ?? 'app rules';
  if (!/^(app rules|model:[a-z0-9.-]+)$/.test(cues))
    throw new Error('--cues is "app rules" or "model:<model id>".');
  const directory = outputDirectory(flags['--out'], {});

  const binary = await helper();
  const check = events((await run(binary, ['--check'])).stdout)[0];
  if (!check?.screenRecording)
    throw new Error(
      'Screen & System Audio Recording is not allowed for the app this runs in. Allow it in System Settings, Privacy & Security, restart that app, and run this again. Nothing was recorded.',
    );

  const work = mkdtempSync(join(tmpdir(), 'talkqte-window-take-'));
  const raw = join(work, 'raw.mov');
  const name = `${safe(meeting.source.conversation)}-real-app-${stamp()}`;
  try {
    let output;
    try {
      output = await run(
        binary,
        [
          '--capture',
          '--emulator-app',
          flags['--emulator-app'] ??
            (meeting.mode === 'live'
              ? 'Google Chrome for Testing'
              : 'QuickTime Player'),
          ...(flags['--emulator-title']
            ? ['--emulator-title', flags['--emulator-title']]
            : []),
          '--companion-app',
          'TalkQTE',
          '--companion-title',
          'TalkQTE companion',
          '--seconds',
          String(seconds),
          '--out',
          raw,
        ],
        { timeout: (seconds + 60) * 1000, maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      const reason = events(error.stdout ?? '').find(
        (event) => event.event === 'error',
      );
      throw new Error(
        `Nothing was kept: ${reason?.message ?? 'the capture program failed.'}`,
      );
    }
    const log = events(output.stdout);
    const matched = log.find((event) => event.event === 'matched');
    const started = log.find((event) => event.event === 'started');
    const stopped = log.find((event) => event.event === 'stopped');
    if (!stopped || stopped.frames === 0)
      throw new Error('Nothing was kept: no picture was recorded.');
    if (stopped.audioBuffers === 0 && !flags['--keep-silent'])
      throw new Error(
        'Nothing was kept: no sound was recorded from the emulator. If it is a browser, its sound may come from a helper process the capture does not follow; use the pre-rendered meeting in QuickTime Player, or --keep-silent to keep a silent take.',
      );
    const labels = windowLabels({ meeting, appCommit, cues });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    let file;
    try {
      const bar = await labelBar(browser, labels, matched.picture);
      file = await burnLabels(
        raw,
        bar,
        join(directory, name),
        barSize(matched.picture),
      );
    } finally {
      await browser.close();
    }
    const record = {
      schema: 'talkqte-real-app-recording/1',
      fictional: true,
      simulated: true,
      labels,
      mode: meeting.mode,
      app: { commit: appCommit, cues },
      meeting: {
        record: basename(flags['--meeting']),
        conversation: meeting.source.conversation,
        sourceSha256: meeting.source.sha256,
      },
      capture: {
        windows: { emulator: matched.emulator, companion: matched.companion },
        picture: matched.picture,
        startedWallMs: started?.wallMs ?? null,
        stoppedWallMs: stopped.wallMs,
        frames: stopped.frames,
        soundBuffers: stopped.audioBuffers,
        note: 'Only these two windows were recorded, with the emulator app’s sound. Nothing else on the screen was captured.',
      },
      timingLog: flags['--timing-log'] ? basename(flags['--timing-log']) : null,
      video: basename(file),
      bytes: statSync(file).size,
      note: 'A simulated meeting with fictional people, heard and answered by the real TalkQTE app. Private: not for the repository, README, website or any promotion.',
    };
    writeFileSync(
      join(directory, `${name}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    print(
      `saved      ${record.video} (${(record.bytes / 1e6).toFixed(1)} MB, ${stopped.frames} frames, ${stopped.audioBuffers ? 'with sound' : 'SILENT'}); companion matched by ${matched.companion.rule}`,
    );
    return record;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
