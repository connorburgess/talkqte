// First-run onboarding and single Settings Your API keys checks against the
// native provider-keys fixture (tests/fixtures/native-provider-keys.ts).
// No real keys or network requests are ever made.
import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

const FICTIONAL_DEEPGRAM_KEY = 'fictionaldeepgramkey0123456789abcdef0123';
const FICTIONAL_DEEPGRAM_REPLACEMENT =
  'fictionaldeepgramreplacement9876543210ab';
const FICTIONAL_ANTHROPIC_KEY =
  'sk-ant-api03-fictional-test-key-0123456789abcdef0123456789';

async function openDesktop(page: Page, query = '') {
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

const providerRow = (page: Page, name: string) =>
  page.getByRole('form', { name, exact: true });

const SAVED_MASK = '••••••••••••••••••••••••';

test('when key commands are unavailable, onboarding does not open and Settings reports an error without Set up TalkQTE again', async ({
  page,
}) => {
  await openDesktop(page, '?keys=unavailable');
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'TalkQTE setup' })).toHaveCount(
    0,
  );

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const keysSection = page.getByRole('region', { name: 'Your API keys' });
  await expect(keysSection).toBeVisible();
  await expect(keysSection.getByRole('alert')).toHaveText(
    'Your keys could not be read. Try again later.',
  );
  await expect(providerRow(page, 'Deepgram')).toContainText('Unavailable');
  await expect(
    providerRow(page, 'Deepgram').locator(
      '.provider-key-state.is-unreadable svg',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Set up TalkQTE again' }),
  ).toHaveCount(0);
});

test('an unreadable key in the Keychain is not missing and does not auto-open onboarding', async ({
  page,
}) => {
  // Both keys unreadable.
  await openDesktop(page, '?keys=unreadable');
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'TalkQTE setup' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(providerRow(page, 'Deepgram')).toContainText(
    'Could not be read from the Keychain. Unlock it or allow access, or save the key again.',
  );
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Privacy & setup', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Set up TalkQTE again' }),
  ).toBeVisible();

  // One key unreadable, one notSet: still does not auto-open onboarding.
  await openDesktop(page, '?keys=unreadable-one');
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'TalkQTE setup' })).toHaveCount(
    0,
  );
});

