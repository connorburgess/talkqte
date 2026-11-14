// Records a real-app lab run: only the meeting emulator's window and the
// real TalkQTE companion's window, with the emulator's sound, never the
// whole screen. A labelled bar is added above the picture, and a record
// is written beside the video.
//
//   node scripts/lab-window-record.mjs --meeting <emulator record .json> \
//     --seconds 120 --out <directory outside the repository> \
//     (--app-commit <sha> | --timing-log <TalkQTE timing log .jsonl>) \
//     [--emulator-app "QuickTime Player"] [--emulator-title <text>] \
//     [--keep-silent]
//
// Where the cues came from is read from the app's timing log, never assumed:
// without a log the label says "cues: unknown".
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
import { basename, dirname, join } from 'node:path';
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
  // `cues` is the label cuesFromLog worked out, such as "cues: unknown".
  return [
    ...meeting.labels,
    meeting.mode === 'live' ? 'Live meeting' : 'Pre-rendered meeting',
    `Real TalkQTE app ${appCommit.slice(0, 7)}`,
    cues,
  ];
}

const DECIDERS = { phrase_rule: 'phrase rules', model: 'model' };

/** Where the app's cues came from in this run, from its timing log: each
 * `cue_decision` names its `decider` ("phrase_rule" or "model"); a log
 * written before that field existed says `source` instead, where
 * "evaluated" means a model and anything else the phrase rules. The model
 * and effort come from the latest `evaluator` event that names a model.
 * Nothing is guessed: no log gives "cues: unknown". */
export function cuesFromLog(text) {
  if (typeof text !== 'string')
    return {
      label: 'cues: unknown',
      decisions: null,
      model: null,
      effort: null,
    };
  const decisions = { phrase_rule: 0, model: 0, unknown: 0 };
  let model = null;
  let effort = null;
  for (const line of text.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.event === 'evaluator' && typeof event.model === 'string') {
      model = event.model;
      effort = typeof event.effort === 'string' ? event.effort : null;
    }
    if (event.event !== 'cue_decision') continue;
    const decider =
      event.decider ??
      (typeof event.source === 'string'
        ? event.source === 'evaluated'
          ? 'model'
          : 'phrase_rule'
        : null);
    decisions[Object.hasOwn(DECIDERS, decider) ? decider : 'unknown']++;
  }
  const modelPart = model
    ? `model, ${model}${effort ? `, ${effort} effort` : ''}`
    : 'model (not named in the log)';
  const kinds = [
    ...(decisions.phrase_rule ? ['phrase rules'] : []),
    ...(decisions.model ? [modelPart] : []),
    ...(decisions.unknown ? ['unknown'] : []),
  ];
  const label = kinds.length
    ? `cues: ${kinds.join(' and ')}`
    : model
      ? `cues: ${modelPart}, none shown`
      : 'cues: none shown';
  return { label, decisions, model, effort };
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

/** Goes through everything a recording needs, except recording: the
 * meeting record and its video, where the take would go and for how long,
 * which app commit and cues it would be labelled with, the capture program,
 * the permission, and (with the permission) whether the two windows can be
 * found. Nothing is captured. Resolves to the steps and whether all are
 * ready. */
