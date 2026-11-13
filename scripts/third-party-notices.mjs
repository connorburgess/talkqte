// Writes src-tauri/THIRD-PARTY-NOTICES.txt from the dependencies a macOS
// release actually contains: the Rust crates linked into the executable
// (resolved by `cargo metadata` for the release target and features, without
// build-time, test-only and procedural-macro crates) and the JavaScript
// packages Vite puts in the frontend bundle. Licence texts are copied from the
// packages themselves; nothing is fetched except what cargo needs to resolve
// the locked dependencies, and the app reads none of this at run time.
//
//   node scripts/third-party-notices.mjs           write the file
//   node scripts/third-party-notices.mjs --check   fail if it would change
//
// The file is committed so a change in what ships is visible in review, and
// the release pre-flight refuses a bundle whose copy is missing or stale.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the notices live in the repository and inside the app bundle. */
export const NOTICES_PATH = 'src-tauri/THIRD-PARTY-NOTICES.txt';
export const NOTICES_IN_BUNDLE = 'Resources/THIRD-PARTY-NOTICES.txt';

/** What a release is built for. Changing either changes the linked crates. */
export const RUST_TARGET = 'aarch64-apple-darwin';
export const RUST_FEATURES = ['local-whisper'];

/** Notices kept beside vendored code rather than at a package's top level. */
const VENDORED_NOTICES = { 'whisper-rs-sys': ['whisper.cpp/LICENSE'] };

const NOTICE_FILE = /^(licen[sc]e|copying|notice|unlicense|copyright)/i;
const LOCKFILES = ['src-tauri/Cargo.lock', 'package-lock.json'];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const byName = (left, right) =>
  left.name < right.name
    ? -1
    : left.name > right.name
      ? 1
      : left.version < right.version
        ? -1
        : left.version > right.version
          ? 1
          : 0;

/** The line that ties a notices file to the lockfiles it was made from. */
export function inputsLine(root = REPOSITORY) {
  return `Inputs: ${LOCKFILES.map(
    (path) => `${path} sha256 ${sha256(readFileSync(join(root, path)))}`,
  ).join('; ')}`;
}

/** Why a notices file does not match the current lockfiles, or null. */
export function staleReason(notices, root = REPOSITORY) {
  const recorded = /^Inputs: .*$/m.exec(notices)?.[0];
  if (!recorded) return 'it records no lockfile digests';
  return recorded === inputsLine(root)
    ? null
    : 'a lockfile changed after it was generated';
}

/** Crates linked into the root package: reached through ordinary
 * dependencies only, never through or into a procedural macro. */
export function linkedCrates(metadata) {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const linked = new Set();
  const pending = [metadata.resolve.root];
  while (pending.length) {
    const id = pending.pop();
    if (linked.has(id)) continue;
    const pkg = packages.get(id);
    if (pkg.targets.some((target) => target.kind.includes('proc-macro')))
      continue;
    linked.add(id);
    for (const dependency of nodes.get(id).deps)
      if (dependency.dep_kinds.some((kind) => kind.kind === null))
        pending.push(dependency.pkg);
  }
  linked.delete(metadata.resolve.root);
  return [...linked].map((id) => packages.get(id)).sort(byName);
}

/** The npm package a bundled module belongs to, or null for app code. */
export function packageOfModule(id) {
  const marker = '/node_modules/';
  const at = id.replaceAll('\\', '/').lastIndexOf(marker);
  if (at < 0) return null;
  const parts = id
    .replaceAll('\\', '/')
    .slice(at + marker.length)
    .split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

const normalize = (text) =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();

/** Notice files in a package folder, as { file, text } in name order. */
function noticeFiles(directory, extra = []) {
  const top = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && NOTICE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => !/\.(spdx|json)$/i.test(name))
    .sort();
  return [...top, ...extra].map((file) => ({
    file,
    text: normalize(readFileSync(join(directory, file), 'utf8')),
  }));
}

function rustComponents(root, metadata) {
  return linkedCrates(metadata).map((pkg) => ({
    kind: 'Rust crate',
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? `see ${pkg.license_file}`,
    source: pkg.repository ?? pkg.homepage ?? 'https://crates.io',
    notices: noticeFiles(
      dirname(pkg.manifest_path),
      VENDORED_NOTICES[pkg.name],
    ),
  }));
}

async function bundledPackages(root) {
  const { build } = await import('vite');
  const names = new Set();
  await build({
    root,
    logLevel: 'silent',
    build: { write: false },
    plugins: [
      {
        name: 'collect-bundled-packages',
        generateBundle(_, bundle) {
          for (const chunk of Object.values(bundle))
            for (const id of chunk.moduleIds ?? []) {
              const name = packageOfModule(id);
              if (name) names.add(name);
            }
        },
      },
    ],
  });
  return [...names].sort();
}

