import { defineConfig, devices } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT || '1420';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  // Records video; opt-in through playwright.lab.config.ts.
  testIgnore: '**/lab-recording.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // On CI a failed test runs once more only to tell a flaky test from a
  // broken one in the report. A test that fails and then passes still fails
  // the run: flaky tests are listed and fixed, never retried to green.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  reporter: 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1320, height: 880 },
      },
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1320, height: 880 },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI && !process.env.PLAYWRIGHT_PORT,
  },
});
