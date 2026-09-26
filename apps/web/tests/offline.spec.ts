import { expect, test } from '@playwright/test';

test('a right swipe adds a word to Liked and survives reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  await expect
    .poll(async () => Number(await page.getByTestId('stack-count').innerText()))
    .toBeGreaterThanOrEqual(150);
  const word = await page.getByTestId('top-card').locator('h2').innerText();
  await page.getByRole('button', { name: 'Interesting' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Added to Liked' }),
  ).toBeVisible();
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: word })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: word })).toBeVisible();
});

test('one fetched batch supports 100 offline swipes and survives reconnection', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  let feedFetches = 0;
  await page.route('**/api/feed?*', async (route) => {
    feedFetches++;
    if (feedFetches > 1) await route.abort();
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  await expect
    .poll(async () => Number(await page.getByTestId('stack-count').innerText()))
    .toBeGreaterThanOrEqual(100);
  expect(feedFetches).toBeGreaterThanOrEqual(1);
  await context.setOffline(true);
  for (let i = 0; i < 100; i++) {
    const before = Number(await page.getByTestId('stack-count').innerText());
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('stack-count')).toHaveText(
      String(before - 1),
    );
  }
  await page.goto('/liked/');
  await expect(page.getByText('100 saved')).toBeVisible();
  await expect(page.locator('.liked-item')).toHaveCount(100);
  await expect(page.getByText('100 swipes waiting to sync')).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByText('100 saved')).toBeVisible();
});

test('keyboard controls, undo, and definition setting work', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('top-card')).toBeVisible();
  const first = await page.getByTestId('top-card').locator('h2').innerText();
  await page.keyboard.press('d');
  await expect(page.getByText('Hide definition')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('status').filter({ hasText: 'Added to Liked' }),
  ).toBeVisible();
  await page.keyboard.press('z');
  await expect(page.getByTestId('top-card').locator('h2')).toHaveText(first);
  await page.getByRole('button', { name: /Settings/ }).click();
  await page.getByLabel('Always show definitions').check();
  await expect(page.getByText('Hide definition')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Hide definition')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(
    page.getByRole('status').filter({ hasText: 'Passed on this word' }),
  ).toBeVisible();
});

test('horizontal drag commits a swipe while vertical movement leaves the card in place', async ({
  page,
}) => {
  await page.goto('/');
  const card = page.getByTestId('top-card');
  await expect(card).toBeVisible();
  const first = await card.locator('h2').innerText();
  const box = await card.boundingBox();
  if (!box) throw new Error('Card has no visible bounds.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 4, y + 85, { steps: 5 });
  await page.mouse.up();
  await expect(card.locator('h2')).toHaveText(first);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + box.width * 0.48, y, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.getByRole('status').filter({ hasText: 'Added to Liked' }),
  ).toBeVisible();
  await page.goto('/liked/');
  await expect(page.getByRole('heading', { name: first })).toBeVisible();
});
