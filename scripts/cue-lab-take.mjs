// One prepared, model-enabled lab take plan (docs/lab-take-runbook.md).
//
// Without --execute it is a dry run: it reads the plan, the two build
// receipts, the recorder helper and the media, and checks them with the
// same option checks the take modules apply. It launches nothing, reads no
// key file, mints no token, runs no codesign and makes no network request.
// It prints what a take of this plan would launch, send and spend, and the
// plan's sha256.
//
// With --execute --confirm <plan sha256> it runs that dry run first, then
// one attempt of the plan within the owner's decisions of 23 November 2026
// (OWNER_TAKE_SCOPE): one attempt per plan sha256, recorded by an
// exclusive marker before anything is launched or any key file is read.
// It composes only the existing modules, in the runbook's order, and adds
// no capability, fallback, retry, model or budget. The in-app approval
// stays the only consent for sending audio and text; the terminal
// confirmation only starts the attempt. It claims nothing: it writes the
// evidence report and prints its path and the take's terminal state.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { outsideCheckout } from './cue-lab-checkout.mjs';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import {
  assertLabLaunchOptions,
  assertLabTranscriptionRoute,
  prepareLabLauncher,
  removeStaleTranscriptionTokens,
  validateLabBuildRecord,
  verifyLabBuild,
} from './cue-lab-launcher.mjs';
import {
  createLabPlayer,
  hashLabOwnedFile,
  LAB_PLAYER_RUNTIME,
  validateLabPlayerBuildRecord,
  verifyLabPlayerBuild,
} from './cue-lab-player.mjs';
import { fixedLabMedia, loadLabMediaManifest } from './cue-lab-media.mjs';
import {
  API_STOP_AFTER_S,
  APPROVAL_BUDGET_MS,
  assertFixedModelTakeOptions,
  createFixedModelTake,
} from './cue-lab-prepared-take.mjs';
import { createLabSourceV1 } from './cue-lab-source-v1.mjs';
import { createLabOwnedWindowSelector } from './cue-lab-window-selection.mjs';
import { createLabRecorder } from './cue-lab-recorder.mjs';
import { createLabEvidenceWriter } from './cue-lab-evidence-writer.mjs';
import { snapshotLabTiming } from './cue-lab-timing-snapshot.mjs';
import { writeEvidenceReport } from './cue-lab-evidence-report.mjs';
import {
  LAB_REFUSED_ENVIRONMENT,
  refusedEnvironment,
} from './cue-lab-key-file.mjs';
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_KEY_FILE,
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_SPEND_CAP_MICRO_USD,
  anthropicEnvironmentNames,
} from './cue-lab-anthropic-core.mjs';
import {
  DEEPGRAM_APP_QUERY,
  DEEPGRAM_GRANT_TTL_S,
  DEEPGRAM_GRANT_URL,
  DEEPGRAM_KEY_FILE,
  REFUSED_TOKEN_PROBE,
  mintDeepgramGrant,
} from './cue-lab-deepgram.mjs';

export const TAKE_PLAN_SCHEMA = 'talkqte.lab.take-plan.v1';
// The fixed take's own timing (cue-lab-prepared-take.mjs): the take clock
// restarts at approval with 135 s.
const TAKE_MS = 135000;
const PLAN_MAX_BYTES = 16384;
const HELPER_MAX_BYTES = 64 * 1024 * 1024;
const REQUIRED = [
  'schema',
  'runId',
  'fictional',
  'native',
  'player',
  'helper',
  'media',
  'selection',
  'transcription',
  'evidenceDirectory',
];
const OPTIONAL = ['tailMs', 'turnOffAfterMs', 'userName', 'contextPolicy'];

export class TakePlanRefused extends Error {
  constructor(step, detail) {
    super(
      `Plan refused at ${step}${detail ? `: ${detail}` : ''}. Nothing was launched.`,
    );
    this.category = 'plan-refused';
    this.step = step;
  }
}

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) =>
  object(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const hex = (v, n) =>
  typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ensure = (ok) => {
  if (!ok) throw new Error('check failed');
};

// Runs one check under a fixed label, so a refusal says which part of the
// plan failed. A refusal that carries its own reason keeps it.
function step(label, fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof TakePlanRefused) throw error;
    throw new TakePlanRefused(
      label,
      error?.category === 'no-transcription' ? error.message : undefined,
    );
  }
}

// A private file outside the checkout: owned by this user, not readable or
// writable by anyone else, canonical, regular, bounded, read once and
// checked unchanged while reading.
function readPrivateFile(path, { max, mode }) {
  ensure(
    typeof path === 'string' &&
      isAbsolute(path) &&
      realpathSync(path) === path &&
      outsideCheckout(path),
  );
  const info = lstatSync(path);
  ensure(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid?.() &&
      (mode === undefined
        ? (info.mode & 0o077) === 0
        : (info.mode & 0o777) === mode) &&
      info.size > 0 &&
      info.size <= max,
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(max + 1);
    const got = readSync(fd, buffer, 0, buffer.length, 0);
    const after = fstatSync(fd);
    ensure(
      got === info.size &&
        after.ino === info.ino &&
        after.size === info.size &&
        after.mtimeMs === info.mtimeMs,
    );
    const bytes = buffer.subarray(0, got);
    return {
      bytes,
      sha256: sha256(bytes),
      value: parseUniqueLabJson(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ),
    };
  } finally {
    closeSync(fd);
  }
}

