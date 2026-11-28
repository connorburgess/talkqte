import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { standIn } from './fixtures/stand-in';

test('Calendar agenda is off by default, independent of pre-call prompts, and prepares a meeting with zero capture or prior-note automation', async ({
  page,
}) => {
  await standIn(page, '/?live&keys=set');

  // Default-off Ready state shows a compact opt-in strip while keeping Start live session enabled.
  const optIn = page.getByRole('region', { name: 'Apple Calendar agenda' });
  await expect(optIn).toBeVisible();
  await expect(optIn).toContainText('Calendar agenda is off.');
  await expect(optIn).toContainText(
    'Apple Calendar meetings (local Mac cache)',
  );
  await expect(
    page.getByRole('button', { name: 'Start live session', exact: true }),
  ).toBeEnabled();

  // Verify Settings keeps Calendar & call prompts and Notebook Calendar agenda as separate default-off toggles.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Capture & prompts', exact: true })
    .click();
  const promptsRegion = page.getByRole('region', {
    name: 'Calendar & call prompts',
  });
  const agendaSettingsRegion = page.getByRole('region', {
    name: 'Notebook Calendar agenda',
  });
  const promptsCheck = promptsRegion.getByRole('checkbox', {
    name: 'Use macOS Calendar for upcoming meetings',
  });
  const agendaCheck = agendaSettingsRegion.getByRole('checkbox', {
    name: 'Show Apple Calendar agenda on Notebook Home',
  });
  await expect(promptsCheck).not.toBeChecked();
  await expect(agendaCheck).not.toBeChecked();
  await expect(agendaSettingsRegion).toContainText(
    'Apple Calendar’s local Mac cache',
  );
  await expect(agendaSettingsRegion).toContainText(
    'can save to Meetings or Markdown export',
  );

  // Turning on pre-call prompts does NOT enable Notebook Calendar agenda.
  await promptsCheck.check();
  await expect(promptsCheck).toBeChecked();
  await expect(agendaCheck).not.toBeChecked();

  // Turn on Notebook Calendar agenda from Settings; return to Notebook Home.
  await agendaCheck.check();
  await expect(agendaCheck).toBeChecked();
  await expect(agendaSettingsRegion.getByRole('status')).toContainText(
    'Connected · 3 of 3 calendars shown',
  );
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();

  // Agenda renders Today with ongoing NOW event, overlapping tags, all-day chip, and video link badge.
  const agenda = page.getByRole('region', { name: 'Calendar agenda' });
  await expect(agenda).toBeVisible();
  await expect(agenda).toContainText('Apple Calendar (local cache)');
  await expect(agenda).toContainText('Autumn catalog print freeze');
  await expect(agenda).toContainText('Garden supply planning');
  await expect(agenda).toContainText('NOW');
  await expect(agenda).toContainText('Signage wording review');
  await expect(agenda).toContainText('Compost supplier check-in');
  await expect(agenda.getByText('Overlaps')).toHaveCount(2);
  // Settings-only sourceLabel (iCloud/Google/Outlook) never leaks onto Notebook Home.
  await expect(agenda).not.toContainText('iCloud');
  await expect(agenda).not.toContainText('Outlook');

  // Selecting an event prepares the editable title locally with zero capture or prior-note automation.
  await agenda.getByRole('button', { name: /Garden supply planning/ }).click();
  const titleInput = page.getByRole('textbox', { name: 'Meeting title' });
  await expect(titleInput).toHaveValue('Garden supply planning');
  await expect(agenda.getByText('Prepared')).toBeVisible();
  expect(await page.evaluate(() => window.captureTest.liveStarts)).toEqual([]);
  await expect(page.locator('.context-disclosure')).toContainText(
    '0 notes selected',
  );

  // Ad-hoc session action clears prepared state cleanly and leaves no event title in status live regions.
  await page.getByRole('button', { name: 'Ad-hoc session' }).click();
  await expect(titleInput).toHaveCount(0);
  await expect(agenda.getByText('Prepared')).toHaveCount(0);
  expect(
    await page
      .locator('[role="status"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.textContent ?? '').join('\n'),
      ),
  ).not.toContain('Garden supply planning');

  // Turning the agenda off retires an unedited agenda-prepared title and leaves it absent from the entire DOM (including live regions).
  await agenda.getByRole('button', { name: /Garden supply planning/ }).click();
  await expect(titleInput).toHaveValue('Garden supply planning');
  await expect(page.locator('.calendar-meeting-title')).toContainText(
    'Prepared from Apple Calendar',
  );
  await agenda
    .getByRole('button', { name: 'Calendar settings', exact: true })
    .click();
  await agendaCheck.uncheck();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(titleInput).toHaveCount(0);
  expect(
    await page.evaluate(() => document.body.textContent ?? ''),
  ).not.toContain('Garden supply planning');

  // Turning the agenda back on: prepare, then revoke permission -> retires agenda-derived title before Start.
  await page.getByRole('button', { name: 'Turn on agenda' }).click();
  await expect(agenda).toBeVisible();
  await agenda.getByRole('button', { name: /Garden supply planning/ }).click();
  await expect(titleInput).toHaveValue('Garden supply planning');
  // Stale lower-revision snapshot cannot retire the prepared title.
  const currentRev = await page.evaluate(() => window.calendarTest.agenda());
  await page.evaluate(
    (staleSnap) => window.calendarTest.emitRawAgenda(staleSnap),
    {
      ...currentRev,
      revision: currentRev.revision - 1,
      agendaEnabled: false,
      permission: 'denied' as const,
      events: [],
    },
  );
  await expect(titleInput).toHaveValue('Garden supply planning');
  // Real revocation retires the unedited agenda-derived title cleanly; title is absent from DOM (including live regions) and Start sends no calendar title.
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({
      permission: 'denied',
      syncState: 'idle',
      events: [],
    }),
  );
  await expect(titleInput).toHaveCount(0);
  expect(
    await page.evaluate(() => document.body.textContent ?? ''),
  ).not.toContain('Garden supply planning');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.captureTest.liveStarts))
    .toEqual([{}]);
  await page
    .getByRole('button', { name: 'Stop live session', exact: true })
    .click();

  // Recover connection: editing a prepared title makes it a user-authored custom title preserved across disable.
  await page.evaluate(() => window.calendarTest.setGrantResult('connected'));
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({
      permission: 'connected',
      syncState: 'ready',
    }),
  );
  await page.getByRole('button', { name: 'Refresh calendar agenda' }).click();
  await agenda.getByRole('button', { name: /Signage wording review/ }).click();
  await titleInput.fill('Signage review — north gate');
  await expect(page.locator('.calendar-meeting-title')).toContainText(
    'Custom title',
  );
  await expect(page.locator('.calendar-meeting-title')).not.toContainText(
    'Prepared from Apple Calendar',
  );
  await agenda
    .getByRole('button', { name: 'Calendar settings', exact: true })
    .click();
  await agendaCheck.uncheck();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(titleInput).toHaveValue('Signage review — north gate');

  // Turning the agenda off does not erase a separate pre-call prompt pending title.
  await page.getByRole('button', { name: 'Ad-hoc session' }).click();
  await page.getByRole('button', { name: 'Turn on agenda' }).click();
  await page.evaluate(() =>
    window.calendarTest.triggerStart('Pre-call Weekly Sync'),
  );
  await expect(titleInput).toHaveValue('Pre-call Weekly Sync');
  await agenda
    .getByRole('button', { name: 'Calendar settings', exact: true })
    .click();
  await agendaCheck.uncheck();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(titleInput).toHaveValue('Pre-call Weekly Sync');
  await page.getByRole('button', { name: 'Turn on agenda' }).click();
  await expect(agenda).toBeVisible();

  // Prepare another meeting, edit its title, start live session -> collapses calendar Home and keeps started title even if revoked mid-session.
  await agenda.getByRole('button', { name: /Signage wording review/ }).click();
  await titleInput.fill('Signage review — north gate');
  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.captureTest.liveStarts))
    .toEqual([{}, { title: 'Signage review — north gate' }]);
  await expect(agenda).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({
      permission: 'denied',
      syncState: 'idle',
      events: [],
    }),
  );
  await expect(
    page.getByText('Meeting: Signage review — north gate'),
  ).toBeVisible();
});

