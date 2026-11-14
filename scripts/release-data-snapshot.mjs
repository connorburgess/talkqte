// Records what TalkQTE keeps on disk, so an upgrade or rollback on a test Mac
// can be shown to have kept it. Run it before and after replacing the app and
// compare the two records. It reads file names, sizes and SHA-256 digests
// only, never file contents into the record, changes nothing, contacts
// nobody, and needs no credentials.
//
//   node scripts/release-data-snapshot.mjs record --out before.json
//   (quit TalkQTE, replace it with the other candidate, open and quit it)
//   node scripts/release-data-snapshot.mjs record --out after.json
//   node scripts/release-data-snapshot.mjs compare before.json after.json
//
// record  --out FILE      where to write the record (required; keep it outside
//                         the checkout, it lists your data folder's file names)
//         --home DIR      read another home folder (default: yours)
//         --identifier ID bundle identifier (default: from tauri.conf.json;
//                         required when this file is copied elsewhere alone)
//         --app PATH      the installed app, to note its version
//                         (default: /Applications/TalkQTE.app)
// compare exits 0 when nothing in the app's data folder was removed or
//         changed, 1 when something was, 2 for a usage error. Added files and
//         changes in caches and web-view storage are reported, not failed.
//         --allow-changes reports data-folder changes without failing, for an
//         upgrade that is meant to migrate them.
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where macOS and the app keep per-app files. `kept` marks the folder whose
 * contents an upgrade must preserve; the others may change at any launch. */
export function dataRoots(identifier) {
  return [
    { path: `Library/Application Support/${identifier}`, kept: true },
    { path: `Library/Preferences/${identifier}.plist`, kept: false },
    { path: `Library/Caches/${identifier}`, kept: false },
    { path: `Library/WebKit/${identifier}`, kept: false },
    { path: `Library/HTTPStorages/${identifier}`, kept: false },
    {
      path: `Library/Saved Application State/${identifier}.savedState`,
      kept: false,
    },
  ];
}

