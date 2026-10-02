import type { Card } from '@etymology-feed/shared/card';
import { putCardsOnStack, waitForSavedSwipes } from './helpers/cards';
import { expect, test } from './helpers/test';

test('proper nouns default off, toggle immediately, and remain available offline', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const preferences: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/feed')
      preferences.push(url.searchParams.get('includeProperNouns') ?? 'missing');
  });
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  const response = await page.request.get('/api/feed?n=100');
  const { cards } = (await response.json()) as { cards: Card[] };
  const [first, second, third, fourth] = cards.slice(0, 4);
  const proper = {
    ...first,
    word: 'Proper One',
    defPos: 'proper noun',
    pos: ['proper noun'],
  };
  const common = {
    ...second,
    word: 'Capitalized Common',
    defPos: 'noun',
    pos: ['noun', 'proper noun'],
  };
  const anotherProper = {
    ...third,
    word: 'Proper Two',
    defPos: 'proper noun',
    pos: ['proper noun'],
  };
  const anotherCommon = {
    ...fourth,
    word: 'ordinary',
    defPos: 'noun',
    pos: ['noun'],
  };
  await context.route('**/api/feed?*', (route) =>
    route.fulfill({ json: { cards: [] } }),
  );
  await putCardsOnStack(
    page,
    [proper, common, anotherProper, anotherCommon],
    common,
  );
  const top = page.getByTestId('top-card').locator('h2');
  const openSettings = async () => {
    await page
      .locator('.top-nav')
      .getByRole('link', { name: 'Settings' })
      .click();
    await expect(toggle).toBeEnabled();
  };
  const toggle = page.getByRole('switch', { name: 'Include proper nouns' });
  const closeSettings = () =>
    page.getByRole('button', { name: 'Close settings' }).click();
  await openSettings();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeEnabled();
  await closeSettings();
  await expect(top).toHaveText('Proper One');
  await expect.poll(() => preferences.includes('true')).toBe(true);
  expect(preferences).toContain('false');
  await openSettings();
  await toggle.uncheck();
  await expect(toggle).toBeEnabled();
  await closeSettings();
  await expect(top).toHaveText('Capitalized Common');
  await page.getByRole('button', { name: 'Interesting', exact: true }).click();
  await waitForSavedSwipes(page, 1);
  await expect(top).toHaveText('ordinary');
  await page.reload();
  await expect(top).toHaveText('ordinary');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  await context.setOffline(true);
  await openSettings();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeEnabled();
  await closeSettings();
  await expect(top).toHaveText('Proper One');
  await page.getByRole('button', { name: 'Interesting', exact: true }).click();
  await waitForSavedSwipes(page, 2);
  await expect(top).toHaveText('Proper Two');
  await openSettings();
  await toggle.uncheck();
  await expect(toggle).toBeEnabled();
  await closeSettings();
  await expect(top).toHaveText('ordinary');
  await page.locator('.top-nav').getByRole('link', { name: 'Liked' }).click();
  await expect(
    page.getByRole('heading', { name: 'Proper One', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Capitalized Common', exact: true }),
  ).toBeVisible();
});

test('the mobile Settings page saves the proper noun preference across reloads', async ({
  page,
}) => {
  await page.goto('/settings/');
  const toggle = page.getByRole('switch', { name: 'Include proper nouns' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeEnabled();
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).toBeEnabled();
  await page.reload();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
});