test('date navigation, week strip keyboard nav, empty day, and truncated disclosure work within horizon', async ({
  page,
}) => {
  await standIn(page, '/?live&keys=set');
  await page.getByRole('button', { name: 'Turn on agenda' }).click();

  const agenda = page.getByRole('region', { name: 'Calendar agenda' });
  await expect(agenda).toBeVisible();

  // Today button starts disabled on Today; Next day moves to Tomorrow (multi-day all-day stays visible).
  const todayBtn = agenda.getByRole('button', { name: 'Today', exact: true });
  await expect(todayBtn).toBeDisabled();
  await agenda.getByRole('button', { name: 'Next day' }).click();
  await expect(agenda.getByRole('heading', { level: 2 })).toContainText(
    'Tomorrow',
  );
  await expect(agenda).toContainText('Autumn catalog print freeze');
  await expect(agenda).toContainText('Weekly community sync');
  await expect(todayBtn).toBeEnabled();

  // Keyboard ArrowRight on week strip moves to day +2 (empty day) -> calm empty state.
  const selectedDay = agenda.locator('.calendar-day-pill.is-selected');
  await selectedDay.focus();
  await page.keyboard.press('ArrowRight');
  await expect(agenda).toContainText('No meetings scheduled for');
  await expect(agenda).toContainText('start an ad-hoc session above');

  // Previous day twice returns to Today, one more reaches Yesterday (horizonStart -> Previous disabled).
  await todayBtn.click();
  await expect(todayBtn).toBeDisabled();
  await agenda.getByRole('button', { name: 'Previous day' }).click();
  await expect(agenda.getByRole('heading', { level: 2 })).toContainText(
    'Yesterday',
  );
  await expect(agenda).toContainText('Greenhouse build retro');
  await expect(
    agenda.getByRole('button', { name: 'Previous day' }),
  ).toBeDisabled();

  // Truncated disclosure covers 100-calendar, 10,000-scanned-item, and 250-event caps
  // honestly — even with only a few visible events (e.g. >100 calendars cap).
  await page.evaluate(() => {
    const snap = window.calendarTest.agenda();
    return window.calendarTest.emitAgenda({
      truncated: true,
      events: snap.events.slice(0, 3),
    });
  });
  await expect(agenda).toContainText(
    'Results are limited by local agenda caps (up to 100 calendars, 10,000 scanned items, or 250 shown events across yesterday through +14 days). Some calendars or events may not appear.',
  );
  await expect(agenda).not.toContainText('first 250 events');
  await expect(
    agenda.getByRole('button', { name: 'Filter calendars', exact: true }),
  ).toBeVisible();

  // On an empty day while truncated (e.g. candidate/event cap), copy does not falsely claim no meetings exist
  // and keeps the single results-limited disclosure below without repeating it.
  await todayBtn.click();
  await agenda.getByRole('button', { name: 'Next day' }).click();
  await agenda.getByRole('button', { name: 'Next day' }).click();
  await expect(agenda).toContainText('No meetings shown for');
  await expect(agenda).not.toContainText('No meetings scheduled for');
  await expect(agenda).toContainText(
    'Results are limited by local agenda caps (up to 100 calendars, 10,000 scanned items, or 250 shown events across yesterday through +14 days). Some calendars or events may not appear.',
  );

  // Settings reflects results-limited status (including >100 calendars Select-all limit) and Filter calendars navigates to Capture & prompts.
  await agenda
    .getByRole('button', { name: 'Filter calendars', exact: true })
    .click();
  const settingsRegion = page.getByRole('region', {
    name: 'Notebook Calendar agenda',
  });
  await expect(settingsRegion).toBeVisible();
  await expect(settingsRegion.getByRole('status').first()).toContainText(
    'results limited',
  );
  await expect(settingsRegion).not.toContainText('first 250 events');
  await expect(settingsRegion).toContainText(
    'Select all only covers the 100 returned here.',
  );
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh calendar agenda' }).click();
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({ truncated: false }),
  );

  // Continuing multi-day events that started before horizonStartDate stay visible on overlapping days.
  await expect(todayBtn).toBeDisabled();
  await page.evaluate(() => {
    const snap = window.calendarTest.agenda();
    const today = snap.todayLocalDate;
    const [y, m, d] = today.split('-').map(Number);
    const fmt = (delta: number) => {
      const dt = new Date(Date.UTC(y, m - 1, d + delta));
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    };
    const nowS = Math.floor(Date.now() / 1000);
    return window.calendarTest.emitAgenda({
      events: [
        ...snap.events,
        {
          occurrenceKey: 'occ-prehorizon-allday',
          title: 'Multi-day workshop (started earlier)',
          calendarId: 'cal-work',
          calendarTitle: 'Work',
          isAllDay: true,
          localDate: fmt(-4),
          endLocalDate: today,
          startEpochS: nowS - 4 * 86_400,
          endEpochS: nowS + 86_400,
          hasMeetingLink: false,
        },
        {
          occurrenceKey: 'occ-prehorizon-timed',
          title: 'Overnight maintenance handoff',
          calendarId: 'cal-work',
          calendarTitle: 'Work',
          isAllDay: false,
          localDate: fmt(-2),
          endLocalDate: today,
          startEpochS: nowS - 2 * 86_400,
          endEpochS: nowS + 180 * 60,
          hasMeetingLink: false,
        },
      ],
    });
  });
  await expect(agenda).toContainText('Multi-day workshop (started earlier)');
  await expect(agenda).toContainText('Overnight maintenance handoff');
});