test('onboarding auto-opens when both keys are notSet, moves focus to each step heading, and Escape asks to confirm Skip', async ({
  page,
}) => {
  await openDesktop(page);

  // Step 1: focus lands on step heading; Two ways shows Free active and Pro planned and disabled.
  const step1 = page.getByRole('heading', {
    name: 'One quiet cue beside your live call',
    level: 1,
  });
  await expect(step1).toBeVisible();
  await expect(step1).toBeFocused();
  await expect(page.getByText('Step 1 of 4')).toBeVisible();
  await expect(page.getByText('Context · Fictional example')).toBeVisible();
  const ways = page.locator('.ob-ways');
  await expect(ways.locator('.ob-way.is-active')).toContainText('Free');
  await expect(ways.locator('.ob-way.is-active')).toContainText(
    'With your own keys',
  );
  await expect(ways.locator('.ob-way.is-disabled')).toContainText('Pro');
  await expect(ways.locator('.ob-way.is-disabled')).toContainText('Planned');
  await expect(ways.locator('.ob-way.is-disabled')).toContainText(
    'Pay as you go',
  );
  await expect(ways.locator('.ob-way.is-disabled')).not.toContainText(
    /[$€£]|\d\s*(?:hours?|hrs?)|per month/i,
  );
  await expect(ways).not.toContainText(/Hosted|BYOK/);
  await expect(page.locator('.ob-way.is-disabled')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled();

  // Step 2: focus moves to heading; nothing sent over network yet.
  await page.getByRole('button', { name: 'Next: Your keys' }).click();
  const step2 = page.getByRole('heading', {
    name: 'Connect your service keys',
    level: 1,
  });
  await expect(step2).toBeFocused();
  await expect(page.getByText('Step 2 of 4')).toBeVisible();
  await expect(
    page.getByText(
      'Test is the only action in setup that sends anything over the network, and only when you press it.',
    ),
  ).toBeVisible();
  const calls = await page.evaluate(() => window.providerKeysTest.calls);
  expect(calls.filter((c) => c.command === 'test_provider_key')).toHaveLength(
    0,
  );

  // Step 3: informational only, focus on heading.
  await page.getByRole('button', { name: 'Next: Permissions' }).click();
  const step3 = page.getByRole('heading', {
    name: 'What macOS will ask later',
    level: 1,
  });
  await expect(step3).toBeFocused();
  await expect(page.getByText('Step 3 of 4')).toBeVisible();
  await expect(page.getByText('Nothing requested here')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Microphone', level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'System Audio Recording Only',
      level: 2,
    }),
  ).toBeVisible();
  await expect(page.locator('.onboarding-flow')).not.toContainText(
    'Screen & System Audio Recording',
  );

  // Step 4: per-session approval sequence, focus on heading.
  await page.getByRole('button', { name: 'Next: First session' }).click();
  const step4 = page.getByRole('heading', {
    name: 'How a live session starts and stops',
    level: 1,
  });
  await expect(step4).toBeFocused();
  await expect(page.getByText('Step 4 of 4')).toBeVisible();

  // Back returns to Step 3 and focuses its heading.
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(step3).toBeFocused();

  // Escape opens Skip confirmation dialog; Keep setting up returns to Step 3.
  await page.keyboard.press('Escape');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: 'Skip setup for now?' }),
  ).toBeVisible();
  const keep = dialog.getByRole('button', { name: 'Keep setting up' });
  await expect(keep).toBeFocused();
  await keep.click();
  await expect(dialog).not.toBeVisible();
  await expect(step3).toBeFocused();

  // Escape again and confirm Skip setup returns to the notebook.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Skip setup' }).click();
  const notebookHeading = page.getByRole('heading', {
    name: 'No session yet',
    level: 1,
  });
  await expect(notebookHeading).toBeVisible();
  await expect(notebookHeading).toBeFocused();
});

