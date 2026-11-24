// What the notebook says about the platform it runs on, on the fictional
// native stand-in with `?platform=` (tests/fixtures/native-microphone.ts).
// Nothing is captured: these establish the words, not Windows or Linux
// behaviour, which needs a real machine (docs/platforms.md).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { standIn } from './fixtures/stand-in';

const session = (page: Page) =>
  page.getByRole('region', { name: 'Session', exact: true });

for (const [os, name] of [
  ['windows', 'Windows'],
  ['linux', 'Linux'],
] as const) {
  test(`${name}: setup says live sessions use the microphone only and what is macOS-only`, async ({
    page,
  }) => {
    await standIn(page, `/?platform=${os}&keys=none`);
    const setup = page.locator('.onboarding-flow');
    await expect(setup).toContainText(`Alpha · ${name}`);
    await expect(setup).toContainText(`beside your meeting on ${name}`);
    const limits = page.getByLabel(`What the ${name} build does`);
    await expect(limits).toContainText(
      'Live sessions here hear your microphone only.',
    );
    await expect(limits).toContainText(
      `Hearing another application, such as the app your call is in, is not available on ${name} yet`,
    );
    await expect(limits).toContainText('Unsigned · not checked on hardware');
    await expect(setup).not.toContainText('on macOS');
    await expect(setup).not.toContainText('your Mac');

    await page.getByRole('button', { name: 'Next: Your keys' }).click();
    await page.getByRole('button', { name: 'Next: Permissions' }).click();
    const permissions = page.getByRole('region', {
      name: 'What TalkQTE will use later',
    });
    await expect(permissions).toBeVisible();
    await expect(permissions).toContainText(
      `${name} does not ask TalkQTE for microphone access with a prompt`,
    );
    await expect(permissions).toContainText(`Not available on ${name} yet`);
    await expect(permissions).not.toContainText('Screen & System Audio');
    await page.getByRole('button', { name: 'Next: First session' }).click();
    await expect(
      page.getByRole('region', { name: 'How a live session starts and stops' }),
    ).not.toContainText('your Mac');
  });

  test(`${name}: the session start says it hears the microphone only, and the call prompt setting says it is not available`, async ({
    page,
  }) => {
    await standIn(page, `/?platform=${os}&live`);
    await expect(
      page.getByRole('button', { name: 'Start live session' }),
    ).toBeVisible();
    await expect(session(page)).toContainText(
      `On ${name}, live sessions hear your microphone only: with headphones, that is your side of a call. Hearing another application is not available on ${name} yet.`,
    );
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const setting = page.getByRole('region', { name: 'When a call starts' });
    await expect(setting).toContainText(`Not available on ${name} yet.`);
    await expect(setting.getByRole('checkbox')).toHaveCount(0);
    const menuBar = page.getByRole('region', { name: 'Menu bar and login' });
    await expect(menuBar).toContainText(`Not available on ${name} yet`);
    await expect(menuBar.getByRole('checkbox')).toHaveCount(0);
    const saved = page.getByRole('region', { name: 'Saved settings' });
    await expect(saved).toContainText(
      os === 'windows'
        ? 'Keys stay in Windows Credential Manager'
        : 'Keys stay in your desktop keyring',
    );
    await expect(saved).not.toContainText('Mac');
    await expect(page.getByText('TalkQTE remembers your name')).toContainText(
      'on this computer.',
    );
  });
}

test('macOS: no platform note at the session start, and setup reads as before', async ({
  page,
}) => {
  await standIn(page, '/?keys=none');
  const setup = page.locator('.onboarding-flow');
  await expect(setup).toContainText('Alpha · macOS');
  await expect(setup).toContainText(
    'TalkQTE sits beside your meeting on macOS and surfaces one short, source-backed cue when a moment matters.',
  );
  await expect(setup).toContainText('go from your Mac to those providers');
  await expect(page.getByLabel(/build does$/)).toHaveCount(0);

  await standIn(page, '/?live');
  await expect(
    page.getByRole('button', { name: 'Start live session' }),
  ).toBeVisible();
  await expect(session(page)).not.toContainText('microphone only');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('checkbox', {
      name: 'Offer to start a session when a call seems to start',
    }),
  ).toBeVisible();
});

test('Windows setup has no automated accessibility violations on its platform-specific steps', async ({
  page,
}) => {
  await standIn(page, '/?platform=windows&keys=none');
  const setup = page.locator('section.onboarding-flow');
  await expect(
    setup.getByRole('heading', {
      level: 1,
      name: 'One quiet cue beside your live call',
    }),
  ).toBeVisible();
  for (const next of [
    'Next: Your keys',
    'Next: Permissions',
    'Next: First session',
    null,
  ]) {
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
    expect(result.violations, `before ${next}`).toEqual([]);
    if (next) await setup.getByRole('button', { name: next }).click();
  }
});
