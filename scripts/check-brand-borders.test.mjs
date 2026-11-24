import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = join(root, 'docs', 'brand', 'index.html');
const tokensPath = join(root, 'docs', 'brand', 'tokens.css');

// Every allowed one-sided border in docs/brand/index.html must be a 1px neutral
// hairline divider using a line/border token, with a one-line reason.
const ALLOWLIST = {
  '.guide-header':
    'Full-width 1px neutral hairline under specimen guide header.',
  '.guide-tag':
    '1px neutral vertical hairline separating wordmark and document tag.',
  '.cover':
    'Full-width 1px neutral hairline separating cover from specimen sheets.',
  '.cover-meta': '1px neutral hairline above cover metadata grid.',
  '.sheet': 'Full-width 1px neutral hairline separating specimen sheets.',
  '.sheet-head':
    '1px neutral hairline separating sheet heading from sheet body.',
  '.ref-card figcaption':
    '1px neutral hairline between studio screenshot and caption.',
  '.cmp-top': '1px neutral hairline under comparison column header.',
  '.cmp-swatches': '1px neutral hairline under comparison palette strip.',
  '.cmp-mini-hero':
    '1px neutral hairline separating mini hero from cue preview.',
  '.cmp-note':
    '1px neutral hairline separating cue preview from alignment note.',
  '.sw-chip': '1px neutral hairline between colour swatch chip and label.',
  '.nb-sidebar':
    '1px neutral hairline separating notebook sidebar from workspace.',
  '.nb-version': '1px neutral hairline above sidebar version line.',
  '.nb-toolbar': '1px neutral hairline under notebook top toolbar.',
  '.nb-live-bar': '1px neutral hairline under live capture status bar.',
  '.nb-session-head': '1px neutral hairline under notebook session strip.',
  '.nb-notes-pane':
    '1px neutral hairline separating Notes/Transcript pane from Cues pane.',
  '.nb-tabs': '1px neutral hairline under Notes/Transcript tab bar.',
  '.nb-cue-source':
    '1px neutral hairline separating cue timeline from quoted source.',
  '.nb-disclosures': '1px neutral hairline starting disclosure rows.',
  '.nb-disclosure-row': '1px neutral hairline separating disclosure rows.',
  '.comp-stays':
    '1px neutral hairline separating no-countdown note from quoted source.',
  '.comp-answer-block':
    '1px neutral hairline separating later answer from original source.',
  '.sm-header': '1px neutral hairline under talkqte.com hero preview header.',
  '.type-table th':
    '1px neutral hairline under typography specimen header cells.',
  '.type-table td': '1px neutral hairline separating typography specimen rows.',
  '.panel-section':
    '1px neutral hairline separating notebook panel specimen sections.',
  '.panel-row': '1px neutral hairline separating notebook panel rows.',
  '.panel-dl dt': '1px neutral hairline separating review summary rows.',
  '.panel-dl dd': '1px neutral hairline separating review summary values.',
  '.panel-dl': '1px neutral hairline closing review summary definition list.',
  '.panel-dev-label':
    '1px neutral hairline under Development build group label.',
  '.panel-transcript-row': '1px neutral hairline separating transcript lines.',
  '.panel-setting-row': '1px neutral hairline separating Settings rows.',
  '.sk-row': '1px neutral hairline separating Service keys provider rows.',
  '.ob-head': '1px neutral hairline under Onboarding step header.',
  '.ob-foot': '1px neutral hairline above Onboarding step footer actions.',
  '.ob-a11y-row':
    '1px neutral hairline separating Keyboard and VoiceOver order blocks.',
  '.km-cue-row':
    '1px neutral hairline separating chronological Shown cues rows.',
  '.km-summary-sep':
    '1px neutral hairline separating Keep this meeting from Not built summary.',
  '.tw-points li':
    '1px neutral hairline separating Two ways comparison bullet items.',
  '.up-notes-section':
    '1px neutral hairline separating structured meeting notes sections.',
  '.panel-note-row': '1px neutral hairline separating Prior context note rows.',
  '.panel-footer-line': '1px neutral hairline above notebook footer note.',
  '.dock-matrix-head':
    '1px neutral hairline under dock matrix subsection heading.',
  '.history-banner':
    'Full-width 1px neutral hairline separating adopted work from history appendix.',
};

