// N2: what a reminder and the prior-context panel say about a Granola copy
// the last update check could not confirm. Simulated provider and fictional
// notes only; the eligibility rules themselves are tested in Rust
// (src-tauri/src/context_refresh.rs).
import { expect, test, type Page } from '@playwright/test';
import { CHECKED_AT_MS } from './fixtures/native-granola-times';
import type {} from './fixtures/native-granola';
import type { Cue } from '../src/lib/types';

// Rendered times must not depend on, or reveal, the machine's settings.
test.use({ timezoneId: 'UTC', locale: 'en-GB' });

const reminder: Cue = {
  id: 'fictional-reminder',
  kind: 'Context',
  question: 'Garden welcome guide',
  evidence: 'Robin will label the watering cans before the open day.',
  sourceId: 'granola:garden-0',
  remainingMs: 18_000,
  totalMs: 18_000,
  held: false,
  expanded: false,
  resolvedBy: null,
  note: {
    title: 'Garden welcome guide',
    sourceDate: '2026-11-02',
    provider: 'granola',
  },
  aboutFocus: false,
};

async function nativePage(page: Page, url: string) {
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
  await page.goto(url);
}

async function show(page: Page, cue: Cue) {
  await page.waitForFunction(() => !!window.liveTest);
  await page.evaluate(() => window.liveTest.start());
  await page.evaluate((value) => window.liveTest.setCue(value), cue);
  const question = page.getByRole('region', { name: 'Suggested question' });
  await expect(question).toContainText('Garden welcome guide');
  return question;
}

for (const [name, url] of [
  ['notebook', '/'],
  ['companion', '/?window=cue'],
] as const) {
  test(`a reminder from an unconfirmed copy says so and when it was last confirmed (${name})`, async ({
    page,
  }) => {
    await nativePage(page, url);
    const question = await show(page, {
      ...reminder,
      note: {
        ...reminder.note!,
        unconfirmed: { lastConfirmedMs: CHECKED_AT_MS },
      },
    });
    // Visible at once, beside where the reminder came from.
    await expect(question).toContainText('From your notes');
    await expect(question).toContainText(
      'Its title came up · imported note, 2026-11-02',
    );
    await expect(question).toContainText('Not verified · last confirmed');
    await expect(question.locator('time')).toHaveAttribute(
      'datetime',
      new Date(CHECKED_AT_MS).toISOString(),
    );
    await expect(question).not.toContainText(/deleted/i);

    // A copy no check has confirmed says that instead of naming a time.
    await page.evaluate((value) => window.liveTest.setCue(value), {
      ...reminder,
      id: 'fictional-reminder-2',
      note: { ...reminder.note!, unconfirmed: { lastConfirmedMs: null } },
    } satisfies Cue);
    await expect(question).toContainText('Not verified · never confirmed');
    await expect(question.locator('time')).toHaveCount(0);

    // A confirmed or never-checked copy carries no warning.
    await page.evaluate((value) => window.liveTest.setCue(value), {
      ...reminder,
      id: 'fictional-reminder-3',
    });
    await expect(question).toContainText('From your notes');
    await expect(question).not.toContainText('Not verified');
  });
}

test('a held reminder keeps its words when only its warning changes', async ({
  page,
}) => {
  await nativePage(page, '/');
  const held = { ...reminder, held: true };
  const question = await show(page, held);
  const heldControl = question.getByRole('button', {
    name: 'Held',
    exact: true,
  });
  await expect(heldControl).toBeVisible();
  await expect(question).toContainText('Robin will label the watering cans');
  await expect(question).not.toContainText('Not verified');
  await expect(question).toContainText(
    'Its title came up · imported note, 2026-11-02',
  );
  // The same reminder after a check that could not reach the provider.
  await page.evaluate((value) => window.liveTest.setCue(value), {
    ...held,
    note: { ...held.note!, unconfirmed: { lastConfirmedMs: CHECKED_AT_MS } },
  });
  await expect(question).toContainText('Not verified · last confirmed');
  await expect(heldControl).toBeVisible();
  await expect(question).toContainText('Robin will label the watering cans');
  await expect(question).toContainText(
    'Its title came up · imported note, 2026-11-02',
  );
});

