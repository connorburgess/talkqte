import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { cue, firstCue, firstLine, standIn } from './fixtures/stand-in';

// Automated accessibility checks of each screen in the states a person
// meets during a session, on the fictional native stand-in. axe-core checks
// roles, names, states and structure; contrast is the design lane's check
// and is left out here. Passing these does not establish VoiceOver
// behavior, which still needs a person on a Mac.

async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
      'wcag22aa',
      'best-practice',
    ])
    .disableRules(['color-contrast'])
    .analyze();
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

const both = {
  microphone: true,
  application: 'Fictional Call',
  applicationAttached: true,
};

async function liveSession(page: Page) {
  await standIn(page, '/?live&processor&keys=set');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeEnabled();
}

test('first-run setup has no automated accessibility violations at any step', async ({
  page,
}) => {
  // No keys stored, so setup opens by itself.
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        '/src/main.tsx',
        '/tests/fixtures/native-microphone.ts',
      ),
    });
  });
  await page.goto('/');
  const setup = page.locator('section.onboarding-flow');
  await expect(setup).toBeVisible();
  for (const next of [
    'Next: Your keys',
    'Next: Permissions',
    'Next: First session',
    null,
  ]) {
    expect(await violations(page), `before ${next}`).toEqual([]);
    if (next) await setup.getByRole('button', { name: next }).click();
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await violations(page), 'skip confirmation').toEqual([]);
});

test('the notebook, the review and a two-source session with a cue have no automated accessibility violations', async ({
  page,
}) => {
  await standIn(page, '/?live&processor&keys=set');
  const startLive = page.getByRole('button', {
    name: 'Start live session',
    exact: true,
  });
  await expect(startLive).toBeVisible();
  expect(await violations(page), 'before a session').toEqual([]);
  await startLive.click();
  const panel = page.getByRole('region', {
    name: 'Cue processing',
    exact: true,
  });
  expect(await violations(page), 'active session').toEqual([]);
  await panel
    .getByRole('button', { name: 'Turn off processing', exact: true })
    .click();
  await panel
    .getByRole('button', { name: 'Review processing', exact: true })
    .click();
  expect(await violations(page), 'review').toEqual([]);
  await panel.getByRole('button', { name: 'Review selected sources' }).click();
  expect(await violations(page), 'approval').toEqual([]);
  await panel.getByRole('button', { name: 'Enable for this session' }).click();
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources: {
          ...sources,
          echoDropped: 1,
          echoes: [
            {
              id: 'e1',
              atMs: 3_000,
              speaker: 'You',
              text: 'Fictional echoed line.',
            },
          ],
        },
        transcript: [
          {
            id: 't1-0-0',
            atMs: 1_000,
            speaker: 'You',
            source: 'microphone',
            text: 'Fictional line from the microphone.',
          },
          {
            id: 't1-0-1',
            atMs: 2_000,
            speaker: 'Them',
            source: 'application',
            text: 'Fictional line from the call.',
          },
        ],
      } as never),
    both,
  );
  await page.evaluate(
    ([line, question]) => window.liveTest.say(line, question),
    [firstLine, firstCue],
  );
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toBeVisible();
  expect(await violations(page), 'live with a cue').toEqual([]);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(await violations(page), 'settings').toEqual([]);
});

test('an active microphone check has no automated accessibility violations in Settings or the compact Notebook bar', async ({
  page,
}) => {
  await standIn(page, '/?live&keys=set');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(await violations(page), 'settings idle mic').toEqual([]);
  await page
    .getByRole('button', { name: 'Start microphone', exact: true })
    .click();
  await page.evaluate(() =>
    window.microphoneTest.send({
      status: 'listening',
      activity: 'active',
      deviceName: 'Fictional microphone',
    }),
  );
  expect(await violations(page), 'settings active mic').toEqual([]);
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Microphone', exact: true })
      .getByRole('button', { name: 'Stop microphone', exact: true }),
  ).toBeVisible();
  expect(await violations(page), 'notebook compact active mic').toEqual([]);
});