const ONE_SIDED_PROP =
  /^border-(?:top|right|bottom|left|inline|inline-start|inline-end|block|block-start|block-end)(?:-(?:width|style|color))?$/i;

const NEUTRAL_1PX_VALUE =
  /^1px\s+(?:solid|dashed)\s+var\(--(?:g-line|d-line|line|border|d-border)\)$/i;

const STRIP_NAME = /(?:^|[\s.#_-])(?:cue|asked|accent|card)-edge\b/i;

function parseRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let i = 0;

  function walk(end) {
    while (i < end) {
      while (i < end && /\s/.test(clean[i])) i++;
      if (i >= end) break;
      const start = i;
      while (i < end && clean[i] !== '{' && clean[i] !== '}') i++;
      if (i >= end || clean[i] === '}') {
        i++;
        return;
      }
      const selector = clean.slice(start, i).trim();
      i++;
      if (selector.startsWith('@media') || selector.startsWith('@supports')) {
        walk(end);
        continue;
      }
      const bodyStart = i;
      let depth = 1;
      while (i < end && depth > 0) {
        if (clean[i] === '{') depth++;
        else if (clean[i] === '}') depth--;
        i++;
      }
      const body = clean.slice(bodyStart, i - 1);
      if (!selector.startsWith('@')) {
        const declarations = body
          .split(';')
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => {
            const colon = d.indexOf(':');
            if (colon < 0) return null;
            return {
              prop: d.slice(0, colon).trim().toLowerCase(),
              val: d.slice(colon + 1).trim(),
            };
          })
          .filter(Boolean);
        rules.push({ selector, declarations });
      }
    }
  }

  walk(clean.length);
  return rules;
}

function isZeroBorder(val) {
  return /^(?:0(?:px|rem|em)?|none)$/i.test(val.trim());
}

function checkCss(css, sourceLabel) {
  const violations = [];
  for (const { selector, declarations } of parseRules(css)) {
    if (STRIP_NAME.test(selector)) {
      violations.push(`${sourceLabel}: forbidden strip selector ${selector}`);
    }
    const selectors = selector.split(',').map((s) => s.trim());
    for (const { prop, val } of declarations) {
      if (ONE_SIDED_PROP.test(prop)) {
        if (isZeroBorder(val)) continue;
        const allAllowed = selectors.every((s) => Object.hasOwn(ALLOWLIST, s));
        if (!allAllowed || !NEUTRAL_1PX_VALUE.test(val)) {
          violations.push(`${sourceLabel}: ${selector} { ${prop}: ${val}; }`);
        }
      }
      if (prop === 'box-shadow' && /\binset\b/i.test(val)) {
        if (/[1-9]\d*(?:\.\d+)?(?:px|rem|em)/i.test(val)) {
          violations.push(`${sourceLabel}: ${selector} { ${prop}: ${val}; }`);
        }
      }
      if (/^--[a-z0-9-]*(?:edge|top-rule)[a-z0-9-]*$/i.test(prop)) {
        violations.push(
          `${sourceLabel}: forbidden edge/one-sided token ${prop}`,
        );
      }
    }
  }
  return violations;
}

test('docs/brand/index.html styles and inline styles obey the no-one-sided-border rule', () => {
  const html = readFileSync(indexPath, 'utf8');
  const violations = [];

  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    violations.push(...checkCss(match[1], 'docs/brand/index.html <style>'));
  }

  for (const match of html.matchAll(/\bstyle="([^"]*)"/gi)) {
    const decls = match[1]
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean);
    for (const d of decls) {
      const colon = d.indexOf(':');
      if (colon < 0) continue;
      const prop = d.slice(0, colon).trim().toLowerCase();
      const val = d.slice(colon + 1).trim();
      if (ONE_SIDED_PROP.test(prop) && !isZeroBorder(val)) {
        violations.push(`docs/brand/index.html inline style: ${prop}: ${val}`);
      }
      if (
        prop === 'box-shadow' &&
        /\binset\b/i.test(val) &&
        /[1-9]\d*(?:\.\d+)?(?:px|rem|em)/i.test(val)
      ) {
        violations.push(`docs/brand/index.html inline style: ${prop}: ${val}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('docs/brand/tokens.css obeys the no-one-sided-border rule', () => {
  const css = readFileSync(tokensPath, 'utf8');
  assert.deepEqual(checkCss(css, 'docs/brand/tokens.css'), []);
});
