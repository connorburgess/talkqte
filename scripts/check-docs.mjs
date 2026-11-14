// Keeps the documentation honest against the repository:
//   1. every relative Markdown link points at a file, and its #anchor at a
//      heading, that exists;
//   2. numbers the docs quote from the source still match the source;
//   3. a change to app source with no documentation change gets a reminder
//      (a warning, not a failure: some changes need no doc edit, and the PR
//      should say why).
//
//   node scripts/check-docs.mjs
//   CONTRIBUTION_BASE=<sha> CONTRIBUTION_HEAD=<sha> node scripts/check-docs.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Heading text as rendered: inline links, emphasis and code marks removed. */
function headingText(raw) {
  const code = [];
  return raw
    .replace(/`+([^`]+)`+/g, (_, text) => `\u0000${code.push(text) - 1}\u0000`)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}])_([^_]+)_(?![\p{L}\p{N}])/gu, '$1')
    .replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)])
    .trim();
}

// A closing fence must use the opening character and be at least as long.
function* proseLines(markdown) {
  let fence = null;
  for (const [index, line] of markdown.split('\n').entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    yield { line: index + 1, text: line };
  }
}

/** Anchors a Markdown file exposes, with GitHub's -1, -2 suffixes for repeats. */
export function anchors(markdown) {
  const result = new Set();
  for (const { text } of proseLines(markdown)) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(text);
    if (!match) continue;
    const base = slug(headingText(match[1]));
    let anchor = base;
    let count = 0;
    while (result.has(anchor)) anchor = `${base}-${++count}`;
    result.add(anchor);
  }
  return result;
}

/** Inline relative links and reference definitions outside fenced code. */
export function links(markdown) {
  const found = [];
  for (const { line, text: raw } of proseLines(markdown)) {
    const text = raw.replace(/`[^`]*`/g, '');
    const targets = [...text.matchAll(/\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)].map(
      (match) => match[1],
    );
    const reference = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(text);
    if (reference) targets.push(reference[1]);
    for (const target of targets) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      found.push({ line, target });
    }
  }
  return found;
}

function checkLinks(files) {
  const problems = [];
  const anchorCache = new Map();
  const anchorsOf = (path) => {
    if (!anchorCache.has(path))
      anchorCache.set(path, anchors(readFileSync(join(root, path), 'utf8')));
    return anchorCache.get(path);
  };
  for (const file of files) {
    const markdown = readFileSync(join(root, file), 'utf8');
    for (const { line, target } of links(markdown)) {
      const [pathPart, anchor] = target.split('#');
      const path = pathPart
        ? normalize(join(dirname(file), decodeURIComponent(pathPart)))
        : file;
      if (path.startsWith('..') || !existsSync(join(root, path))) {
        problems.push(`${file}:${line} links to missing ${target}`);
        continue;
      }
      if (anchor && path.endsWith('.md') && !anchorsOf(path).has(anchor))
        problems.push(`${file}:${line} links to missing heading ${target}`);
    }
  }
  return problems;
}

const read = (path) => readFileSync(join(root, path), 'utf8');
const capture = (text, pattern, what) => {
  const match = pattern.exec(text);
  if (!match) throw new Error(`cannot find ${what}`);
  return match.slice(1).map(Number);
};

/** A millisecond constant in the cue engine, in seconds. */
function engineSeconds(name) {
  const match = new RegExp(`const ${name}: u64 = ([\\d_]+);`).exec(
    read('src-tauri/src/engine.rs'),
  );
  if (!match) throw new Error(`cannot find ${name} in engine.rs`);
  return Number(match[1].replaceAll('_', '')) / 1000;
}

// Numbers a document quotes from the source. Each entry reads both sides, so
// changing the source without the document (or the reverse) fails here.
const FACTS = [
  {
    claim: 'DESIGN.md: height of the companion window showing a question',
    doc: () =>
      capture(
        read('DESIGN.md'),
        /A question uses (\d+) of height/,
        'the question height in DESIGN.md',
      ),
    source: () =>
      capture(
        read('src-tauri/src/companion.rs'),
        /Mode::Question => (\d+)\.0/,
        'Mode::Question height in companion.rs',
      ),
  },
  {
    claim: 'DESIGN.md: size of the resting companion bar',
    doc: () =>
      capture(
        read('DESIGN.md'),
        /resting bar is (\d+) × (\d+) logical pixels/,
        'the resting bar size in DESIGN.md',
      ),
    source: () => {
      const text = read('src-tauri/src/companion.rs');
      return [
        ...capture(text, /COMPACT_WIDTH: f64 = (\d+)\.0/, 'COMPACT_WIDTH'),
        ...capture(text, /_ => (\d+)\.0,\n\s*\} \+ if question/, 'bar height'),
      ];
    },
  },
  {
    claim: 'ROADMAP.md: how long an unread cue and an "asked you" cue stay',
    doc: () =>
      capture(
        read('ROADMAP.md'),
        /an unread suggestion expires after (\d+) s \((\d+) s for a question asked of you by name\)/,
        'the cue lifetimes in ROADMAP.md',
      ),
    source: () => ['CUE_MS', 'ASKED_MS'].map(engineSeconds),
  },
  {
    claim: 'docs/note-file-formats.md: lines searched for a Date: line',
    doc: () =>
      capture(
        read('docs/note-file-formats.md'),
        /among the note's first (\d+) non-blank lines/,
        'the date-line search in docs/note-file-formats.md',
      ),
    source: () =>
      capture(
        read('src-tauri/src/notes_file.rs'),
        /const DATE_LINE_SEARCH: usize = (\d+);/,
        'DATE_LINE_SEARCH in notes_file.rs',
      ),
  },
];

function checkFacts() {
  const problems = [];
  for (const fact of FACTS) {
    try {
      const doc = fact.doc();
      const source = fact.source();
      if (doc.join() !== source.join())
        problems.push(
          `${fact.claim}: the document says ${doc.join(' × ')}, the source says ${source.join(' × ')}`,
        );
    } catch (error) {
      problems.push(`${fact.claim}: ${error.message}`);
    }
  }
  return problems;
}

/** App source changed with no Markdown change: worth a second look. */
function docsReminder(base, head) {
  const changed = git('diff', '--name-only', `${base}...${head}`)
    .split('\n')
    .filter(Boolean);
  const app = changed.filter(
    (file) =>
      /^(src|src-tauri\/src)\//.test(file) &&
      !/\.(test|spec)\.|\/tests?\//.test(file),
  );
  const docs = changed.filter((file) => file.endsWith('.md'));
  if (app.length && !docs.length)
    return `${app.length} app source file(s) changed and no documentation did. If README, DESIGN.md, ROADMAP.md and docs/ are still accurate, say so in the PR under "Documentation reviewed".`;
  return null;
}

if (isMain(import.meta.url)) {
  const files = git('ls-files', '*.md').split('\n').filter(Boolean);
  const problems = [...checkLinks(files), ...checkFacts()];
  const { CONTRIBUTION_BASE: base, CONTRIBUTION_HEAD: head } = process.env;
  if (base && head) {
    const reminder = docsReminder(base, head);
    if (reminder)
      console.log(
        `${process.env.GITHUB_ACTIONS ? '::warning::' : 'Reminder: '}${reminder}`,
      );
  }
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    console.error(`\n${problems.length} documentation problem(s).`);
    process.exit(1);
  }
  console.log(
    `Checked links in ${files.length} Markdown files and ${FACTS.length} source-backed facts.`,
  );
}
