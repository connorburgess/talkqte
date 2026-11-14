// The bundled fictional case sets and the recorded outcomes of the phrase
// rules on them. Nothing here starts a process or a model.
import { readFile } from 'node:fs/promises';

const read = async (name) =>
  JSON.parse(
    await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  );

export const SETS = {
  'cue-lab': 'cue-lab.json',
  'held-out': 'cue-rules-held-out.json',
  independent: 'cue-rules-independent.json',
};

/** One shape for all three files: a missing cue becomes null. */
export function normalizeCase(item) {
  return { ...item, existingCue: item.existingCue ?? null };
}

export async function loadSet(name) {
  if (!Object.hasOwn(SETS, name))
    throw new Error(
      `Unknown set. Choose one of: ${Object.keys(SETS).join(', ')}.`,
    );
  const file = await read(SETS[name]);
  const cases = (Array.isArray(file) ? file : file.cases).map(normalizeCase);
  return { name, file: `scripts/fixtures/${SETS[name]}`, cases };
}

/** The phrase rules' recorded final action for each case of a set. */
export async function loadRulesOutcomes(name) {
  const recorded = await read('cue-rules-recorded.json');
  const set = recorded.sets[name];
  if (!set) throw new Error(`No recorded rule outcomes for ${name}.`);
  return set.actions;
}

/** Selects listed cases in the set's order; an unknown ID is an error. */
export function selectCases(cases, ids) {
  if (!ids) return cases;
  const unknown = ids.filter((id) => !cases.some((item) => item.id === id));
  if (unknown.length)
    throw new Error(`Unknown fictional case: ${unknown.join(', ')}.`);
  return cases.filter((item) => ids.includes(item.id));
}