test('key entry clears without echoing, Test -> rejected -> replace -> set and checked, remove works, provider-keys:changed syncs, and Set up TalkQTE again reopens from Settings', async ({
  page,
}) => {
  await openDesktop(page);

  // Step 2 uses the single ProviderKeys rows with dashboard guidance.
  await page.getByRole('button', { name: 'Next: Your keys' }).click();
  const deepgram = providerRow(page, 'Deepgram');
  const elevenlabs = providerRow(page, 'ElevenLabs');
  const anthropic = providerRow(page, 'Anthropic');
  await expect(deepgram).toContainText('Not set');
  await expect(deepgram).toContainText('console.deepgram.com');
  await expect(elevenlabs).toContainText('Not set');
  await elevenlabs
    .getByRole('button', { name: 'Configure ElevenLabs key' })
    .click();
  await expect(elevenlabs).toContainText('elevenlabs.io');
  await expect(anthropic).toContainText('Not set');
  await expect(anthropic).toContainText('console.anthropic.com');

  // Bad shape rejects with verbatim Rust error and clears the password input.
  const anthropicInput = anthropic.getByLabel('Anthropic API key');
  await anthropicInput.fill('not-a-valid-key');
  await anthropic.getByRole('button', { name: 'Save key' }).click();
  await expect(anthropic.getByRole('alert')).toHaveText(
    'That does not look like an Anthropic API key. It starts with sk-ant-api.',
  );
  await expect(anthropicInput).toHaveValue('');

  // Valid Deepgram key clears, shows Saved · not checked yet with checkmark + masked display, and never echoes.
  const input = deepgram.getByLabel('Deepgram API key');
  await expect(input).toHaveAttribute('type', 'password');
  const save = deepgram.getByRole('button', { name: 'Save key' });
  await expect(save).toBeDisabled();

  await input.fill(FICTIONAL_DEEPGRAM_KEY);
  await expect(save).toBeEnabled();
  await save.click();

  await expect(deepgram).toContainText('Saved · not checked yet');
  await expect(
    deepgram.locator('.provider-key-state.is-set svg'),
  ).toBeVisible();
  await expect(deepgram.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  await expect(deepgram.locator('.provider-key-stored')).toContainText(
    'Stored in macOS Keychain',
  );
  await expect(deepgram.getByLabel('Replace Deepgram key')).toHaveCount(0);
  await expect(
    deepgram.getByRole('button', { name: 'Replace key' }),
  ).toBeEnabled();
  await expect(page.locator('body')).not.toContainText(FICTIONAL_DEEPGRAM_KEY);
  expect(
    await page.evaluate(
      (secret) => document.documentElement.innerHTML.includes(secret),
      FICTIONAL_DEEPGRAM_KEY,
    ),
  ).toBe(false);

  // Unreachable error shows exact message without changing Saved state.
  await page.evaluate(() => {
    window.providerKeysTest.setTestOutcome('deepgram', {
      error:
        'Deepgram could not be reached to check the key. Nothing was changed.',
    });
  });
  await deepgram.getByRole('button', { name: 'Test key' }).click();
  await expect(deepgram.getByRole('alert')).toHaveText(
    'Deepgram could not be reached to check the key. Nothing was changed.',
  );
  await expect(deepgram).toContainText('Saved · not checked yet');

  // Test -> Checking… (controls disabled) -> Rejected (input opens directly).
  await page.evaluate(() => {
    window.providerKeysTest.setTestOutcome('deepgram', 'rejected');
    window.providerKeysTest.holdNextTest();
  });
  await deepgram.getByRole('button', { name: 'Test key' }).click();
  await expect(deepgram).toContainText('Checking…');
  await expect(
    deepgram.getByRole('button', { name: 'Checking…' }),
  ).toBeDisabled();
  await expect(
    deepgram.getByRole('button', { name: 'Remove key' }),
  ).toBeDisabled();

  await page.evaluate(() => window.providerKeysTest.releaseTest());
  await expect(deepgram).toContainText(
    'Rejected by Deepgram. Replace it with a new key.',
  );
  await expect(
    deepgram.locator('.provider-key-state.is-rejected svg'),
  ).toBeVisible();

  // Rejected -> password input is immediately visible & empty -> Saved · not checked yet -> Test verifies.
  const replaceInput = deepgram.getByLabel('Replace Deepgram key');
  await expect(replaceInput).toBeVisible();
  await expect(replaceInput).toHaveValue('');
  await expect(replaceInput).toHaveAttribute(
    'placeholder',
    'Paste a new key to replace the rejected one',
  );
  await replaceInput.fill(FICTIONAL_DEEPGRAM_REPLACEMENT);
  await deepgram.getByRole('button', { name: 'Save key' }).click();
  await expect(deepgram).toContainText('Saved · not checked yet');
  await expect(deepgram.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  expect(
    await page.evaluate(
      (secret) => document.documentElement.innerHTML.includes(secret),
      FICTIONAL_DEEPGRAM_REPLACEMENT,
    ),
  ).toBe(false);

  await page.evaluate(() => {
    window.providerKeysTest.setTestOutcome('deepgram', 'verified');
  });
  await deepgram.getByRole('button', { name: 'Test key' }).click();
  await expect(deepgram).toContainText('Saved · checked');
  await expect(
    deepgram.locator('.provider-key-state.is-set svg'),
  ).toBeVisible();
  await expect(deepgram.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  await expect(deepgram.getByRole('alert')).toHaveCount(0);

  // Clicking Replace key in Step 2 reveals the input + Cancel, and Cancel hides it.
  await deepgram.getByRole('button', { name: 'Replace key' }).click();
  await expect(deepgram.getByLabel('Replace Deepgram key')).toBeVisible();
  await deepgram.getByRole('button', { name: 'Cancel' }).click();
  await expect(deepgram.getByLabel('Replace Deepgram key')).toHaveCount(0);
  await expect(deepgram.locator('.provider-key-mask')).toHaveText(SAVED_MASK);

  // Remove resets state to Not set and restores the direct API key input.
  await deepgram.getByRole('button', { name: 'Remove key' }).click();
  await expect(deepgram).toContainText('Not set');
  await expect(deepgram.getByLabel('Deepgram API key')).toBeVisible();
  await expect(deepgram.getByLabel('Deepgram API key')).not.toHaveAttribute(
    'placeholder',
    /.+/,
  );

  // Skip setup, verify Settings has ONE keys surface ("Your API keys") beside
  // "Set up TalkQTE again", live-syncs provider-keys:changed, and reopens onboarding.
  await page.getByRole('button', { name: 'Skip setup' }).click();
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Your API keys' }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Service keys' })).toHaveCount(
    0,
  );

  await page.evaluate(() =>
    window.providerKeysTest.emitStatus({
      deepgram: { state: 'set', verified: true },
      elevenlabs: { state: 'notSet', verified: false },
      anthropic: { state: 'notSet', verified: false },
      anyMissing: true,
    }),
  );
  await expect(providerRow(page, 'Deepgram')).toContainText('Saved · checked');
  await expect(
    providerRow(page, 'Deepgram').locator('.provider-key-state.is-set svg'),
  ).toBeVisible();
  const dgConfigure = providerRow(page, 'Deepgram').getByRole('button', {
    name: 'Configure Deepgram key',
  });
  if (await dgConfigure.isVisible()) await dgConfigure.click();
  await expect(
    providerRow(page, 'Deepgram').locator('.provider-key-mask'),
  ).toHaveText(SAVED_MASK);

  // Reopen onboarding via "Set up TalkQTE again" and verify Step 2 preserves the masked saved UI.
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Privacy & setup', exact: true })
    .click();
  await page.getByRole('button', { name: 'Set up TalkQTE again' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'One quiet cue beside your live call',
      level: 1,
    }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Next: Your keys' }).click();
  await expect(providerRow(page, 'Deepgram')).toContainText('Saved · checked');
  await expect(
    providerRow(page, 'Deepgram').locator('.provider-key-state.is-set svg'),
  ).toBeVisible();
  await providerRow(page, 'Deepgram')
    .getByRole('button', { name: 'Configure Deepgram key' })
    .click();
  await expect(
    providerRow(page, 'Deepgram').locator('.provider-key-mask'),
  ).toHaveText(SAVED_MASK);
  await providerRow(page, 'Deepgram')
    .getByRole('button', { name: 'Replace key' })
    .click();
  await expect(
    providerRow(page, 'Deepgram').getByLabel('Replace Deepgram key'),
  ).toHaveValue('');

  // Fresh load with keys already set does not auto-open onboarding.
  await openDesktop(page, '?keys=set');
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'TalkQTE setup' })).toHaveCount(
    0,
  );
});

