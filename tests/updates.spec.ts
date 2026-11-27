import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { standIn, startLive } from './fixtures/stand-in';

type UpdatesConfig = {
  currentVersion?: string;
  configured?: boolean;
  labRun?: boolean;
  checkAtLaunch?: boolean;
  available?: { version: string; notes?: string; published?: string } | null;
  phase?: string;
  nextCheck?:
    | 'upToDate'
    | { available: { version: string; notes?: string } }
    | { error: string };
  nextInstall?: 'ok' | { error: string };
};

async function openUpdates(
  page: Page,
  config: UpdatesConfig = {},
  path = '/?live',
) {
  await page.addInitScript((value) => {
    (window as unknown as { standInUpdates: UpdatesConfig }).standInUpdates =
      value;
  }, config);
  await standIn(page, path);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Privacy & setup', exact: true })
    .click();
  return page.getByRole('region', { name: 'Updates' });
}

test('Settings Updates shows version, toggles launch check, and reports up-to-date', async ({
  page,
}) => {
  const section = await openUpdates(page);
  await expect(section).toContainText('v0.1.0');
  const toggle = section.getByRole('checkbox', {
    name: 'Check for updates on launch',
  });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  expect(
    await page.evaluate(() => window.updatesTest.state().checkAtLaunch),
  ).toBe(false);

  await section.getByRole('button', { name: 'Check for updates' }).click();
  await expect(section).toContainText('TalkQTE is up to date.');
});

test('Settings Updates shows an available release and downloads with progress before restarting', async ({
  page,
}) => {
  const section = await openUpdates(page, {
    nextCheck: {
      available: {
        version: '0.2.0',
        notes: 'Fictional release notes: smoother capture cleanup.',
      },
    },
  });

  await section.getByRole('button', { name: 'Check for updates' }).click();
  const offer = section.getByRole('group', {
    name: 'Update available: v0.2.0',
  });
  await expect(offer).toBeVisible();
  await expect(offer).toContainText(
    'Fictional release notes: smoother capture cleanup.',
  );

  const axe = await new AxeBuilder({ page })
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
  expect(axe.violations).toEqual([]);

  await offer.getByRole('button', { name: 'Download and restart' }).click();
  await expect(offer).toContainText(
    /Downloading update|Installing update|Restarting/,
  );
  await expect
    .poll(async () => page.evaluate(() => window.updatesTest.state().restarts))
    .toBe(1);
});

test('Updates defer during an active live session, mic check, or dictation and release after Stop', async ({
  page,
}) => {
  const section = await openUpdates(page, {
    available: {
      version: '0.2.0',
      notes: 'Deferred until call ends.',
    },
    phase: 'available',
  });
  await expect(
    section.getByRole('group', { name: 'Update available: v0.2.0' }),
  ).toBeVisible();

  // Start a live session: offer must hide and pause notice must appear.
  await startLive(page);
  await expect(section).toContainText('Update paused until this session ends');
  await expect(
    section.getByRole('group', { name: 'Update available: v0.2.0' }),
  ).toHaveCount(0);
  await expect(
    section.getByRole('button', { name: 'Check for updates' }),
  ).toBeDisabled();

  // Stop the live session: held offer releases automatically.
  await page.evaluate(async () => {
    await window.liveTest.publish({ status: 'ended', cue: null });
    await window.microphoneTest.send({ status: 'off', canStart: true });
  });
  await expect(
    section.getByRole('group', { name: 'Update available: v0.2.0' }),
  ).toBeVisible();

  // Active microphone check also pauses updates.
  await page.evaluate(() =>
    window.microphoneTest.send({ status: 'listening', canStart: false }),
  );
  await expect(section).toContainText('Update paused until this session ends');
  await page.evaluate(() =>
    window.microphoneTest.send({ status: 'off', canStart: true }),
  );
  await expect(
    section.getByRole('group', { name: 'Update available: v0.2.0' }),
  ).toBeVisible();

  // Active dictation on Notebook also pauses updates and blocks manual checks.
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.evaluate(() =>
    window.dictationTest.send({
      status: 'listening',
      target: 'notes',
      canStart: false,
    }),
  );
  const pausedByDictation = await page.evaluate(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const status = await internals.invoke('update_status');
    let checkError = '';
    try {
      await internals.invoke('check_for_updates');
    } catch (err) {
      checkError = String(err);
    }
    return { status, checkError };
  });
  expect(pausedByDictation.status).toMatchObject({
    phase: 'deferred',
    hold: 'dictation',
    available: null,
  });
  expect(pausedByDictation.checkError).toContain(
    'Update paused until this session ends.',
  );

  // Returning to Settings stops dictation cleanly and releases the offer.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Updates' })
      .getByRole('group', { name: 'Update available: v0.2.0' }),
  ).toBeVisible();
});

test('Settings Updates recovers from check and download errors and handles unconfigured/lab builds', async ({
  page,
}) => {
  const section = await openUpdates(page, {
    nextCheck: {
      error:
        'Could not reach the update server. Check your connection and try again.',
    },
    nextInstall: {
      error:
        'The update signature could not be verified. The current version was kept.',
    },
  });

  await section.getByRole('button', { name: 'Check for updates' }).click();
  await expect(section.getByRole('alert')).toContainText(
    'Could not reach the update server.',
  );

  // Retry check succeeds with an offer.
  await page.evaluate(() =>
    window.updatesTest.setNextCheck({
      available: { version: '0.2.0', notes: 'Retry succeeded.' },
    }),
  );
  await section.getByRole('button', { name: 'Check for updates' }).click();
  const offer = section.getByRole('group', {
    name: 'Update available: v0.2.0',
  });
  await expect(offer).toBeVisible();

  // Failed download recovers cleanly and allows retry.
  await offer.getByRole('button', { name: 'Download and restart' }).click();
  await expect(section.getByRole('alert')).toContainText(
    'The update signature could not be verified.',
  );
  await page.evaluate(() => window.updatesTest.setNextInstall('ok'));
  await offer.getByRole('button', { name: 'Download and restart' }).click();
  await expect
    .poll(async () => page.evaluate(() => window.updatesTest.state().restarts))
    .toBe(1);

  // Unconfigured build message.
  const unconfigured = await openUpdates(page, { configured: false });
  await expect(unconfigured).toContainText(
    'Updates are not configured in this build',
  );
  await expect(
    unconfigured.getByRole('button', { name: 'Check for updates' }),
  ).toBeDisabled();

  // Lab run message.
  const lab = await openUpdates(page, { labRun: true }, '/?live&lab');
  await expect(lab).toContainText('Lab runs do not check for updates.');
  await expect(
    lab.getByRole('checkbox', { name: 'Check for updates on launch' }),
  ).toBeDisabled();
  await expect(
    lab.getByRole('button', { name: 'Check for updates' }),
  ).toBeDisabled();
});