test('the panel separates a copy kept out of reminders from one that reminds with a warning', async ({
  page,
}) => {
  await nativePage(page, '/?granola&update-check');
  const context = page.getByRole('region', { name: 'Prior context' });
  const notes = context.getByRole('listitem');
  await page.locator('.context-disclosure > summary').press('Enter');
  await context
    .getByRole('button', { name: 'Connect Granola', exact: true })
    .press('Enter');
  await context
    .getByRole('button', { name: 'Choose Granola notes', exact: true })
    .press('Enter');
  const chooser = page.getByRole('dialog', { name: /Choose notes/ });
  for (const index of [0, 1, 2])
    await chooser.getByRole('checkbox').nth(index).check();
  await chooser.getByRole('button', { name: 'Import 3 selected' }).click();
  await expect(notes).toHaveCount(3);

  await page.evaluate(() =>
    window.granolaTest.setProvider({
      withdrawn: ['garden-0'],
      missing: ['garden-1'],
    }),
  );
  await context
    .getByRole('button', { name: 'Check for updates', exact: true })
    .press('Enter');
  await expect(context.getByRole('status').last()).toContainText(
    'Checked 3 Granola notes: 0 updated, 1 unchanged, 2 not verified.',
  );
  // Reported as withdrawn: kept, out of reminders, never called deleted.
  const withdrawn = notes.nth(0);
  await expect(withdrawn).toContainText(
    'Not verified. Granola reported that this note is no longer available to you. This copy was kept, but it is not used for reminders until a later check or import returns the note.',
  );
  await expect(withdrawn).toContainText('Robin will label the watering cans');
  await expect(withdrawn).not.toContainText(/deleted/i);
  await expect(withdrawn).not.toContainText('A reminder from this note');
  // Not returned: kept and still eligible, with a warning.
  await expect(notes.nth(1)).toContainText(
    'A reminder from this note says it could not be verified.',
  );
  await expect(notes.nth(1)).toContainText('not proof it was deleted');
  await expect(notes.nth(2)).toContainText('Matched Granola when checked');

  // A later check that cannot reach Granola says nothing new about the
  // withdrawn note: it stays out of reminders.
  await page.evaluate(() =>
    window.granolaTest.setProvider({ fail: 'unavailable' }),
  );
  await context
    .getByRole('button', { name: 'Check for updates', exact: true })
    .press('Enter');
  await expect(context.getByRole('alert')).toContainText('you may be offline');
  await expect(withdrawn).toContainText('it is not used for reminders');
  await expect(notes.nth(2)).toContainText(
    'A reminder from this note says it could not be verified.',
  );
  await expect(notes.nth(2)).toContainText('Last confirmed');

  // Disconnecting forgets what was confirmed, not what could not be, and
  // with it every confirmation time, so no note keeps an older history.
  await context
    .getByRole('button', { name: 'Disconnect Granola', exact: true })
    .press('Enter');
  await expect(
    context.getByRole('button', { name: 'Connect Granola', exact: true }),
  ).toBeFocused();
  await expect(notes).toHaveCount(3);
  await expect(withdrawn).toContainText('it is not used for reminders');
  await expect(notes.nth(1)).toContainText('Not verified.');
  await expect(notes.nth(2)).toContainText('Not verified.');
  await expect(notes.nth(2)).not.toContainText('Matched Granola');
  await expect(context).not.toContainText('Last confirmed');

  // Importing the withdrawn note again is a fresh read of it.
  await context
    .getByRole('button', { name: 'Connect Granola', exact: true })
    .press('Enter');
  await context
    .getByRole('button', { name: 'Choose Granola notes', exact: true })
    .press('Enter');
  for (const index of [0, 1, 2])
    await chooser.getByRole('checkbox').nth(index).check();
  await chooser.getByRole('button', { name: 'Import 3 selected' }).click();
  await expect(chooser).not.toBeVisible();
  await expect(notes).toHaveCount(3);
  await expect(context).not.toContainText('Not verified.');
});

