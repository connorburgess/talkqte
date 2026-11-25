// Windows and Linux key stores as the notebook shows them, against the
// fictional native fixture (tests/fixtures/native-provider-keys.ts) with
// `?store=`. The stores themselves are covered by the Rust tests, including
// round trips in CI's real Credential Manager and a throwaway GNOME Keyring.
import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

const DEEPGRAM = '0123456789abcdef0123456789abcdef01234567';

async function openNative(page: Page, query: string) {
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
  await page.goto(`/${query}`);
  await page.waitForFunction(() => !!window.providerKeysTest);
}

const row = (page: Page, name: string) =>
  page.getByRole('form', { name, exact: true });

test('Windows: keys are said to be kept in Windows Credential Manager, and removal names it', async ({
  page,
}) => {
  await openNative(page, '?keys=set&store=credentialManager');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const keys = page.getByRole('region', { name: 'Your API keys' });
  await expect(keys).toContainText(
    'Each is kept in Windows Credential Manager and is never shown again.',
  );
  await expect(keys).not.toContainText('Keychain');
  await row(page, 'Deepgram')
    .getByRole('button', { name: 'Remove key' })
    .click();
  await expect(row(page, 'Deepgram')).toContainText(
    'Deepgram key removed from Windows Credential Manager.',
  );
});

test('Linux: keys are said to be kept in the desktop keyring', async ({
  page,
}) => {
  await openNative(page, '?keys=set&store=secretService');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const keys = page.getByRole('region', { name: 'Your API keys' });
  await expect(keys).toContainText(
    'Each is kept in your desktop keyring and is never shown again.',
  );
  await expect(keys).not.toContainText('Keychain');
});

test('Linux without a keyring: keys cannot be saved, the notebook says why, and nothing is offered that would pretend', async ({
  page,
}) => {
  await openNative(page, '?store=none');
  // Keys that cannot be kept are not "missing", so setup does not open by
  // itself to ask for them.
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'TalkQTE setup' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const keys = page.getByRole('region', { name: 'Your API keys' });
  await expect(keys.getByRole('status').first()).toHaveText(
    /^Keys cannot be saved on this system yet\. .*Live sessions need a transcription key and an Anthropic key\.$/,
  );
  for (const name of ['Deepgram', 'ElevenLabs', 'Anthropic']) {
    await expect(row(page, name)).toContainText(
      'Cannot be saved on this system yet',
    );
    await expect(row(page, name).locator('input')).toBeDisabled();
    for (const button of ['Save key', 'Test key', 'Remove key'])
      await expect(
        row(page, name).getByRole('button', { name: button }),
      ).toBeDisabled();
  }
});

test('Linux without a keyring: setup step 2 says there is no keyring', async ({
  page,
}) => {
  await openNative(page, '?store=none');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Set up TalkQTE again' }).click();
  await page.getByRole('button', { name: 'Next: Your keys' }).click();
  const setup = page.getByRole('region', { name: 'Connect your service keys' });
  await expect(setup).toContainText('No keyring on this system');
  await expect(setup).not.toContainText('macOS Keychain');
});

test('Windows: setup step 2 names Windows Credential Manager', async ({
  page,
}) => {
  await openNative(page, '?store=credentialManager');
  await page.getByRole('button', { name: 'Next: Your keys' }).click();
  const setup = page.getByRole('region', { name: 'Connect your service keys' });
  await expect(setup).toContainText('Stored in Windows Credential Manager');
  await row(page, 'Deepgram').getByLabel('Deepgram API key').fill(DEEPGRAM);
  await row(page, 'Deepgram').getByRole('button', { name: 'Save key' }).click();
  await expect(row(page, 'Deepgram')).toContainText('Set, not checked yet');
});
