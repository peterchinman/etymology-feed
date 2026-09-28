import type { Card } from '@etymology-feed/shared/card';
import { expect, test } from '@playwright/test';

test('subtle like totals survive offline reloads and old cards omit unknown totals', async ({
  page,
  context,
}, testInfo) => {
  await page.route('**/api/feed?*', async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as { cards: Card[] };
    data.cards.forEach((card, index) => {
      const counts = [1234, 1, 0];
      if (index < counts.length) card.likeCount = counts[index];
      else delete card.likeCount;
    });
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  const card = page.getByTestId('top-card');
  const count = card.locator('.card-like-count');
  await expect(count).toHaveText('Liked by 1,234 users');
  await expect(
    page.getByRole('button', { name: 'Interesting', exact: true }),
  ).toBeEnabled();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => resolve(),
          { once: true },
        ),
      );
  });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const countBox = await count.boundingBox();
    const sourceBox = await card
      .getByRole('link', { name: 'Wiktionary' })
      .boundingBox();
    if (!countBox || !sourceBox) throw new Error('Missing card footer.');
    expect(countBox.x + countBox.width).toBeLessThan(sourceBox.x);
    expect(Math.abs(countBox.y - sourceBox.y)).toBeLessThan(5);
  }
  await page.screenshot({
    path: testInfo.outputPath('like-count-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('like-count-mobile.png'),
  });
  await context.setOffline(true);
  await page.reload();
  await expect(count).toHaveText('Liked by 1,234 users');
  await expect(
    page.getByRole('button', { name: 'Interesting', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('ArrowLeft');
  await expect(count).toHaveText('Liked by 1 user');
  await page.keyboard.press('ArrowLeft');
  await expect(count).toHaveText('Liked by 0 users');
  await page.keyboard.press('ArrowLeft');
  await expect(count).toHaveCount(0);
  await expect(card.getByRole('link', { name: 'Wiktionary' })).toBeVisible();
});