for (const fail of ['revoked', 'unavailable'] as const) {
  test(`after a check that ends ${fail}, each note says whether it still reminds`, async ({
    page,
  }) => {
    await nativePage(page, '/?granola&update-check');
    const context = page.getByRole('region', { name: 'Prior context' });
    await page.locator('.context-disclosure > summary').press('Enter');
    await context
      .getByRole('button', { name: 'Connect Granola', exact: true })
      .press('Enter');
    await context
      .getByRole('button', { name: 'Choose Granola notes', exact: true })
      .press('Enter');
    const chooser = page.getByRole('dialog', { name: /Choose notes/ });
    await chooser.getByRole('checkbox').nth(0).check();
    await chooser.getByRole('button', { name: 'Import 1 selected' }).click();
    await page.evaluate(
      (value) => window.granolaTest.setProvider({ fail: value }),
      fail,
    );
    await context
      .getByRole('button', { name: 'Check for updates', exact: true })
      .press('Enter');
    await expect(context.getByRole('alert')).toBeVisible();
    const note = context.getByRole('listitem').first();
    await expect(note).toContainText('Robin will label the watering cans');
    if (fail === 'revoked') {
      // Only the checked notes are held back; the banner says so.
      await expect(context.getByRole('alert')).toContainText(
        'The notes this check covered stay until you remove them, but are not used for reminders until a later check or import returns them. Notes imported while it ran are not affected.',
      );
      await expect(context.getByRole('alert')).not.toContainText('Your copies');
      await expect(note).toContainText(
        'it is not used for reminders until a later check or import returns the note',
      );
      await expect(note).not.toContainText('A reminder from this note');
    } else
      await expect(note).toContainText(
        'A reminder from this note says it could not be verified.',
      );
    await expect(note).not.toContainText(/deleted/i);
  });
}

for (const [fail, withheld] of [
  ['unavailable', true],
  ['workspaceChanged', false],
] as const) {
  test(`a withdrawal reported before a check ends ${fail} is ${withheld ? 'kept' : 'not applied'}`, async ({
    page,
  }) => {
    await nativePage(page, '/?granola&update-check');
    const context = page.getByRole('region', { name: 'Prior context' });
    await page.locator('.context-disclosure > summary').press('Enter');
    await context
      .getByRole('button', { name: 'Connect Granola', exact: true })
      .press('Enter');
    await context
      .getByRole('button', { name: 'Choose Granola notes', exact: true })
      .press('Enter');
    const chooser = page.getByRole('dialog', { name: /Choose notes/ });
    await chooser.getByRole('checkbox').nth(0).check();
    await chooser.getByRole('button', { name: 'Import 1 selected' }).click();
    await page.evaluate(
      (value) =>
        window.granolaTest.setProvider({
          fail: value,
          withdrawn: ['garden-0'],
        }),
      fail,
    );
    await context
      .getByRole('button', { name: 'Check for updates', exact: true })
      .press('Enter');
    await expect(context.getByRole('alert')).toBeVisible();
    const note = context.getByRole('listitem').first();
    if (withheld)
      await expect(note).toContainText(
        'Granola reported that this note is no longer available to you.',
      );
    else {
      await expect(note).not.toContainText('no longer available');
      await expect(note).toContainText(
        'A reminder from this note says it could not be verified.',
      );
    }
  });
}

