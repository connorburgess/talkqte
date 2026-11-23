// Guards against one-sided accent borders and strip bars on cards, cues,
// notes, callouts, alerts, quotes, chips and list items.
//
// Full-width neutral 1px hairlines used as section or row dividers must be
// listed in ALLOWED_ONE_SIDED_BORDERS with a one-line reason and still pass
// value checks.
//
//   node scripts/check-one-sided-borders.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ONE_SIDED_BORDER_RE =
  /^border-(?:top|right|bottom|left|inline(?:-start|-end)?|block(?:-start|-end)?)(?:-(?:width|style|color))?$/i;

const NEUTRAL_HAIRLINE_RE =
  /^1px\s+(?:solid|dashed)\s+var\(--(?:line|cue-rule)\)$/i;

const ZERO_OR_NONE_RE = /^(?:0(?:px|rem|em|%)?|none|hidden)$/i;

/**
 * Explicitly reviewed one-sided rules currently permitted in the app.
 * Adding a new entry requires a clear structural divider reason; accent bars
 * or card edge borders must never be allowlisted here.
 */
export const ALLOWED_ONE_SIDED_BORDERS = [
  {
    file: 'src/components/cue-card.css',
    selector: '.cue-card .cue-answer > .cue-source::after',
    property: 'border-top',
    kind: 'hairline',
    reason: 'Full-width 1px neutral divider between an answer and its source.',
  },
  {
    file: 'src/components/processing.css',
    selector: '.processing-panel',
    property: 'border-top',
    kind: 'hairline',
    reason: 'Full-width 1px neutral section divider above Cue processing.',
  },
  {
    file: 'src/components/processing.css',
    selector: '.processing-review',
    property: 'border-top',
    kind: 'hairline',
    reason: 'Full-width 1px neutral section divider above approval review.',
  },
  {
    file: 'src/components/processing.css',
    selector: '.processing-note',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral divider below the review note.',
  },
  {
    file: 'src/components/processing.css',
    selector: '.processing-review dl',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral closing hairline under the review table.',
  },
  {
    file: 'src/components/processing.css',
    selector: '.processing-review dt',
    property: 'border-top',
    kind: 'hairline',
    reason: 'Full-width 1px neutral row divider in the review table.',
  },
  {
    file: 'src/components/processing.css',
    selector: '.processing-review dd',
    property: 'border-top',
    kind: 'hairline',
    reason: 'Full-width 1px neutral row divider in the review table.',
  },
  {
    file: 'src/components/processing.css',
    selector: '.processing-panel .processing-dev-label',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral dashed hairline for development controls.',
  },
  {
    file: 'src/components/processing.css',
    selector: '.notebook-processing .processing-panel',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral section divider below Cue processing.',
  },
  {
    file: 'src/styles.css',
    selector: '.version',
    property: 'border-top',
    kind: 'hairline',
    reason: 'Full-width 1px neutral divider above the sidebar version footer.',
  },
  {
    file: 'src/styles.css',
    selector: '.meeting-list',
    property: 'border-right',
    kind: 'hairline',
    reason: 'Full-height 1px neutral structural divider beside the sidebar.',
  },
  {
    file: 'src/styles.css',
    selector: '.meeting-list',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral structural divider under the narrow rail.',
  },
  {
    file: 'src/styles.css',
    selector: '.toolbar',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral divider under the top workspace bar.',
  },
  {
    file: 'src/styles.css',
    selector: '.session-strip',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral divider under the session header strip.',
  },
  {
    file: 'src/styles.css',
    selector: '.microphone-panel-body',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral divider under the microphone status row.',
  },
  {
    file: 'src/styles.css',
    selector: '.meeting-focus',
    property: 'border-block',
    kind: 'hairline',
    reason: 'Full-width 1px neutral hairlines framing the focus section.',
  },
  {
    file: 'src/styles.css',
    selector: '.setup-disclosure',
    property: 'border-top',
    kind: 'hairline',
    reason: 'Full-width 1px neutral section divider above setup disclosure.',
  },
  {
    file: 'src/styles.css',
    selector: '.tabs',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral baseline rule under the tab bar.',
  },
  {
    file: 'src/styles.css',
    selector: '.companion-heading',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral divider under the Cues column heading.',
  },
  {
    file: 'src/styles.css',
    selector: '.context-list li',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral row divider between prior-context items.',
  },
  {
    file: 'src/styles.css',
    selector: '.context-choices li + li',
    property: 'border-top',
    kind: 'hairline',
    reason: 'Full-width 1px neutral row divider between note picker rows.',
  },
  {
    file: 'src/styles.css',
    selector: '.notebook-footer',
    property: 'border-top',
    kind: 'hairline',
    reason: 'Full-width 1px neutral divider above the notebook footer.',
  },
  {
    file: 'src/styles.css',
    selector: '.setting',
    property: 'border-bottom',
    kind: 'hairline',
    reason: 'Full-width 1px neutral row divider between Settings sections.',
  },
];

function stripCssComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === '*' && source[i + 1] === '/')
      ) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function parseDeclarations(body, baseOffset, fullText) {
  const declarations = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i <= body.length; i += 1) {
    const ch = i < body.length ? body[i] : ';';
    if (quote) {
      if (ch === '\\' && i + 1 < body.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
    else if (ch === ';' && depth === 0) {
      const raw = body.slice(start, i);
      const colon = raw.indexOf(':');
      if (colon !== -1) {
        const propRaw = raw.slice(0, colon);
        const property = propRaw.trim().toLowerCase();
        const value = raw
          .slice(colon + 1)
          .replace(/\s+/g, ' ')
          .trim();
        const leading = propRaw.length - propRaw.trimStart().length;
        if (property) {
          declarations.push({
            property,
            value,
            line: lineNumberAt(fullText, baseOffset + start + leading),
          });
        }
      }
      start = i + 1;
    }
  }
  return declarations;
}

function parseCssRules(cleanSource) {
  const rules = [];
  function walk(start, end) {
    let i = start;
    let headerStart = start;
    let quote = null;
    while (i < end) {
      const ch = cleanSource[i];
      if (quote) {
        if (ch === '\\' && i + 1 < end) {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === ';') {
        headerStart = i + 1;
        i += 1;
        continue;
      }
      if (ch === '{') {
        const header = cleanSource
          .slice(headerStart, i)
          .replace(/\s+/g, ' ')
          .trim();
        let depth = 1;
        let j = i + 1;
        let innerQuote = null;
        while (j < end && depth > 0) {
          const c = cleanSource[j];
          if (innerQuote) {
            if (c === '\\' && j + 1 < end) {
              j += 2;
              continue;
            }
            if (c === innerQuote) innerQuote = null;
            j += 1;
            continue;
          }
          if (c === '"' || c === "'") {
            innerQuote = c;
          } else if (c === '{') {
            depth += 1;
          } else if (c === '}') {
            depth -= 1;
          }
          j += 1;
        }
        const blockStart = i + 1;
        const blockEnd = j - 1;
        if (header.startsWith('@')) {
          if (!/^@(?:keyframes|font-face)\b/i.test(header)) {
            walk(blockStart, blockEnd);
          }
        } else if (header) {
          const body = cleanSource.slice(blockStart, blockEnd);
          const leading =
            cleanSource.slice(headerStart, i).length -
            cleanSource.slice(headerStart, i).trimStart().length;
          rules.push({
            selector: header,
            line: lineNumberAt(cleanSource, headerStart + leading),
            declarations: parseDeclarations(body, blockStart, cleanSource),
          });
        }
        i = j;
        headerStart = j;
        continue;
      }
      i += 1;
    }
  }
  walk(0, cleanSource.length);
  return rules;
}

function parsePx(value) {
  const match = /^([\d.]+)px$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function isAllowedBorder(file, selector, property, value) {
  const match = ALLOWED_ONE_SIDED_BORDERS.find(
    (entry) =>
      entry.file === file &&
      entry.selector === selector &&
      entry.property === property,
  );
  if (!match) return false;
  return match.kind === 'hairline' && NEUTRAL_HAIRLINE_RE.test(value);
}

function isNonTransparentBackground(value) {
  const v = value.trim().toLowerCase();
  if (!v || v === 'none' || v === 'transparent') return false;
  if (v.includes('linear-gradient') || v.includes('radial-gradient')) {
    return false;
  }
  return true;
}

/** Check a CSS source string for banned one-sided borders and accent strips. */
export function checkCss(source, filePath) {
  const clean = stripCssComments(source);
  const rules = parseCssRules(clean);
  const violations = [];

  for (const rule of rules) {
    const byProp = new Map();
    for (const decl of rule.declarations) {
      byProp.set(decl.property, decl);

      if (ONE_SIDED_BORDER_RE.test(decl.property)) {
        if (ZERO_OR_NONE_RE.test(decl.value)) continue;
        if (
          !isAllowedBorder(filePath, rule.selector, decl.property, decl.value)
        ) {
          violations.push({
            file: filePath,
            line: decl.line,
            rule: 'one-sided-border',
            message: `${rule.selector}: disallowed one-sided border \`${decl.property}: ${decl.value}\``,
          });
        }
      }

      if (
        decl.property === 'box-shadow' &&
        /\binset\b/i.test(decl.value) &&
        !/^none$/i.test(decl.value)
      ) {
        violations.push({
          file: filePath,
          line: decl.line,
          rule: 'inset-box-shadow',
          message: `${rule.selector}: disallowed inset box-shadow \`${decl.value}\``,
        });
      }
    }

    const position = byProp.get('position')?.value.toLowerCase();
    if (position === 'absolute' || position === 'fixed') {
      const bg = byProp.get('background') || byProp.get('background-color');
      if (bg && isNonTransparentBackground(bg.value)) {
        const w = byProp.get('width')
          ? parsePx(byProp.get('width').value)
          : null;
        const h = byProp.get('height')
          ? parsePx(byProp.get('height').value)
          : null;
        const thinWidth = w !== null && w > 0 && w <= 8;
        const thinHeight = h !== null && h > 0 && h <= 8;
        if (thinWidth || thinHeight) {
          violations.push({
            file: filePath,
            line: rule.line,
            rule: 'absolute-accent-strip',
            message: `${rule.selector}: disallowed thin positioned strip (${thinWidth ? `width: ${w}px` : `height: ${h}px`} with background \`${bg.value}\`)`,
          });
        }
      }
    }
  }

  return violations;
}

const TSX_ONE_SIDED_BORDER_RE =
  /\b(border(?:Top|Right|Bottom|Left|Inline(?:Start|End)?|Block(?:Start|End)?)(?:Width|Style|Color)?)\s*:\s*([^,}\n]+)/g;

const TSX_INSET_SHADOW_RE =
  /\bboxShadow\s*:\s*(['"`])([^'"`]*\binset\b[^'"`]*)\1/gi;

function stripTsxComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === '*' && source[i + 1] === '/')
      ) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function extractInlineStyleObjects(cleanSource) {
  const blocks = [];
  const marker = /style\s*=\s*\{\{/g;
  let match;
  while ((match = marker.exec(cleanSource)) !== null) {
    const objStart = match.index + match[0].length - 1;
    let depth = 1;
    let i = objStart + 1;
    let quote = null;
    while (i < cleanSource.length && depth > 0) {
      const ch = cleanSource[i];
      if (quote) {
        if (ch === '\\' && i + 1 < cleanSource.length) {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
      }
      i += 1;
    }
    blocks.push({
      offset: objStart,
      text: cleanSource.slice(objStart, i),
    });
  }
  return blocks;
}

/** Check a TSX source string for inline one-sided borders and accent strips. */
export function checkTsx(source, filePath) {
  const clean = stripTsxComments(source);
  const violations = [];

  for (const block of extractInlineStyleObjects(clean)) {
    TSX_ONE_SIDED_BORDER_RE.lastIndex = 0;
    let match;
    while ((match = TSX_ONE_SIDED_BORDER_RE.exec(block.text)) !== null) {
      const prop = match[1];
      const rawVal = match[2].trim().replace(/^['"`]|['"`]$/g, '');
      if (ZERO_OR_NONE_RE.test(rawVal)) continue;
      violations.push({
        file: filePath,
        line: lineNumberAt(clean, block.offset + match.index),
        rule: 'inline-one-sided-border',
        message: `inline style: disallowed one-sided border \`${prop}: ${match[2].trim()}\``,
      });
    }

    TSX_INSET_SHADOW_RE.lastIndex = 0;
    while ((match = TSX_INSET_SHADOW_RE.exec(block.text)) !== null) {
      violations.push({
        file: filePath,
        line: lineNumberAt(clean, block.offset + match.index),
        rule: 'inline-inset-box-shadow',
        message: `inline style: disallowed inset boxShadow \`${match[2]}\``,
      });
    }

    const posMatch = /\bposition\s*:\s*['"`](absolute|fixed)['"`]/.exec(
      block.text,
    );
    const bgMatch =
      /\b(?:background|backgroundColor)\s*:\s*(['"`])([^'"`]+)\1/.exec(
        block.text,
      );
    if (posMatch && bgMatch && isNonTransparentBackground(bgMatch[2])) {
      const dimMatch =
        /\b(width|height)\s*:\s*(?:['"`]([\d.]+)px['"`]|([\d.]+))\b/.exec(
          block.text,
        );
      const px = dimMatch ? Number(dimMatch[2] ?? dimMatch[3]) : null;
      if (px !== null && px > 0 && px <= 8) {
        violations.push({
          file: filePath,
          line: lineNumberAt(clean, block.offset + dimMatch.index),
          rule: 'inline-absolute-strip',
          message: `inline style: disallowed thin positioned strip (${dimMatch[1]}: ${px}px with background \`${bgMatch[2]}\`)`,
        });
      }
    }
  }

  return violations;
}

function collectFiles(dir, predicate, results = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, predicate, results);
    } else if (predicate(full)) {
      results.push(full);
    }
  }
  return results;
}