// Stands in for the Deepgram grant while the launch options are checked.
// The real grant is minted from the key file only when a take runs; this
// one can never write a token.
const PLANNED_GRANT = Object.freeze({
  writeTokenFile() {
    throw new Error('A dry-run plan holds no transcription token.');
  },
});

/**
 * Checks the plan at `planPath` without launching anything and returns what
 * a take of it would launch, send and spend. Throws TakePlanRefused naming
 * the failed step.
 */
export function checkTakePlan(planPath, options) {
  return inspectTakePlan(planPath, options).summary;
}

// The dry run itself. Besides the summary it keeps what an attempt needs:
// the plan as read (the bytes the sha256 is of), the approved media
// descriptor from the media loader, and the native receipt.
function inspectTakePlan(planPath, { environment = process.env } = {}) {
  const plan = step('plan file', () =>
    readPrivateFile(planPath, { max: PLAN_MAX_BYTES }),
  );
  const p = plan.value;
  step('plan fields', () =>
    ensure(
      object(p) &&
        REQUIRED.every((k) => Object.hasOwn(p, k)) &&
        Object.keys(p).every(
          (k) => REQUIRED.includes(k) || OPTIONAL.includes(k),
        ) &&
        p.schema === TAKE_PLAN_SCHEMA &&
        p.fictional === true &&
        typeof p.runId === 'string' &&
        /^[A-Za-z0-9_-]{1,64}$/.test(p.runId),
    ),
  );
  step('environment', () =>
    // What the API route and the Deepgram grant refuse in this process's
    // own environment, whatever environment a runner passes on: TLS, proxy
    // and code-loading settings, and any ANTHROPIC_* name, even empty.
    ensure(
      !refusedEnvironment(environment) &&
        anthropicEnvironmentNames(environment).length === 0,
    ),
  );
  const native = step('native build receipt', () => {
    ensure(exact(p.native, ['manifestFile', 'approved']));
    const receipt = readPrivateFile(p.native.manifestFile, {
      max: 16384,
      mode: 0o600,
    });
    return validateLabBuildRecord(
      receipt.value,
      p.native.approved,
      receipt.sha256,
    );
  });
  const player = step('player build receipt', () => {
    ensure(exact(p.player, ['manifestFile', 'approved']));
    const receipt = readPrivateFile(p.player.manifestFile, {
      max: 16384,
      mode: 0o600,
    });
    ensure(receipt.sha256 === p.player.approved?.manifestSha256);
    return validateLabPlayerBuildRecord(receipt.value, p.player.approved);
  });
  step('recorder helper', () =>
    ensure(
      exact(p.helper, ['path', 'sha256']) &&
        hex(p.helper.sha256, 64) &&
        typeof p.helper.path === 'string' &&
        isAbsolute(p.helper.path) &&
        realpathSync(p.helper.path) === p.helper.path &&
        outsideCheckout(p.helper.path) &&
        hashLabOwnedFile(p.helper.path, HELPER_MAX_BYTES) === p.helper.sha256,
    ),
  );
  const media = step('media', () =>
    exact(p.media, ['fixedPath'])
      ? fixedLabMedia(p.media.fixedPath)
      : (ensure(exact(p.media, ['manifestFile', 'sha256'])),
        loadLabMediaManifest(p.media.manifestFile, { sha256: p.media.sha256 })),
  );
  const probe = p.transcription?.failureProbe === REFUSED_TOKEN_PROBE;
  // The plan names no grant: the take mints it from the key file (or uses
  // the probe's fixed text) only when it runs.
  const transcription = object(p.transcription)
    ? Object.hasOwn(p.transcription, 'failureProbe')
      ? p.transcription
      : { ...p.transcription, grant: PLANNED_GRANT }
    : p.transcription;
  step('launch options', () => {
    ensure(
      !object(p.transcription) || !Object.hasOwn(p.transcription, 'grant'),
    );
    assertLabTranscriptionRoute({
      mode: 'model-enabled',
      selection: p.selection,
      transcription: p.transcription,
    });
    assertLabLaunchOptions({
      mode: 'model-enabled',
      selection: p.selection,
      sourceApplication: 'TalkQTE Lab Player',
      stopAfterS: API_STOP_AFTER_S,
      transcription,
      userName: p.userName,
      contextPolicy: p.contextPolicy,
      turnOff: p.turnOffAfterMs === undefined ? undefined : true,
    });
  });
  step('take options', () =>
    assertFixedModelTakeOptions({
      settings: p.selection,
      stopAfterS: API_STOP_AFTER_S,
      approvalBudgetMs: APPROVAL_BUDGET_MS,
      takeMs: TAKE_MS,
      tailMs: p.tailMs,
      turnOffAfterMs: p.turnOffAfterMs,
      media,
    }),
  );
  step('evidence directory', () => {
    const dir = p.evidenceDirectory;
    ensure(
      typeof dir === 'string' &&
        isAbsolute(dir) &&
        realpathSync(dir) === dir &&
        outsideCheckout(dir),
    );
    const info = lstatSync(dir);
    ensure(
      info.isDirectory() &&
        (info.mode & 0o777) === 0o700 &&
        info.uid === process.getuid?.(),
    );
  });
  const { model, maxCalls } = p.selection;
  const spendCapMicroUsd = ANTHROPIC_SPEND_CAP_MICRO_USD[model];
  const summary = Object.freeze({
    schema: TAKE_PLAN_SCHEMA,
    planSha256: plan.sha256,
    runId: p.runId,
    kind: probe
      ? 'provider-failure'
      : p.turnOffAfterMs !== undefined
        ? 'turn-off'
        : 'prepared',
    launch: {
      app: {
        executable: native.executable,
        commit: native.commit,
        features: [...native.features].sort(),
        signature: native.signature.identifier,
      },
      player: {
        executable: player.executable,
        commit: player.commit,
        signature: player.signature.identifier,
      },
      helper: { path: p.helper.path, sha256: p.helper.sha256 },
      media: {
        path: media.path,
        sha256: media.sha256,
        durationMs: media.durationMs,
        scenarioId: media.scenarioId,
      },
      evidenceDirectory: p.evidenceDirectory,
    },
    timing: {
      approvalBudgetMs: APPROVAL_BUDGET_MS,
      nativeStopAfterS: API_STOP_AFTER_S,
      takeMsAfterApproval: TAKE_MS,
      tailMs: p.tailMs ?? 0,
      turnOffAfterMs: p.turnOffAfterMs ?? null,
    },
    send: {
      deepgram: probe
        ? {
            what: 'the fixed refused-token text in place of a token; Deepgram is expected to refuse it (401, code auth)',
            keyFile: null,
            minuteCap: p.transcription.minuteCap,
          }
        : {
            what: "the lab player's application audio, only after Enable for this session",
            query: DEEPGRAM_APP_QUERY,
            grant: `${DEEPGRAM_GRANT_URL} once before launch, ${DEEPGRAM_GRANT_TTL_S} s token`,
            keyFile: DEEPGRAM_KEY_FILE,
            keyFileReadAt: 'before launch, to mint the token',
            minuteCap: p.transcription.minuteCap,
            reconnect: p.transcription.reconnect === true,
          },
      anthropic: {
        what: 'one cue evaluation per request: recent fictional transcript lines (at most 32), any cue on screen, earlier cue texts and the user name if set',
        endpoint: ANTHROPIC_BASE_URL,
        model,
        effort: p.selection.effort,
        maxTokens: ANTHROPIC_MAX_TOKENS,
        maxRequests: maxCalls,
        contextPolicy: p.contextPolicy ?? 'fresh-only',
        userName: p.userName ?? null,
        keyFile: ANTHROPIC_KEY_FILE,
        keyFileReadAt: 'after the in-app approval',
      },
    },
    spend: {
      anthropicLocalEstimateCapUsd: spendCapMicroUsd / 1e6,
      anthropicNote:
        'local estimated-spend guard checked before each request; not a guarantee of the provider bill',
      deepgramMinutesAtMost: probe ? 0 : p.transcription.minuteCap,
      deepgramNote: probe
        ? 'no token is minted; the refused stream is not expected to bill'
        : 'the code computes no Deepgram cost',
    },
    refusedEnvironment: [...LAB_REFUSED_ENVIRONMENT, 'ANTHROPIC_*'],
  });
  return { summary, plan: p, media, native };
}