function digest(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const file = openSync(path, 'r');
  try {
    for (;;) {
      const read = readSync(file, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(file);
  }
  return hash.digest('hex');
}

/** Every file and link under `path`, keyed by its path relative to it. A
 * single file is recorded under the key ".". */
function entriesOf(path, relative = '.') {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return { [relative]: { unreadable: error.code ?? 'error' } };
  }
  if (stat.isSymbolicLink())
    return { [relative]: { link: readlinkSync(path) } };
  if (stat.isDirectory()) {
    let names;
    try {
      names = readdirSync(path).sort();
    } catch (error) {
      return { [relative]: { unreadable: error.code ?? 'error' } };
    }
    return Object.assign(
      {},
      ...names.map((name) =>
        entriesOf(
          join(path, name),
          relative === '.' ? name : `${relative}/${name}`,
        ),
      ),
    );
  }
  if (!stat.isFile()) return {};
  try {
    return { [relative]: { size: stat.size, sha256: digest(path) } };
  } catch (error) {
    return { [relative]: { unreadable: error.code ?? 'error' } };
  }
}

/** A record of the per-app folders under `home`. Paths are stored relative
 * to the home folder, so the record does not name the account. */
export function record({ home, identifier, appVersion, now = new Date() }) {
  return {
    format: 1,
    identifier,
    appVersion: appVersion ?? null,
    recorded: now.toISOString(),
    roots: dataRoots(identifier).map(({ path, kept }) => {
      const full = join(home, path);
      const present = existsSync(full);
      return {
        path: `~/${path}`,
        kept,
        present,
        entries: present ? entriesOf(full) : {},
      };
    }),
  };
}

const same = (left, right) =>
  left.sha256 !== undefined
    ? left.sha256 === right.sha256 && left.size === right.size
    : left.link !== undefined
      ? left.link === right.link
      : false;

/** What differs between two records, root by root, and whether anything the
 * upgrade had to keep was removed, changed or could not be read. */
export function compare(before, after) {
  for (const snapshot of [before, after])
    if (snapshot?.format !== 1 || !Array.isArray(snapshot.roots))
      throw new Error('not a record written by this script (format 1)');
  if (before.identifier !== after.identifier)
    throw new Error(
      `the records are for different apps: ${before.identifier} and ${after.identifier}`,
    );
  const roots = before.roots.map((root) => {
    const later = after.roots.find((other) => other.path === root.path) ?? {
      entries: {},
      present: false,
    };
    const names = [
      ...new Set([...Object.keys(root.entries), ...Object.keys(later.entries)]),
    ].sort();
    const result = {
      path: root.path,
      kept: root.kept,
      removed: [],
      changed: [],
      added: [],
      unreadable: [],
      unchanged: 0,
    };
    for (const name of names) {
      const old = root.entries[name];
      const next = later.entries[name];
      if (old?.unreadable || next?.unreadable) result.unreadable.push(name);
      else if (!next) result.removed.push(name);
      else if (!old) result.added.push(name);
      else if (same(old, next)) result.unchanged++;
      else result.changed.push(name);
    }
    return result;
  });
  const lost = roots
    .filter((root) => root.kept)
    .flatMap((root) =>
      [...root.removed, ...root.changed, ...root.unreadable].map(
        (name) => `${root.path}/${name}`,
      ),
    );
  return { roots, lost, preserved: lost.length === 0 };
}

/** The comparison as lines a person can keep with the test evidence. */
export function report(before, after, result, { allowChanges = false } = {}) {
  const lines = [
    `${before.identifier}: ${before.appVersion ?? 'unknown version'} (${before.recorded}) -> ${after.appVersion ?? 'unknown version'} (${after.recorded})`,
  ];
  for (const root of result.roots) {
    const total =
      root.unchanged +
      root.removed.length +
      root.changed.length +
      root.added.length +
      root.unreadable.length;
    lines.push(
      '',
      `${root.path}${root.kept ? ' (must be kept)' : ' (may change)'}: ${total ? `${root.unchanged} unchanged, ${root.changed.length} changed, ${root.removed.length} removed, ${root.added.length} added${root.unreadable.length ? `, ${root.unreadable.length} unreadable` : ''}` : 'absent in both records'}`,
    );
    for (const kind of ['removed', 'changed', 'unreadable', 'added'])
      for (const name of root[kind]) lines.push(`  ${kind}: ${name}`);
  }
  lines.push(
    '',
    result.preserved
      ? 'Kept: nothing in the data folder was removed or changed.'
      : `${allowChanges ? 'Changed (allowed)' : 'NOT KEPT'}: ${result.lost.length} item(s) in the data folder were removed, changed or unreadable.`,
  );
  return lines.join('\n');
}

function usage(message) {
  console.error(`release-data-snapshot: ${message}`);
  console.error(
    'usage: node scripts/release-data-snapshot.mjs record --out FILE [--home DIR] [--identifier ID] [--app PATH]\n       node scripts/release-data-snapshot.mjs compare BEFORE.json AFTER.json [--allow-changes]',
  );
  process.exit(2);
}

// Compare real paths: a copy under a linked folder (such as /tmp on macOS)
// would otherwise be taken for an import and do nothing.
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const [command, ...rest] = process.argv.slice(2);
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (['--out', '--home', '--identifier', '--app'].includes(argument)) {
      if (index + 1 >= rest.length) usage(`${argument} needs a value`);
      options[argument.slice(2)] = rest[++index];
    } else if (argument === '--allow-changes') options.allowChanges = true;
    else if (argument.startsWith('-')) usage(`unknown option ${argument}`);
    else positional.push(argument);
  }

  if (command === 'record') {
    if (!options.out || positional.length)
      usage('record needs --out FILE and nothing else');
    // The file also runs on its own, copied to a Mac with no checkout.
    const configPath = join(REPOSITORY, 'src-tauri', 'tauri.conf.json');
    const config = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, 'utf8'))
      : {};
    const identifier = options.identifier ?? config.identifier;
    if (!identifier)
      usage('no tauri.conf.json beside this script; pass --identifier ID');
    const home = options.home ?? homedir();
    const installed = join(
      options.app ?? `/Applications/${config.productName ?? 'TalkQTE'}.app`,
      'Contents',
      'Info.plist',
    );
    const appVersion = existsSync(installed)
      ? (/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
          readFileSync(installed, 'utf8'),
        )?.[1] ?? null)
      : null;
    const snapshot = record({ home, identifier, appVersion });
    writeFileSync(options.out, `${JSON.stringify(snapshot, null, 2)}\n`);
    const files = snapshot.roots.reduce(
      (total, root) => total + Object.keys(root.entries).length,
      0,
    );
    console.log(
      `Recorded ${files} item(s) in ${snapshot.roots.filter((root) => root.present).length} of ${snapshot.roots.length} locations for ${identifier}${appVersion ? ` (installed app ${appVersion})` : ' (no installed app found)'} to ${options.out}`,
    );
  } else if (command === 'compare') {
    if (positional.length !== 2 || options.out)
      usage('compare needs two record files');
    let before, after, result;
    try {
      [before, after] = positional.map((path) =>
        JSON.parse(readFileSync(path, 'utf8')),
      );
      result = compare(before, after);
    } catch (error) {
      usage(error.message);
    }
    console.log(report(before, after, result, options));
    process.exit(result.preserved || options.allowChanges ? 0 : 1);
  } else usage('give a command: record or compare');
}
