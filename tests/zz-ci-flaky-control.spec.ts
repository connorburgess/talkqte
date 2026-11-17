import { test, expect } from '@playwright/test';

test('temporary CI control: fails on the first attempt and passes on retry', async ({}, testInfo) => {
  expect(testInfo.retry).toBeGreaterThan(0);
});
