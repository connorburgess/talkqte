import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/native-microphone';

// These checks run the notebook against stand-ins, never the Rust commands:
// the browser preview's in-memory fake (src/lib/providerKeys.ts), or the
// fictional native fixture (tests/fixtures/native-provider-keys.ts) for what
// crosses IPC. Key storage, shape checks and provider checks in Rust are
// covered by the `provider_keys` Rust tests.
// Fictional keys of the right shape; they reach no provider.
const ANTHROPIC = 'sk-ant-api03-FICTIONALfictional0123456789abcdefghij-_XYZ';
const OPENAI = 'sk-proj-FICTIONALfictional0123456789abcdef';
const GEMINI = 'AIzaFictionalGeminiKey0123456789abcdefXYZ';
const DEEPGRAM = '0123456789abcdef0123456789abcdef01234567';
const ELEVENLABS = 'sk_fictional0123456789abcdef0123456789abcdef01234567';

async function openNative(page: Page) {
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}

const row = (page: Page, name: string) =>
  page.getByRole('form', { name, exact: true });

const SAVED_MASK = '••••••••••••••••••••••••';

test('browser preview fake: a new install shows both keys as not set, with what each is for', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const keys = page.getByRole('region', { name: 'Your API keys' });
  await expect(keys).toBeVisible();
  await expect(keys).toContainText("kept in your Mac's Keychain");
  for (const name of ['Deepgram', 'ElevenLabs', 'Anthropic']) {
    await expect(row(page, name)).toContainText('Not set');
    await expect(
      row(page, name).getByRole('button', { name: 'Test key' }),
    ).toBeDisabled();
    await expect(
      row(page, name).getByRole('button', { name: 'Remove key' }),
    ).toBeDisabled();
  }
  await expect(row(page, 'Deepgram')).toContainText('per minute');
  await expect(row(page, 'ElevenLabs')).toContainText('Scribe v2 Realtime');
  await expect(row(page, 'Anthropic')).toContainText('per token');
  await expect(keys).toContainText(
    'No session has used your Anthropic key yet.',
  );
});

test('browser preview fake: a key is entered, hidden, cleared after saving or refusal, and removed', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const anthropic = row(page, 'Anthropic');
  const input = anthropic.getByLabel('Anthropic API key');
  await expect(input).toHaveAttribute('type', 'password');
  await expect(input).toHaveAttribute('autocomplete', 'off');
  // A wrong shape is refused without quoting it.
  await input.fill('not a key');
  await input.press('Enter');
  await expect(anthropic.getByRole('alert')).toHaveText(
    'That does not look like an Anthropic API key. It starts with sk-ant-api.',
  );
  await expect(anthropic).toContainText('Not set');
  await expect(input).toHaveValue('');
  await input.fill(ANTHROPIC);
  await anthropic.getByRole('button', { name: 'Save key' }).click();
  await expect(anthropic).toContainText('Saved · not checked yet');
  await expect(
    anthropic.locator('.provider-key-state.is-set svg'),
  ).toBeVisible();
  await expect(anthropic).toContainText('Anthropic key saved.');
  // Saved state hides the blank input behind a non-editable masked display + Replace key.
  await expect(anthropic.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  await expect(anthropic.locator('.provider-key-stored')).toContainText(
    'Stored in macOS Keychain',
  );
  await expect(anthropic.getByLabel('Replace Anthropic key')).toHaveCount(0);
  await expect(
    anthropic.getByRole('button', { name: 'Replace key' }),
  ).toBeEnabled();
  await expect(page.locator('body')).not.toContainText(ANTHROPIC);

  // Clicking Replace key reveals the empty replacement input + Save key + Cancel.
  await anthropic.getByRole('button', { name: 'Replace key' }).click();
  const replaceInput = anthropic.getByLabel('Replace Anthropic key');
  await expect(replaceInput).toBeFocused();
  await expect(replaceInput).toHaveValue('');
  await expect(replaceInput).toHaveAttribute(
    'placeholder',
    'Paste a new key to replace the saved one',
  );
  await expect(
    anthropic.getByRole('button', { name: 'Save key' }),
  ).toBeDisabled();
  await anthropic.getByRole('button', { name: 'Cancel' }).click();
  await expect(anthropic.getByLabel('Replace Anthropic key')).toHaveCount(0);
  await expect(anthropic.locator('.provider-key-mask')).toHaveText(SAVED_MASK);

  // The browser preview checks nothing.
  await anthropic.getByRole('button', { name: 'Test key' }).click();
  await expect(anthropic.getByRole('alert')).toContainText(
    'The browser preview cannot check a key.',
  );
  await anthropic.getByRole('button', { name: 'Remove key' }).click();
  await expect(anthropic).toContainText('Not set');
  const clearedInput = anthropic.getByLabel('Anthropic API key');
  await expect(clearedInput).toBeVisible();
  await expect(clearedInput).not.toHaveAttribute('placeholder', /.+/);
});