test('Live session keeps Stop/consent primary, shows paused-while-live Schedule glance, and handles mid-session revocation', async ({
  page,
}) => {
  await standIn(page, '/?live&processor&keys=set');
  await page.getByRole('button', { name: 'Turn on agenda' }).click();
  await expect(
    page.getByRole('region', { name: 'Calendar agenda' }),
  ).toBeVisible();

  await page
    .getByRole('button', { name: 'Start live session', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('region', { name: 'Calendar agenda' }),
  ).toHaveCount(0);

  // Open compact Schedule glance during live session.
  const glanceBtn = page.getByRole('button', {
    name: 'Schedule glance',
    exact: true,
  });
  await expect(glanceBtn).toBeVisible();
  await glanceBtn.click();

  const glance = page.getByRole('region', { name: 'Schedule glance' });
  await expect(glance).toBeVisible();
  await expect(glance.getByRole('status')).toContainText('Paused while live');
  await expect(glance).toContainText('Garden supply planning');

  // Stop live session and Cue processing controls stay unobstructed while glance is open.
  await expect(
    page.getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pause cues', exact: true }),
  ).toBeVisible();

  // Stale while live discloses both stale and paused state clearly.
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({ stale: true, pausedWhileLive: true }),
  );
  await expect(glance.getByRole('status')).toContainText(
    /Stale · cached .+ \(paused while live\)/,
  );

  // Manual Refresh inside Schedule glance clears stale without interrupting live capture.
  await glance.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(glance.getByRole('status')).toContainText('Paused while live');
  await expect(
    page.getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeEnabled();

  // Results-limited disclosure appears inside Schedule glance on both populated and empty days without over-claiming first-250.
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({ truncated: true, pausedWhileLive: true }),
  );
  await expect(glance).toContainText(
    'Results are limited (up to 100 calendars, 10,000 scanned items, or 250 shown events); some calendars or meetings may not appear.',
  );
  await expect(glance).not.toContainText('first 250 events');
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({
      truncated: true,
      pausedWhileLive: true,
      events: [],
    }),
  );
  await expect(glance).toContainText(
    'No more meetings shown on today’s cached schedule. Results are limited (up to 100 calendars, 10,000 scanned items, or 250 shown events)',
  );

  // Loading, unknown (permission: off), and all-hidden states stay honest inside Schedule glance.
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({
      syncState: 'loading',
      events: [],
      truncated: false,
    }),
  );
  await expect(
    glance.locator('.calendar-agenda-skeleton[aria-busy="true"]'),
  ).toBeVisible();

  await page.evaluate(() =>
    window.calendarTest.emitAgenda({
      permission: 'off',
      syncState: 'idle',
      events: [],
    }),
  );
  await expect(glance).toContainText(
    'Apple Calendar permission has not been granted yet. Your live session continues unaffected.',
  );

  await glance.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(glance).toContainText('Garden supply planning');

  // Escape closes Schedule glance and returns keyboard focus to the trigger.
  await page.keyboard.press('Escape');
  await expect(glance).toHaveCount(0);
  await expect(glanceBtn).toBeFocused();

  // Permission revoked mid-session: reopening Schedule glance synchronously rechecks,
  // clears cached events, and never interrupts the live session.
  await page.evaluate(() => window.calendarTest.setGrantResult('denied'));
  await glanceBtn.click();
  await expect(glance).toContainText(
    'Calendar access was revoked in macOS System Settings. Cached events are cleared, and your live session continues unaffected.',
  );
  await expect(glance).not.toContainText('Garden supply planning');
  await expect(
    page.getByRole('button', { name: 'Stop live session', exact: true }),
  ).toBeEnabled();
});