export function renderTakePlan(s, { execute = false } = {}) {
  const d = s.send.deepgram,
    a = s.send.anthropic;
  return [
    execute
      ? `Plan valid. Checking this attempt before anything is launched.`
      : `Plan valid (dry run). Nothing was launched, no key file was read.`,
    `plan sha256: ${s.planSha256}`,
    `run id: ${s.runId}  kind: ${s.kind}`,
    ``,
    `Would launch:`,
    `  TalkQTE   ${s.launch.app.executable}`,
    `            commit ${s.launch.app.commit}, features ${s.launch.app.features.join(', ')}`,
    `  player    ${s.launch.player.executable} (commit ${s.launch.player.commit})`,
    `  recorder  ${s.launch.helper.path}`,
    `  media     ${s.launch.media.path}`,
    `            ${s.launch.media.durationMs} ms, sha256 ${s.launch.media.sha256}, ${s.launch.media.scenarioId}`,
    `  evidence  ${s.launch.evidenceDirectory}`,
    ``,
    `Timing: in-app approval within ${s.timing.approvalBudgetMs / 1000} s of Listening; native Stop at ${s.timing.nativeStopAfterS} s; take ${s.timing.takeMsAfterApproval / 1000} s after approval; tail ${s.timing.tailMs} ms` +
      (s.timing.turnOffAfterMs === null
        ? ''
        : `; turn processing off ${s.timing.turnOffAfterMs} ms after render start`),
    ``,
    `Would send:`,
    `  Deepgram: ${d.what}; at most ${d.minuteCap} min` +
      (d.keyFile
        ? `; key file ${d.keyFile} read ${d.keyFileReadAt}; ${d.grant}${d.reconnect ? '; token kept for reconnect until Stop' : ''}`
        : '; no key file read'),
    `  Anthropic: ${a.what}; ${a.endpoint}, ${a.model}, effort ${a.effort}, at most ${a.maxRequests} requests, max_tokens ${a.maxTokens}, context ${a.contextPolicy}${a.userName ? `, user name "${a.userName}"` : ''}; key file ${a.keyFile} read ${a.keyFileReadAt}`,
    ``,
    `Would spend: Anthropic local estimate capped at $${s.spend.anthropicLocalEstimateCapUsd.toFixed(2)} (${s.spend.anthropicNote}); Deepgram at most ${s.spend.deepgramMinutesAtMost} min (${s.spend.deepgramNote}).`,
    ...(execute
      ? []
      : [
          ``,
          `To run this plan once (docs/lab-take-runbook.md): npm run lab:take -- --plan <this plan> --execute --confirm ${s.planSha256}`,
        ]),
  ].join('\n');
}

