import { expect, test } from '@playwright/test';

test('prior context is compact and keyboard accessible', async ({ page }) => {
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Prior context' });
  const summary = panel.locator('summary');
  const add = panel.getByRole('button', { name: 'Add notes from a file' });
  await expect(summary).toContainText('0 notes selected');
  await expect(add).toBeHidden();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(add).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(add).toBeHidden();
});
