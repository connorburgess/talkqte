// Dry-run check of one prepared, model-enabled lab take plan
// (docs/lab-take-runbook.md). It reads the plan, the two build receipts,
// the recorder helper and the media, and checks them with the same option
// checks the take modules apply. It launches nothing, reads no key file,
// mints no token, runs no codesign and makes no network request. It then
// prints what a take of this plan would launch, send and spend, and the
// plan's sha256.
//
// It has no execute path: what a committed runner would still need from
// the owner is listed in the runbook ("Decisions before a committed
// runner"). A take is still run from a reviewed private package.
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { isMain } from './is-main.mjs';
import { outsideCheckout } from './cue-lab-checkout.mjs';
import { parseUniqueLabJson } from './cue-lab-strict-json.mjs';
import {
  assertLabLaunchOptions,
  assertLabTranscriptionRoute,
  validateLabBuildRecord,
} from './cue-lab-launcher.mjs';
import {
  hashLabOwnedFile,
  validateLabPlayerBuildRecord,
} from './cue-lab-player.mjs';
import { fixedLabMedia, loadLabMediaManifest } from './cue-lab-media.mjs';
import {
  API_STOP_AFTER_S,
  APPROVAL_BUDGET_MS,
  assertFixedModelTakeOptions,
} from './cue-lab-prepared-take.mjs';
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
export function checkTakePlan(planPath, { environment = process.env } = {}) {
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
  return Object.freeze({
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
}

export function renderTakePlan(s) {
  const d = s.send.deepgram,
    a = s.send.anthropic;
  return [
    `Plan valid (dry run). Nothing was launched, no key file was read.`,
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
    ``,
    `No execute path is committed. See docs/lab-take-runbook.md.`,
  ].join('\n');
}

const USAGE = 'Usage: npm run lab:take -- --plan /absolute/path/plan.json';

export function main(argv = process.argv.slice(2), io = console) {
  if (argv.length !== 2 || argv[0] !== '--plan') {
    io.error(
      argv.includes('--confirm') || argv.includes('--execute')
        ? `This command only checks a plan; it has no execute path yet (docs/lab-take-runbook.md). ${USAGE}`
        : USAGE,
    );
    return 2;
  }
  try {
    io.log(renderTakePlan(checkTakePlan(argv[1])));
    return 0;
  } catch (error) {
    io.error(
      error instanceof TakePlanRefused
        ? error.message
        : 'Plan refused. Nothing was launched.',
    );
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = main();