async function dryRun({ flags, meeting, appCommit, seconds, helper, print }) {
  const steps = [];
  const step = (ok, text) => steps.push({ ok, text });
  const emulatorApp =
    flags['--emulator-app'] ??
    (meeting.mode === 'live'
      ? 'Google Chrome for Testing'
      : 'QuickTime Player');
  const video = meeting.video
    ? join(dirname(flags['--meeting']), meeting.video)
    : null;
  step(
    meeting.mode === 'live' || (video && existsSync(video)),
    meeting.mode === 'live'
      ? `Meeting: live "${meeting.source.conversation}"; open its window before recording.`
      : `Meeting: "${meeting.source.conversation}", ${video && existsSync(video) ? video : 'its video is missing beside the record'}. Open it in ${emulatorApp}, paused at the start.`,
  );
  step(true, `Recording length: ${seconds} s.`);
  let directory = null;
  try {
    directory = outputDirectory(flags['--out'], {});
    step(true, `Takes go to ${directory}.`);
  } catch (error) {
    step(false, error.message);
  }
  if (/^[0-9a-f]{7,40}$/.test(appCommit ?? ''))
    step(
      true,
      `TalkQTE commit: ${appCommit.slice(0, 7)} (${flags['--app-commit'] ? 'given' : 'from the timing log'}).`,
    );
  else if (flags['--timing-log'])
    step(
      false,
      existsSync(flags['--timing-log'])
        ? 'TalkQTE commit: the timing log has no session line with a commit yet. Start the session from QuickTime Player first, from a build made with TALKQTE_COMMIT set.'
        : 'TalkQTE commit: the timing log does not exist yet. Launch TalkQTE with TALKQTE_TIMING_LOG set to that file.',
    );
  else
    step(
      false,
      'TalkQTE commit: give --timing-log <file> or --app-commit <sha>.',
    );
  const log =
    flags['--timing-log'] && existsSync(flags['--timing-log'])
      ? readFileSync(flags['--timing-log'], 'utf8')
      : undefined;
  step(
    true,
    `Cues label so far: "${cuesFromLog(log).label}" (read again from the log when the take ends).`,
  );
  let binary = null;
  try {
    binary = await helper();
    step(true, 'Window capture program: built.');
  } catch (error) {
    step(false, `Window capture program: ${error.message}`);
  }
  if (binary) {
    const check = events((await run(binary, ['--check'])).stdout)[0];
    step(
      Boolean(check?.screenRecording),
      check?.screenRecording
        ? 'Screen & System Audio Recording: allowed for the app this runs in.'
        : 'Screen & System Audio Recording: not allowed for the app this runs in (for example Terminal). Allow it in System Settings, Privacy & Security, then restart that app. TalkQTE needs the same permission separately for its own capture.',
    );
    if (check?.screenRecording) {
      const windows = events(
        (await run(binary, ['--list', '--apps', `${emulatorApp},TalkQTE`]))
          .stdout,
      ).filter((event) => event.event === 'window' && event.onScreen);
      const emulator = windows.filter((window) => window.app === emulatorApp);
      const talkqte = windows.filter((window) => window.app === 'TalkQTE');
      step(
        emulator.length > 0,
        emulator.length
          ? `${emulatorApp}: ${emulator.length} window on screen.`
          : `${emulatorApp}: no window on screen. Open the meeting in it.`,
      );
      const byTitle = talkqte.some(
        (window) => window.title === 'TalkQTE companion',
      );
      step(
        talkqte.length > 0,
        byTitle
          ? 'TalkQTE companion: found by its title.'
          : talkqte.length
            ? 'TalkQTE companion: its title is not visible; the smallest TalkQTE window would be used. Check that is the companion.'
            : 'TalkQTE companion: no TalkQTE window on screen. Open TalkQTE and show the companion.',
      );
    } else
      step(
        false,
        'Windows: not checked, because the permission is not allowed yet.',
      );
  }
  const ready = steps.every((item) => item.ok);
  for (const item of steps)
    print(`${item.ok ? 'ready' : 'to do'}  ${item.text}`);
  print(
    ready
      ? 'Everything a recording needs is in place. Nothing was recorded.'
      : 'Not ready yet. Nothing was recorded.',
  );
  return { dryRun: true, ready, steps };
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
    ],
    switches: ['--keep-silent', '--dry-run'],
  });
  // Everything that can refuse does so before anything is built or run.
  if (!flags['--meeting'] || !flags['--out'])
    throw new Error(
      'Use --meeting <emulator record .json> --out <directory outside the repository>, with --app-commit <sha> or --timing-log <file>.',
    );
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
  // How long to record: as asked, or the pre-rendered meeting's length with
  // a little room either side.
  const lastLine = meeting.timing?.lines?.at(-1)?.endsAtMs;
  const seconds = flags['--seconds']
    ? Number(flags['--seconds'])
    : Number.isFinite(lastLine)
      ? Math.ceil(lastLine / 1000) + 15
      : NaN;
  if (!flags['--seconds'] && !Number.isFinite(seconds))
    throw new Error(
      'Use --seconds <n>: this meeting record does not say how long it lasts.',
    );
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS)
    throw new Error(`--seconds is a whole number from 1 to ${MAX_SECONDS}.`);
  const appCommit =
    flags['--app-commit'] ??
    (flags['--timing-log']
      ? existsSync(flags['--timing-log'])
        ? commitFromLog(readFileSync(flags['--timing-log'], 'utf8'))
        : null
      : null);
  if (flags['--dry-run'])
    return dryRun({ flags, meeting, appCommit, seconds, helper, print });
  if (!/^[0-9a-f]{7,40}$/.test(appCommit ?? ''))
    throw new Error(
      "Say which TalkQTE the recording shows: --app-commit <sha>, or --timing-log <file> from a build that records its commit. The recording's label names it.",
    );
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
    // Read after the run, so the log holds this run's decisions.
    const cues = cuesFromLog(
      flags['--timing-log']
        ? readFileSync(flags['--timing-log'], 'utf8')
        : undefined,
    );
    const labels = windowLabels({ meeting, appCommit, cues: cues.label });
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
      app: {
        commit: appCommit,
        cues: {
          ...cues,
          from: flags['--timing-log'] ? 'timing log' : 'no timing log given',
        },
      },
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
