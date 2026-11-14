// Optional, separate step: makes an invented portrait for each speaker of
// the bundled fictional conversations with a hosted image service, and
// keeps each image in a cache outside the repository so it is bought once.
// The recorder can then show them in the mock call's tiles. Without this
// step the tiles show initials.
//
//   node scripts/cue-sim-portraits.mjs --conversations a,b --cache <dir>
//   node scripts/cue-sim-portraits.mjs --conversations a,b --cache <dir> \
//     --run --max-images 12 --env-file <private dotenv with OPENAI_API_KEY>
//
// Without --run nothing is sent: it lists each description and a rough
// cost. A run sends only those descriptions, which name no one and ask for
// a person who does not exist; it stops at the first failure and never
// prints, logs or passes on the key. This script is not part of the cue
// lab's model runs and shares no process or environment with them.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { outputDirectory, parseFlags } from './cue-lab-output.mjs';
import { castFor } from './cue-sim-cast.mjs';
import { loadConversations } from './cue-sim.mjs';
import { loadPlayable } from './lab-playable.mjs';
import { isMain } from './is-main.mjs';

export const IMAGE_MODEL = 'gpt-image-2';
const SIZE = '1536x1024';
const QUALITY = 'medium';
const ENDPOINT = 'https://api.openai.com/v1/images/generations';
/** No single invocation may ask for more images than this. */
export const MAX_IMAGES_CEILING = 60;
// Rough guide only, for deciding whether to go ahead. The provider's bill
// is the only real figure.
const ESTIMATED_USD_PER_IMAGE = 0.07;

/** The portrait of every speaker of a conversation: its description and
 * its cache name, which depends only on the model, size, quality and
 * description, so the same portrait is never bought twice. */
export function portraitPlan(conversation) {
  const cast = castFor(conversation);
  return Object.fromEntries(
    Object.entries(cast).map(([speaker, { prompt }]) => [
      speaker,
      {
        prompt,
        file: `${createHash('sha256')
          .update(JSON.stringify([IMAGE_MODEL, SIZE, QUALITY, prompt]))
          .digest('hex')
          .slice(0, 32)}.png`,
      },
    ]),
  );
}

function keyFrom(file) {
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*)\s*$/.exec(raw);
    if (match) return match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return '';
}

export async function main(
  args,
  {
    print = console.log,
    environment = process.env,
    request = fetch,
    now = () => new Date(),
  } = {},
) {
  const flags = parseFlags(args, {
    values: [
      '--conversations',
      '--results',
      '--cache',
      '--max-images',
      '--env-file',
    ],
    switches: ['--run'],
  });
  if (!flags['--cache'] || !(flags['--conversations'] || flags['--results']))
    throw new Error(
      'Use --conversations <bundled ids>, or --results <a fictional results file> with optional --conversations <ids in it>, and --cache <directory outside the repository>. Without --run nothing is sent.',
    );
  // Only fictional conversations: the bundled ones by ID, or those of a
  // results file that passes the lab's checks (a generated run against its
  // own brief).
  const all = flags['--results']
    ? (await loadPlayable(flags['--results'])).replays
    : await loadConversations();
  const ids = flags['--conversations']?.split(',') ?? all.map((c) => c.id);
  const unknown = ids.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length)
    throw new Error(`Unknown fictional conversation: ${unknown.join(', ')}.`);
  const cache = outputDirectory(flags['--cache'], {});
  const wanted = new Map();
  for (const conversation of all.filter((c) => ids.includes(c.id)))
    for (const [speaker, portrait] of Object.entries(
      portraitPlan(conversation),
    ))
      wanted.set(portrait.file, {
        ...portrait,
        who: `${conversation.id}/${speaker}`,
      });
  const missing = [...wanted.values()].filter(
    (portrait) => !existsSync(join(cache, portrait.file)),
  );
  const estimate = (count) =>
    `about $${(count * ESTIMATED_USD_PER_IMAGE).toFixed(2)} (a rough guide, not the provider's price)`;
  print(
    `${wanted.size} portraits needed, ${wanted.size - missing.length} already cached, ${missing.length} to make: ${estimate(missing.length)}.`,
  );
  if (!flags['--run']) {
    print(
      `Dry run. Nothing was sent. A run sends these ${missing.length} descriptions to OpenAI image generation (${IMAGE_MODEL}, ${SIZE}, ${QUALITY}). That is a hosted, separately billed service. Each describes an invented person and names no one.`,
    );
    for (const portrait of missing)
      print(`  ${portrait.who}: ${portrait.prompt}`);
    return { made: 0, cached: wanted.size - missing.length };
  }
  if (!missing.length) {
    print('Every portrait is already cached. Nothing was sent.');
    return { made: 0, cached: wanted.size };
  }
  if (!/^\d+$/.test(flags['--max-images'] ?? ''))
    throw new Error(
      'A run needs a spending cap: --max-images <number>. Nothing was sent.',
    );
  const cap = Number(flags['--max-images']);
  if (cap < 1 || cap > MAX_IMAGES_CEILING)
    throw new Error(
      `--max-images must be from 1 to ${MAX_IMAGES_CEILING}. Nothing was sent.`,
    );
  if (missing.length > cap)
    throw new Error(
      `This would make ${missing.length} images and the cap is ${cap}. Choose fewer conversations or raise the cap. Nothing was sent.`,
    );
  const key = flags['--env-file']
    ? keyFrom(flags['--env-file'])
    : (environment.OPENAI_API_KEY ?? '');
  if (!key)
    throw new Error(
      'No OPENAI_API_KEY was found. Give --env-file <private dotenv file>, or set the variable for this process only. Nothing was sent.',
    );
  const log = (event) =>
    appendFileSync(
      join(cache, 'portraits.log.jsonl'),
      `${JSON.stringify({ at: now().toISOString(), ...event })}\n`,
    );
  let made = 0;
  for (const portrait of missing) {
    const started = Date.now();
    const response = await request(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt: portrait.prompt,
        size: SIZE,
        quality: QUALITY,
        n: 1,
      }),
    });
    const body = await response.json().catch(() => ({}));
    const data = response.ok ? body.data?.[0]?.b64_json : null;
    if (!data) {
      // The status and the provider's short error identifiers only: its
      // message is not echoed.
      const identifiers = ['code', 'type', 'param']
        .map((field) => body.error?.[field])
        .filter(
          (value) => typeof value === 'string' && /^[\w.-]{1,60}$/.test(value),
        );
      log({
        type: 'failed',
        file: portrait.file,
        status: response.status,
        identifiers,
      });
      throw new Error(
        `The image request failed with status ${response.status}${identifiers.length ? ` (${identifiers.join(', ')})` : ''} after ${made} images. Nothing was retried.`,
      );
    }
    writeFileSync(join(cache, portrait.file), Buffer.from(data, 'base64'));
    made++;
    log({
      type: 'portrait',
      file: portrait.file,
      who: portrait.who,
      bytes: statSync(join(cache, portrait.file)).size,
      ms: Date.now() - started,
    });
  }
  print(
    `Made ${made} portraits, ${estimate(made)}. Cached in ${cache}; a later run will not buy them again.`,
  );
  return { made, cached: wanted.size - missing.length };
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
