// The owner's lab key files: one `NAME=value` line in a 0600 file inside a
// 0700 directory, both owned by the current user, outside any repository or
// temporary directory. Every refusal is fixed text; a value never appears.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const LAB_KEY_DIR = join(
  process.env.HOME ?? '/nonexistent',
  '.config',
  'talkqte-lab',
);

class KeyRefused extends Error {
  constructor(reason) {
    super(`Lab key refused: ${reason}.`);
    this.category = 'credentials';
  }
}

function insideRepository(path) {
  for (let p = path; ; p = dirname(p)) {
    if (existsSync(join(p, '.git'))) return true;
    if (dirname(p) === p) return false;
  }
}

/**
 * Reads `name` from `file` under the ownership, mode and location rules, then
 * applies `accept` (a predicate on the value). Returns the value.
 */
export function readLabKeyFile({
  file,
  name,
  accept,
  forbiddenRoots = [tmpdir(), '/tmp', '/private/tmp'],
}) {
  const uid = process.getuid?.();
  const dir = dirname(file);
  let d, f;
  try {
    d = lstatSync(dir);
    f = lstatSync(file);
  } catch {
    throw new KeyRefused('missing');
  }
  if (!d.isDirectory() || d.isSymbolicLink() || d.uid !== uid)
    throw new KeyRefused('directory');
  if ((d.mode & 0o777) !== 0o700) throw new KeyRefused('directory mode');
  if (!f.isFile() || f.isSymbolicLink() || f.uid !== uid)
    throw new KeyRefused('file');
  if ((f.mode & 0o777) !== 0o600) throw new KeyRefused('file mode');
  if (f.size === 0 || f.size > 4096) throw new KeyRefused('size');
  const real = realpathSync(file);
  const roots = forbiddenRoots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  if (roots.some((r) => real === r || real.startsWith(r + '/')))
    throw new KeyRefused('location');
  if (insideRepository(dirname(real))) throw new KeyRefused('location');
  const lines = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length !== 1) throw new KeyRefused('format');
  const m = lines[0].match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
  if (!m || m[1] !== name) throw new KeyRefused('format');
  let value = m[2].trim();
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
  if (/\s/.test(value) || value.length > 512 || !accept(value))
    throw new KeyRefused('kind');
  return value;
}