// The owner's decisions of 23 November 2026 for executing a plan: the
// fixed fictional meeting, claude-opus-5-5 (the code's fixed 40 calls and
// $1.00 local estimate) and a Deepgram minute cap of 5. The dry run still
// checks any plan the modules accept; an attempt runs only within these.
export const OWNER_TAKE_SCOPE = Object.freeze({
  model: 'claude-opus-5-5',
  minuteCap: 5,
  fixedMediaOnly: true,
});
// Refuse to start below this much free space on the evidence volume.
export const DISK_FLOOR_BYTES = 5 * 1024 ** 3;
// Values the modules leave open, fixed here and stated in the runbook
// ("Runner settings"). The recorder runs for at most 180 s, its maximum,
// so it outlasts the take's 135 s after approval plus native release; the
// take stops it earlier. The player start and recorder startup deadlines
// are the ones the take's own budgets allow (1 s and 3 s). The provider
// deadline is the one the fixed-take tests use. The window selector looks
// for the bundle's product name, TalkQTE.
export const RUNNER_SETTINGS = Object.freeze({
  recorderSeconds: 180,
  recorderStartupMs: 3000,
  playerStartMs: 1000,
  providerDeadlineMs: 30000,
  nativeApplication: 'TalkQTE',
});
// The only names the runner passes on to the launcher and the provider;
// both forward no others to their children.
const RUNNER_ENVIRONMENT = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'];
const ATTEMPT_SCHEMA = 'talkqte.lab.take-attempt.v1';
const OUTCOME_SCHEMA = 'talkqte.lab.take-outcome.v1';
const DURATION_SOURCE = fileURLToPath(
  new URL('./lab-recording-duration.swift', import.meta.url),
);

/** Free bytes for this user on the volume holding `directory`. */
export function evidenceFreeBytes(directory) {
  const s = statfsSync(directory);
  return s.bavail * s.bsize;
}

// Builds the duration helper (scripts/lab-recording-duration.swift) into a
// private temporary folder before anything is launched, so a missing
// compiler stops the attempt before it starts rather than after the take.
// The helper asks AVFoundation for the recording's precise duration; it is
// exact to the movie's timescale. The folder holds only the helper and is
// removed afterwards; it is not evidence.
export function prepareRecordingDuration({ environment }) {
  const directory = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'tq-duration-')),
  );
  chmodSync(directory, 0o700);
  const binary = join(directory, 'lab-recording-duration');
  const cache = join(directory, 'module-cache');
  try {
    execFileSync(
      '/usr/bin/swiftc',
      [
        '-O',
        '-parse-as-library',
        '-swift-version',
        '5',
        '-module-cache-path',
        cache,
        '-o',
        binary,
        DURATION_SOURCE,
        '-framework',
        'AVFoundation',
        '-framework',
        'CoreMedia',
      ],
      {
        env: { ...environment, CLANG_MODULE_CACHE_PATH: cache },
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 300000,
      },
    );
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    method: 'AVFoundation precise duration (lab-recording-duration.swift)',
    measure(path) {
      const out = execFileSync(binary, [path], {
        env: {},
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 60000,
        maxBuffer: 4096,
      });
      const value = parseUniqueLabJson(out.trim());
      ensure(
        exact(value, ['durationMs', 'timescale']) &&
          Number.isFinite(value.durationMs) &&
          value.durationMs > 0 &&
          Number.isSafeInteger(value.timescale) &&
          value.timescale > 0,
      );
      return value.durationMs;
    },
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  });
}