/** Scan all CSS and TSX files under src/ in the given repository root. */
export function checkRepository(repoRoot = root) {
  const srcDir = join(repoRoot, 'src');
  const cssFiles = collectFiles(srcDir, (file) => file.endsWith('.css')).sort();
  const tsxFiles = collectFiles(srcDir, (file) => file.endsWith('.tsx')).sort();
  const violations = [];

  for (const file of cssFiles) {
    const rel = relative(repoRoot, file).replaceAll('\\', '/');
    violations.push(...checkCss(readFileSync(file, 'utf8'), rel));
  }
  for (const file of tsxFiles) {
    const rel = relative(repoRoot, file).replaceAll('\\', '/');
    violations.push(...checkTsx(readFileSync(file, 'utf8'), rel));
  }

  return {
    cssCount: cssFiles.length,
    tsxCount: tsxFiles.length,
    violations,
  };
}

if (isMain(import.meta.url)) {
  const { cssCount, tsxCount, violations } = checkRepository(root);
  if (violations.length) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line} [${v.rule}] ${v.message}`);
    }
    console.error(
      `\n${violations.length} disallowed one-sided border or strip violation(s) found.`,
    );
    process.exit(1);
  }
  console.log(
    `Checked ${cssCount} CSS file(s) and ${tsxCount} TSX file(s): no disallowed one-sided borders or accent strips.`,
  );
}