test('browser preview fake: the keyboard reaches every key control in order', async ({
  page,
  browserName,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const input = row(page, 'Deepgram').getByLabel('Deepgram API key');
  await input.focus();
  await page.keyboard.type(DEEPGRAM);
  await page.keyboard.press('Enter');
  await expect(row(page, 'Deepgram')).toContainText('Saved · not checked yet');
  // macOS WebKit follows Safari's Tab setting; Option-Tab reaches buttons.
  const tab =
    browserName === 'webkit' && process.platform === 'darwin'
      ? 'Alt+Tab'
      : 'Tab';
  const replaceBtn = row(page, 'Deepgram').getByRole('button', {
    name: 'Replace key',
  });
  await expect(replaceBtn).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    row(page, 'Deepgram').getByRole('button', { name: 'Test key' }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    row(page, 'Deepgram').getByRole('button', { name: 'Remove key' }),
  ).toBeFocused();
  await replaceBtn.focus();
  await page.keyboard.press('Enter');
  await expect(
    row(page, 'Deepgram').getByLabel('Replace Deepgram key'),
  ).toBeFocused();
  await page.keyboard.type(DEEPGRAM);
  await page.keyboard.press(tab);
  await expect(
    row(page, 'Deepgram').getByRole('button', { name: 'Save key' }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    row(page, 'Deepgram').getByRole('button', { name: 'Cancel' }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    row(page, 'Deepgram').getByRole('button', { name: 'Test key' }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    row(page, 'Deepgram').getByRole('button', { name: 'Remove key' }),
  ).toBeFocused();
});

test('native fixture: the key crosses IPC once and only its state comes back', async ({
  page,
}) => {
  await openNative(page);
  const deepgram = row(page, 'Deepgram');
  const anthropic = row(page, 'Anthropic');
  await expect(deepgram).toContainText('Not set');
  await deepgram.getByLabel('Deepgram API key').fill(DEEPGRAM);
  await deepgram.getByRole('button', { name: 'Save key' }).click();
  await expect(deepgram).toContainText('Saved · not checked yet');
  await expect(
    deepgram.locator('.provider-key-state.is-set svg'),
  ).toBeVisible();
  await expect(deepgram.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  await deepgram.getByRole('button', { name: 'Test key' }).click();
  await expect(deepgram).toContainText('Saved · checked');
  await expect(
    deepgram.locator('.provider-key-state.is-set svg'),
  ).toBeVisible();
  await expect(deepgram.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  await expect(deepgram.getByLabel('Replace Deepgram key')).toHaveCount(0);
  await expect(deepgram).toContainText('Deepgram accepted the key.');
  await anthropic.getByLabel('Anthropic API key').fill(ANTHROPIC);
  await anthropic.getByRole('button', { name: 'Save key' }).click();
  // Different-length keys share the exact same fixed-length masked display.
  await expect(anthropic.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  await anthropic.getByRole('button', { name: 'Test key' }).click();
  await expect(anthropic).toContainText(
    'Rejected by Anthropic. Replace it with a new key.',
  );
  await expect(
    anthropic.locator('.provider-key-state.is-rejected svg'),
  ).toBeVisible();
  // Rejected state shows the replace input directly with zero extra clicks.
  const replaceAnthropic = anthropic.getByLabel('Replace Anthropic key');
  await expect(replaceAnthropic).toBeVisible();
  await expect(replaceAnthropic).toHaveAttribute(
    'placeholder',
    'Paste a new key to replace the rejected one',
  );
  const { sent, replies } = await page.evaluate(() => ({
    sent: window.providerKeysTest.sent,
    replies: window.providerKeysTest.replies,
  }));
  // Each key was sent exactly once, with its own provider.
  expect(sent.filter((a) => JSON.stringify(a).includes(DEEPGRAM))).toEqual([
    { provider: 'deepgram', key: DEEPGRAM },
  ]);
  expect(sent.filter((a) => JSON.stringify(a).includes(ANTHROPIC))).toEqual([
    { provider: 'anthropic', key: ANTHROPIC },
  ]);
  // No reply carried a key back.
  for (const reply of replies) {
    expect(JSON.stringify(reply)).not.toContain(DEEPGRAM);
    expect(JSON.stringify(reply)).not.toContain(ANTHROPIC);
  }
  await expect(page.locator('body')).not.toContainText(DEEPGRAM);
});

test('native fixture: the session spend estimate is shown as an estimate', async ({
  page,
}) => {
  await openNative(page);
  await page.evaluate(() =>
    window.providerKeysTest.setUsage({
      model: 'claude-haiku-5-5',
      requests: 12,
      requestCap: 400,
      spentMicroUsd: 31_000,
      spendCapMicroUsd: 500_000,
    }),
  );
  // Settings reads usage when it opens.
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByText(
      'This session: 12 of 400 cue requests, about $0.03 of $0.50 (an estimate, not your bill), model claude-haiku-5-5.',
    ),
  ).toBeVisible();
});

test('browser preview fake: a narrow window keeps the key controls inside the page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(row(page, 'Anthropic')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  for (const button of await row(page, 'Anthropic').getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test('browser preview fake: the transcription language is English until changed, with what each means', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const choice = page.getByLabel('Transcription language');
  await expect(choice).toHaveValue('en');
  await expect(
    page.getByText(
      'Applies to the next live session, never one already running.',
    ),
  ).toBeVisible();
  await expect(page.locator('body')).toContainText(
    'Deepgram bills it at a higher rate than English',
  );
  await expect(page.locator('body')).toContainText(
    'Phrase-rule cues understand English only',
  );
  await choice.selectOption('multi');
  await expect(choice).toHaveValue('multi');
});

test('native fixture: the language is sent as en or multi, and a running session refuses a change', async ({
  page,
}) => {
  await openNative(page);
  const choice = page.getByLabel('Transcription language');
  await expect(choice).toHaveValue('en');
  await choice.selectOption('multi');
  await expect
    .poll(() => page.evaluate(() => window.providerKeysTest.language()))
    .toBe('multi');
  expect(
    await page.evaluate(() =>
      window.providerKeysTest.sent.filter((a) =>
        JSON.stringify(a).includes('language'),
      ),
    ),
  ).toEqual([{ language: 'multi' }]);
  await page.evaluate(() => window.providerKeysTest.setSessionRunning(true));
  await choice.selectOption('en');
  await expect(page.getByRole('alert')).toHaveText(
    'Change the transcription language when no live session is running.',
  );
  await expect(choice).toHaveValue('multi');
});

test('native fixture: ElevenLabs key entry, test, removal, and Transcription provider selector work', async ({
  page,
}) => {
  await openNative(page);
  const elevenlabs = row(page, 'ElevenLabs');
  await expect(elevenlabs).toContainText('Not set');
  await elevenlabs.getByLabel('ElevenLabs API key').fill('not-an-el-key');
  await elevenlabs.getByRole('button', { name: 'Save key' }).click();
  await expect(elevenlabs.getByRole('alert')).toContainText(
    'That does not look like an ElevenLabs API key.',
  );
  await elevenlabs.getByLabel('ElevenLabs API key').fill(ELEVENLABS);
  await elevenlabs.getByRole('button', { name: 'Save key' }).click();
  await expect(elevenlabs).toContainText('Saved · not checked yet');
  await expect(
    elevenlabs.locator('.provider-key-state.is-set svg'),
  ).toBeVisible();
  await expect(elevenlabs.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  await expect(page.locator('body')).not.toContainText(ELEVENLABS);
  await elevenlabs.getByRole('button', { name: 'Test key' }).click();
  await expect(elevenlabs).toContainText('Saved · checked');
  await expect(
    elevenlabs.locator('.provider-key-state.is-set svg'),
  ).toBeVisible();
  await expect(elevenlabs.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  await expect(elevenlabs).toContainText('ElevenLabs accepted the key.');

  const providerChoice = page.getByLabel('Transcription provider');
  await expect(providerChoice).toHaveValue('deepgram');
  await providerChoice.selectOption('elevenlabs');
  await expect
    .poll(() => page.evaluate(() => window.providerKeysTest.provider()))
    .toBe('elevenlabs');
  await expect(page.locator('body')).toContainText(
    'detect languages automatically',
  );

  await page.evaluate(() => window.providerKeysTest.setSessionRunning(true));
  await providerChoice.selectOption('deepgram');
  await expect(page.getByRole('alert')).toHaveText(
    'Change the transcription provider when no live session is running.',
  );
  await expect(providerChoice).toHaveValue('elevenlabs');

  await elevenlabs.getByRole('button', { name: 'Remove key' }).click();
  await expect(elevenlabs).toContainText('Not set');
});

test('native fixture: openai and gemini keys validate, cross IPC once, and remove cleanly', async ({
  page,
}) => {
  await openNative(page);
  const openai = row(page, 'OpenAI');
  const gemini = row(page, 'Gemini');
  await expect(openai).toContainText('Not set');
  await expect(gemini).toContainText('Not set');

  await openai.getByLabel('OpenAI API key').fill('sk-ant-not-openai-key');
  await openai.getByLabel('OpenAI API key').press('Enter');
  await expect(openai.getByRole('alert')).toHaveText(
    'That does not look like an OpenAI API key. It starts with sk-.',
  );
  await openai.getByLabel('OpenAI API key').fill(OPENAI);
  await openai.getByRole('button', { name: 'Save key' }).click();
  await expect(openai).toContainText('Saved · not checked yet');
  await expect(openai.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  await openai.getByRole('button', { name: 'Test key' }).click();
  await expect(openai).toContainText(
    'Rejected by OpenAI. Replace it with a new key.',
  );

  await gemini.getByLabel('Gemini API key').fill('not-a-gemini-key');
  await gemini.getByLabel('Gemini API key').press('Enter');
  await expect(gemini.getByRole('alert')).toHaveText(
    'That does not look like a Google AI Studio Gemini API key. It starts with AIza.',
  );
  await page.evaluate(() =>
    window.providerKeysTest.setTestOutcome('gemini', 'verified'),
  );
  await gemini.getByLabel('Gemini API key').fill(GEMINI);
  await gemini.getByRole('button', { name: 'Save key' }).click();
  await gemini.getByRole('button', { name: 'Test key' }).click();
  await expect(gemini).toContainText('Saved · checked');
  await expect(gemini.locator('.provider-key-mask')).toHaveText(SAVED_MASK);
  await expect(gemini).toContainText('Gemini accepted the key.');

  const { sent, replies } = await page.evaluate(() => ({
    sent: window.providerKeysTest.sent,
    replies: window.providerKeysTest.replies,
  }));
  expect(sent.filter((a) => JSON.stringify(a).includes(OPENAI))).toEqual([
    { provider: 'openai', key: OPENAI },
  ]);
  expect(sent.filter((a) => JSON.stringify(a).includes(GEMINI))).toEqual([
    { provider: 'gemini', key: GEMINI },
  ]);
  for (const reply of replies) {
    expect(JSON.stringify(reply)).not.toContain(OPENAI);
    expect(JSON.stringify(reply)).not.toContain(GEMINI);
  }
  await gemini.getByRole('button', { name: 'Remove key' }).click();
  await expect(gemini).toContainText('Not set');
});

test('native fixture: cue provider switching, custom model validation, and honest custom spend', async ({
  page,
}) => {
  await openNative(page);
  const providerSelect = page.getByLabel('Cue & notes provider');
  const cueSelect = page.getByLabel('Cue model', { exact: true });
  const customCueInput = page.getByLabel('Custom cue model ID (optional)');
  const notesSelect = page.getByLabel('Model for meeting notes');

  await expect(providerSelect).toHaveValue('anthropic');
  await expect(cueSelect).toHaveValue('claude-haiku-5-5');
  await expect(notesSelect).toHaveValue('claude-opus-5-5');

  await providerSelect.selectOption('openai');
  await expect(providerSelect).toHaveValue('openai');
  await expect(cueSelect).toHaveValue('gpt-5-mini');
  await expect(notesSelect).toHaveValue('gpt-5');

  // Invalid custom ID is rejected with an inline error and keeps the curated default.
  await customCueInput.fill('gpt 5 invalid');
  await page.getByRole('button', { name: 'Save cue model' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Model ID must be up to 96 ASCII characters',
  );
  await expect(cueSelect).toHaveValue('gpt-5-mini');

  // Valid custom ID updates the selector and survives until cleared.
  await customCueInput.fill('gpt-5.4-codex');
  await page.getByRole('button', { name: 'Save cue model' }).click();
  await expect(cueSelect).toHaveValue('__custom__');
  await expect(
    page.getByText('Custom cue model saved: gpt-5.4-codex.'),
  ).toBeVisible();

  // Usage for custom model omits fabricated dollar spend.
  await page.evaluate(() =>
    window.providerKeysTest.setUsage({
      provider: 'openai',
      model: 'gpt-5.4-codex',
      requests: 7,
      requestCap: 400,
      spentMicroUsd: null,
      spendCapMicroUsd: null,
      customModel: true,
    }),
  );
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByText(
      'This session: 7 of 400 cue requests. Estimated spend unavailable for custom model gpt-5.4-codex.',
    ),
  ).toBeVisible();

  // Reset back to tested default, then switch to Gemini.
  await page.getByRole('button', { name: 'Use tested default' }).click();
  await expect(cueSelect).toHaveValue('gpt-5-mini');
  await providerSelect.selectOption('gemini');
  await expect(cueSelect).toHaveValue('gemini-2.5-flash');
  await expect(notesSelect).toHaveValue('gemini-2.5-pro');
});

test('browser preview fake: narrow 390px viewport fits all five providers and custom model controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const name of [
    'Deepgram',
    'ElevenLabs',
    'Anthropic',
    'OpenAI',
    'Gemini',
  ]) {
    await expect(row(page, name)).toBeVisible();
  }
  await expect(page.getByLabel('Transcription provider')).toBeVisible();
  await expect(page.getByLabel('Cue & notes provider')).toBeVisible();
  await expect(page.getByLabel('Custom cue model ID (optional)')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
