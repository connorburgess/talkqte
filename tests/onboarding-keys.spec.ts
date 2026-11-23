// First-run onboarding and Settings Service keys checks against the real
// PR #408 / #411 command shapes mocked in tests/fixtures/native-microphone.ts.
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
  await page.waitForFunction(() => !!window.keysTest);
}

test('when key commands are missing, onboarding does not open and Settings reports Unavailable in this build', async ({
  page,
}) => {
  await openDesktop(page);
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'TalkQTE setup' })).toHaveCount(
    0,
  );

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const keysSection = page.getByRole('region', { name: 'Service keys' });
  await expect(keysSection).toBeVisible();
  await expect(keysSection).toContainText('Unavailable in this build');
  await expect(keysSection).not.toContainText('Not set');
  await expect(
    keysSection.getByRole('button', { name: 'Add key' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Set up TalkQTE again' }),
  ).toHaveCount(0);
});

test('onboarding opens with no keys, moves focus to each step heading, and Escape asks to confirm Skip', async ({
  page,
}) => {
  await openDesktop(page, '?keys');

  // Step 1: focus lands on step heading; Two ways shows own keys active and Hosted disabled.
  const step1 = page.getByRole('heading', {
    name: 'One quiet cue beside your live call',
    level: 2,
  });
  await expect(step1).toBeVisible();
  await expect(step1).toBeFocused();
  await expect(page.getByText('Step 1 of 4')).toBeVisible();
  await expect(page.getByText('Context · Fictional example')).toBeVisible();
  await expect(page.getByText('Use your own keys')).toBeVisible();
  await expect(page.locator('.ob-way.is-disabled')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled();

  // Step 2: focus moves to heading; nothing sent over network yet.
  await page.getByRole('button', { name: 'Next: Your keys' }).click();
  const step2 = page.getByRole('heading', {
    name: 'Connect your service keys',
    level: 2,
  });
  await expect(step2).toBeFocused();
  await expect(page.getByText('Step 2 of 4')).toBeVisible();
  await expect(
    page.getByText(
      'Test is the only action in setup that sends anything over the network, and only when you press it.',
    ),
  ).toBeVisible();
  const calls = await page.evaluate(() => window.keysTest.calls);
  expect(calls.filter((c) => c.command === 'test_provider_key')).toHaveLength(
    0,
  );

  // Step 3: informational only, focus on heading.
  await page.getByRole('button', { name: 'Next: Permissions' }).click();
  const step3 = page.getByRole('heading', {
    name: 'What macOS will ask later',
    level: 2,
  });
  await expect(step3).toBeFocused();
  await expect(page.getByText('Step 3 of 4')).toBeVisible();
  await expect(page.getByText('Nothing requested here')).toBeVisible();

  // Step 4: per-session approval sequence, focus on heading.
  await page.getByRole('button', { name: 'Next: First session' }).click();
  const step4 = page.getByRole('heading', {
    name: 'How a live session starts and stops',
    level: 2,
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

test('key entry validates and clears without echoing, Test -> Rejected -> Replace -> Checked, Remove confirms, provider-keys:changed syncs, and cue_usage displays without model', async ({
  page,
}) => {
  await openDesktop(page, '?keys&live');

  // Go to Step 2 and verify exact Deepgram & Anthropic data statements.
  await page.getByRole('button', { name: 'Next: Your keys' }).click();
  const deepgram = page.getByRole('region', { name: 'Deepgram' });
  const anthropic = page.getByRole('region', { name: 'Anthropic' });
  await expect(deepgram).toContainText('Not set');
  await expect(deepgram).toContainText(
    "Receives the session's audio (microphone or the application you chose), only after you approve cue processing for that session; at most 120 minutes per session. Billed to your own Deepgram account.",
  );
  await expect(anthropic).toContainText(
    'Receives up to six recent transcript lines, the cue on screen and earlier cues, and your session name if set, for cue decisions; never audio, your notes or focus lines. Billed to your own Anthropic account.',
  );

  // Bad shape rejects with verbatim Rust error and clears the password input.
  await anthropic.getByRole('button', { name: 'Add key' }).click();
  const anthropicInput = anthropic.getByLabel(/Anthropic API key/);
  await anthropicInput.fill('not-a-valid-key');
  await anthropic.getByRole('button', { name: 'Save key' }).click();
  await expect(anthropic.getByRole('alert')).toHaveText(
    'That does not look like an Anthropic API key. It starts with sk-ant-api.',
  );
  await expect(anthropicInput).toHaveValue('');
  await anthropic.getByRole('button', { name: 'Cancel' }).click();

  // Valid Deepgram key clears, sets Set (not yet Checked), and never echoes.
  await deepgram.getByRole('button', { name: 'Add key' }).click();
  const input = deepgram.getByLabel(/Deepgram API key/);
  await expect(input).toHaveAttribute('type', 'password');
  const save = deepgram.getByRole('button', { name: 'Save key' });
  await expect(save).toBeDisabled();

  await input.fill(FICTIONAL_DEEPGRAM_KEY);
  await expect(save).toBeEnabled();
  await save.click();

  await expect(deepgram).toContainText('Set');
  await expect(deepgram).not.toContainText('Checked');
  await expect(page.locator('body')).not.toContainText(FICTIONAL_DEEPGRAM_KEY);
  expect(
    await page.evaluate(
      (secret) => document.documentElement.innerHTML.includes(secret),
      FICTIONAL_DEEPGRAM_KEY,
    ),
  ).toBe(false);

  // Unreachable error shows the exact verbatim message from Rust without changing Set.
  await page.evaluate(() => {
    window.keysTest.setTestOutcome('deepgram', {
      error:
        'Deepgram could not be reached to check the key. Nothing was changed.',
    });
  });
  await deepgram.getByRole('button', { name: 'Test' }).click();
  await expect(deepgram.getByRole('alert')).toHaveText(
    'Deepgram could not be reached to check the key. Nothing was changed.',
  );
  await expect(deepgram).toContainText('Set');

  // Test -> Checking… (controls disabled) -> Rejected.
  await page.evaluate(() => {
    window.keysTest.setTestOutcome('deepgram', 'rejected');
    window.keysTest.holdNextTest();
  });
  await deepgram.getByRole('button', { name: 'Test' }).click();
  await expect(deepgram).toContainText('Checking…');
  await expect(deepgram.getByRole('button', { name: 'Test' })).toBeDisabled();
  await expect(
    deepgram.getByRole('button', { name: 'Replace' }),
  ).toBeDisabled();
  await expect(deepgram.getByRole('button', { name: 'Remove' })).toBeDisabled();

  await page.evaluate(() => window.keysTest.releaseTest());
  await expect(deepgram).toContainText('Rejected');
  await expect(deepgram.getByRole('alert')).toContainText(
    'Refused by the service.',
  );

  // Replace -> password input starts empty -> Set -> Test verifies ("Checked").
  await deepgram.getByRole('button', { name: 'Replace' }).click();
  const replaceInput = deepgram.getByLabel(/Deepgram API key/);
  await expect(replaceInput).toHaveValue('');
  await replaceInput.fill(FICTIONAL_DEEPGRAM_REPLACEMENT);
  await deepgram.getByRole('button', { name: 'Save key' }).click();
  await expect(deepgram).toContainText('Set');
  expect(
    await page.evaluate(
      (secret) => document.documentElement.innerHTML.includes(secret),
      FICTIONAL_DEEPGRAM_REPLACEMENT,
    ),
  ).toBe(false);

  await page.evaluate(() => {
    window.keysTest.setTestOutcome('deepgram', 'verified');
  });
  await deepgram.getByRole('button', { name: 'Test' }).click();
  await expect(deepgram).toContainText('Set');
  await expect(deepgram).toContainText('Checked');
  await expect(deepgram.getByRole('alert')).toHaveCount(0);

  // Remove asks for inline confirmation; Cancel keeps Set; Remove key sets Not set.
  await deepgram.getByRole('button', { name: 'Remove' }).click();
  const confirmGroup = deepgram.getByRole('group', {
    name: 'Confirm removing Deepgram key',
  });
  await expect(confirmGroup).toContainText('Remove Deepgram key?');
  await confirmGroup.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmGroup).toHaveCount(0);
  await expect(deepgram).toContainText('Set');

  await deepgram.getByRole('button', { name: 'Remove' }).click();
  await deepgram
    .getByRole('group', { name: 'Confirm removing Deepgram key' })
    .getByRole('button', { name: 'Remove key' })
    .click();
  await expect(deepgram).toContainText('Not set');

  // Skip setup, inspect Settings Service keys + cue_usage (without showing model),
  // verify provider-keys:changed event updates Settings live, then reopen onboarding.
  await page.getByRole('button', { name: 'Skip setup' }).click();
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();

  await page.evaluate(() => {
    window.keysTest.setUsage({
      model: 'claude-sonnet-fictional-hidden',
      requests: 12,
      requestCap: 400,
      spentMicroUsd: 60_000,
      spendCapMicroUsd: 500_000,
    });
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const keysSection = page.getByRole('region', { name: 'Service keys' });
  await expect(keysSection).toBeVisible();
  await expect(keysSection).toContainText('This session');
  await expect(keysSection).toContainText('12 of 400');
  await expect(keysSection).toContainText('Est. $0.06 of $0.50');
  await expect(keysSection).toContainText(
    'Estimate calculated locally from token counts; not a bill from Anthropic.',
  );
  await expect(keysSection).not.toContainText('claude-sonnet-fictional-hidden');

  // Event `provider-keys:changed` updates Settings rows live.
  await page.evaluate(() =>
    window.keysTest.emitStatus({
      deepgram: { state: 'set', verified: true },
      anthropic: { state: 'notSet', verified: false },
      anyMissing: true,
    }),
  );
  const settingsDeepgram = keysSection.getByRole('region', {
    name: 'Deepgram',
  });
  await expect(settingsDeepgram).toContainText('Set');
  await expect(settingsDeepgram).toContainText('Checked');

  // Reopen onboarding via "Set up TalkQTE again".
  await page.getByRole('button', { name: 'Set up TalkQTE again' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'One quiet cue beside your live call',
      level: 2,
    }),
  ).toBeFocused();

  // Fresh load with keys already set: no auto-onboarding, empty cue_usage state.
  await openDesktop(page, '?keys=set');
  await expect(
    page.getByRole('heading', { name: 'No session yet', level: 1 }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Service keys' }),
  ).toContainText('0 of 400 Anthropic requests · Est. $0.00 of $0.50');
});

test('keyboard-only path completes all four steps and finishes in the notebook', async ({
  page,
}) => {
  await openDesktop(page, '?keys');

  await expect(
    page.getByRole('heading', {
      name: 'One quiet cue beside your live call',
      level: 2,
    }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Next: Your keys' }).focus();
  await page.keyboard.press('Enter');

  await expect(
    page.getByRole('heading', {
      name: 'Connect your service keys',
      level: 2,
    }),
  ).toBeFocused();
  const anthropic = page.getByRole('region', { name: 'Anthropic' });
  await anthropic.getByRole('button', { name: 'Add key' }).focus();
  await page.keyboard.press('Enter');
  await expect(anthropic.getByLabel(/Anthropic API key/)).toBeFocused();
  await page.keyboard.type(FICTIONAL_ANTHROPIC_KEY);
  await page.keyboard.press('Enter');
  await expect(anthropic).toContainText('Set');

  await page.getByRole('button', { name: 'Next: Permissions' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', {
      name: 'What macOS will ask later',
      level: 2,
    }),
  ).toBeFocused();

  await page.getByRole('button', { name: 'Next: First session' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', {
      name: 'How a live session starts and stops',
      level: 2,
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
  await openDesktop(page, '?keys');

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
    page.getByRole('region', { name: 'Service keys' }),
  ).toBeVisible();
  await checkNoOverflowAndReducedMotion('Settings Service keys at 390px');
});
