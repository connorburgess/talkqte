// What the lab may play: fictional conversations only, either the bundled
// ones (checked word for word against their fixtures) or generated runs
// (checked against the brief file saved beside them). The recorder, the
// meeting emulator and the voice and portrait steps all load through here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SETS, loadSet } from './cue-lab-sets.mjs';
import { conversationFromCase, loadConversations } from './cue-sim.mjs';

export const SIM_SCHEMA = 'talkqte-cue-sim/1';
export const DIALOGUE_SCHEMA = 'talkqte-cue-dialogue/1';
/** How a generated person may sound. */
export const VOICE_KINDS = ['feminine', 'masculine', 'neutral'];

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

/** Refuses a generated run unless its brief file is beside it, unchanged
 * (by the SHA-256 the run recorded), and names every person in it; and
 * unless every person carries casting the emulator can use and every line
 * is spoken by someone in the call, in order. */
export function assertBrief(results, file) {
  const brief = results.brief;
  if (
    !brief ||
    typeof brief.file !== 'string' ||
    brief.file !== basename(brief.file) ||
    !/^[0-9a-f]{64}$/.test(brief.sha256 ?? '')
  )
    throw new Error(
      "A generated run must name its brief file, saved beside it, and that file's SHA-256.",
    );
  let bytes;
  try {
    bytes = readFileSync(join(dirname(file), brief.file));
  } catch {
    throw new Error(`The brief file ${brief.file} is not beside the results.`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== brief.sha256)
    throw new Error(
      "The brief file does not match the hash the run recorded: it was changed, or it is not this run's brief.",
    );
  const text = bytes.toString('utf8');
  if (!Array.isArray(results.branches) || !results.branches.length)
    throw new Error('The generated run has no conversations to play.');
  for (const replay of results.branches) {
    const where = `In ${replay.id},`;
    const names = new Set(replay.participants.map((person) => person.name));
    for (const person of replay.participants) {
      if (!text.includes(person.name))
        throw new Error(`${where} ${person.name} is not in the brief.`);
      const casting = person.casting;
      if (
        !casting ||
        !VOICE_KINDS.includes(casting.voice) ||
        !/^\d{2}-\d{2}$/.test(casting.age ?? '') ||
        typeof casting.portrait !== 'string' ||
        !casting.portrait.trim() ||
        casting.portrait.length > 200
      )
        throw new Error(
          `${where} ${person.name} has no usable casting (voice, age range and portrait).`,
        );
    }
    if (replay.listener && !names.has(replay.listener))
      throw new Error(`${where} the listener is not in the call.`);
    let last = -Infinity;
    for (const line of replay.lines) {
      if (!names.has(line.speaker))
        throw new Error(
          `${where} line ${line.id} is spoken by someone not in the call.`,
        );
      if (typeof line.text !== 'string' || !line.text.trim())
        throw new Error(`${where} line ${line.id} has no words.`);
      if (!(line.atMs > last))
        throw new Error(`${where} line ${line.id} is out of order.`);
      last = line.atMs;
    }
  }
}

/** Loads a results file the lab may play, with its conversations. */
export async function loadPlayable(file) {
  let results;
  try {
    results = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('That results file cannot be read.');
  }
  if (results.fictional !== true)
    throw new Error('The lab only plays results marked fictional.');
  if (results.schema === SIM_SCHEMA) {
    for (const replay of results.conversations)
      await assertBundled(results, replay);
    return { results, replays: results.conversations, generated: false };
  }
  if (results.schema === DIALOGUE_SCHEMA) {
    assertBrief(results, file);
    return { results, replays: results.branches, generated: true };
  }
  throw new Error('That is not a results file the lab can play.');
}