test('Settings included-calendars exact filter, empty-all-hidden recovery, and failure/stale/loading/revision states', async ({
  page,
}) => {
  await standIn(page, '/?live&keys=set');
  await page.getByRole('button', { name: 'Turn on agenda' }).click();
  const agenda = page.getByRole('region', { name: 'Calendar agenda' });
  await expect(agenda).toContainText('Signage wording review');

  // Open Settings and filter calendars to exact subset (including empty []).
  await agenda
    .getByRole('button', { name: 'Calendar settings', exact: true })
    .click();
  const settingsRegion = page.getByRole('region', {
    name: 'Notebook Calendar agenda',
  });
  await expect(settingsRegion).toContainText('iCloud');
  await expect(settingsRegion).toContainText('Google');
  await expect(settingsRegion).toContainText('Outlook');

  await settingsRegion
    .getByRole('checkbox', { name: /Design Studio/ })
    .uncheck();
  await settingsRegion.getByRole('checkbox', { name: /Garden Club/ }).uncheck();
  await expect(settingsRegion.getByRole('status')).toContainText(
    'Connected · 1 of 3 calendars shown',
  );

  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(agenda).toContainText('Garden supply planning');
  await expect(agenda).not.toContainText('Signage wording review');
  await expect(agenda).not.toContainText('Compost supplier check-in');

  // Unchecking the last calendar sends exact [] -> all-hidden message, never auto-widens.
  await agenda
    .getByRole('button', { name: 'Calendar settings', exact: true })
    .click();
  await settingsRegion.getByRole('checkbox', { name: /Work/ }).uncheck();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(agenda).toContainText('All calendars are hidden.');
  await agenda.getByRole('button', { name: 'Choose calendars' }).click();
  await settingsRegion.getByRole('button', { name: 'Select all' }).click();
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(agenda).toContainText('Signage wording review');

  // Loading skeleton state preserves Start live session.
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({ syncState: 'loading', events: [] }),
  );
  await expect(
    agenda.locator('.calendar-agenda-skeleton[aria-busy="true"]'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start live session', exact: true }),
  ).toBeEnabled();

  // Stale cache bar renders on Home Agenda and Settings with direct Refresh recovery.
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({
      syncState: 'ready',
      stale: true,
      error: null,
    }),
  );
  await expect(agenda).toContainText('Showing a cached schedule');
  await agenda
    .getByRole('button', { name: 'Calendar settings', exact: true })
    .click();
  await expect(settingsRegion.getByRole('status').first()).toContainText(
    'Connected · stale cache',
  );
  await settingsRegion.getByRole('button', { name: 'Refresh now' }).click();
  await expect(settingsRegion.getByRole('status').first()).toContainText(
    'Connected · 3 of 3 calendars shown',
  );
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(agenda).not.toContainText('Showing a cached schedule');

  // Error + stale recovery via Retry.
  await page.evaluate(() =>
    window.calendarTest.setNextAgendaError(
      'Apple Calendar did not respond. Try again.',
    ),
  );
  await agenda.getByRole('button', { name: 'Refresh calendar agenda' }).click();
  await expect(agenda.getByRole('alert')).toContainText(
    'Apple Calendar did not respond. Try again.',
  );
  await agenda.getByRole('button', { name: 'Retry' }).click();
  await expect(agenda.getByRole('alert')).toHaveCount(0);
  await expect(agenda).toContainText('Garden supply planning');

  // Out-of-order lower revision snapshot is ignored.
  const current = await page.evaluate(() => window.calendarTest.agenda());
  await page.evaluate(
    (staleRevSnap) => window.calendarTest.emitRawAgenda(staleRevSnap),
    { ...current, revision: current.revision - 1, events: [] },
  );
  await expect(agenda).toContainText('Garden supply planning');
});