function javascriptComponents(root, names) {
  return names
    .map((name) => {
      const directory = join(root, 'node_modules', name);
      const manifest = JSON.parse(
        readFileSync(join(directory, 'package.json'), 'utf8'),
      );
      const repository =
        typeof manifest.repository === 'string'
          ? manifest.repository
          : manifest.repository?.url;
      return {
        kind: 'JavaScript package',
        name,
        version: manifest.version,
        license: manifest.license ?? 'not declared',
        source: repository ?? manifest.homepage ?? 'https://www.npmjs.com',
        notices: noticeFiles(directory),
      };
    })
    .sort(byName);
}

function toolchainComponent(root) {
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
    readFileSync(join(root, 'rust-toolchain.toml'), 'utf8'),
  )?.[1];
  return {
    kind: 'Rust standard library',
    name: 'rust-std',
    version: channel ?? 'unknown',
    license: 'MIT OR Apache-2.0',
    source: 'https://github.com/rust-lang/rust',
    notices: [],
  };
}

/** The notices file for the given components. Pure, so it can be tested. */
export function render(components, inputs) {
  const texts = new Map();
  for (const component of components)
    for (const notice of component.notices) {
      const key = sha256(notice.text);
      if (!texts.has(key)) texts.set(key, { text: notice.text, users: [] });
      texts.get(key).users.push(`${component.name} ${component.version}`);
    }
  const ordered = [...texts.entries()].sort(([left], [right]) =>
    left < right ? -1 : 1,
  );
  const label = new Map(
    ordered.map(([key], index) => [
      key,
      `T${String(index + 1).padStart(3, '0')}`,
    ]),
  );
  const count = (items) => {
    const totals = new Map();
    for (const item of items)
      totals.set(item.license, (totals.get(item.license) ?? 0) + 1);
    return [...totals.entries()]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
      .map(([license, total]) => `  ${String(total).padStart(4)}  ${license}`);
  };
  const kinds = [...new Set(components.map((component) => component.kind))];
  const lines = [
    'TalkQTE third-party notices',
    '===========================',
    '',
    'Generated by scripts/third-party-notices.mjs. Do not edit by hand; run',
    '`npm run notices` after any dependency change and before each release.',
    inputs,
    `Scope: Rust crates linked for ${RUST_TARGET} with the ${RUST_FEATURES.join(', ')} feature${RUST_FEATURES.length === 1 ? '' : 's'}`,
    '(a build without that feature links a subset), the Rust standard library,',
    'and the JavaScript packages in the frontend bundle. The system web view and',
    'macOS frameworks are part of the operating system and are not listed.',
    '',
    'Declared licences',
    '-----------------',
  ];
  for (const kind of kinds) {
    const items = components.filter((component) => component.kind === kind);
    lines.push('', `${kind}: ${items.length}`, ...count(items));
  }
  lines.push('', 'Components', '----------');
  for (const kind of kinds) {
    lines.push('', `${kind}`);
    for (const component of components.filter((item) => item.kind === kind)) {
      const refs = component.notices.map(
        (notice) => `${label.get(sha256(notice.text))} (${notice.file})`,
      );
      lines.push(
        '',
        `${component.name} ${component.version}`,
        `  Declared licence: ${component.license}`,
        `  Source: ${component.source}`,
        `  Notice texts: ${refs.length ? refs.join(', ') : 'none shipped in the package; see the source for its licence files'}`,
      );
    }
  }
  lines.push('', 'Licence and notice texts', '------------------------');
  for (const [key, { text, users }] of ordered)
    lines.push(
      '',
      `---- ${label.get(key)} ---- used by: ${users.join(', ')}`,
      '',
      text,
    );
  return `${lines.join('\n')}\n`;
}

export async function generate(root = REPOSITORY) {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--locked',
        '--filter-platform',
        RUST_TARGET,
        '--features',
        RUST_FEATURES.join(','),
        '--manifest-path',
        join(root, 'src-tauri', 'Cargo.toml'),
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    ),
  );
  return render(
    [
      ...rustComponents(root, metadata),
      toolchainComponent(root),
      ...javascriptComponents(root, await bundledPackages(root)),
    ],
    inputsLine(root),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const path = join(REPOSITORY, NOTICES_PATH);
  const fresh = await generate();
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (check) {
    if (current === fresh) {
      console.log(`${NOTICES_PATH} matches the current dependencies.`);
    } else {
      console.error(
        `${NOTICES_PATH} is ${current === null ? 'missing' : 'out of date'}. Run \`npm run notices\` and commit the result.`,
      );
      process.exit(1);
    }
  } else {
    writeFileSync(path, fresh);
    const summary = fresh.slice(
      fresh.indexOf('Declared licences'),
      fresh.indexOf('\nComponents\n'),
    );
    console.log(
      `${current === fresh ? 'Unchanged' : 'Wrote'} ${NOTICES_PATH}\n\n${summary}`,
    );
  }
}