test('an ended session, its meeting notes offer and the export review have no automated accessibility violations', async ({
  page,
}) => {
  await liveSession(page);
  await page.evaluate(
    ([line, question]) => window.liveTest.say(line, question),
    [firstLine, firstCue],
  );
  await page.evaluate(() =>
    window.liveTest.publish({
      status: 'ended',
      cue: null,
      meetingNotes: 'none',
    } as never),
  );
  await expect(
    page.getByRole('heading', { name: 'Live session ended', level: 1 }),
  ).toBeVisible();
  expect(await violations(page), 'ended').toEqual([]);
  const write = page.getByRole('button', { name: 'Write meeting notes…' });
  if (await write.count()) {
    await write.click();
    expect(await violations(page), 'meeting notes confirm').toEqual([]);
    await page.keyboard.press('Escape');
  }
  await page
    .getByRole('button', { name: 'Export Markdown…', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await violations(page), 'export review').toEqual([]);
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    window.historyTest.add({
      title: 'Fictional orchard sync',
      startedAtMs: Date.UTC(2026, 10, 4, 9),
      durationMs: 600_000,
      sources: 'microphone',
      transcript: [{ atMs: 1_000, text: 'The keys are in the blue tin.' }],
      notes: 'Bring the ladder.',
      cues: [],
    });
  });
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Meetings', level: 1 }),
  ).toBeVisible();
  expect(await violations(page), 'meetings list').toEqual([]);

  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByRole('textbox', { name: 'Folder name' }).fill('Client A');
  await page
    .getByRole('button', { name: 'Create folder', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Folder for Fictional orchard sync' })
    .selectOption('Client A');
  await expect(
    page.getByRole('list', { name: 'Meetings in Client A' }),
  ).toBeVisible();
  expect(await violations(page), 'meetings list with folder').toEqual([]);

  await page.getByRole('button', { name: /^Fictional orchard sync/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Fictional orchard sync', level: 1 }),
  ).toBeVisible();
  expect(await violations(page), 'kept meeting detail').toEqual([]);
  await page
    .getByRole('button', { name: 'Export Markdown…', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await violations(page), 'kept meeting export').toEqual([]);
});

test('the companion with a cue and with the call-starting offer has no automated accessibility violations', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 232 });
  await standIn(page, '/?window=cue');
  await page.evaluate(() => window.liveTest.start());
  await page.evaluate(
    ([line, question]) => window.liveTest.say(line, question),
    [firstLine, firstCue],
  );
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toBeVisible();
  expect(await violations(page), 'companion cue').toEqual([]);
  await page.setViewportSize({ width: 320, height: 160 });
  await standIn(page, '/?window=cue');
  await page.evaluate(() =>
    window.liveTest.publish({
      callPrompt: { id: 7, application: 'Fictional Call', kind: 'meeting' },
    } as never),
  );
  await expect(page.getByRole('status')).toHaveText('Call in Fictional Call');
  expect(await violations(page), 'call-starting offer').toEqual([]);
});

const cueRegion = (page: Page) =>
  page.getByRole('status', { name: 'Cue', exact: true });

test('a new cue is announced once through a region that was there before it, and its countdown is not re-read', async ({
  page,
}) => {
  await liveSession(page);
  const region = cueRegion(page);
  // Present and empty before any cue, so its first words are a change.
  await expect(region).toHaveCount(1);
  await expect(region).toHaveText('');
  await page.evaluate(
    ([line, question]) => window.liveTest.say(line, question),
    [firstLine, firstCue],
  );
  await expect(region).toHaveText(`You could ask: ${firstCue}`);
  // The card's own heading is not a second live region.
  await expect(
    page
      .getByRole('region', { name: 'Suggested question' })
      .locator('[aria-live]:not(.question-warning)'),
  ).toHaveCount(0);
  const changes = await page.evaluate(() => {
    const target = [...document.querySelectorAll('[role="status"]')].find(
      (node) => node.getAttribute('aria-label') === 'Cue',
    )!;
    const seen: string[] = [];
    new MutationObserver(() => seen.push(target.textContent ?? '')).observe(
      target,
      { childList: true, characterData: true, subtree: true },
    );
    (window as unknown as { cueChanges: string[] }).cueChanges = seen;
    return seen.length;
  });
  expect(changes).toBe(0);
  // The countdown and a hold change the card, not what was announced.
  await page.evaluate(() =>
    window.liveTest.setCue({
      ...window.liveTest.session().cue!,
      remainingMs: 9_000,
      held: true,
    }),
  );
  await expect(
    page.getByRole('button', { name: 'Held', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { cueChanges: string[] }).cueChanges,
    ),
  ).toEqual([]);
  // A different cue is announced; a cleared one empties the region quietly.
  await page.evaluate(
    (next) => window.liveTest.setCue(next),
    cue({
      id: 'live:second',
      kind: 'Open question',
      question: 'Which room holds the fictional potluck?',
    }),
  );
  await expect(region).toHaveText(
    'Asked the group: Which room holds the fictional potluck?',
  );
  await page.evaluate(() => window.liveTest.setCue(null));
  await expect(region).toHaveText('');
});