test('denied permission recovery and non-macOS / lab unavailable states stay honest', async ({
  page,
}) => {
  await standIn(page, '/?live&keys=set');
  await page.evaluate(() => window.calendarTest.setGrantResult('denied'));
  await page.getByRole('button', { name: 'Turn on agenda' }).click();

  const agenda = page.getByRole('region', { name: 'Calendar agenda' });
  await expect(agenda).toContainText(
    'Calendar access is off or was revoked in macOS System Settings',
  );
  await agenda
    .getByRole('button', { name: 'Open Calendar privacy settings' })
    .click();
  expect(await page.evaluate(() => window.calendarTest.settingsOpened())).toBe(
    1,
  );
  await expect(
    page.getByRole('button', { name: 'Start live session', exact: true }),
  ).toBeEnabled();

  // Granting permission and clicking Check again recovers smoothly.
  await page.evaluate(() => window.calendarTest.setGrantResult('connected'));
  await agenda.getByRole('button', { name: 'Check again' }).click();
  await expect(agenda).toContainText('Garden supply planning');

  // Expired/undetermined initial Off state shows waiting-for-permission recovery on Home AND Settings.
  await page.evaluate(() =>
    window.calendarTest.emitAgenda({
      agendaEnabled: true,
      permission: 'off',
      syncState: 'idle',
      events: [],
    }),
  );
  await expect(agenda).toContainText(
    'Apple Calendar access has not been granted yet.',
  );
  await agenda
    .getByRole('button', { name: 'Calendar settings', exact: true })
    .click();
  const agendaSettings = page.getByRole('region', {
    name: 'Notebook Calendar agenda',
  });
  await expect(agendaSettings.getByRole('status').first()).toContainText(
    'Waiting for macOS Calendar permission',
  );
  await agendaSettings
    .getByRole('button', { name: 'Request access again' })
    .click();
  await expect(agendaSettings.getByRole('status').first()).toContainText(
    'Connected · 3 of 3 calendars shown',
  );
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await expect(agenda).toContainText('Garden supply planning');

  // Direct #calendar-agenda-setting hash opens Settings -> Capture & prompts.
  await page.evaluate(() => {
    window.location.hash = '#calendar-agenda-setting';
  });
  await expect(agendaSettings).toBeVisible();

  // Non-macOS and lab runs hide Notebook Calendar Home and disclose unavailability in Settings.
  for (const [query, expected] of [
    ['/?platform=windows&live', 'Not available on Windows yet.'],
    ['/?platform=linux&live', 'Not available on Linux yet.'],
    ['/?lab&live', 'Unavailable in lab runs'],
  ] as const) {
    await standIn(page, query);
    await expect(
      page.getByRole('region', { name: 'Apple Calendar agenda' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: 'Calendar agenda' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Capture & prompts', exact: true })
      .click();
    const region = page.getByRole('region', {
      name: 'Notebook Calendar agenda',
    });
    await expect(region).toContainText(expected);
    await expect(region.getByRole('checkbox')).toHaveCount(0);
  }
});

for (const width of [320, 390, 1320]) {
  test(`Calendar Home and Live Schedule Glance fit cleanly with zero overflow and pass axe at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 880 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await standIn(page, '/?live&processor&keys=set');
    await page.getByRole('button', { name: 'Turn on agenda' }).click();

    const agenda = page.getByRole('region', { name: 'Calendar agenda' });
    await expect(agenda).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);

    if (width <= 520) {
      for (const btn of await agenda.getByRole('button').all()) {
        const box = await btn.boundingBox();
        if (box) expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }

    const readyAxe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .disableRules(['color-contrast'])
      .analyze();
    expect(readyAxe.violations).toEqual([]);

    // Start live session, open Schedule glance, verify zero overflow + axe.
    await page
      .getByRole('button', { name: 'Start live session', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Schedule glance', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Schedule glance' }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);

    const liveAxe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .disableRules(['color-contrast'])
      .analyze();
    expect(liveAxe.violations).toEqual([]);
  });
}
