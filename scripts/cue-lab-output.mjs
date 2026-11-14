// Where lab runs write, and the event log every run keeps. Results and logs
// of runs are private working files: they never go inside the checkout.
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Resolves links in the longest existing part of a path, so a linked
// location that points into the checkout is still recognized.
function real(path) {
  let existing = resolve(path);
  const rest = [];
  for (;;) {
    try {
      // The native call also returns the stored spelling, so a path that
      // differs from the checkout only by letter case is still recognized.
      return join(realpathSync.native(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** The directory a run writes to: `--out`, else TALKQTE_LAB_OUTPUT. It must
 * be absolute and outside the repository, and is created if missing. */
export function outputDirectory(
  flag,
  environment = process.env,
  root = repository,
) {
  const value = flag ?? environment.TALKQTE_LAB_OUTPUT;
  if (!value)
    throw new Error(
      'Say where to write: --out <absolute directory outside the repository>, or set TALKQTE_LAB_OUTPUT.',
    );
  if (!isAbsolute(value))
    throw new Error('The output directory must be an absolute path.');
  // Everything after this uses the resolved location, never the text given,
  // so a link or "link/.." cannot lead somewhere other than what was checked.
  const directory = real(value);
  const inside = relative(real(root), directory);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside)))
    throw new Error(
      'The output directory is inside the repository. Lab results, logs and recordings stay outside it.',
    );
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** 20261114-093005, in UTC, for file names that sort by time. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** An append-only JSON Lines log. Each event is written as it happens, so
 * a run that stops early still leaves everything up to that point. */
export function createRunLog(path, now = () => new Date()) {
  let sequence = 0;
  const events = [];
  return {
    path,
    events,
    write(type, data = {}) {
      const event = { seq: ++sequence, at: now().toISOString(), type, ...data };
      events.push(event);
      if (path) appendFileSync(path, `${JSON.stringify(event)}\n`);
      return event;
    },
  };
}

/** Nearest-rank percentile of a list of numbers; null when empty. */
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function latencySummary(values, budgetMs) {
  if (!values.length) return null;
  return {
    count: values.length,
    minMs: Math.min(...values),
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
    overBudget: values.filter((value) => value > budgetMs).length,
    budgetMs,
  };
}

/** Reads `--name value` and `--switch` arguments; anything else is an
 * error, so a mistyped flag never silently changes what a run does. */
export function parseFlags(args, { values = [], switches = [] }) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (Object.hasOwn(flags, name)) throw new Error(`${name} was given twice.`);
    if (switches.includes(name)) flags[name] = true;
    else if (values.includes(name) && i + 1 < args.length)
      flags[name] = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${name}`);
  }
  return flags;
}
