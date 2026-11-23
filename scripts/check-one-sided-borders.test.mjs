import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALLOWED_ONE_SIDED_BORDERS,
  checkCss,
  checkRepository,
  checkTsx,
} from './check-one-sided-borders.mjs';

test('rejects one-sided borders in CSS including logical sides and longhands', () => {
  const css = `
    .card { border-left: 4px solid #875500; }
    .callout { border-inline-start: 3px solid var(--accent-ink); }
    .alert { border-top-width: 2px; }
    @media (max-width: 900px) {
      .chip { border-right: 2px solid var(--ink); }
    }
  `;
  const violations = checkCss(css, 'src/example.css');
  assert.equal(violations.length, 4);
  assert.deepEqual(
    violations.map((v) => v.rule),
    [
      'one-sided-border',
      'one-sided-border',
      'one-sided-border',
      'one-sided-border',
    ],
  );
});

test('allows full four-sided borders and zero/none resets', () => {
  const css = `
    .question.cue-card.cue-asked {
      border: 1.5px solid var(--accent-ink);
    }
    .reset {
      border-right: 0;
      border-bottom: none;
      border-left-width: 0px;
    }
  `;
  assert.deepEqual(checkCss(css, 'src/example.css'), []);
});

test('rejects inset box-shadow accent strips', () => {
  const css = `
    .card { box-shadow: inset 4px 0 0 #875500; }
    .ok { box-shadow: 0 8px 24px rgba(17, 21, 27, 0.05); }
  `;
  const violations = checkCss(css, 'src/example.css');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'inset-box-shadow');
});

test('rejects absolutely positioned thin strip bars while allowing fade overlays and visually-hidden text', () => {
  const css = `
    .cue-edge {
      position: absolute;
      inset: 0 auto 0 0;
      width: 6px;
      background: var(--accent-ink);
    }
    .top-bar-strip::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background-color: #ebb45b;
    }
    .scroll-fade::after {
      content: '';
      position: absolute;
      height: 48px;
      background: linear-gradient(transparent, #ffffff 78%);
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
    }
  `;
  const violations = checkCss(css, 'src/example.css');
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => v.rule),
    ['absolute-accent-strip', 'absolute-accent-strip'],
  );
});

test('enforces value rules even for allowlisted divider selectors', () => {
  const good = `.toolbar { border-bottom: 1px solid var(--line); }`;
  assert.deepEqual(checkCss(good, 'src/styles.css'), []);

  const badThick = `.toolbar { border-bottom: 4px solid var(--accent-ink); }`;
  assert.equal(checkCss(badThick, 'src/styles.css').length, 1);

  const badAccent = `.toolbar { border-bottom: 1px solid var(--accent-ink); }`;
  assert.equal(checkCss(badAccent, 'src/styles.css').length, 1);
});

test('rejects inline one-sided borders, inset shadows and strips in TSX', () => {
  const tsx = `
    export function Demo() {
      return (
        <div>
          <div style={{ borderLeft: '4px solid #875500' }} />
          <div style={{ boxShadow: 'inset 3px 0 0 #875500' }} />
          <span style={{ position: 'absolute', width: 4, background: '#875500' }} />
          <div style={{ border: '1.5px solid #875500', borderBottom: 0 }} />
        </div>
      );
    }
  `;
  const violations = checkTsx(tsx, 'src/Demo.tsx');
  assert.deepEqual(
    violations.map((v) => v.rule),
    [
      'inline-one-sided-border',
      'inline-inset-box-shadow',
      'inline-absolute-strip',
    ],
  );
});

test('every allowlist entry documents a reason and the repository passes cleanly', () => {
  for (const entry of ALLOWED_ONE_SIDED_BORDERS) {
    assert.ok(entry.reason.length > 10, `${entry.selector} must have a reason`);
  }
  const result = checkRepository();
  assert.ok(result.cssCount >= 6);
  assert.ok(result.tsxCount >= 1);
  assert.deepEqual(result.violations, []);
});