test('keyboard-only path completes all four steps and finishes in the notebook', async ({
  page,
}) => {
  await openDesktop(page);

  await expect(
    page.getByRole('heading', {
      name: 'One quiet cue beside your live call',
      level: 1,
    }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Next: Your keys' }).focus();
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('heading', {
      name: 'Connect your service keys',
      level: 1,
    }),
  ).toBeFocused();
  const anthropic = providerRow(page, 'Anthropic');
  const anthropicInput = anthropic.getByLabel('Anthropic API key');
  await anthropicInput.focus();
  await page.keyboard.type(FICTIONAL_ANTHROPIC_KEY);
  await page.keyboard.press('Enter');
  await expect(anthropic).toContainText('Saved · not checked yet');

  await page.getByRole('button', { name: 'Next: Permissions' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', {
      name: 'What macOS will ask later',
      level: 1,
    }),
  ).toBeFocused();

  await page.getByRole('button', { name: 'Next: First session' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', {
      name: 'How a live session starts and stops',
      level: 1,
    }),
  ).toBeFocused();

  await page.getByRole('button', { name: 'Go to the notebook' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeFocused();
});

test('390px narrow layout has zero horizontal overflow and reduced motion disables transitions', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await openDesktop(page);

  const checkNoOverflowAndReducedMotion = async (label: string) => {
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      animations: document.getAnimations().length,
    }));
    expect(metrics.scrollWidth, label).toBeLessThanOrEqual(metrics.innerWidth);
    expect(metrics.animations, `${label} animations`).toBe(0);
  };

  await checkNoOverflowAndReducedMotion('Step 1 at 390px');
  const nextBtn = page.getByRole('button', { name: 'Next: Your keys' });
  expect((await nextBtn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(
    await nextBtn.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s');

  await nextBtn.click();
  await checkNoOverflowAndReducedMotion('Step 2 at 390px');
  await page.getByRole('button', { name: 'Next: Permissions' }).click();
  await checkNoOverflowAndReducedMotion('Step 3 at 390px');
  await page.getByRole('button', { name: 'Next: First session' }).click();
  await checkNoOverflowAndReducedMotion('Step 4 at 390px');

  await page.getByRole('button', { name: 'Go to the notebook' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Your API keys' }),
  ).toBeVisible();
  await checkNoOverflowAndReducedMotion('Settings Your API keys at 390px');
});

test('a launch whose live transcription is already available (development or lab credentials) does not open onboarding by itself, and Settings still reopens it', async ({
  page,
}) => {
  await openDesktop(page, '?live');
  await expect(
    page.getByRole('heading', { name: 'Ready for a meeting', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'One quiet cue beside your live call' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Start live session', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Privacy & setup', exact: true })
    .click();
  await page.getByRole('button', { name: 'Set up TalkQTE again' }).click();
  await expect(
    page.getByRole('heading', { name: 'One quiet cue beside your live call' }),
  ).toBeFocused();
});

test('saving keys in onboarding Step 2 immediately enables Start live session in Step 4 without restarting', async ({
  page,
}) => {
  await openDesktop(page, '?live-from-keys');

  await page.getByRole('button', { name: 'Next: Your keys' }).click();
  await page.getByRole('button', { name: 'Next: Permissions' }).click();
  await page.getByRole('button', { name: 'Next: First session' }).click();
  const startLive = page.getByRole('button', {
    name: 'Start live session',
    exact: true,
  });
  await expect(startLive).toBeDisabled();

  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();

  const deepgram = providerRow(page, 'Deepgram');
  const anthropic = providerRow(page, 'Anthropic');
  await deepgram.getByLabel('Deepgram API key').fill(FICTIONAL_DEEPGRAM_KEY);
  await deepgram.getByRole('button', { name: 'Save key' }).click();
  await expect(deepgram).toContainText('Saved · not checked yet');

  await anthropic.getByLabel('Anthropic API key').fill(FICTIONAL_ANTHROPIC_KEY);
  await anthropic.getByRole('button', { name: 'Save key' }).click();
  await expect(anthropic).toContainText('Saved · not checked yet');

  await page.getByRole('button', { name: 'Next: Permissions' }).click();
  await page.getByRole('button', { name: 'Next: First session' }).click();
  await expect(startLive).toBeEnabled();

  // Removing a required key in Step 2 disables Step 4's Start live session again.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await deepgram
    .getByRole('button', { name: 'Configure Deepgram key' })
    .click();
  await deepgram.getByRole('button', { name: 'Remove key' }).click();
  await expect(deepgram).toContainText('Not set');
  await page.getByRole('button', { name: 'Next: Permissions' }).click();
  await page.getByRole('button', { name: 'Next: First session' }).click();
  await expect(startLive).toBeDisabled();
});