// The existing modules an attempt composes. Tests substitute the existing
// fixtures; `main` always uses these.
const TAKE_MODULES = Object.freeze({
  // Before the attempt marker: the launcher's and the player's own receipt,
  // hash and signature checks (repeated at launch).
  verifyNative: verifyLabBuild,
  verifyPlayer: verifyLabPlayerBuild,
  prepareDuration: prepareRecordingDuration,
  sweepTokens: () => removeStaleTranscriptionTokens(),
  createWriter: createLabEvidenceWriter,
  createPlayer: createLabPlayer,
  mintGrant: () => mintDeepgramGrant(),
  prepareLauncher: prepareLabLauncher,
  createSource: createLabSourceV1,
  createSelector: createLabOwnedWindowSelector,
  createRecorder: createLabRecorder,
  createTake: createFixedModelTake,
  snapshotTiming: snapshotLabTiming,
  writeReport: writeEvidenceReport,
});

// Writes `value` as a new owner-only file; refuses to replace anything.
function writeNewPrivateJson(path, value) {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at);
  } finally {
    closeSync(fd);
  }
}

export const attemptMarkerPath = (evidenceDirectory, planSha256) =>
  join(evidenceDirectory, `take-attempt-${planSha256}.json`);

/**
 * Runs one attempt of the plan at `planPath`. Resolves with
 * { exitCode, state, reportDirectory, outcomePath } once the evidence is
 * written, or throws TakePlanRefused before anything was launched.
 */