test('the warning region is in place before the warning arrives, so its change can be announced', async ({
  page,
}) => {
  await nativePage(page, '/');
  const question = await show(page, reminder);
  const region = question.locator('[aria-live="polite"].question-warning');
  await expect(region).toHaveCount(1);
  await expect(region).toBeEmpty();
  await region.evaluate((node) => node.setAttribute('data-same-node', ''));
  await page.evaluate((value) => window.liveTest.setCue(value), {
    ...reminder,
    note: {
      ...reminder.note!,
      unconfirmed: { lastConfirmedMs: CHECKED_AT_MS },
    },
  } satisfies Cue);
  // The same element now carries the warning: it was updated, not mounted.
  await expect(question.locator('[data-same-node]')).toContainText(
    'Not verified · last confirmed',
  );
  // Other cues have no such region.
  await page.evaluate((value) => window.liveTest.setCue(value), {
    ...reminder,
    id: 'fictional-question',
    kind: 'Owner',
    note: null,
  } satisfies Cue);
  await expect(question.locator('.question-warning')).toHaveCount(0);
});

for (const size of ['standard', 'large'] as const) {
  test(`the companion fits a reminder with its warning in ${size} text`, async ({
    page,
  }) => {
    // Native companion sizes (companion.rs, glance.spec.ts): 360 px wide on
    // a small display, 420 otherwise; 340 px tall for a cue, 420 with large
    // text. Holding a cue does not change them.
    const windowHeight = size === 'large' ? 420 : 340;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await nativePage(page, '/?window=cue');
    await page.waitForFunction(() => !!window.liveTest);
    await page.evaluate(() => window.liveTest.start());
    await page.evaluate(
      (value) => window.liveTest.setQuestionSize(value),
      size,
    );
    const question = page.getByRole('region', { name: 'Suggested question' });
    const fits = () =>
      page.evaluate(
        () =>
          document.querySelector('main')!.scrollHeight <= innerHeight &&
          document.documentElement.scrollWidth <= innerWidth,
      );
    // How far the card's content runs past the card; 0 when all of it shows.
    const hidden = () =>
      question.evaluate((card) => card.scrollHeight - card.clientHeight);
    let id = 0;
    const show = async (cue: Cue) => {
      await page.evaluate((value) => window.liveTest.setCue(value), {
        ...cue,
        id: `fictional-reminder-${++id}`,
      });
      await expect(question).toContainText(cue.question);
    };
    for (const width of [360, 420])
      for (const title of [
        'Garden welcome guide',
        'Garden welcome guide and the open day',
      ]) {
        const plain: Cue = {
          ...reminder,
          question: title,
          evidence:
            'Robin will label the watering cans before the open day. Sam is checking whether the side gate can stay open until four.',
          note: { ...reminder.note!, title },
        };
        const warned: Cue = {
          ...plain,
          note: {
            ...plain.note!,
            unconfirmed: { lastConfirmedMs: CHECKED_AT_MS },
          },
        };
        await page.setViewportSize({ width, height: windowHeight });
        await show(plain);
        expect(await fits(), `${width} ${title}`).toBe(true);
        const plainHidden = await hidden();
        await show(warned);
        await expect(question).toContainText('Not verified');
        await expect(question.locator('blockquote')).toBeVisible();
        expect(await fits(), `${width} ${title} warned`).toBe(true);
        // The warning sits above the excerpt, in view with nothing pressed
        // or scrolled, and costs a line or two. Whether the excerpt's last
        // line also fits under it depends on the platform's fonts; it is
        // always reached from the keyboard.
        await expect(question.locator('.question-warning')).toBeInViewport({
          ratio: 1,
        });
        expect(await hidden(), `${width} ${title} warned`).toBeLessThanOrEqual(
          plainHidden + (size === 'large' ? 48 : 40),
        );
        await question.getByRole('button', { name: 'Hold' }).focus();
        await page.keyboard.press('End');
        await expect(
          question.locator('blockquote').getByText('stay open until four'),
        ).toBeInViewport();
        await expect(
          question.getByRole('button', { name: 'Dismiss' }),
        ).toBeInViewport();
      }
  });
}
