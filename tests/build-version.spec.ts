import { test, expect } from '@playwright/test';

const info = {
  version: '0.1.0',
  commit: '1234567890abcdef1234567890abcdef12345678',
  dirty: false,
  profile: 'debug',
  target: 'fictional-test-target',
  sourceDateEpoch: null,
};

async function mount(
  page: import('@playwright/test').Page,
  value: unknown,
  reject = false,
) {
  await page.goto('/');
  await page.evaluate(
    async ({ value, reject }) => {
      document.body.innerHTML =
        '<main id="version-fixture" style="width:180px"></main>';
      const fixturePath = '/tests/fixtures/build-version.tsx';
      const { mountBuildVersion } = await import(fixturePath);
      mountBuildVersion(
        document.getElementById('version-fixture')!,
        value,
        reject,
      );
    },
    { value, reject },
  );
}

test('native footer distinguishes builds and exposes complete keyboard-readable details', async ({
  page,
}) => {
  await mount(page, info);
  // Native details/summary is keyboard-operable; disclosure needs no custom key handler.
  await expect(page.locator('summary')).toContainText('0.1.0 · 1234567');
  await page.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(info.commit, { exact: true })).toBeVisible();
  await expect(page.getByText('Clean at build')).toBeVisible();
  await expect(page.getByText(info.target, { exact: true })).toBeVisible();
  if (process.env.BUILD_VERSION_QA_DIR) {
    await page.locator('#version-fixture').screenshot({
      path: `${process.env.BUILD_VERSION_QA_DIR}/known-expanded.png`,
    });
  }
  expect(
    await page
      .locator('#version-fixture')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await mount(page, {
    ...info,
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
    dirty: true,
  });
  await expect(page.locator('summary')).toContainText('abcdef0 · modified');
  if (process.env.BUILD_VERSION_QA_DIR) {
    await page
      .locator('#version-fixture')
      .screenshot({ path: `${process.env.BUILD_VERSION_QA_DIR}/modified.png` });
  }
});

test('preview, unavailable, unknown source and supplied source date are honest', async ({
  page,
}) => {
  await mount(page, null);
  await expect(page.getByText('Browser preview')).toBeVisible();
  await expect(page.locator('summary')).toHaveCount(0);
  await mount(page, null, true);
  await expect(page.getByText('Build identity unavailable')).toBeVisible();
  await mount(page, {
    ...info,
    commit: 'unknown',
    dirty: null,
    sourceDateEpoch: 0,
  });
  await expect(page.locator('summary')).toContainText(
    'unknown source · changes unknown',
  );
  await page.locator('summary').click();
  await expect(page.getByText('1970-01-01T00:00:00.000Z')).toBeVisible();
});
