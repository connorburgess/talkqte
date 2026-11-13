import { expect, test } from '@playwright/test';

test('prior context is compact, keyboard accessible, and opens from setup', async ({
  page,
}) => {
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
  await page.locator('.setup-disclosure > summary').press('Enter');
  await page.getByRole('button', { name: 'Choose notes' }).press('Enter');
  await expect(add).toBeFocused();
  await expect(add).toBeVisible();
});
