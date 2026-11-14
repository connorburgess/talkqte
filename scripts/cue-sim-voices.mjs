// Optional, separate step: makes natural-sounding synthetic speech for the
// bundled fictional conversations with a hosted text-to-speech service, and
// keeps each clip in a cache outside the repository so it is bought once.
// The recorder can then lay the cached clips under a recording. Without
// this step the recorder uses the system's own voices, or silence.
//
//   node scripts/cue-sim-voices.mjs --conversations a,b --cache <dir>
//   node scripts/cue-sim-voices.mjs --conversations a,b --cache <dir> \
//     --run --max-chars 4000 --env-file <private dotenv with OPENAI_API_KEY>
//
// Without --run nothing is sent: it lists every line, its voice, how many
// characters are new, and a rough cost. A run sends only the fictional
// lines of bundled conversations, stops at the first failure, and never
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
import { isMain } from './is-main.mjs';

export const SPEECH_MODEL = 'gpt-4o-mini-tts';
const ENDPOINT = 'https://api.openai.com/v1/audio/speech';
// So speakers do not all read at one pace.
const MANNER = [
  'A little brisk and matter-of-fact, the way someone runs a meeting.',
  'Relaxed and easy, at a comfortable pace.',
  'Warm and direct, with easy energy.',
  'Quieter and thoughtful, still fluent.',
  'Friendly and quick, slightly informal.',
  'Calm and even.',
];
// An earlier wording asked for small hesitations, and the speech came out
// halting: about 25 pauses a minute inside lines. This asks for fluency.
const BASE =
  'You are one person speaking in an ordinary work video call, not a narrator or an announcer. Speak fluently and continuously in a natural conversational voice, the way people talk when they know what they want to say: connected phrases, no gaps between words, and only the brief pauses that punctuation calls for. Do not add or change any words.';
/** No single invocation may send more text than this. */
export const MAX_CHARS_CEILING = 20_000;
// Rough guide only, for deciding whether to go ahead: about a cent and a
// half per minute of speech at roughly 900 characters a minute. The
// provider's bill is the only real figure.
const ESTIMATED_USD_PER_1000_CHARS = 0.017;

/** The voice, manner and cache name of every line of a conversation. The
 * cache name depends only on the model, voice, instructions and words, so
 * the same line is never bought twice. */
export function voicePlan(conversation) {
  const speakers = [...new Set(conversation.lines.map((line) => line.speaker))];
  // Preset voices only, cast so a voice and a portrait agree.
  const cast = castFor(conversation);
  const voices = Object.fromEntries(
    speakers.map((speaker) => [speaker, cast[speaker].voice]),
  );
  const roles = Object.fromEntries(
    conversation.participants.map((p) => [
      p.name,
      p.role.replace(/ \(listener\)$/, ''),
    ]),
  );
  return {
    voices,
    lines: conversation.lines.map((line) => {
      const voice = voices[line.speaker];
      const words = line.text.split(/\s+/).length;
      const instructions = [
        BASE,
        MANNER[speakers.indexOf(line.speaker) % MANNER.length],
        roles[line.speaker] ? `You are the ${roles[line.speaker]}.` : '',
        words <= 3
          ? 'This is a brief murmur of acknowledgement while someone else has the floor.'
          : line.text.trim().endsWith('?')
            ? 'This is a genuine question to the others.'
            : '',
      ]
        .filter(Boolean)
        .join(' ');
      const key = createHash('sha256')
        .update(JSON.stringify([SPEECH_MODEL, voice, instructions, line.text]))
        .digest('hex')
        .slice(0, 32);
      return {
        lineId: line.id,
        speaker: line.speaker,
        voice,
        instructions,
        text: line.text,
        file: `${key}.mp3`,
      };
    }),
  };
}

