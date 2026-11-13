import { expect, test, type Page } from '@playwright/test';

// The same React code runs in the desktop webview, where browser storage
// would outlive the app and a remote request would leave the device. Every
// value typed here is fictional.

const stored = (page: Page) =>
  page.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    cookies: document.cookie,
    databases: (await indexedDB.databases()).map((database) => database.name),
    caches: 'caches' in window ? await caches.keys() : [],
  }));

test('notes, focus, name and an export review stay out of browser storage and off the network', async ({
  page,
  context,
}) => {
  const contacted: string[] = [];
  page.on('request', (request) => contacted.push(request.url()));
  page.on('websocket', (socket) => contacted.push(socket.url()));
  await page.clock.install();
  await page.goto('/');
  const host = new URL(page.url()).host;

  const notes = page.getByRole('textbox', {
    name: 'Meeting notes',
    exact: true,
  });
  await notes.fill('Fictional note: confirm the garden welcome date.');
  await page.locator('.focus-disclosure > summary').press('Enter');
  const focus = page.getByRole('textbox', { name: 'Focus' });
  await focus.fill('Agree the seating chart for the potluck');
  await focus.blur();

  await page.getByRole('button', { name: 'Try demo', exact: true }).click();
  await page.clock.runFor(5200);
  await expect(
    page.getByRole('heading', { name: 'Who will take the first draft?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review your export' });
  await expect(review).toContainText('confirm the garden welcome date');
  await expect(review).not.toContainText('seating chart');
  await page.keyboard.press('Escape');

  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .press('Enter');
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Marisol');
  await name.press('Enter');
  await expect(name).toHaveValue('Marisol');

  expect(await stored(page)).toEqual({
    local: [],
    session: [],
    cookies: '',
    databases: [],
    caches: [],
  });
  expect(await context.cookies()).toEqual([]);
  // Only the page's own server: its files and the development reload socket.
  expect(
    contacted.filter(
      (url) => !/^(data|blob):/.test(url) && new URL(url).host !== host,
    ),
  ).toEqual([]);

  // Nothing typed returns after a reload, as after quitting the app.
  await page.reload();
  await expect(notes).toHaveValue('');
  await page.locator('.focus-disclosure > summary').press('Enter');
  await expect(page.getByRole('textbox', { name: 'Focus' })).toHaveValue('');
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .press('Enter');
  await expect(
    page.getByRole('textbox', { name: 'Name', exact: true }),
  ).toHaveValue('');
  expect(await stored(page)).toEqual({
    local: [],
    session: [],
    cookies: '',
    databases: [],
    caches: [],
  });
});