export async function executeTakePlan(
  planPath,
  {
    confirm,
    io = console,
    environment = process.env,
    processEvents = process,
    modules = TAKE_MODULES,
    scope = OWNER_TAKE_SCOPE,
    freeBytes = evidenceFreeBytes,
    // This process's runtime, which the owned player requires exactly.
    runtime = {
      platform: process.platform,
      node: process.version,
      libuv: process.versions.uv,
    },
  } = {},
) {
  const {
    summary,
    plan: p,
    media,
    native,
  } = inspectTakePlan(planPath, {
    environment,
  });
  io.log(renderTakePlan(summary, { execute: true }));
  io.log('');
  if (confirm !== summary.planSha256)
    throw new TakePlanRefused(
      'confirmation',
      "--confirm is not this plan's sha256",
    );
  step('owner decisions', () =>
    ensure(
      p.selection.model === scope.model &&
        p.transcription.minuteCap === scope.minuteCap &&
        (!scope.fixedMediaOnly || exact(p.media, ['fixedPath'])),
    ),
  );
  // Everything that needs nothing private is checked before the marker, so
  // it cannot use up the attempt.
  if (
    runtime.platform !== LAB_PLAYER_RUNTIME.platform ||
    runtime.node !== LAB_PLAYER_RUNTIME.node ||
    runtime.libuv !== LAB_PLAYER_RUNTIME.libuv
  )
    throw new TakePlanRefused(
      'runtime',
      `the owned player needs Node ${LAB_PLAYER_RUNTIME.node} with libuv ${LAB_PLAYER_RUNTIME.libuv} on macOS; this is Node ${runtime.node} with libuv ${runtime.libuv} on ${runtime.platform}`,
    );
  const free = step('disk', () => freeBytes(p.evidenceDirectory));
  if (!(free >= DISK_FLOOR_BYTES))
    throw new TakePlanRefused(
      'disk',
      `${(free / 1024 ** 3).toFixed(1)} GiB free on the evidence volume, below the 5 GiB floor`,
    );
  const markerPath = attemptMarkerPath(p.evidenceDirectory, summary.planSha256);
  const used = () =>
    new TakePlanRefused(
      'attempt',
      `this plan's one attempt was already used (${markerPath}); a new attempt needs a new plan`,
    );
  if (existsSync(markerPath)) throw used();
  step('native build signature', () =>
    modules.verifyNative({
      manifestFile: p.native.manifestFile,
      approved: p.native.approved,
    }),
  );
  step('player build signature', () =>
    modules.verifyPlayer({
      manifestFile: p.player.manifestFile,
      approved: p.player.approved,
    }),
  );
  const runnerEnvironment = Object.fromEntries(
    RUNNER_ENVIRONMENT.filter((k) => typeof environment[k] === 'string').map(
      (k) => [k, environment[k]],
    ),
  );
  io.log(
    'Building the recording-duration helper (up to two minutes the first time)…',
  );
  const duration = step('duration tool', () =>
    modules.prepareDuration({ environment: runnerEnvironment }),
  );
  try {
    writeNewPrivateJson(markerPath, {
      schema: ATTEMPT_SCHEMA,
      planSha256: summary.planSha256,
      runId: p.runId,
      kind: summary.kind,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    duration.close();
    if (error?.code === 'EEXIST') throw used();
    throw new TakePlanRefused('attempt marker');
  }
  io.log(`Attempt recorded: ${markerPath}`);
  io.log(
    'The in-app approval is the only consent for sending audio and text; this confirmation only starts the attempt.',
  );
  try {
    return await runAttempt({
      p,
      summary,
      media,
      native,
      io,
      processEvents,
      modules,
      runnerEnvironment,
      duration,
    });
  } catch {
    // The attempt started: say so, never "nothing was launched".
    throw Object.assign(
      new Error(
        `The attempt failed after it started; everything is kept in ${p.evidenceDirectory}. A new attempt needs a new plan.`,
      ),
      { category: 'attempt-failed' },
    );
  } finally {
    duration.close();
  }
}

async function runAttempt({
  p,
  summary,
  media,
  native,
  io,
  processEvents,
  modules,
  runnerEnvironment,
  duration,
}) {
  const runId = p.runId;
  const probe = summary.kind === 'provider-failure';
  const stop = new AbortController();
  let stopSignal = null;
  // Ctrl-C or SIGTERM in the terminal asks the take's ordinary Stop and
  // cleanup (the take's signal); it never kills the app. Until the
  // evidence is written, a repeated signal changes nothing.
  const onSignal = (name) => () => {
    if (!stopSignal)
      io.log(
        `${name}: stopping through the take's ordinary Stop and cleanup. Wait for the evidence report.`,
      );
    stopSignal ??= name;
    stop.abort();
  };
  const onInt = onSignal('SIGINT'),
    onTerm = onSignal('SIGTERM');
  processEvents.on('SIGINT', onInt);
  processEvents.on('SIGTERM', onTerm);
  const checkStop = () => {
    if (stop.signal.aborted) throw new Error('stopped');
  };
  let writer = null,
    player = null,
    grant = null,
    launcher = null,
    source = null,
    recorder = null,
    take = null,
    at = 'token-sweep',
    startFailure = null,
    evidenceFailure = null;
  try {
    try {
      modules.sweepTokens();
      at = 'evidence-writer';
      writer = modules.createWriter({
        parentDirectory: p.evidenceDirectory,
        runId,
        fictional: true,
        mode: 'prepared',
        contentMode: 'fictional-content',
        onFailure: () => {
          evidenceFailure ??= 'writer';
          stop.abort();
        },
      });
      writer.addClock({ id: 'node', kind: 'monotonic' });
      writer.addClock({ id: 'native-logger', kind: 'monotonic' });
      io.log(`Evidence folder: ${writer.directory}`);
      checkStop();
      at = 'player-prepare';
      player = modules.createPlayer({
        runId,
        manifestFile: p.player.manifestFile,
        approved: p.player.approved,
        startMs: RUNNER_SETTINGS.playerStartMs,
      });
      await player.prepare({ media, signal: stop.signal });
      checkStop();
      if (!probe) {
        at = 'deepgram-grant';
        grant = await modules.mintGrant();
        checkStop();
      }
      at = 'launcher-prepare';
      const transcription = probe
        ? { ...p.transcription }
        : { ...p.transcription, grant };
      launcher = modules.prepareLauncher({
        manifestFile: p.native.manifestFile,
        approved: p.native.approved,
        mode: 'model-enabled',
        selection: p.selection,
        sourceApplication: 'TalkQTE Lab Player',
        playerSource: player.identity,
        stopAfterS: API_STOP_AFTER_S,
        transcription,
        environment: runnerEnvironment,
        // The terminal's Ctrl-C must reach only this runner, which stops
        // the app through the take's ordinary Stop.
        ownProcessGroup: true,
        ...(p.userName === undefined ? {} : { userName: p.userName }),
        ...(p.contextPolicy === undefined
          ? {}
          : { contextPolicy: p.contextPolicy }),
        ...(p.turnOffAfterMs === undefined ? {} : { turnOff: true }),
      });
      // The launcher owns the grant now and discards it at close.
      grant = null;
      const t = launcher.transcription;
      writer.recordTranscription(
        probe
          ? {
              backend: t.backend,
              minuteCap: t.minuteCap,
              failureProbe: t.failureProbe,
            }
          : {
              backend: t.backend,
              minuteCap: t.minuteCap,
              grantTtlS: t.grantTtlS,
            },
      );
      at = 'source';
      source = modules.createSource({
        launcher,
        application: 'TalkQTE Lab Player',
        commit: native.commit,
        features: [...native.features],
      });
      at = 'recorder';
      const selectWindows = modules.createSelector({
        binary: p.helper.path,
        sha256: p.helper.sha256,
        playerSource: player.identity,
        native: launcher,
        nativeApplication: RUNNER_SETTINGS.nativeApplication,
      });
      recorder = modules.createRecorder({
        binary: p.helper.path,
        sha256: p.helper.sha256,
        directory: writer.directory,
        selectWindows,
        native: launcher,
        playerSource: player.identity,
        seconds: RUNNER_SETTINGS.recorderSeconds,
        startupMs: RUNNER_SETTINGS.recorderStartupMs,
      });
      checkStop();
      at = 'take';
      take = modules.createTake({
        settings: {
          ...p.selection,
          deadlineMs: RUNNER_SETTINGS.providerDeadlineMs,
          execution: 'api',
          environment: runnerEnvironment,
          ...(p.contextPolicy === undefined
            ? {}
            : { contextPolicy: p.contextPolicy }),
        },
        runId,
        launcher,
        source,
        player,
        recorder,
        media,
        stopAfterS: API_STOP_AFTER_S,
        approvalBudgetMs: APPROVAL_BUDGET_MS,
        takeMs: TAKE_MS,
        ...(p.tailMs === undefined ? {} : { tailMs: p.tailMs }),
        ...(p.turnOffAfterMs === undefined
          ? {}
          : { turnOffAfterMs: p.turnOffAfterMs }),
        onApproval(event) {
          if (event.state === 'waiting')
            io.log(
              `TalkQTE is Listening. Press Review processing, Review selected sources, Enable for this session NOW: ${Math.floor(event.budgetMs / 1000)} s remain.`,
            );
          else if (event.state === 'approved')
            io.log(
              `In-app approval received after ${(event.waitMs / 1000).toFixed(1)} s. The take now plays and records on its own; watch for permission prompts.`,
            );
        },
        observe(event) {
          if (!writer.emit(event)) {
            evidenceFailure ??= 'events';
            stop.abort();
          }
        },
        onGuard: (guard) => writer.recordGuard(guard),
        signal: stop.signal,
        processEvents,
      });
      io.log(
        'Take started: launching TalkQTE and waiting for Listening (approval within 180 s).',
      );
      await take.done.catch(() => {});
    } catch {
      // Not expected once the take exists; its own cleanup still runs.
      if (take) await take.done.catch(() => {});
    }
    if (!take) {
      startFailure = stop.signal.aborted ? `stopped-at-${at}` : at;
      // The take never existed: nothing was launched. Retire what was
      // prepared, as the take's own cleanup would.
      try {
        source?.close?.();
      } catch {}
      try {
        launcher?.close();
      } catch {}
      try {
        grant?.discard?.();
      } catch {}
    }
    return await finishAttempt({
      p,
      summary,
      io,
      modules,
      duration,
      writer,
      player,
      launcher,
      recorder,
      take,
      startFailure,
      stopSignal: () => stopSignal,
      evidenceFailure: () => evidenceFailure,
    });
  } finally {
    processEvents.off('SIGINT', onInt);
    processEvents.off('SIGTERM', onTerm);
  }
}

// After the take settled (native released, recorder finalized, player
// retired) or never started: timing snapshot, recording, manifest, report
// and the take's own result, in that order. Nothing is deleted.
async function finishAttempt({
  p,
  summary,
  io,
  modules,
  duration,
  writer,
  player,
  launcher,
  recorder,
  take,
  startFailure,
  stopSignal,
  evidenceFailure,
}) {
  // The player is always retired once the take has settled: when the take
  // retired it this returns its result again; when the take could not
  // (release unconfirmed, or no take), the runner retires it so nothing it
  // owns keeps running. The outcome records whether native was released.
  let playerRetired = null;
  if (player)
    playerRetired = await player
      .close({ nativeReleased: true })
      .then((r) => r?.closed === true)
      .catch(() => false);
  const recorderFinalized = recorder
    ? await recorder.stop().then(
        (r) => r?.stopped === true,
        () => false,
      )
    : true;
  const evidence = { timing: null, recording: null };
  if (writer && launcher?.processStarted && recorderFinalized) {
    const ended = launcher.sourceReleased
      ? { sourceReleased: true }
      : launcher.nativeEnded
        ? { nativeEnded: launcher.nativeEnded }
        : null;
    if (!ended) evidence.timing = 'not-released';
    else
      try {
        const s = modules.snapshotTiming({
          path: launcher.timingPath,
          parentDirectory: writer.directory,
          runId: p.runId,
          expectedIdentity: launcher.timingFileIdentity,
          ...ended,
          recorderFinalized: true,
        });
        writer.attach({
          id: 'native-timing',
          kind: 'native-timing',
          path: s.path,
          clockId: 'native-logger',
          sealed: s.sealed,
          snapshotCoverage: s.coverage,
        });
        evidence.timing = 'attached';
      } catch {
        evidence.timing = 'failed';
      }
  }
  let durationMs = null;
  if (writer && recorder?.report && recorderFinalized)
    try {
      durationMs = duration.measure(recorder.output);
      writer.attach({
        id: 'recording',
        kind: 'recording',
        path: recorder.output,
        durationMs,
        sealed: true,
      });
      evidence.recording = 'attached';
    } catch {
      evidence.recording = 'failed';
    }
  let manifestPath = null,
    reportDirectory = null;
  if (writer) {
    try {
      manifestPath = writer.close().manifestPath;
      reportDirectory = (
        await modules.writeReport({
          manifestPath,
          outDir: join(writer.directory, 'report'),
        })
      ).output;
    } catch {
      reportDirectory = null;
    }
  }
  const get = (fn) => {
    try {
      return fn() ?? null;
    } catch {
      return null;
    }
  };
  const state = take ? take.phase : 'not-started';
  const outcome = {
    schema: OUTCOME_SCHEMA,
    planSha256: summary.planSha256,
    runId: p.runId,
    kind: summary.kind,
    state,
    failure: get(() => take.failure),
    failedStep: get(() => take.failedStep),
    runStopReason: get(() => take.runStopReason),
    startFailure,
    stopSignal: stopSignal(),
    evidenceFailure: evidenceFailure(),
    approval: get(() => take.approval),
    turnOff: get(() => take.turnOff),
    dispatchesUsed: get(() => take.dispatchesUsed),
    providerSpentMicroUsd: get(() => take.providerSpentMicroUsd),
    providerReceipts: get(() => take.providerReceipts),
    evaluationSummary: get(() => take.evaluationSummary),
    startupDiagnostics: get(() => take.startupDiagnostics),
    native: {
      launched: get(() => launcher.processStarted) ?? false,
      released: get(() => launcher.sourceReleased),
      ended: get(() => launcher.nativeEnded),
      transcription: get(() => launcher.transcription),
      userName: get(() => launcher.userName),
      turnOff: get(() => launcher.turnOff),
    },
    player: {
      diagnostics: get(() => player.diagnostics),
      retired: playerRetired,
    },
    recorder: {
      finalized: recorderFinalized,
      failureDetail: get(() => recorder.failureDetail),
      report: get(() => recorder.report),
    },
    evidence: {
      ...evidence,
      recordingDurationMs: durationMs,
      durationMethod: durationMs === null ? null : duration.method,
      manifest: manifestPath,
      report: reportDirectory,
    },
  };
  let outcomePath = null;
  if (writer)
    try {
      outcomePath = join(writer.directory, 'take-outcome.json');
      writeNewPrivateJson(outcomePath, outcome);
    } catch {
      outcomePath = null;
    }
  const detail = [
    outcome.failure && `failure ${outcome.failure}`,
    outcome.failedStep && `failed step ${outcome.failedStep}`,
    outcome.runStopReason && `run stop reason ${outcome.runStopReason}`,
    startFailure && `stopped before launch at ${startFailure}`,
  ].filter(Boolean);
  io.log('');
  io.log(
    `Take ended: ${state}${detail.length ? ` (${detail.join('; ')})` : ''}.`,
  );
  if (reportDirectory)
    io.log(`Evidence report: ${join(reportDirectory, 'report.md')}`);
  else
    io.log(
      `No evidence report was written; everything is kept${writer ? ` in ${writer.directory}` : ''}.`,
    );
  if (outcomePath) io.log(`Take outcome: ${outcomePath}`);
  io.log(
    'This runner claims nothing about the take: review the report, the recording and the outcome. The attempt is used; a new attempt needs a new plan.',
  );
  if (get(() => launcher.processStarted) && !get(() => launcher.processEnded))
    io.log(
      'TalkQTE keeps running after its release: quit it from its menu. This runner exits once TalkQTE has quit; Ctrl-C now ends only the runner, not TalkQTE.',
    );
  return Object.freeze({
    exitCode: reportDirectory ? 0 : 1,
    state,
    reportDirectory,
    outcomePath,
    outcome,
  });
}

const USAGE =
  'Usage: npm run lab:take -- --plan /absolute/path/plan.json [--execute --confirm <plan sha256>]';

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plan' && options.plan === undefined && i + 1 < argv.length)
      options.plan = argv[++i];
    else if (
      arg === '--confirm' &&
      options.confirm === undefined &&
      i + 1 < argv.length
    )
      options.confirm = argv[++i];
    else if (arg === '--execute' && !options.execute) options.execute = true;
    else return null;
  }
  if (
    options.plan === undefined ||
    !!options.execute !== (options.confirm !== undefined)
  )
    return null;
  return options;
}

export async function main(argv = process.argv.slice(2), io = console) {
  const options = parseArguments(argv);
  if (!options) {
    io.error(USAGE);
    return 2;
  }
  try {
    if (!options.execute) {
      io.log(renderTakePlan(checkTakePlan(options.plan)));
      return 0;
    }
    return (
      await executeTakePlan(options.plan, { confirm: options.confirm, io })
    ).exitCode;
  } catch (error) {
    io.error(
      error instanceof TakePlanRefused || error?.category === 'attempt-failed'
        ? error.message
        : 'Plan refused. Nothing was launched.',
    );
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