/** Reads one variable from a dotenv file without exposing anything else. */
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
    values: ['--conversations', '--cache', '--max-chars', '--env-file'],
    switches: ['--run'],
  });
  if (!flags['--conversations'] || !flags['--cache'])
    throw new Error(
      'Use --conversations <bundled ids> --cache <directory outside the repository>. Without --run nothing is sent.',
    );
  // Only bundled fictional conversations can be chosen, by ID.
  const all = await loadConversations();
  const ids = flags['--conversations'].split(',');
  const unknown = ids.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length)
    throw new Error(`Unknown fictional conversation: ${unknown.join(', ')}.`);
  const cache = outputDirectory(flags['--cache'], {});
  const plans = all
    .filter((c) => ids.includes(c.id))
    .map((c) => ({ id: c.id, ...voicePlan(c) }));
  const wanted = new Map();
  for (const plan of plans)
    for (const line of plan.lines) wanted.set(line.file, line);
  const missing = [...wanted.values()].filter(
    (line) => !existsSync(join(cache, line.file)),
  );
  const chars = missing.reduce((sum, line) => sum + line.text.length, 0);
  const estimate = (count) =>
    `about $${((count / 1000) * ESTIMATED_USD_PER_1000_CHARS).toFixed(2)} (a rough guide, not the provider's price)`;

  for (const plan of plans)
    print(
      `${plan.id}: ${plan.lines.length} lines; voices ${Object.entries(
        plan.voices,
      )
        .map(([speaker, voice]) => `${speaker} = ${voice}`)
        .join(', ')}`,
    );
  print(
    `${wanted.size} clips needed, ${wanted.size - missing.length} already cached, ${missing.length} to make: ${chars} characters, ${estimate(chars)}.`,
  );
  if (!flags['--run']) {
    print(
      `Dry run. Nothing was sent. A run sends these ${missing.length} fictional lines, with a voice name and speaking instructions, to OpenAI text-to-speech (${SPEECH_MODEL}). That is a hosted, separately billed service.`,
    );
    for (const line of missing)
      print(`  ${line.voice.padEnd(6)} ${line.speaker}: ${line.text}`);
    return { made: 0, cached: wanted.size - missing.length, chars: 0 };
  }
  if (!missing.length) {
    print('Every clip is already cached. Nothing was sent.');
    return { made: 0, cached: wanted.size, chars: 0 };
  }
  if (!/^\d+$/.test(flags['--max-chars'] ?? ''))
    throw new Error(
      'A run needs a spending cap: --max-chars <number of characters>. Nothing was sent.',
    );
  const cap = Number(flags['--max-chars']);
  if (cap < 1 || cap > MAX_CHARS_CEILING)
    throw new Error(
      `--max-chars must be from 1 to ${MAX_CHARS_CEILING}. Nothing was sent.`,
    );
  if (chars > cap)
    throw new Error(
      `This would send ${chars} characters and the cap is ${cap}. Choose fewer conversations or raise the cap. Nothing was sent.`,
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
      join(cache, 'voices.log.jsonl'),
      `${JSON.stringify({ at: now().toISOString(), ...event })}\n`,
    );
  let made = 0;
  let sent = 0;
  for (const line of missing) {
    const started = Date.now();
    const response = await request(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: SPEECH_MODEL,
        voice: line.voice,
        input: line.text,
        instructions: line.instructions,
        response_format: 'mp3',
      }),
    });
    sent += line.text.length;
    if (!response.ok) {
      // The status only: a provider's error text is not echoed.
      log({ type: 'failed', file: line.file, status: response.status });
      throw new Error(
        `The speech request failed with status ${response.status} after ${made} clips (${sent} characters sent). Nothing was retried.`,
      );
    }
    const audio = Buffer.from(await response.arrayBuffer());
    writeFileSync(join(cache, line.file), audio);
    made++;
    log({
      type: 'clip',
      file: line.file,
      speaker: line.speaker,
      voice: line.voice,
      characters: line.text.length,
      bytes: statSync(join(cache, line.file)).size,
      ms: Date.now() - started,
    });
  }
  print(
    `Made ${made} clips: ${sent} characters sent, ${estimate(sent)}. Cached in ${cache}; a later run will not buy them again.`,
  );
  return { made, cached: wanted.size - missing.length, chars: sent };
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