test('the companion never announces cues itself, so a cue is not read twice', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 232 });
  await standIn(page, '/?window=cue');
  await page.evaluate(() => window.liveTest.start());
  await page.evaluate(
    ([line, question]) => window.liveTest.say(line, question),
    [firstLine, firstCue],
  );
  await expect(
    page.getByRole('region', { name: 'Suggested question' }),
  ).toBeVisible();
  await expect(cueRegion(page)).toHaveCount(0);
  await expect(page.locator('main [aria-live]')).toHaveCount(0);
});

test('the end of a session and the first marked echo are each said once, politely', async ({
  page,
}) => {
  await liveSession(page);
  const notice = page.getByRole('status').filter({
    hasText: /Live session ended\.|look like a repeat|looks like a/,
  });
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources: { ...sources, echoDropped: 1 },
      } as never),
    both,
  );
  await expect(notice).toHaveText(
    /^1 microphone line looks like a repeat of Fictional Call's sound/,
  );
  // A growing count is shown, not announced again.
  await page.evaluate(
    (sources) =>
      window.liveTest.publish({
        sources: { ...sources, echoDropped: 5 },
      } as never),
    both,
  );
  await expect(page.getByText(/^5 microphone lines look like/)).toBeVisible();
  await expect(notice).toHaveText(/^1 microphone line looks/);
  await expect(
    page.getByRole('status').filter({ hasText: /^5 microphone lines/ }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    window.liveTest.publish({ status: 'ended' } as never),
  );
  await expect(notice).toHaveText('Live session ended.');
  // Nothing in a polite region is an alert.
  await expect(
    page.getByRole('alert').filter({ hasText: 'Live session ended' }),
  ).toHaveCount(0);
});

test('every control in a live session is reached by Tab with a visible focus indicator, and Tab never gets stuck', async ({
  page,
  browserName,
}) => {
  await liveSession(page);
  await page.evaluate(
    ([line, question]) => window.liveTest.say(line, question),
    [firstLine, firstCue],
  );
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const seen: string[] = [];
  const unmarked: string[] = [];
  // Match the full-control traversal used by the narrow keyboard checks:
  // WebKit's default Tab skips buttons; Option-Tab includes all controls.
  for (let press = 0; press < 80; press++) {
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      const marked =
        (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== 'none' ||
        // A control may draw its ring on a child or a pseudo-element.
        [...element.querySelectorAll('*')].some(
          (child) => getComputedStyle(child).outlineStyle !== 'none',
        ) ||
        getComputedStyle(element, '::before').outlineStyle !== 'none' ||
        getComputedStyle(element, '::after').outlineStyle !== 'none' ||
        getComputedStyle(element, '::before').boxShadow !== 'none';
      const name =
        element.getAttribute('aria-label') ||
        element.textContent?.trim().slice(0, 40) ||
        element.tagName;
      return { name: `${element.tagName}:${name}`, marked };
    });
    if (!focused) break;
    if (seen.includes(focused.name) && seen[0] === focused.name) break;
    seen.push(focused.name);
    if (!focused.marked) unmarked.push(focused.name);
  }
  expect(seen.some((name) => name.includes('Stop live session'))).toBe(true);
  expect(seen.some((name) => name.includes('Dismiss'))).toBe(true);
  // Focus moved on from the last control rather than staying in a trap.
  expect(new Set(seen).size).toBeGreaterThan(5);
  expect(unmarked).toEqual([]);
});
