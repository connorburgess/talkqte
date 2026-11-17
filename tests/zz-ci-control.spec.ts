import { test, expect } from '@playwright/test';

test('temporary CI control: a failing browser test leaves a trace', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveText('this text is never shown');
});
