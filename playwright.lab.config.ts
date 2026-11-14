import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Opt-in: `npm run test:lab-record`. The lab recording test records video,
// so it is kept out of `npm test` and CI. It writes only to a temporary
// directory outside the repository.
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: '**/lab-recording.spec.ts',
});
